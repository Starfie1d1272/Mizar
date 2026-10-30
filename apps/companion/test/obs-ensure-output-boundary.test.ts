import { expect, it, vi } from 'vitest';
vi.mock('obs-websocket-js', async () => await import('obs-websocket-js/json'));
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsAdapter } from '../src/obs/adapter.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { RemoteCommentary } from '../src/obs/remote-commentary.js';
import { OBS_CAPTURE_INPUT, obsDesiredScenes, obsSceneName } from '../src/obs/desired-state.js';
import { registerObsRoutes } from '../src/obs/routes.js';
import { createLocalWebOriginPolicy } from '../src/local-web/origin-policy.js';

it.each([
  {
    preparedAudio: false,
    align: false,
    event: '',
    label: 'active output and default audio sources',
  },
  {
    preparedAudio: true,
    align: false,
    event: '',
    label: 'active output and automatic TeamSpeak probe',
  },
  {
    preparedAudio: true,
    align: true,
    event: '',
    label: 'idle output and an existing gameplay scene',
  },
  ...[
    'StreamStateChanged',
    'RecordStateChanged',
    'ReplayBufferStateChanged',
    'VirtualcamStateChanged',
  ].map((event) => ({ preparedAudio: true, align: true, event, label: `${event} STARTING` })),
  {
    preparedAudio: true,
    align: true,
    event: 'StreamStateChanged',
    late: true,
    label: 'stream STARTING immediately before the scene switch',
  },
  {
    preparedAudio: true,
    align: true,
    event: 'ReplayBufferStateChanged',
    transient: true,
    label: 'replay starting and stopping during preparation',
  },
  {
    preparedAudio: true,
    align: true,
    event: 'CurrentProgramSceneChanged',
    label: 'external scene takeover',
  },
  {
    preparedAudio: true,
    align: true,
    event: 'CurrentSceneCollectionChanging',
    label: 'external collection takeover',
  },
  { preparedAudio: true, align: true, event: 'ExitStarted', label: 'OBS exit' },
])('explicit ensure handles $label', async ({ preparedAudio, align, event, late, transient }) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-ensure-output-'));
  const server = Fastify();
  const app = Fastify();
  const baseUrl = 'http://127.0.0.1:3000';
  const desired = obsDesiredScenes(baseUrl);
  const requests: string[] = [];
  const unexpected: string[] = [];
  let currentScene = obsSceneName(align ? 'gameplay' : 'waiting');
  const sockets = new Set<{ send: (data: string) => void }>();
  let outputReads = 0;
  let waitForEvent: (eventType: string, transient: boolean) => Promise<void> = async () => {};
  await server.register(websocket);
  server.get('/', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.6.3', rpcVersion: 1 } }));
    socket.on('message', (raw) => {
      const packet = JSON.parse(raw.toString()) as {
        op: number;
        d: { requestType: string; requestId: string; requestData?: Record<string, unknown> };
      };
      if (packet.op === 1) {
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (packet.op !== 6) return;
      const { requestType: type, requestId, requestData = {} } = packet.d;
      requests.push(type);
      const scene = desired.find((item) => item.sceneName === requestData.sceneName);
      let responseData: Record<string, unknown> = {};
      switch (type) {
        case 'GetStreamStatus':
        case 'GetRecordStatus':
          responseData = { outputActive: false, outputPaused: false, outputReconnecting: false };
          break;
        case 'GetSceneCollectionList':
          responseData = { currentSceneCollectionName: 'Mizar', sceneCollections: ['Mizar'] };
          break;
        case 'GetSceneTransitionList':
          responseData = {
            transitions: [
              { transitionKind: 'fade_transition', transitionName: 'Fade' },
              { transitionKind: 'cut_transition', transitionName: 'Cut' },
            ],
          };
          break;
        case 'GetVideoSettings':
          responseData = {
            baseWidth: 1920,
            baseHeight: 1080,
            outputWidth: 1920,
            outputHeight: 1080,
            fpsNumerator: 60,
            fpsDenominator: 1,
          };
          break;
        case 'GetSceneList':
          responseData = {
            currentProgramSceneName: currentScene,
            scenes: desired.map((item) => ({ sceneName: item.sceneName })),
          };
          break;
        case 'GetCurrentProgramScene':
          responseData = { currentProgramSceneName: currentScene };
          break;
        case 'SetSceneSceneTransitionOverride':
          break;
        case 'SetCurrentProgramScene':
          currentScene = String(requestData.sceneName);
          break;
        case 'GetInputList':
          responseData = {
            inputs: [
              ...desired.map((item) => ({
                inputName: item.browserInput,
                inputKind: 'browser_source',
              })),
              { inputName: OBS_CAPTURE_INPUT, inputKind: 'game_capture' },
              ...(preparedAudio
                ? [
                    { inputName: '桌面声音', inputKind: 'wasapi_output_capture' },
                    { inputName: '麦克风', inputKind: 'wasapi_input_capture' },
                  ]
                : []),
            ],
          };
          break;
        case 'GetInputPropertiesListPropertyItems':
          responseData = { propertyItems: [] };
          break;
        case 'GetInputSettings': {
          const browser = desired.find((item) => item.browserInput === requestData.inputName);
          responseData = browser
            ? { inputSettings: { url: browser.browserUrl, width: 1920, height: 1080 } }
            : {
                inputSettings: {
                  capture_mode: 'window',
                  window: 'Counter-Strike 2:SDL_app:cs2.exe',
                  priority: 2,
                  capture_audio: false,
                },
              };
          break;
        }
        case 'GetSceneItemList':
          responseData = {
            sceneItems: [
              ...(scene?.sources ?? []).map((sourceName, index) => ({
                sourceName,
                sceneItemId: index + 1,
                sceneItemIndex: index,
                sceneItemEnabled: true,
              })),
              ...(preparedAudio
                ? [
                    { sourceName: '桌面声音', sceneItemId: 100, sceneItemEnabled: true },
                    { sourceName: '麦克风', sceneItemId: 101, sceneItemEnabled: true },
                  ]
                : []),
            ],
          };
          break;
        case 'GetSceneItemTransform': {
          const source = scene?.sources[Number(requestData.sceneItemId) - 1];
          responseData = {
            sceneItemTransform:
              source === OBS_CAPTURE_INPUT
                ? {
                    positionX: 0,
                    positionY: 0,
                    rotation: 0,
                    boundsType: 'OBS_BOUNDS_STRETCH',
                    boundsWidth: 1920,
                    boundsHeight: 1080,
                    cropLeft: 0,
                    cropRight: 0,
                    cropTop: 0,
                    cropBottom: 0,
                  }
                : {
                    positionX: 0,
                    positionY: 0,
                    rotation: 0,
                    scaleX: 1,
                    scaleY: 1,
                    boundsType: 'OBS_BOUNDS_NONE',
                    cropLeft: 0,
                    cropRight: 0,
                    cropTop: 0,
                    cropBottom: 0,
                  },
          };
          break;
        }
        case 'GetSpecialInputs':
          responseData = {};
          break;
        case 'GetInputMute':
          responseData = { inputMuted: false };
          break;
        case 'GetInputVolume':
          responseData = { inputVolumeMul: 1 };
          break;
        case 'GetInputAudioTracks':
          responseData = { inputAudioTracks: { 1: true } };
          break;
        case 'GetVersion':
          responseData = {
            availableRequests: [
              'CreateInput',
              'GetInputKindList',
              'GetInputPropertiesListPropertyItems',
            ],
          };
          break;
        case 'GetInputKindList':
          responseData = { inputKinds: ['wasapi_process_output_capture'] };
          break;
        case 'GetOutputList':
          responseData = {
            outputs: [
              {
                outputName: 'Plugin video',
                outputKind: 'plugin_output',
                outputWidth: 1920,
                outputHeight: 1080,
                outputActive: !align,
                outputFlags: {
                  OBS_OUTPUT_VIDEO: true,
                  OBS_OUTPUT_AUDIO: true,
                  OBS_OUTPUT_ENCODED: true,
                  OBS_OUTPUT_MULTI_TRACK: false,
                  OBS_OUTPUT_SERVICE: false,
                },
              },
            ],
          };
          break;
        default:
          unexpected.push(type);
      }
      const respond = () =>
        socket.send(
          JSON.stringify({
            op: 7,
            d: {
              requestType: type,
              requestId,
              requestStatus: { result: true, code: 100 },
              responseData,
            },
          }),
        );
      if (type === 'GetOutputList' && event && ++outputReads === (late ? 2 : 1)) {
        void waitForEvent(event, !!transient).then(respond);
      } else respond();
    });
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('address unavailable');
  const config = new ObsConfigStore(join(directory, 'obs.json'));
  await config.save({ host: '127.0.0.1', port: address.port, password: '', executablePath: null });
  const adapter = new ObsAdapter(
    config,
    baseUrl,
    undefined,
    undefined,
    preparedAudio && !align
      ? {
          owner: new RemoteCommentary(join(directory, 'commentary.json')),
          journal: join(directory, 'commentary-probe.json'),
        }
      : undefined,
  );
  waitForEvent = async (eventType, finish) => {
    const lease = await adapter.captureWarmupGuard();
    const emit = (eventData: Record<string, unknown>) => {
      for (const socket of sockets)
        socket.send(
          JSON.stringify({
            op: 5,
            d: {
              eventType,
              eventIntent:
                eventType === 'CurrentProgramSceneChanged'
                  ? 4
                  : eventType === 'CurrentSceneCollectionChanging'
                    ? 2
                    : eventType === 'ExitStarted'
                      ? 1
                      : 64,
              eventData,
            },
          }),
        );
    };
    if (eventType === 'CurrentProgramSceneChanged') {
      currentScene = '外部场景';
      emit({ sceneName: currentScene });
    } else if (eventType === 'CurrentSceneCollectionChanging') {
      emit({ sceneCollectionName: '外部集合' });
    } else if (eventType === 'ExitStarted') {
      emit({});
    } else emit({ outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' });
    await vi.waitFor(() => expect(lease()).toBe(false));
    if (finish) {
      emit({ outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED' });
      await vi.waitFor(async () => expect((await adapter.captureWarmupGuard())()).toBe(true));
    }
  };
  registerObsRoutes(app, {
    adapter,
    configStore: config,
    originPolicy: createLocalWebOriginPolicy(),
    activeScene: () => 'waiting',
    preparationValid: (revision) => () => revision === 'revision',
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/operator/obs/ensure',
      headers: { origin: baseUrl },
      payload: { expectedRevision: 'revision' },
    });
    if (event) {
      expect(response.statusCode).toBe(409);
      if (event.endsWith('StateChanged'))
        expect(response.json()).toMatchObject({ error: 'preparation_output_changed' });
      expect(currentScene).toBe(
        event === 'CurrentProgramSceneChanged' ? '外部场景' : obsSceneName('gameplay'),
      );
      expect(requests.filter((type) => type === 'SetCurrentProgramScene')).toHaveLength(0);
      expect(requests.filter((type) => type === 'SetSceneSceneTransitionOverride')).toHaveLength(
        late ? 1 : 0,
      );
      expect(requests.some((type) => type.startsWith('Stop'))).toBe(false);
      expect(unexpected).toEqual([]);
      return;
    }
    if (align) {
      expect(response.statusCode).toBe(200);
      expect(currentScene).toBe(obsSceneName('waiting'));
      expect(requests.filter((type) => type === 'SetCurrentProgramScene')).toHaveLength(1);
      expect(requests.some((type) => type.startsWith('Stop'))).toBe(false);
      expect(unexpected).toEqual([]);
      return;
    }
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: 'video_output_active',
      message: expect.stringContaining('Plugin video'),
    });
    expect(requests).toContain('GetOutputList');
    if (preparedAudio) {
      expect(requests).toContain('GetVersion');
      // The guard rejected before the RPC was sent, so no uncertain-create
      // journal should prevent the next explicit preparation from retrying.
      await expect(access(join(directory, 'commentary-probe.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
    expect(unexpected).toEqual([]);
    expect(requests.filter((type) => /^(Set|Create|Remove|Stop)/.test(type))).toEqual([]);
  } finally {
    await adapter.close();
    await app.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
