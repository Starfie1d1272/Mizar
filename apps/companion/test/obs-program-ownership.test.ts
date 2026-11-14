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
import { OBS_COLLECTION } from '../src/obs/desired-state.js';
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
    marker: undefined as unknown,
  };
  const writes: string[] = [];
  let notify: (type: string, data: object) => void = () => {};
  const rpc: ObsRpc = {
    call: async (type, data) => {
      if (/^(Set|Create|Stop)/.test(type)) writes.push(type);
      if (type === 'GetVersion') {
        if (state.versionReadFailed) throw new Error('version unavailable');
        return { obsVersion: state.version };
      }
      if (type === 'GetVideoSettings') return { ...state.video };
      if (type === 'GetProfileList') return { currentProfileName: '个人' };
      if (type === 'SetVideoSettings') Object.assign(state.video, data);
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
      if (type === 'GetInputList') return { inputs: [] };
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
      return {};
    },
  };
  const server = Fastify();
  await server.register(websocket);
  const sockets = new Set<{ send(data: string): void }>();
  notify = (eventType, eventData) => {
    for (const socket of sockets)
      socket.send(JSON.stringify({ op: 5, d: { eventType, eventData, eventIntent: 4 } }));
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
  return { path, state, scenes, writes, bind, store };
}

it('reports unsupported or unknown OBS versions and blocks preparation before configuration writes', async () => {
  const f = await rig();
  const adapter = new ObsAdapter(f.store, 'http://127.0.0.1:3000');
  cleanups.push(() => adapter.close());
  for (const [version, code] of [
    ['30.2.3', 'obs_version_unsupported'],
    ['32.1.0', 'obs_version_unsupported'],
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
  expect((await adapter.status()).findings).toContainEqual({
    code: 'obs_version_unsupported',
    message: expect.stringContaining('OBS 33'),
  });
  f.state.version = '33.1.0';
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

it('does not replace a deleted original scene by a same-name scene or discard the return record', async () => {
  const f = await rig();
  const managed = await f.bind();
  await managed.prepareManagedCollection!(true, managed);
  f.scenes.set('个人', ['replacement-uuid']);
  await expect((await f.bind()).restoreManagedCollection!()).rejects.toThrow('原节目场景已不存在');
  expect(await f.store.managedResources.hasPendingReturn()).toBe(true);
  expect(f.writes).not.toContain('SetCurrentProgramScene');
});

it('production finish restores the original program after the independent website handoff', async () => {
  const f = await rig();
  const managed = await f.bind();
  await managed.prepareManagedCollection!(true, managed);
  const adapter = new ObsAdapter(f.store, 'http://127.0.0.1:3000');
  cleanups.push(() => adapter.close());
  const production = createProduction({
    scenes: {
      get: () => ({ active: 'waiting', revision: 'scene' }),
      holdAutomatic: () => {},
      controlValid: () => () => true,
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
      handoffForExit: async () => {},
      clearStats: () => {},
    } as unknown as ProductionDependencies['source'],
    obsExit: { previousUnconfirmed: false, record: async () => {}, wait: async () => {} },
    warn: () => {},
    error: () => {},
  });
  const entered = await production.change({
    action: 'enter',
    expectedRevision: production.get().revision,
    preparationId: null,
  });
  expect(entered.ok).toBe(true);
  const finished = await production.change({
    action: 'finish',
    expectedRevision: production.get().revision,
    preparationId: null,
  });
  expect(finished.ok).toBe(true);
  expect(await production.waitForObsExit()).toBe('confirmed');
  expect(f.state.collection).toBe('个人');
  expect(f.state.scene).toBe('personal-program');
});
