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
        const responseData = await rpc.call(message.d.requestType, message.d.requestData);
        socket.send(
          JSON.stringify({
            op: 7,
            d: {
              requestType: message.d.requestType,
              requestId: message.d.requestId,
              requestStatus: { result: true, code: 100 },
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
