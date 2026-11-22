import { afterEach, expect, it, vi } from 'vitest';
vi.mock('obs-websocket-js', async () => await import('obs-websocket-js/json'));
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsAdapter } from '../src/obs/adapter.js';
import { ensureManagedAudioSources, syncManagedMicrophoneAcrossScenes } from '../src/obs/audio.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function createManagedSceneRig(initial: {
  collection?: string;
  activeScene?: string;
  micEnabledByScene?: Record<string, boolean>;
  includePersonalScene?: boolean;
}) {
  const desired = obsDesiredScenes('http://127.0.0.1:3000');
  const micUuid = 'mic-uuid-1';
  const desktopUuid = 'desktop-uuid-1';
  const personalUuid = 'personal-mic-uuid';
  const state = {
    collection: initial.collection ?? OBS_COLLECTION,
    activeScene: initial.activeScene ?? '比赛中',
    muteByInput: new Map<string, boolean>([
      [micUuid, false],
      [desktopUuid, false],
    ]),
    volumeByInput: new Map<string, number>([
      [micUuid, 0.85],
      [desktopUuid, 1],
    ]),
    sceneItems: new Map<
      string,
      { sceneItemId: number; sourceUuid: string; sourceName: string; sceneItemEnabled: boolean }[]
    >(),
  };
  for (const scene of desired) {
    state.sceneItems.set(scene.sceneName, [
      {
        sceneItemId: 1,
        sourceUuid: desktopUuid,
        sourceName: '桌面声音',
        sceneItemEnabled: true,
      },
      {
        sceneItemId: 6,
        sourceUuid: micUuid,
        sourceName: '麦克风',
        sceneItemEnabled: initial.micEnabledByScene?.[scene.sceneName] ?? false,
      },
      {
        sceneItemId: 7,
        sourceUuid: 'game-capture-uuid',
        sourceName: '游戏画面',
        sceneItemEnabled: true,
      },
    ]);
  }
  if (initial.includePersonalScene) {
    state.sceneItems.set('个人场景', [
      {
        sceneItemId: 10,
        sourceUuid: personalUuid,
        sourceName: '个人麦',
        sceneItemEnabled: false,
      },
    ]);
  }
  const setCalls: { sceneName: string; sceneItemId: number; sceneItemEnabled: boolean }[] = [];
  const otherWrites: string[] = [];
  const rpc: ObsRpc = {
    managedInputIdentity: async (name) =>
      name === '麦克风' ? { uuid: micUuid, kind: 'wasapi_input_capture' } : null,
    call: async (type, data) => {
      if (type === 'GetSceneCollectionList')
        return {
          currentSceneCollectionName: state.collection,
          sceneCollections: [OBS_COLLECTION, '个人'],
        };
      if (type === 'GetCurrentProgramScene') return { currentProgramSceneName: state.activeScene };
      if (type === 'GetInputList')
        return {
          inputs: [
            { inputName: '桌面声音', inputKind: 'wasapi_output_capture', inputUuid: desktopUuid },
            { inputName: '麦克风', inputKind: 'wasapi_input_capture', inputUuid: micUuid },
          ],
        };
      if (type === 'GetSceneItemList')
        return { sceneItems: state.sceneItems.get(String(data?.sceneName)) ?? [] };
      if (type === 'SetSceneItemEnabled') {
        const sceneName = String(data?.sceneName);
        const sceneItemId = Number(data?.sceneItemId);
        const sceneItemEnabled = Boolean(data?.sceneItemEnabled);
        setCalls.push({ sceneName, sceneItemId, sceneItemEnabled });
        const list = state.sceneItems.get(sceneName) ?? [];
        const found = list.find((item) => item.sceneItemId === sceneItemId);
        if (found) found.sceneItemEnabled = sceneItemEnabled;
        return {};
      }
      if (/^(Set|Create|Remove)/.test(type)) otherWrites.push(type);
      return {};
    },
  };
  return { desired, micUuid, state, setCalls, otherWrites, rpc };
}

it('propagates microphone enable/disable across all managed scenes without touching non-managed targets or mixer state', async () => {
  const rig = createManagedSceneRig({
    activeScene: '比赛中',
    micEnabledByScene: { 比赛中: true },
    includePersonalScene: true,
  });

  // 1. User enables mic in '比赛中' -> all managed scenes (半场, 图间, etc.) become enabled; personal scene stays false.
  await syncManagedMicrophoneAcrossScenes(rig.rpc, 'http://127.0.0.1:3000', {
    sceneName: '比赛中',
    sceneItemId: 6,
    enabled: true,
  });
  for (const scene of rig.desired) {
    const mic = rig.state.sceneItems
      .get(scene.sceneName)!
      .find((item) => item.sourceUuid === rig.micUuid)!;
    expect(mic.sceneItemEnabled).toBe(true);
  }
  expect(rig.state.sceneItems.get('个人场景')![0]!.sceneItemEnabled).toBe(false);
  expect(rig.otherWrites).toEqual([]);
  expect(rig.state.muteByInput.get(rig.micUuid)).toBe(false);
  expect(rig.state.volumeByInput.get(rig.micUuid)).toBe(0.85);

  // 2. User disables mic in '图间' -> all managed scenes become disabled.
  rig.state.sceneItems
    .get('图间')!
    .find((item) => item.sourceUuid === rig.micUuid)!.sceneItemEnabled = false;
  await syncManagedMicrophoneAcrossScenes(rig.rpc, 'http://127.0.0.1:3000', {
    sceneName: '图间',
    sceneItemId: 6,
    enabled: false,
  });
  for (const scene of rig.desired) {
    const mic = rig.state.sceneItems
      .get(scene.sceneName)!
      .find((item) => item.sourceUuid === rig.micUuid)!;
    expect(mic.sceneItemEnabled).toBe(false);
  }

  // 3. Toggling a non-microphone item ('游戏画面', id=7) does not touch microphone items.
  const callsBefore = rig.setCalls.length;
  await syncManagedMicrophoneAcrossScenes(rig.rpc, 'http://127.0.0.1:3000', {
    sceneName: '比赛中',
    sceneItemId: 7,
    enabled: false,
  });
  expect(rig.setCalls.length).toBe(callsBefore);

  // 4. Non-Mizar collection is completely untouched.
  rig.state.collection = '个人';
  await expect(
    syncManagedMicrophoneAcrossScenes(rig.rpc, 'http://127.0.0.1:3000', {
      sceneName: '比赛中',
      sceneItemId: 6,
      enabled: true,
    }),
  ).resolves.toBeNull();
  expect(rig.setCalls.length).toBe(callsBefore);
});

it('reconciles mismatched scenes toward the active scene and preserves active scene disabled choice in ensureManagedAudioSources', async () => {
  // Active scene '比赛中' has mic disabled while '赛前等待' still had it enabled -> active scene wins.
  const rig = createManagedSceneRig({
    activeScene: '比赛中',
    micEnabledByScene: { 赛前等待: true, 比赛中: false },
  });
  await ensureManagedAudioSources(rig.rpc, 'http://127.0.0.1:3000', false);
  for (const scene of rig.desired) {
    const mic = rig.state.sceneItems
      .get(scene.sceneName)!
      .find((item) => item.sourceUuid === rig.micUuid)!;
    expect(mic.sceneItemEnabled).toBe(false);
  }

  // Reconcile on connect when active scene '对阵' has mic enabled and other scenes were disabled -> enables all.
  rig.state.activeScene = '对阵';
  rig.state.sceneItems
    .get('对阵')!
    .find((item) => item.sourceUuid === rig.micUuid)!.sceneItemEnabled = true;
  await syncManagedMicrophoneAcrossScenes(rig.rpc, 'http://127.0.0.1:3000');
  for (const scene of rig.desired) {
    const mic = rig.state.sceneItems
      .get(scene.sceneName)!
      .find((item) => item.sourceUuid === rig.micUuid)!;
    expect(mic.sceneItemEnabled).toBe(true);
  }
  // Already consistent -> zero writes on repeated reconcile.
  const before = rig.setCalls.length;
  await syncManagedMicrophoneAcrossScenes(rig.rpc, 'http://127.0.0.1:3000');
  expect(rig.setCalls.length).toBe(before);
});

it('syncs across scenes on live OBS SceneItemEnableStateChanged events without echoing its own writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-mic-ws-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const desired = obsDesiredScenes('http://127.0.0.1:3000');
  const micUuid = 'mic-uuid-live';
  const desktopUuid = 'desktop-uuid-live';
  const instance = '11111111-1111-4111-8111-111111111111';
  const collectionIdentity = '22222222-2222-4222-8222-222222222222';
  const sceneItems = new Map<
    string,
    { sceneItemId: number; sourceUuid: string; sourceName: string; sceneItemEnabled: boolean }[]
  >();
  for (const scene of desired) {
    sceneItems.set(scene.sceneName, [
      { sceneItemId: 1, sourceUuid: desktopUuid, sourceName: '桌面声音', sceneItemEnabled: true },
      { sceneItemId: 6, sourceUuid: micUuid, sourceName: '麦克风', sceneItemEnabled: false },
    ]);
  }
  const setEvents: { sceneName: string; sceneItemEnabled: boolean }[] = [];
  let notify: (eventType: string, eventData: object) => void = () => {};
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
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as {
        op: number;
        d: { requestType?: string; requestId?: string; requestData?: Record<string, unknown> };
      };
      if (msg.op === 1) {
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (msg.op !== 6) return;
      const type = msg.d.requestType!;
      const data = msg.d.requestData ?? {};
      let responseData: Record<string, unknown> = {};
      if (
        type === 'GetStreamStatus' ||
        type === 'GetRecordStatus' ||
        type === 'GetReplayBufferStatus' ||
        type === 'GetVirtualCamStatus'
      )
        responseData = { outputActive: false };
      else if (type === 'GetSceneCollectionList')
        responseData = {
          currentSceneCollectionName: OBS_COLLECTION,
          sceneCollections: [OBS_COLLECTION],
        };
      else if (type === 'GetCurrentProgramScene')
        responseData = {
          currentProgramSceneUuid: 'scene-uuid-0',
          currentProgramSceneName: '比赛中',
        };
      else if (type === 'GetPersistentData') responseData = { slotValue: instance };
      else if (type === 'GetSceneList')
        responseData = {
          scenes: desired.map((s, i) => ({ sceneUuid: `scene-uuid-${i}`, sceneName: s.sceneName })),
        };
      else if (type === 'GetInputList')
        responseData = {
          inputs: [
            { inputUuid: desktopUuid, inputName: '桌面声音', inputKind: 'wasapi_output_capture' },
            { inputUuid: micUuid, inputName: '麦克风', inputKind: 'wasapi_input_capture' },
          ],
        };
      else if (type === 'GetSceneItemList') {
        const sceneName =
          typeof data.sceneName === 'string'
            ? data.sceneName
            : typeof data.sceneUuid === 'string' && data.sceneUuid.startsWith('scene-uuid-')
              ? desired[Number(data.sceneUuid.slice('scene-uuid-'.length))]?.sceneName
              : undefined;
        responseData = { sceneItems: sceneName ? (sceneItems.get(sceneName) ?? []) : [] };
      } else if (type === 'SetSceneItemEnabled') {
        const sceneName =
          typeof data.sceneName === 'string'
            ? data.sceneName
            : typeof data.sceneUuid === 'string' && data.sceneUuid.startsWith('scene-uuid-')
              ? desired[Number(data.sceneUuid.slice('scene-uuid-'.length))]!.sceneName
              : String(data.sceneName);
        const sceneItemId = Number(data.sceneItemId);
        const sceneItemEnabled = Boolean(data.sceneItemEnabled);
        setEvents.push({ sceneName, sceneItemEnabled });
        const found = sceneItems.get(sceneName)?.find((item) => item.sceneItemId === sceneItemId);
        if (found) found.sceneItemEnabled = sceneItemEnabled;
        notify('SceneItemEnableStateChanged', { sceneName, sceneItemId, sceneItemEnabled });
      }
      socket.send(
        JSON.stringify({
          op: 7,
          d: {
            requestType: type,
            requestId: msg.d.requestId,
            requestStatus: { result: true, code: 100 },
            responseData,
          },
        }),
      );
    });
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => server.close());
  const port = (server.server.address() as { port: number }).port;
  const endpoint = `ws://127.0.0.1:${port}`;

  const configStore = new ObsConfigStore(join(dir, 'obs.json'));
  await configStore.save({ executablePath: null, host: '127.0.0.1', port, password: '' });
  // Seed managed resource ownership for the mock collection.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    join(dir, 'obs.json.collection.json'),
    JSON.stringify([
      {
        endpoint,
        instance,
        collectionIdentity,
        roles: {
          麦克风: { uuid: micUuid, kind: 'wasapi_input_capture' },
          桌面声音: { uuid: desktopUuid, kind: 'wasapi_output_capture' },
          ...Object.fromEntries(
            desired.map((s, i) => [s.sceneName, { uuid: `scene-uuid-${i}`, kind: 'scene' }]),
          ),
        },
        creating: false,
        creationSent: false,
      },
    ]),
  );
  const adapter = new ObsAdapter(configStore, 'http://127.0.0.1:3000');
  cleanups.push(() => adapter.close());

  await adapter.outputStatus(false);

  // Simulate user clicking the eye icon on '比赛中' -> enabled in OBS.
  sceneItems.get('比赛中')!.find((i) => i.sourceUuid === micUuid)!.sceneItemEnabled = true;
  notify('SceneItemEnableStateChanged', {
    sceneName: '比赛中',
    sceneItemId: 6,
    sceneItemEnabled: true,
  });

  await vi.waitFor(() => {
    for (const scene of desired) {
      const mic = sceneItems.get(scene.sceneName)!.find((i) => i.sourceUuid === micUuid)!;
      expect(mic.sceneItemEnabled).toBe(true);
    }
  });
  // Exactly the other 7 scenes should have been written once each (no echo loop).
  expect(setEvents).toHaveLength(desired.length - 1);
});
