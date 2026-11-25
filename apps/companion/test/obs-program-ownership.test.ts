import { afterEach, expect, it, vi } from 'vitest';
vi.mock('obs-websocket-js', async () => await import('obs-websocket-js/json'));
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedObsResources } from '../src/obs/managed-resources.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { ObsAdapter } from '../src/obs/adapter.js';
import { ObsVideoTransaction } from '../src/obs/video-transaction.js';
import { OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';
import { ProgramDirector } from '../src/program-scenes/director.js';
import { createProduction, type ProductionDependencies } from '../src/program-scenes/production.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function rig() {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-program-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'obs.json');
  const scenes = new Map([['个人', ['personal-default', 'personal-program']]]);
  const state = {
    version: '33.0.1' as string | undefined,
    versionReadFailed: false,
    video: {
      baseWidth: 1280,
      baseHeight: 720,
      outputWidth: 1280,
      outputHeight: 720,
      fpsNumerator: 30,
      fpsDenominator: 1,
    },
    collection: '个人',
    scene: 'personal-program',
    output: false,
    failVirtualCamStatus: false,
    marker: undefined as unknown,
    inputListReads: 0,
    inputs: [] as { inputUuid: string; inputName: string; inputKind: string }[],
    sceneItems: new Map<
      string,
      { sceneItemId: number; sourceUuid: string; sourceName: string; sceneItemEnabled: boolean }[]
    >(),
    inputSettings: new Map<string, Record<string, unknown>>(),
    calls: [] as string[],
    nextSceneOnScreenshot: undefined as string | undefined,
  };
  const writes: string[] = [];
  let notify: (type: string, data: object) => void = () => {};
  const rpc: ObsRpc = {
    call: async (type, data) => {
      state.calls.push(type);
      if (/^(Set|Create|Start|Stop)/.test(type)) writes.push(type);
      if (type === 'GetVersion') {
        if (state.versionReadFailed) throw new Error('version unavailable');
        return { obsVersion: state.version };
      }
      if (type === 'GetVideoSettings') return { ...state.video };
      if (type === 'GetProfileList') return { currentProfileName: '个人' };
      if (type === 'SetVideoSettings') Object.assign(state.video, data);
      if (type === 'GetVirtualCamStatus' && state.failVirtualCamStatus)
        throw new Error('virtualcam status unavailable');
      if (
        [
          'GetStreamStatus',
          'GetRecordStatus',
          'GetReplayBufferStatus',
          'GetVirtualCamStatus',
        ].includes(type)
      )
        return { outputActive: state.output };
      if (type === 'GetOutputList')
        return {
          outputs: [
            {
              outputName: '直播',
              outputActive: state.output,
              outputFlags: { OBS_OUTPUT_VIDEO: true },
            },
          ],
        };
      if (type === 'GetSceneCollectionList')
        return {
          currentSceneCollectionName: state.collection,
          sceneCollections: [...scenes.keys()],
        };
      if (type === 'GetCurrentProgramScene')
        return { currentProgramSceneUuid: state.scene, currentProgramSceneName: state.scene };
      if (type === 'GetSceneList')
        return {
          scenes: scenes
            .get(state.collection)!
            .map((sceneUuid) => ({ sceneUuid, sceneName: sceneUuid })),
        };
      if (type === 'GetInputList') {
        state.inputListReads++;
        return { inputs: state.inputs };
      }
      if (type === 'GetSceneItemList') {
        const sceneName = String(data?.sceneName ?? data?.sceneUuid ?? '');
        return { sceneItems: state.sceneItems.get(sceneName) ?? [] };
      }
      if (type === 'SetSceneItemEnabled') {
        const sceneName = String(data?.sceneName ?? data?.sceneUuid ?? '');
        const sceneItemId = Number(data?.sceneItemId);
        const sceneItemEnabled = Boolean(data?.sceneItemEnabled);
        const found = state.sceneItems.get(sceneName)?.find((i) => i.sceneItemId === sceneItemId);
        if (found) found.sceneItemEnabled = sceneItemEnabled;
        notify('SceneItemEnableStateChanged', { sceneName, sceneItemId, sceneItemEnabled });
      }
      if (type === 'GetPersistentData') return { slotValue: state.marker };
      if (type === 'SetPersistentData') state.marker = data!.slotValue;
      if (type === 'CreateSceneCollection' || type === 'SetCurrentSceneCollection') {
        notify('CurrentSceneCollectionChanging', { sceneCollectionName: state.collection });
        state.collection = String(data!.sceneCollectionName);
        if (type === 'CreateSceneCollection') scenes.set(state.collection, ['managed-bootstrap']);
        state.scene = scenes.get(state.collection)![0]!;
        notify('CurrentProgramSceneChanged', { sceneUuid: state.scene, sceneName: state.scene });
        notify('CurrentSceneCollectionChanged', { sceneCollectionName: state.collection });
      }
      if (type === 'SetCurrentProgramScene') {
        state.scene = String(data!.sceneUuid);
        notify('CurrentProgramSceneChanged', { sceneUuid: state.scene, sceneName: state.scene });
      }
      if (type === 'GetInputSettings') {
        return {
          inputSettings:
            state.inputSettings.get(String(data?.inputUuid ?? data?.inputName ?? '')) ?? {},
        };
      }
      if (type === 'GetSourceScreenshot') {
        if (state.nextSceneOnScreenshot) state.scene = state.nextSceneOnScreenshot;
        return { imageData: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' };
      }
      return {};
    },
  };
  const server = Fastify();
  await server.register(websocket);
  const sockets = new Set<{ send(data: string): void }>();
  notify = (eventType, eventData) => {
    for (const socket of sockets)
      socket.send(JSON.stringify({ op: 5, d: { eventType, eventData, eventIntent: 1023 } }));
  };
  server.get('/', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.6.3', rpcVersion: 1 } }));
    socket.on('message', async (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.op === 1) socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      if (message.op === 6) {
        let responseData = {};
        let requestStatus = { result: true, code: 100 };
        try {
          responseData = await rpc.call(message.d.requestType, message.d.requestData);
        } catch {
          requestStatus = { result: false, code: 600 };
        }
        socket.send(
          JSON.stringify({
            op: 7,
            d: {
              requestType: message.d.requestType,
              requestId: message.d.requestId,
              requestStatus,
              responseData,
            },
          }),
        );
      }
    });
  });
  const endpoint = (await server.listen({ port: 0, host: '127.0.0.1' })).replace('http:', 'ws:');
  cleanups.push(() => server.close());
  const store = new ObsConfigStore(path);
  await store.save({
    executablePath: null,
    host: '127.0.0.1',
    port: Number(new URL(endpoint).port),
    password: '',
  });
  const bind = () =>
    new ManagedObsResources(path + '.collection.json').bind(rpc, endpoint, 'http://127.0.0.1:3000');
  return { path, state, scenes, writes, bind, store, notify, server };
}

it('confirms an output already started on the observed connection without a second start', async () => {
  const f = await rig();
  const adapter = new ObsAdapter(f.store, 'http://127.0.0.1:3000');
  cleanups.push(() => adapter.close());
  const before = await adapter.outputStatus();
  expect(before.record.phase).toBe('idle');
  f.state.output = true;
  const after = await adapter.outputCommand({
    output: 'record',
    action: 'start',
    expectedRevision: before.record.revision,
  });
  expect(after.record).toMatchObject({ phase: 'active', active: true, pending: null });
  expect(f.writes).toEqual([]);
});

it('reports unsupported or unknown OBS versions and blocks preparation before configuration writes', async () => {
  const f = await rig();
  const adapter = new ObsAdapter(f.store, 'http://127.0.0.1:3000');
  cleanups.push(() => adapter.close());
  for (const [version, code] of [
    ['30.2.3', 'obs_version_unsupported'],
    ['31.1.0', 'obs_version_unsupported'],
    ['33.0.0-beta1', 'obs_version_unsupported'],
    ['34.0.0', 'obs_version_unsupported'],
    [undefined, 'obs_version_unknown'],
  ] as const) {
    f.state.version = version;
    expect(await adapter.check()).toEqual([{ code, message: expect.any(String) }]);
    await expect(adapter.videoPreflight(() => true)).rejects.toMatchObject({ code });
    await expect(adapter.prepareVideo(() => true)).rejects.toMatchObject({ code });
    await expect(
      adapter.ensure(
        () => 'waiting',
        () => true,
      ),
    ).rejects.toMatchObject({ code });
  }
  f.state.versionReadFailed = true;
  expect(await adapter.check()).toEqual([
    { code: 'obs_version_unknown', message: expect.stringContaining('重新检查连接') },
  ]);
  await expect(
    adapter.ensure(
      () => 'waiting',
      () => true,
    ),
  ).rejects.toMatchObject({
    code: 'obs_version_unknown',
  });
  expect(f.writes).toEqual([]);
  expect(f.state.collection).toBe('个人');
  expect(await f.store.managedResources.hasPendingReturn()).toBe(false);
});

it('reuses the visual input inventory for preparation observations', async () => {
  const f = await rig();
  const managed = await f.bind();
  await managed.prepareManagedCollection!(true, managed);
  const adapter = new ObsAdapter(f.store, 'http://127.0.0.1:3000');
  cleanups.push(() => adapter.close());
  const before = f.state.inputListReads;
  f.writes.length = 0;
  expect(await adapter.check()).toContainEqual({
    code: 'scene_missing',
    scene: expect.any(String),
    message: expect.any(String),
  });
  expect(f.state.inputListReads - before).toBe(6);
  expect(f.writes).toEqual([]);
});

it('rechecks after an OBS upgrade, prepares video on the supported major, and permits old-version recovery', async () => {
  const f = await rig();
  const adapter = new ObsAdapter(
    f.store,
    'http://127.0.0.1:3000',
    undefined,
    undefined,
    undefined,
    new ObsVideoTransaction(f.path + '.video.json'),
  );
  cleanups.push(() => adapter.close());
  f.state.version = '30.2.3';
  expect(await adapter.check()).toContainEqual({
    code: 'obs_version_unsupported',
    message: expect.stringContaining('OBS 32'),
  });
  f.state.version = '32.2.2';
  expect(await adapter.check()).toEqual([
    { code: 'collection_missing', message: expect.any(String) },
  ]);
  const before = { ...f.state.video };
  await adapter.videoPreflight(() => true);
  const id = await adapter.prepareVideo(() => true);
  expect(id).toEqual(expect.any(String));
  expect(f.state.video).toEqual({
    baseWidth: 1920,
    baseHeight: 1080,
    outputWidth: 1920,
    outputHeight: 1080,
    fpsNumerator: 60,
    fpsDenominator: 1,
  });
  f.state.version = '30.2.3';
  await adapter.restoreVideo(id!);
  expect(f.state.video).toEqual(before);
});

it('keeps the original program across preparation retries and restores it after restart through OBS events', async () => {
  const f = await rig();
  const managed = await f.bind();
  await managed.prepareManagedCollection!(true, managed);
  expect(f.state.collection).toBe(OBS_COLLECTION);
  const retry = await f.bind();
  await retry.prepareManagedCollection!(true, retry);
  expect(JSON.parse(await readFile(f.path + '.collection.json', 'utf8'))[0].returnTo).toEqual({
    collection: '个人',
    sceneUuid: 'personal-program',
  });
  const adapter = new ObsAdapter(f.store, 'http://127.0.0.1:3000');
  cleanups.push(() => adapter.close());
  f.state.version = '30.2.3';
  const events: string[] = [];
  adapter.onProgramChanged((kind) => events.push(kind));
  await adapter.outputStatus();
  await adapter.restoreProgram();
  expect(f.state.collection).toBe('个人');
  expect(f.state.scene).toBe('personal-program');
  // Changing carries the OLD collection; this must not be mistaken for outside control.
  expect(events).toEqual([]);
  expect(await f.store.managedResources.hasPendingReturn()).toBe(false);
});

it('returns to the owned collection without overwriting the original, and retains blocked restoration', async () => {
  const f = await rig();
  const managed = await f.bind();
  await managed.prepareManagedCollection!(true, managed);
  f.state.collection = '个人';
  f.state.scene = 'personal-default';
  const reconnected = await f.bind();
  await reconnected.activateManagedCollection!();
  expect(f.state.collection).toBe(OBS_COLLECTION);
  f.state.output = true;
  await expect(reconnected.restoreManagedCollection!()).rejects.toThrow();
  expect(await f.store.managedResources.hasPendingReturn()).toBe(true);
  expect(f.writes.some((type) => type.startsWith('Stop'))).toBe(false);
  f.state.output = false;
  await (
    await f.bind()
  ).restoreManagedCollection!();
  expect(f.state.scene).toBe('personal-program');
});

it('restores the selected program without manual hold and leaves OBS alone after exit', async () => {
  let actualProgram = 'external';
  const controller = new ProgramSceneController({} as never, {} as never, async (id, options) => {
    if (options.valid?.()) actualProgram = id;
  });
  let active = true;
  const director = new ProgramDirector({} as never, controller, {} as never, () => active);
  controller.attachDirector(director);
  controller.obsProgramChanged();
  await Promise.all([controller.reconcileObs(() => active), controller.reconcileObs(() => active)]);
  expect(actualProgram).toBe('waiting');
  expect(director.get().mode).not.toBe('manual');
  actualProgram = 'external';
  controller.obsProgramChanged();
  const late = controller.reconcileObs(() => active, Infinity);
  active = false;
  await late;
  expect(actualProgram).toBe('external');
});

it('notifies opening media only when the current matchup take starts in OBS', async () => {
  const projection = {
    getCurrent: () => ({
      operator: {
        runtime: { telemetryFreshness: 'fresh' },
        matchContext: { freshness: 'fresh', origin: 'fixture' },
        identity: { state: 'matched' },
      },
      program: { map: { name: 'de_dust2' }, match: { matchId: 'match' } },
    }),
    getBpAssessment: () => ({ readiness: 'unavailable' }),
  } as unknown as ConstructorParameters<typeof ProgramSceneController>[0];
  let eligible = true;
  let firstStarted: (() => void) | undefined;
  const opening = vi.fn();
  const controller = new ProgramSceneController(projection, {} as never, async (id, options) => {
    if (id !== 'matchup') return;
    if (!firstStarted) {
      firstStarted = options.onStarted;
      eligible = false;
      options.onStarted?.();
      return;
    }
    firstStarted();
    expect(opening).not.toHaveBeenCalled();
    expect(controller.get().active).toBe('waiting');
    options.onStarted?.();
  });
  controller.onMatchupStarted(opening);
  const cancelled = await controller.selectAutomatic(
    'matchup',
    controller.get().revision,
    () => eligible,
  );
  expect(cancelled.ok).toBe(false);
  expect(opening).not.toHaveBeenCalled();

  eligible = true;
  const taken = await controller.selectAutomatic(
    'matchup',
    controller.get().revision,
    () => eligible,
  );
  expect(taken.ok).toBe(true);
  expect(opening).toHaveBeenCalledExactlyOnceWith(controller.get().introRevision, 'de_dust2');
});

it('does not replace a deleted original scene by a same-name scene or discard the return record', async () => {
  const f = await rig();
  const managed = await f.bind();
  await managed.prepareManagedCollection!(true, managed);
  f.scenes.set('个人', ['replacement-uuid']);
  await expect((await f.bind()).restoreManagedCollection!()).rejects.toThrow('原节目场景已不存在');
  expect(await f.store.managedResources.hasPendingReturn()).toBe(true);
  expect(f.writes).not.toContain('SetCurrentProgramScene');
});

it('production finish restores the original program and retries the website handoff automatically', async () => {
  const f = await rig();
  const managed = await f.bind();
  await managed.prepareManagedCollection!(true, managed);
  const adapter = new ObsAdapter(f.store, 'http://127.0.0.1:3000');
  cleanups.push(() => adapter.close());
  let obsCurrent = true;
  const clearStats = vi.fn();
  const production = createProduction({
    scenes: {
      get: () => ({ active: 'waiting', revision: 'scene' }),
      holdAutomatic: () => {},
      controlValid: () => () => obsCurrent,
      selectWaitingForExit: async () => ({ ok: true }),
      setResourceActivationPending: () => {},
    } as unknown as ProductionDependencies['scenes'],
    obs: adapter,
    music: () => undefined,
    camera: () => undefined,
    demo: () => undefined,
    observer: { endProduction: () => {} } as ProductionDependencies['observer'],
    binding: () => undefined,
    waitForBroadcast: async () => {},
    source: {
      handoffForExit: async () => {
        throw new Error('rivalhub_source_capture_unconfirmed');
      },
      retryExitHandoffs: async () => {},
      clearStats,
    } as unknown as ProductionDependencies['source'],
    obsExit: { previousUnconfirmed: false, record: async () => {}, wait: async () => {} },
    warn: () => {},
    error: () => {},
  });
  cleanups.push(async () => {
    production.stopHandoffRecovery();
    vi.useRealTimers();
  });
  const entered = await production.change({
    action: 'enter',
    expectedRevision: production.get().revision,
    preparationId: null,
  });
  expect(entered.ok).toBe(true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const finish = {
    action: 'finish' as const,
    expectedRevision: production.get().revision,
    preparationId: null,
  };
  const [finished, repeated] = await Promise.all([
    production.change(finish),
    production.change(finish),
  ]);
  expect(finished.ok).toBe(true);
  expect(repeated).toEqual(finished);
  expect(production.get().mode).toBe('preparation');
  expect(production.get().releaseHandoffState).toBe('unconfirmed');
  expect(await production.change(finish)).toEqual({ ok: true, value: production.get() });
  expect(clearStats).toHaveBeenCalledTimes(1);
  expect(await production.waitForObsExit()).toBe('confirmed');
  expect(f.state.collection).toBe('个人');
  expect(f.state.scene).toBe('personal-program');
  obsCurrent = false;
  expect(production.get().obsExitState).toBe('confirmed');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(production.get().releaseHandoffState).toBe('recorded');
  vi.useRealTimers();
  expect(
    await production.change({
      action: 'enter',
      expectedRevision: production.get().revision,
      preparationId: null,
    }),
  ).toMatchObject({ ok: true });
  expect(await production.change(finish)).toMatchObject({
    ok: false,
    failure: 'productionConflict',
  });
  expect(production.get().mode).toBe('live');
});

async function seedManagedScenes(
  f: Awaited<ReturnType<typeof rig>>,
  extraRoles: Record<string, { uuid: string; kind: string }>,
) {
  const desired = obsDesiredScenes('http://127.0.0.1:3000');
  f.scenes.set(
    OBS_COLLECTION,
    desired.map((s) => s.sceneName),
  );
  f.state.scene = desired[0]!.sceneName;
  const { readFile, writeFile } = await import('node:fs/promises');
  const raw = JSON.parse(await readFile(f.path + '.collection.json', 'utf8')) as {
    roles: Record<string, { uuid: string; kind: string }>;
  }[];
  Object.assign(raw[0]!.roles, extraRoles);
  for (const s of desired) raw[0]!.roles[s.sceneName] = { uuid: s.sceneName, kind: 'scene' };
  await writeFile(f.path + '.collection.json', JSON.stringify(raw));
  return desired;
}

it('syncs managed microphone across all scenes on OBS SceneItemEnableStateChanged without echo loops', async () => {
  const f = await rig();
  const managed = await f.bind();
  await managed.prepareManagedCollection!(true, managed);
  const micUuid = 'mic-uuid-live';
  const desired = await seedManagedScenes(f, {
    麦克风: { uuid: micUuid, kind: 'wasapi_input_capture' },
  });
  f.state.inputs = [{ inputUuid: micUuid, inputName: '麦克风', inputKind: 'wasapi_input_capture' }];
  for (const s of desired) {
    f.state.sceneItems.set(s.sceneName, [
      { sceneItemId: 6, sourceUuid: micUuid, sourceName: '麦克风', sceneItemEnabled: false },
    ]);
  }

  const adapter = new ObsAdapter(f.store, 'http://127.0.0.1:3000');
  cleanups.push(() => adapter.close());
  let configChanges = 0;
  adapter.onConfigurationChanged(() => {
    configChanges++;
  });
  await adapter.outputStatus(false);
  const beforeCheck = configChanges;
  await adapter.check();
  expect(configChanges).toBe(beforeCheck);
  f.writes.length = 0;

  f.state.sceneItems.get('比赛中')![0]!.sceneItemEnabled = true;
  f.notify('SceneItemEnableStateChanged', {
    sceneName: '比赛中',
    sceneItemId: 6,
    sceneItemEnabled: true,
  });

  await vi.waitFor(() => {
    for (const s of desired) {
      expect(f.state.sceneItems.get(s.sceneName)![0]!.sceneItemEnabled).toBe(true);
    }
  });
  expect(f.writes.filter((w) => w === 'SetSceneItemEnabled')).toHaveLength(desired.length - 1);
});

it('returns structured preview reasons, deduplicates preview diagnostics, and wakes browser recovery when output stops', async () => {
  const f = await rig();
  const managed = await f.bind();
  f.state.output = true;
  const desired = obsDesiredScenes('http://127.0.0.1:3000');
  f.state.output = false;
  await managed.prepareManagedCollection!(true, managed);
  await seedManagedScenes(
    f,
    Object.fromEntries(
      desired.map((s) => [
        s.browserInput,
        { uuid: `uuid-${s.browserInput}`, kind: 'browser_source' },
      ]),
    ),
  );
  f.state.inputs = desired.map((s) => ({
    inputUuid: `uuid-${s.browserInput}`,
    inputName: s.browserInput,
    inputKind: 'browser_source',
  }));
  for (const s of desired) {
    f.state.inputSettings.set(`uuid-${s.browserInput}`, {
      url: s.browserUrl,
      width: 1920,
      height: 1080,
    });
    f.state.sceneItems.set(s.sceneName, [
      {
        sceneItemId: 1,
        sourceUuid: `uuid-${s.browserInput}`,
        sourceName: s.browserInput,
        sceneItemEnabled: true,
      },
    ]);
  }
  f.state.output = true;
  const diagnostics: string[] = [];
  const adapter = new ObsAdapter(f.store, 'http://127.0.0.1:3000', (stage) =>
    diagnostics.push(stage),
  );
  cleanups.push(() => adapter.close());
  // Browser recovery stays silent while output status is unknown, and never calls PressInputPropertiesButton.
  adapter.startBrowserRecovery(() => true);
  await new Promise((r) => setTimeout(r, 30));
  expect(f.state.calls).not.toContain('PressInputPropertiesButton');
  expect(diagnostics.filter((d) => d === 'obs_browser_recovery')).toEqual([]);
  await adapter.outputStatus(false);

  // Browser recovery stays silent while streaming and wakes when stream stops.
  f.state.calls.length = 0;
  adapter.startBrowserRecovery(() => true);
  await new Promise((r) => setTimeout(r, 50));
  expect(f.state.calls).not.toContain('PressInputPropertiesButton');
  expect(diagnostics.filter((d) => d === 'obs_browser_recovery')).toEqual([]);

  f.state.output = false;
  f.notify('StreamStateChanged', {
    outputActive: false,
    outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
  });
  f.notify('RecordStateChanged', {
    outputActive: false,
    outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
  });
  f.notify('ReplayBufferStateChanged', {
    outputActive: false,
    outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
  });
  f.notify('VirtualcamStateChanged', {
    outputActive: false,
    outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
  });
  await vi.waitFor(() => {
    expect(f.state.calls).toContain('PressInputPropertiesButton');
  });

  // Unknown extra output stays silent, then wakes browser recovery via refresh() readback with zero OBS events.
  f.state.failVirtualCamStatus = true;
  const readbackAdapter = new ObsAdapter(f.store, 'http://127.0.0.1:3000');
  cleanups.push(() => readbackAdapter.close());
  await readbackAdapter.outputStatus(false);
  f.state.calls.length = 0;
  readbackAdapter.startBrowserRecovery(() => true);
  await new Promise((r) => setTimeout(r, 30));
  expect(f.state.calls).not.toContain('PressInputPropertiesButton');
  f.state.failVirtualCamStatus = false;
  await readbackAdapter.outputStatus(false);
  await vi.waitFor(() => {
    expect(f.state.calls).toContain('PressInputPropertiesButton');
  });
  await readbackAdapter.close();

  // Preview reports structured reasons and deduplicates repeated failures.
  expect((await adapter.confidencePreview()).preview?.scene).toBe('赛前等待');
  f.state.nextSceneOnScreenshot = '比赛中';
  expect(await adapter.confidencePreview()).toEqual({ preview: null, reason: 'scene_changing' });
  await f.server.close();
  expect(await adapter.confidencePreview()).toEqual({ preview: null, reason: 'disconnected' });
  expect(await adapter.confidencePreview()).toEqual({ preview: null, reason: 'disconnected' });
  expect(diagnostics.filter((s) => s === 'obs_confidence_preview')).toHaveLength(1);
});
