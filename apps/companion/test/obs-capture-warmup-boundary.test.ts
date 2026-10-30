import { afterEach, expect, it, vi } from 'vitest';
vi.mock('obs-websocket-js', async () => await import('obs-websocket-js/json'));
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsAdapter } from '../src/obs/adapter.js';
import { ObsCaptureWarmup } from '../src/obs/capture-warmup.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { obsSceneName } from '../src/obs/desired-state.js';
import type { ObsNativeEvidence } from '../src/obs/native-evidence.js';
import { registerObsRoutes } from '../src/obs/routes.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const prep = '00000000-0000-4000-8000-000000000001';
const origin = 'http://127.0.0.1:3000';
async function rig(scenario: 'normal' | 'starting' | 'takeover' | 'cancel' = 'normal') {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-warmup-ws-'));
  const obsServer = Fastify();
  await obsServer.register(websocket);
  const clients = new Set<{ send: (data: string) => void }>();
  const calls: string[] = [];
  let valid = true;
  let item: {
    sceneItemId: number;
    sourceUuid: string;
    sourceName: string;
    sceneItemEnabled: boolean;
  } | null = null;
  let geometry: Record<string, unknown> = {
    boundsType: 'OBS_BOUNDS_NONE',
    scaleX: 1,
    scaleY: 1,
    positionX: 0,
    positionY: 0,
    rotation: 0,
    width: 1920,
    height: 1080,
  };
  let diagnosticFailure = false;
  const notify = (eventType: string, eventData: unknown, eventIntent: number) => {
    for (const socket of clients)
      socket.send(JSON.stringify({ op: 5, d: { eventType, eventIntent, eventData } }));
  };
  obsServer.get('/', { websocket: true }, (socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.6.3', rpcVersion: 1 } }));
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as {
        op: number;
        d: { requestType: string; requestId: string; requestData: Record<string, unknown> };
      };
      if (request.op === 1) {
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (request.op !== 6) return;
      void (async () => {
        const type = request.d.requestType;
        const data = request.d.requestData ?? {};
        calls.push(type);
        let responseData: Record<string, unknown> = {};
        if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
          responseData = { outputActive: false };
        else if (type === 'GetOutputList') responseData = { outputs: [] };
        else if (type === 'GetSceneCollectionList')
          responseData = { currentSceneCollectionName: 'Mizar' };
        else if (type === 'GetSceneList')
          responseData = {
            currentProgramSceneName: obsSceneName('waiting'),
            scenes: [{ sceneName: obsSceneName('waiting'), sceneUuid: 'waiting-uuid' }],
          };
        else if (type === 'GetInputList')
          responseData = {
            inputs: [
              { inputName: '游戏画面', inputKind: 'game_capture', inputUuid: 'capture-uuid' },
            ],
          };
        else if (type === 'GetInputSettings')
          responseData = {
            inputSettings: {
              capture_audio: false,
              capture_mode: 'window',
              window: 'Counter-Strike 2:SDL_app:cs2.exe',
            },
          };
        else if (type === 'GetInputPropertiesListPropertyItems')
          responseData = {
            propertyItems: [{ itemValue: 'Counter-Strike 2:SDL_app:cs2.exe', itemEnabled: true }],
          };
        else if (type === 'GetSourceActive')
          responseData = { videoShowing: item?.sceneItemEnabled === true };
        else if (type === 'GetSceneItemList')
          responseData = {
            sceneItems:
              data.sceneName === obsSceneName('gameplay')
                ? [{ sourceName: '游戏画面', sceneItemEnabled: true, sceneItemId: 7 }]
                : item
                  ? [item]
                  : [],
          };
        else if (type === 'GetSceneItemTransform')
          responseData = {
            sceneItemTransform:
              data.sceneName === obsSceneName('gameplay')
                ? { sourceWidth: 1920, sourceHeight: 1080 }
                : geometry,
          };
        else if (type === 'CreateSceneItem') {
          item = {
            sceneItemId: 17,
            sourceName: '游戏画面',
            sourceUuid: 'capture-uuid',
            sceneItemEnabled: false,
          };
          responseData = { sceneItemId: 17 };
        } else if (type === 'SetSceneItemTransform') {
          geometry = {
            ...(data.sceneItemTransform as Record<string, unknown>),
            width: 0,
            height: 0,
          };
          if (scenario === 'cancel') valid = false;
        } else if (type === 'SetSceneItemEnabled') {
          if (item) item.sceneItemEnabled = true;
          if (scenario === 'starting')
            notify(
              'StreamStateChanged',
              { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' },
              64,
            );
          if (scenario === 'takeover')
            notify('CurrentProgramSceneChanged', { sceneName: '用户场景' }, 4);
          if (scenario === 'starting' || scenario === 'takeover')
            await new Promise((resolve) => setTimeout(resolve, 50));
        } else if (type === 'RemoveSceneItem') item = null;
        socket.send(
          JSON.stringify({
            op: 7,
            d: {
              requestType: type,
              requestId: request.d.requestId,
              requestStatus: { result: true, code: 100 },
              responseData,
            },
          }),
        );
      })().catch(() => undefined);
    });
  });
  await obsServer.listen({ host: '127.0.0.1', port: 0 });
  const address = obsServer.server.address();
  if (!address || typeof address === 'string') throw new Error('missing port');
  const config = new ObsConfigStore(join(dir, 'obs.json'));
  await config.save({ host: '127.0.0.1', port: address.port, password: '', executablePath: null });
  const adapter = new ObsAdapter(
    config,
    origin,
    undefined,
    undefined,
    undefined,
    undefined,
    new ObsCaptureWarmup(join(dir, 'warmup.json')),
  );
  const app = Fastify();
  registerObsRoutes(app, {
    adapter,
    configStore: config,
    originPolicy: { mode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: [] },
    activeScene: () => 'waiting',
    preparationValid: (revision) => () => valid && revision === 'revision',
    readCaptureEvidence: async () =>
      diagnosticFailure
        ? ({
            collectionStatus: 'available',
            processes: [{ role: 'obs', pid: 42 }],
            roots: [
              {
                logs: [
                  {
                    processAssociation: 'time_correlated',
                    processPid: 42,
                    timestampStatus: 'ordered',
                    latestCaptureEvent: {
                      occurredAt: new Date().toISOString(),
                      outcome: 'failure',
                      source: 'mizar_capture',
                      reason: 'capture_failure',
                      code: null,
                    },
                  },
                ],
              },
            ],
          } as unknown as ObsNativeEvidence)
        : ({ collectionStatus: 'unsupported' } as ObsNativeEvidence),
  });
  cleanups.push(async () => {
    await app.close();
    await adapter.close();
    await obsServer.close();
    await rm(dir, { recursive: true, force: true });
  });
  const post = (path: string, payload: object) =>
    app.inject({ method: 'POST', url: `/operator/obs/${path}`, headers: { origin }, payload });
  return {
    post,
    calls,
    item: () => item,
    setFailure: () => {
      diagnosticFailure = true;
    },
    journal: () => readFile(join(dir, 'warmup.json'), 'utf8'),
  };
}

it('uses actual HTTP routes and OBS WebSocket for disabled → zero → enabled → capture → cleanup', async () => {
  const r = await rig();
  const begin = await r.post('capture-warmup', {
    expectedRevision: 'revision',
    preparationId: prep,
  });
  expect(begin.statusCode).toBe(200);
  const { transactionId, startedAt } = begin.json();
  expect(r.calls.indexOf('CreateSceneItem')).toBeLessThan(r.calls.indexOf('SetSceneItemTransform'));
  expect(r.calls.indexOf('SetSceneItemTransform')).toBeLessThan(
    r.calls.indexOf('SetSceneItemEnabled'),
  );
  const payload = { expectedRevision: 'revision', transactionId, since: startedAt };
  expect((await r.post('capture-initialization', payload)).json()).toMatchObject({
    state: 'initialized',
    captureDiagnostic: { state: 'unknown' },
  });
  r.setFailure();
  expect((await r.post('capture-initialization', payload)).json()).toMatchObject({
    state: 'failed',
    reason: 'hook_failed',
  });
  expect((await r.post('capture-warmup-release', { transactionId })).statusCode).toBe(200);
  expect(r.item()).toBeNull();
  expect((await r.post('capture-warmup-release', { transactionId })).statusCode).toBe(200);
});

it.each(['starting', 'takeover'] as const)(
  'keeps the recovery journal on %s instead of removing the item',
  async (scenario) => {
    const r = await rig(scenario);
    const result = await r.post('capture-warmup', {
      expectedRevision: 'revision',
      preparationId: prep,
    });
    expect(result.statusCode).toBe(409);
    expect(r.calls).not.toContain('RemoveSceneItem');
    expect(JSON.parse(await r.journal())).toMatchObject({ phase: 'enabling', itemId: 17 });
  },
);

it('cleans its disabled item when the preparation revision changes mid-transform', async () => {
  const r = await rig('cancel');
  const result = await r.post('capture-warmup', {
    expectedRevision: 'revision',
    preparationId: prep,
  });
  expect(result.statusCode).toBe(409);
  expect(r.calls).not.toContain('SetSceneItemEnabled');
  expect(r.item()).toBeNull();
});
