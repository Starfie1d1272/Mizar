import { afterEach, expect, it, vi } from 'vitest';
vi.mock('obs-websocket-js', async () => await import('obs-websocket-js/json'));
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsAdapter } from '../src/obs/adapter.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { obsDesiredScenes } from '../src/obs/desired-state.js';

const base = 'http://127.0.0.1:3000';
const scenes = obsDesiredScenes(base);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function rig(blockSettings = false) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-obs-recovery-'));
  const server = Fastify();
  await server.register(websocket);
  const calls: { type: string; data: Record<string, unknown> }[] = [];
  let release!: () => void;
  let reached!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let currentCollection = 'Mizar';
  let notifyScene: (() => void) | undefined;
  server.get('/', { websocket: true }, (socket) => {
    notifyScene = () =>
      socket.send(
        JSON.stringify({
          op: 5,
          d: {
            eventType: 'CurrentProgramSceneChanged',
            eventIntent: 4,
            eventData: { sceneName: 'Personal' },
          },
        }),
      );
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.6.3', rpcVersion: 1 } }));
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as {
        op: number;
        d: { requestType: string; requestId: string; requestData: Record<string, unknown> };
      };
      if (request.op === 1) socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      if (request.op !== 6) return;
      void (async () => {
        const type = request.d.requestType;
        calls.push({ type, data: request.d.requestData });
        if (type === 'GetInputSettings' && blockSettings) {
          reached();
          await blocked;
        }
        const responseData =
          type === 'GetSceneCollectionList'
            ? { currentSceneCollectionName: currentCollection }
            : type === 'GetInputList'
              ? {
                  inputs: [
                    ...scenes.map((scene, index) => ({
                      inputName: scene.browserInput,
                      inputKind: 'browser_source',
                      inputUuid: `owned-${index}`,
                    })),
                    { inputName: 'Personal', inputKind: 'browser_source', inputUuid: 'personal' },
                  ],
                }
              : type === 'GetInputSettings'
                ? {
                    inputSettings: {
                      url: scenes.find(
                        (_, index) => `owned-${index}` === request.d.requestData?.inputUuid,
                      )?.browserUrl,
                    },
                  }
                : {};
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
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const config = new ObsConfigStore(join(dir, 'obs.json'));
  await config.save({ host: '127.0.0.1', port: address.port, password: '', executablePath: null });
  const adapter = new ObsAdapter(config, base);
  cleanups.push(async () => {
    release();
    await adapter.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    adapter,
    calls,
    waiting,
    release,
    notifyScene: () => notifyScene?.(),
    setCollection: (name: string) => {
      currentCollection = name;
    },
  };
}

it('refreshes an existing owned browser source on enter without granting scene/audio preparation', async () => {
  const r = await rig();
  r.adapter.startBrowserRecovery();
  await r.adapter.settleAutomatic();
  expect(r.adapter.hasCurrentPreparation()).toBe(false);
  expect(
    r.calls
      .filter((call) => call.type === 'PressInputPropertiesButton')
      .map((call) => call.data.inputUuid),
  ).toEqual(scenes.map((_, index) => `owned-${index}`));
  expect(
    r.calls.every(
      (call) => call.type.startsWith('Get') || call.type === 'PressInputPropertiesButton',
    ),
  ).toBe(true);
  r.adapter.pauseAutomatic();
  r.adapter.resumeAutomatic();
  r.adapter.startBrowserRecovery();
  await r.adapter.settleAutomatic();
  expect(r.calls.filter((call) => call.type === 'PressInputPropertiesButton')).toHaveLength(
    scenes.length,
  );
});

it('revokes an in-flight refresh when the OBS scene changes externally', async () => {
  const r = await rig(true);
  r.adapter.startBrowserRecovery();
  await r.waiting;
  r.notifyScene();
  await new Promise((resolve) => setTimeout(resolve, 25));
  r.release();
  await r.adapter.settleAutomatic();
  expect(r.calls.some((call) => call.type === 'PressInputPropertiesButton')).toBe(false);
});

it('revokes a pending refresh on exit and refuses a personal collection', async () => {
  const r = await rig(true);
  r.adapter.startBrowserRecovery();
  await r.waiting;
  r.adapter.pauseAutomatic();
  r.release();
  await r.adapter.settleAutomatic();
  expect(r.calls.some((call) => call.type === 'PressInputPropertiesButton')).toBe(false);
  r.setCollection('Personal');
  r.adapter.resumeAutomatic();
  r.adapter.startBrowserRecovery();
  await r.adapter.settleAutomatic();
  expect(r.calls.some((call) => call.type === 'PressInputPropertiesButton')).toBe(false);
});
