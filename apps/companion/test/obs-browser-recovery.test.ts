import { afterEach, expect, it, vi } from 'vitest';
import { ObsAdapter } from '../src/obs/adapter.js';
import { ObsConfigStore } from '../src/obs/config.js';
import * as reconcile from '../src/obs/reconcile.js';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';

const websocket = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  call: vi.fn(),
}));
vi.mock('obs-websocket-js', () => ({
  EventSubscription: { Outputs: 64 },
  OBSWebSocket: class {
    on() {
      return this;
    }
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

it('keeps an OBS connection when Program diagnostics fail and retains the redacted request cause', async () => {
  websocket.connect.mockResolvedValue(undefined);
  websocket.disconnect.mockResolvedValue(undefined);
  vi.spyOn(reconcile, 'checkObsConfiguration').mockResolvedValue([
    { code: 'scene_missing', message: 'missing' },
  ]);
  websocket.call.mockImplementation(async (type: string) => {
    await Promise.resolve();
    if (type === 'GetSceneCollectionList')
      throw Object.assign(new Error('property lookup denied private-password'), { code: 600 });
    if (type === 'GetCurrentProgramScene') return { currentProgramSceneName: 'Mizar · 比赛中' };
    return { outputActive: false };
  });
  const store = new ObsConfigStore('/unused-test-config');
  vi.spyOn(store, 'read').mockResolvedValue({
    host: '127.0.0.1',
    port: 4455,
    password: 'private-password',
    executablePath: null,
  });
  const diagnostic = vi.fn();
  const adapter = new ObsAdapter(store, 'http://127.0.0.1:3000', diagnostic);
  try {
    expect(await adapter.status()).toMatchObject({
      connection: 'connected',
      currentScene: 'Mizar · 比赛中',
      programEvidence: null,
    });
    expect(diagnostic).toHaveBeenCalledWith(
      'obs_program_check',
      expect.objectContaining({ code: 600, message: 'property lookup denied [redacted]' }),
    );
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-password');
  } finally {
    await adapter.close();
  }
});

it.each([false, true])(
  'preserves confirmed base facts with stalled capture or cleanup (%s) after a slow base read',
  async (stalledCleanup) => {
    vi.useFakeTimers();
    websocket.connect.mockResolvedValue(undefined);
    websocket.disconnect.mockResolvedValue(undefined);
    vi.spyOn(reconcile, 'checkObsConfiguration').mockResolvedValue([
      { code: 'scene_missing', message: 'missing' },
    ]);
    let releaseActivity!: (value: Record<string, unknown>) => void;
    const sourceActivity = new Promise<Record<string, unknown>>((resolve) => {
      releaseActivity = resolve;
    });
    if (stalledCleanup)
      websocket.disconnect
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(() => new Promise(() => {}));
    let sceneReads = 0;
    const sceneName = obsDesiredScenes('http://127.0.0.1:3000').find(
      (scene) => scene.id === 'gameplay',
    )!.sceneName;
    websocket.call.mockImplementation(async (type: string) => {
      if (type === 'GetCurrentProgramScene') {
        if (sceneReads++ === 0) await new Promise((resolve) => setTimeout(resolve, 3500));
        return { currentProgramSceneName: sceneName };
      }
      if (type === 'GetVideoSettings')
        return {
          baseWidth: 1920,
          baseHeight: 1080,
          outputWidth: 1280,
          outputHeight: 720,
          fpsNumerator: 60,
          fpsDenominator: 1,
        };
      if (type === 'GetStreamStatus') return { outputActive: true };
      if (type === 'GetRecordStatus') return { outputActive: false };
      if (type === 'GetSceneCollectionList') return { currentSceneCollectionName: OBS_COLLECTION };
      if (type === 'GetSceneItemList')
        return {
          sceneItems: [{ sourceName: OBS_CAPTURE_INPUT, sceneItemEnabled: true, sceneItemId: 7 }],
        };
      if (type === 'GetInputList')
        return { inputs: [{ inputName: OBS_CAPTURE_INPUT, inputKind: 'game_capture' }] };
      if (type === 'GetInputSettings')
        return { inputSettings: { capture_mode: 'window', window: 'CS2:SDL_app:cs2.exe' } };
      if (type === 'GetInputPropertiesListPropertyItems') return { propertyItems: [] };
      if (type === 'GetSourceActive')
        return stalledCleanup ? { videoActive: true, videoShowing: true } : sourceActivity;
      return {};
    });
    const store = new ObsConfigStore('/unused-test-config');
    vi.spyOn(store, 'read').mockResolvedValue({
      host: '127.0.0.1',
      port: 4455,
      password: '',
      executablePath: null,
    });
    const diagnostic = vi.fn();
    const adapter = new ObsAdapter(store, 'http://127.0.0.1:3000', diagnostic);
    try {
      const pending = adapter.status();
      await vi.advanceTimersByTimeAsync(3500);
      expect(websocket.call.mock.calls.some(([type]) => type === 'GetSourceActive')).toBe(true);
      await vi.advanceTimersByTimeAsync(800);
      const status = await pending;
      expect(status).toMatchObject({
        connection: 'connected',
        currentScene: sceneName,
        streaming: true,
        recording: false,
        video: { canvas: '1920×1080', output: '1280×720', fps: 60 },
        findings: [{ code: 'scene_missing' }],
        programEvidence: null,
      });
      expect(JSON.stringify(diagnostic.mock.calls)).toContain('obs_program_check');
      expect(JSON.stringify(diagnostic.mock.calls)).toContain('超时');
      // A late evidence response never replaces the already-returned base facts.
      releaseActivity({ videoActive: true, videoShowing: true });
      await vi.advanceTimersByTimeAsync(5000);
      expect(status.programEvidence).toBeNull();
      expect(status.connection).toBe('connected');
    } finally {
      await adapter.close();
    }
  },
);
