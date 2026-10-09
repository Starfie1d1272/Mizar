import { afterEach, expect, it, vi } from 'vitest';
import { ObsAdapter } from '../src/obs/adapter.js';
import { ObsConfigStore } from '../src/obs/config.js';
import * as reconcile from '../src/obs/reconcile.js';
import { OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';

const websocket = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  call: vi.fn(),
}));
vi.mock('obs-websocket-js', () => ({
  OBSWebSocket: class {
    connect = websocket.connect;
    disconnect = websocket.disconnect;
    call = websocket.call;
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

it('retries unavailable OBS after service readiness, refreshes each owned source once and stops on success', async () => {
  vi.useFakeTimers();
  const scenes = obsDesiredScenes('http://127.0.0.1:3000');
  websocket.connect.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  websocket.disconnect.mockResolvedValue(undefined);
  websocket.call.mockImplementation(async (type: string, data?: Record<string, unknown>) => {
    await Promise.resolve();
    if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: OBS_COLLECTION };
    if (type === 'GetInputList')
      return {
        inputs: scenes.map((scene) => ({
          inputName: scene.browserInput,
          inputKind: 'browser_source',
        })),
      };
    if (type === 'GetInputSettings')
      return {
        inputSettings: {
          url: scenes.find((scene) => scene.browserInput === data?.inputName)!.browserUrl,
        },
      };
    if (type === 'PressInputPropertiesButton') return {};
    throw new Error(`unexpected mutation: ${type}`);
  });
  const store = new ObsConfigStore('/unused-test-config');
  vi.spyOn(store, 'read').mockResolvedValue({
    host: '127.0.0.1',
    port: 4455,
    password: '',
    executablePath: null,
  });
  const adapter = new ObsAdapter(store, 'http://127.0.0.1:3000');
  try {
    adapter.startBrowserRecovery();
    adapter.startBrowserRecovery();
    await vi.advanceTimersByTimeAsync(0);
    expect(websocket.connect).toHaveBeenCalledTimes(1);
    expect(websocket.call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(websocket.connect).toHaveBeenCalledTimes(2);
    expect(
      websocket.call.mock.calls.filter(([type]) => type === 'PressInputPropertiesButton'),
    ).toHaveLength(scenes.length);
    adapter.startBrowserRecovery();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(websocket.connect).toHaveBeenCalledTimes(2);
  } finally {
    await adapter.close();
  }
});

it('cancels retries on shutdown and does not start recovery again', async () => {
  vi.useFakeTimers();
  websocket.connect.mockRejectedValue(new Error('offline'));
  websocket.disconnect.mockResolvedValue(undefined);
  const store = new ObsConfigStore('/unused-test-config');
  vi.spyOn(store, 'read').mockResolvedValue({
    host: '127.0.0.1',
    port: 4455,
    password: '',
    executablePath: null,
  });
  const adapter = new ObsAdapter(store, 'http://127.0.0.1:3000');
  adapter.startBrowserRecovery();
  await vi.advanceTimersByTimeAsync(0);
  await adapter.close();
  adapter.startBrowserRecovery();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(websocket.connect).toHaveBeenCalledTimes(1);
  expect(websocket.call).not.toHaveBeenCalled();
});

it('keeps audio readiness findings in successive normal status polls and clears them only after correction', async () => {
  websocket.connect.mockResolvedValue(undefined);
  websocket.disconnect.mockResolvedValue(undefined);
  vi.spyOn(reconcile, 'checkObsConfiguration').mockResolvedValue([]);
  let audio: 'missing' | 'muted' | 'ready' = 'missing';
  websocket.call.mockImplementation(async (type: string) => {
    await Promise.resolve();
    if (type === 'GetInputList')
      return {
        inputs:
          audio === 'missing' ? [] : [{ inputName: 'Desktop', inputKind: 'wasapi_output_capture' }],
      };
    if (type === 'GetSpecialInputs') return { desktop1: 'Desktop' };
    if (type === 'GetInputMute') return { inputMuted: audio === 'muted' };
    if (type === 'GetInputVolume') return { inputVolumeMul: 1 };
    if (type === 'GetInputAudioTracks') return { inputAudioTracks: { '1': audio === 'ready' } };
    if (type === 'GetSceneItemList') return { sceneItems: [] };
    return {};
  });
  const store = new ObsConfigStore('/unused-test-config');
  vi.spyOn(store, 'read').mockResolvedValue({
    host: '127.0.0.1',
    port: 4455,
    password: '',
    executablePath: null,
  });
  const adapter = new ObsAdapter(store, 'http://127.0.0.1:3000');
  expect(await adapter.check()).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'audio_missing' })]),
  );
  for (let index = 0; index < 2; index++)
    expect((await adapter.status()).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'audio_missing' })]),
    );
  audio = 'muted';
  expect((await adapter.status()).findings.map((finding) => finding.code)).toEqual([
    'audio_muted:Desktop',
    'audio_tracks:Desktop',
  ]);
  audio = 'ready';
  const first = adapter.status();
  expect((await first).findings).toEqual([]);
  await adapter.close();
});
