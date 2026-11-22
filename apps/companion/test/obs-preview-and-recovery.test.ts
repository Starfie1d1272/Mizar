import { afterEach, expect, it, vi } from 'vitest';
vi.mock('obs-websocket-js', async () => await import('obs-websocket-js/json'));
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsAdapter } from '../src/obs/adapter.js';
import { checkObsAudio } from '../src/obs/audio.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';
import type { ObsRpc } from '../src/obs/reconcile.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function rig(options: { outputActive?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-preview-recovery-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'obs.json');
  const desired = obsDesiredScenes('http://127.0.0.1:3000');
  let outputActive = options.outputActive ?? false;
  let currentCollection = options.outputActive ? '个人' : OBS_COLLECTION;
  const collections = new Set([currentCollection]);
  let currentScene = desired[0]!.sceneName;
  let changeSceneDuringScreenshot = false;
  const calls: string[] = [];
  const sockets = new Set<{ send(data: string): void }>();
  const notify = (eventType: string, eventData: object) => {
    for (const socket of sockets)
      socket.send(JSON.stringify({ op: 5, d: { eventType, eventData, eventIntent: 1023 } }));
  };

  let marker: unknown;
  const rpc: ObsRpc = {
    call: async (type, data) => {
      calls.push(type);
      if (type === 'GetVersion') return { obsVersion: '33.0.1' };
      if (type === 'GetStreamStatus') return { outputActive };
      if (
        type === 'GetRecordStatus' ||
        type === 'GetReplayBufferStatus' ||
        type === 'GetVirtualCamStatus'
      )
        return { outputActive: false };
      if (type === 'GetOutputList') {
        return {
          outputs: [
            {
              outputName: '直播',
              outputActive,
              outputFlags: { OBS_OUTPUT_VIDEO: true },
            },
          ],
        };
      }
      if (type === 'GetPersistentData') return { slotValue: marker };
      if (type === 'SetPersistentData') {
        marker = data?.slotValue;
        return {};
      }
      if (type === 'CreateSceneCollection' || type === 'SetCurrentSceneCollection') {
        currentCollection = String(data?.sceneCollectionName ?? currentCollection);
        collections.add(currentCollection);
        return {};
      }
      if (type === 'CreateScene') return { sceneUuid: `scene-${data?.sceneName}` };
      if (type === 'CreateInput') return { inputUuid: `uuid-${data?.inputName}` };
      if (type === 'GetSceneCollectionList')
        return {
          currentSceneCollectionName: currentCollection,
          sceneCollections: [...collections],
        };
      if (type === 'GetCurrentProgramScene')
        return { currentProgramSceneName: currentScene, currentProgramSceneUuid: 'scene-waiting' };
      if (type === 'GetSceneList')
        return {
          scenes:
            currentCollection === OBS_COLLECTION
              ? desired.map((s) => ({ sceneName: s.sceneName, sceneUuid: `scene-${s.sceneName}` }))
              : [{ sceneName: '个人', sceneUuid: 'personal-scene' }],
        };
      if (type === 'GetSceneItemList') {
        const match =
          currentCollection === OBS_COLLECTION
            ? desired.find((s) => s.sceneName === data?.sceneName)
            : undefined;
        return {
          sceneItems: match
            ? [
                {
                  sourceName: match.browserInput,
                  sourceUuid: `uuid-${match.browserInput}`,
                  sceneItemId: 1,
                  sceneItemEnabled: true,
                },
              ]
            : [],
        };
      }
      if (type === 'GetInputList') {
        return {
          inputs:
            currentCollection === OBS_COLLECTION
              ? desired.map((s) => ({
                  inputName: s.browserInput,
                  inputUuid: `uuid-${s.browserInput}`,
                  inputKind: 'browser_source',
                }))
              : [],
        };
      }
      if (type === 'GetInputSettings') {
        const match = desired.find((s) => `uuid-${s.browserInput}` === data?.inputUuid);
        return {
          inputSettings: {
            url: match?.browserUrl ?? desired[0]!.browserUrl,
            width: 1920,
            height: 1080,
          },
        };
      }
      if (type === 'GetSourceScreenshot') {
        if (changeSceneDuringScreenshot) currentScene = desired[1]!.sceneName;
        return { imageData: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' };
      }
      return {};
    },
  };

  const server = Fastify();
  await server.register(websocket);
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
  const managed = await store.managedResources.bind(rpc, endpoint, 'http://127.0.0.1:3000');
  return {
    store,
    server,
    calls,
    prepareCollection: async () => {
      const prev = outputActive;
      outputActive = false;
      await managed.prepareManagedCollection!(true, managed);
      outputActive = prev;
    },
    setChangeSceneDuringScreenshot: (v: boolean) => {
      changeSceneDuringScreenshot = v;
    },
    stopStream: () => {
      outputActive = false;
      notify('StreamStateChanged', {
        outputActive: false,
        outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
      });
    },
  };
}

it('returns structured preview reasons and deduplicates repeated diagnostics', async () => {
  const f = await rig();
  const diagnostics: string[] = [];
  const adapter = new ObsAdapter(f.store, 'http://127.0.0.1:3000', (stage) =>
    diagnostics.push(stage),
  );
  cleanups.push(() => adapter.close());

  const ok = await adapter.confidencePreview();
  expect(ok.preview?.scene).toBe('赛前等待');
  expect(ok.preview?.image).toContain('data:image/jpeg;base64,');

  f.setChangeSceneDuringScreenshot(true);
  const changing = await adapter.confidencePreview();
  expect(changing).toEqual({ preview: null, reason: 'scene_changing' });

  await f.server.close();
  const disconnected1 = await adapter.confidencePreview();
  const disconnected2 = await adapter.confidencePreview();
  expect(disconnected1).toEqual({ preview: null, reason: 'disconnected' });
  expect(disconnected2).toEqual({ preview: null, reason: 'disconnected' });
  expect(diagnostics.filter((s) => s === 'obs_confidence_preview')).toHaveLength(1);
});

it('waits silently while streaming is active and resumes browser recovery when stream stops', async () => {
  const f = await rig({ outputActive: true });
  await f.prepareCollection();
  const diagnostics: string[] = [];
  const adapter = new ObsAdapter(f.store, 'http://127.0.0.1:3000', (stage) =>
    diagnostics.push(stage),
  );
  cleanups.push(() => adapter.close());

  await adapter.outputStatus(false);
  f.calls.length = 0;

  adapter.startBrowserRecovery(() => true);
  await new Promise((r) => setTimeout(r, 50));
  expect(f.calls.filter((c) => c === 'PressInputPropertiesButton')).toEqual([]);
  expect(diagnostics.filter((d) => d === 'obs_browser_recovery')).toEqual([]);

  f.stopStream();
  await vi.waitFor(() => {
    expect(f.calls).toContain('PressInputPropertiesButton');
  });
});

it('returns structured scene_missing finding in checkObsAudio without probing missing scenes', async () => {
  const calls: string[] = [];
  const obs: ObsRpc = {
    call: async (type) => {
      calls.push(type);
      if (type === 'GetSpecialInputs') return {};
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: OBS_COLLECTION };
      if (type === 'GetSceneList') return { scenes: [{ sceneName: '比赛中' }] };
      if (type === 'GetInputList') return { inputs: [] };
      if (type === 'GetSceneItemList') throw new Error('600 missing scene');
      return {};
    },
  };
  const findings = await checkObsAudio(obs);
  expect(findings.some((f) => f.code === 'scene_missing' && f.scene === '赛前等待')).toBe(true);
  expect(calls).not.toContain('GetSceneItemList');
});
