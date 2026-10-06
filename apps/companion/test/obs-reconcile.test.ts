import { expect, it, vi } from 'vitest';
import { PROGRAM_SCENES } from '@mizar/protocol/program-scenes';
import { OBS_COLLECTION, obsDesiredScenes } from '../src/obs/desired-state.js';
import {
  checkObsConfiguration,
  repairObsConfiguration,
  refreshObsBrowserSources,
  switchObsScene,
  type ObsRpc,
} from '../src/obs/reconcile.js';

class FakeObs implements ObsRpc {
  collection = 'User Collection';
  collections = new Set(['User Collection']);
  scenes = new Map<
    string,
    { sourceName: string; sceneItemId: number; sceneItemIndex: number; sceneItemEnabled: boolean }[]
  >();
  inputs = new Map<string, { kind: string; settings: Record<string, unknown> }>();
  transforms = new Map<number, Record<string, unknown>>();
  outputActive = false;
  captureWindows: { itemValue: string; itemEnabled: boolean }[] = [];
  calls: string[] = [];
  currentScene = '';
  overrides = new Map<string, Record<string, unknown>>();
  transitions = [
    { transitionKind: 'cut_transition', transitionName: '直接切换' },
    { transitionKind: 'fade_transition', transitionName: '淡化' },
  ];
  listeners = new Set<(name: string) => void>();
  onTransitionVideoEnded(listener: (name: string) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  nextId = 1;
  call(type: string, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    return Promise.resolve(this.callSync(type, data));
  }
  private callSync(type: string, data: Record<string, unknown>): Record<string, unknown> {
    this.calls.push(type);
    const name = typeof data.sceneName === 'string' ? data.sceneName : '';
    if (type === 'GetSceneCollectionList')
      return {
        currentSceneCollectionName: this.collection,
        sceneCollections: [...this.collections],
      };
    if (type === 'CreateSceneCollection' || type === 'SetCurrentSceneCollection') {
      if (
        type === 'CreateSceneCollection' &&
        this.collections.has(String(data.sceneCollectionName))
      )
        throw new Error('Scene collection already exists');
      this.collection = String(data.sceneCollectionName);
      this.collections.add(this.collection);
      return {};
    }
    if (type === 'GetStreamStatus' || type === 'GetRecordStatus')
      return { outputActive: this.outputActive };
    if (type === 'GetVideoSettings')
      return {
        baseWidth: 1920,
        baseHeight: 1080,
        outputWidth: 1920,
        outputHeight: 1080,
        fpsNumerator: 60,
        fpsDenominator: 1,
      };
    if (type === 'GetSceneList')
      return {
        currentProgramSceneName: this.currentScene,
        scenes: [...this.scenes.keys()].map((sceneName) => ({ sceneName })),
      };
    if (type === 'CreateScene') {
      this.scenes.set(name, []);
      return {};
    }
    if (type === 'GetInputList')
      return {
        inputs: [...this.inputs].map(([inputName, input]) => ({
          inputName,
          inputKind: input.kind,
        })),
      };
    if (type === 'CreateInput') {
      this.inputs.set(String(data.inputName), {
        kind: String(data.inputKind),
        settings: data.inputSettings as Record<string, unknown>,
      });
      this.addItem(name, String(data.inputName));
      return {};
    }
    if (type === 'SetInputSettings') {
      this.inputs.get(String(data.inputName))!.settings = {
        ...this.inputs.get(String(data.inputName))!.settings,
        ...(data.inputSettings as Record<string, unknown>),
      };
      return {};
    }
    if (type === 'GetInputSettings')
      return { inputSettings: this.inputs.get(String(data.inputName))!.settings };
    if (type === 'GetInputPropertiesListPropertyItems')
      return { propertyItems: this.captureWindows };
    if (type === 'GetSceneItemList')
      return { sceneItems: this.scenes.get(name)?.map((item) => ({ ...item })) ?? [] };
    if (type === 'CreateSceneItem') {
      this.addItem(name, String(data.sourceName));
      return {};
    }
    if (type === 'GetSceneItemTransform')
      return { sceneItemTransform: this.transforms.get(Number(data.sceneItemId)) };
    if (type === 'SetSceneItemTransform') {
      this.transforms.set(Number(data.sceneItemId), {
        ...(data.sceneItemTransform as Record<string, unknown>),
      });
      return {};
    }
    if (type === 'SetSceneItemEnabled') {
      this.scenes
        .get(name)!
        .find((item) => item.sceneItemId === data.sceneItemId)!.sceneItemEnabled = Boolean(
        data.sceneItemEnabled,
      );
      return {};
    }
    if (type === 'SetSceneItemIndex') {
      this.scenes.get(name)!.find((item) => item.sceneItemId === data.sceneItemId)!.sceneItemIndex =
        Number(data.sceneItemIndex);
      return {};
    }
    if (type === 'GetSceneTransitionList') return { transitions: this.transitions };
    if (type === 'SetSceneSceneTransitionOverride') {
      this.overrides.set(name, data);
      return {};
    }
    if (type === 'GetCurrentProgramScene') return { currentProgramSceneName: this.currentScene };
    if (type === 'PressInputPropertiesButton') return {};
    if (type === 'GetCurrentSceneTransitionCursor') return { transitionCursor: 1 };
    if (type === 'SetCurrentProgramScene') {
      this.currentScene = name;
      return {};
    }
    throw new Error(`unknown request ${type}`);
  }
  addItem(sceneName: string, sourceName: string) {
    const items = this.scenes.get(sceneName)!;
    const sceneItemId = this.nextId++;
    items.push({ sourceName, sceneItemId, sceneItemIndex: items.length, sceneItemEnabled: true });
    this.transforms.set(sceneItemId, { positionX: 0, positionY: 0, scaleX: 1, scaleY: 1 });
  }
}

const baseUrl = 'http://127.0.0.1:3000';

it('refreshes exact owned program URLs once without changing collection, scene, or non-Mizar inputs', async () => {
  const obs = new FakeObs();
  const refreshed = new Set<string>();
  expect(await refreshObsBrowserSources(obs, baseUrl, refreshed)).toBe(false);
  expect(obs.calls).not.toContain('PressInputPropertiesButton');
  await repairObsConfiguration(obs, baseUrl);
  obs.inputs.set('User Browser', {
    kind: 'browser_source',
    settings: { url: 'https://example.test' },
  });
  const expected = obsDesiredScenes(baseUrl);
  const conflicting = expected[0]!;
  obs.inputs.get(conflicting.browserInput)!.settings.url = 'https://example.test';
  obs.calls = [];
  expect(await refreshObsBrowserSources(obs, baseUrl, refreshed)).toBe(false);
  expect(refreshed.size).toBe(expected.length - 1);
  expect(refreshed.has(conflicting.browserInput)).toBe(false);
  expect(refreshed.has('User Browser')).toBe(false);
  const firstRefreshCount = obs.calls.filter(
    (call) => call === 'PressInputPropertiesButton',
  ).length;
  await refreshObsBrowserSources(obs, baseUrl, refreshed);
  expect(obs.calls.filter((call) => call === 'PressInputPropertiesButton')).toHaveLength(
    firstRefreshCount,
  );
  obs.inputs.get(conflicting.browserInput)!.settings.url = conflicting.browserUrl;
  expect(await refreshObsBrowserSources(obs, baseUrl, refreshed)).toBe(true);
  expect(obs.calls).not.toContain('SetCurrentSceneCollection');
  expect(obs.calls).not.toContain('SetCurrentProgramScene');
  expect(obs.inputs.get('User Browser')!.settings).toEqual({ url: 'https://example.test' });
});

it('derives all OBS scenes and URLs from the shared registry', () => {
  const desired = obsDesiredScenes(baseUrl);
  expect(desired.map((scene) => scene.id)).toEqual(PROGRAM_SCENES.map((scene) => scene.id));
  expect(desired.find((scene) => scene.id === 'gameplay')?.sources).toHaveLength(2);
  expect(desired.find((scene) => scene.id === 'bp')?.browserUrl).toBe(`${baseUrl}/program/bp`);
});

it('repairs only Mizar collection, browser sources and order, then is idempotently healthy', async () => {
  const obs = new FakeObs();
  obs.scenes.set('My Camera Scene', []);
  expect((await checkObsConfiguration(obs, baseUrl)).map((finding) => finding.code)).toEqual([
    'collection_missing',
  ]);
  expect(await repairObsConfiguration(obs, baseUrl)).toEqual([]);
  const gameplay = obsDesiredScenes(baseUrl).find((scene) => scene.id === 'gameplay')!;
  const capture = obs.scenes
    .get(gameplay.sceneName)!
    .find((item) => item.sourceName === 'Mizar · CS2 Game Capture')!;
  expect(obs.transforms.get(capture.sceneItemId)).toMatchObject({
    boundsType: 'OBS_BOUNDS_STRETCH',
    boundsWidth: 1920,
    boundsHeight: 1080,
  });
  capture.sceneItemEnabled = false;
  obs.transforms.get(capture.sceneItemId)!.boundsWidth = 1440;
  expect((await checkObsConfiguration(obs, baseUrl)).map((finding) => finding.code)).toEqual(
    expect.arrayContaining(['source_disabled', 'transform_drift']),
  );
  expect(await repairObsConfiguration(obs, baseUrl)).toEqual([]);
  expect(capture.sceneItemEnabled).toBe(true);
  expect(obs.collection).toBe(OBS_COLLECTION);
  expect(obs.scenes.get('My Camera Scene')).toEqual([]);
  expect(obs.scenes.size).toBe(PROGRAM_SCENES.length + 1);
  expect(await repairObsConfiguration(obs, baseUrl)).toEqual([]);
  expect(obs.scenes.size).toBe(PROGRAM_SCENES.length + 1);
  obs.inputs.get('Mizar · CS2 Game Capture')!.settings.window = 'other.exe';
  expect((await checkObsConfiguration(obs, baseUrl)).map((finding) => finding.code)).toContain(
    'capture_drift',
  );
  expect(await repairObsConfiguration(obs, baseUrl)).toEqual([]);
  const gameplayBrowser = obs.scenes
    .get(gameplay.sceneName)!
    .find((item) => item.sourceName === gameplay.browserInput)!;
  obs.transforms.get(gameplayBrowser.sceneItemId)!.positionX = 50;
  expect((await checkObsConfiguration(obs, baseUrl)).map((finding) => finding.code)).toContain(
    'transform_drift',
  );
  expect(await repairObsConfiguration(obs, baseUrl)).toEqual([]);
  const bp = obsDesiredScenes(baseUrl).find((scene) => scene.id === 'bp')!;
  obs.inputs.get(bp.browserInput)!.settings.url = 'http://127.0.0.1:3000/wrong';
  expect((await checkObsConfiguration(obs, baseUrl)).map((finding) => finding.code)).toContain(
    'url_drift',
  );
  expect(await repairObsConfiguration(obs, baseUrl)).toEqual([]);
  await switchObsScene(obs, 'gameplay');
  expect(obs.calls.at(-1)).toBe('GetCurrentProgramScene');
});

it('replaces the null-window target and follows actual CS2 windows across server titles', async () => {
  const obs = new FakeObs();
  await repairObsConfiguration(obs, baseUrl);
  const capture = obs.inputs.get('Mizar · CS2 Game Capture')!;
  expect(capture.settings).toMatchObject({
    window: 'Counter-Strike 2:SDL_app:cs2.exe',
    priority: 2,
  });
  capture.settings.window = '::cs2.exe';
  expect((await checkObsConfiguration(obs, baseUrl)).map((item) => item.code)).toContain(
    'capture_drift',
  );
  for (const window of ['Counter-Strike 2:SDL_app:cs2.exe', '反恐精英2:SDL_app:cs2.exe']) {
    obs.captureWindows = [
      { itemValue: 'Other game:SDL_app:other.exe', itemEnabled: true },
      { itemValue: 'Old CS2:SDL_app:cs2.exe', itemEnabled: false },
      { itemValue: window, itemEnabled: true },
    ];
    expect(await repairObsConfiguration(obs, baseUrl)).toEqual([]);
    expect(capture.settings.window).toBe(window);
  }
});

it('refuses collection mutations during output and protects user source names', async () => {
  const obs = new FakeObs();
  obs.outputActive = true;
  await expect(repairObsConfiguration(obs, baseUrl)).rejects.toThrow('OBS 正在输出');
  expect(obs.collection).toBe('User Collection');
  obs.outputActive = false;
  const ownedBrowser = obsDesiredScenes(baseUrl)[0]!.browserInput;
  obs.inputs.set(ownedBrowser, { kind: 'image_source', settings: {} });
  await expect(repairObsConfiguration(obs, baseUrl)).rejects.toThrow('来源名称冲突');
  expect(obs.scenes.size).toBe(0);
});

it('uses localized transition kinds only on the target Mizar scene and waits for video completion', async () => {
  const obs = new FakeObs();
  await repairObsConfiguration(obs, baseUrl);
  let done = false;
  const switching = switchObsScene(obs, 'halftime', {
    transition: { kind: 'fade', durationMs: 300 },
  }).then(() => {
    done = true;
  });
  await vi.waitFor(() => expect(obs.currentScene).toBe('Mizar · 半场'));
  expect(done).toBe(false);
  expect(obs.overrides.get('Mizar · 半场')).toEqual({
    sceneName: 'Mizar · 半场',
    transitionName: '淡化',
    transitionDuration: 300,
  });
  obs.listeners.forEach((listener) => listener('other transition'));
  await Promise.resolve();
  expect(done).toBe(false);
  obs.listeners.forEach((listener) => listener('淡化'));
  await switching;
  expect(done).toBe(true);
  expect(obs.listeners.size).toBe(0);
  expect(obs.calls).not.toContain('SetCurrentSceneTransition');
});

it('an immediate Cut has no animation wait and abort releases an in-flight fade listener', async () => {
  const obs = new FakeObs();
  await repairObsConfiguration(obs, baseUrl);
  const abort = new AbortController();
  const switching = switchObsScene(obs, 'waiting', {
    transition: { kind: 'fade', durationMs: 300 },
    signal: abort.signal,
  });
  const rejected = expect(switching).rejects.toThrow();
  await vi.waitFor(() => expect(obs.currentScene).toBe('Mizar · 赛前等待'));
  abort.abort();
  await rejected;
  expect(obs.listeners.size).toBe(0);
  await switchObsScene(obs, 'gameplay', { transition: { kind: 'cut', durationMs: 0 } });
  expect(obs.currentScene).toBe('Mizar · 比赛中');
  expect(obs.overrides.get(obs.currentScene)).toMatchObject({
    transitionName: '直接切换',
    transitionDuration: null,
  });
});

it('fails closed when the required transition is missing or the intent becomes invalid before Take', async () => {
  const obs = new FakeObs();
  await repairObsConfiguration(obs, baseUrl);
  obs.transitions = obs.transitions.filter((t) => t.transitionKind === 'cut_transition');
  await expect(
    switchObsScene(obs, 'waiting', { transition: { kind: 'fade', durationMs: 300 } }),
  ).rejects.toThrow('缺少');
  expect(obs.calls).not.toContain('SetCurrentProgramScene');
  await expect(
    switchObsScene(obs, 'waiting', {
      transition: { kind: 'cut', durationMs: 0 },
      valid: () => false,
    }),
  ).rejects.toThrow('失效');
  expect(obs.calls).not.toContain('SetCurrentProgramScene');
});

it('does not report a fade as complete when OBS omits its completion event', async () => {
  const obs = new FakeObs();
  await repairObsConfiguration(obs, baseUrl);
  vi.useFakeTimers();
  try {
    const switching = switchObsScene(obs, 'waiting', {
      transition: { kind: 'fade', durationMs: 300 },
    });
    const rejected = expect(switching).rejects.toThrow('超时');
    await vi.advanceTimersByTimeAsync(1001);
    await rejected;
    expect(obs.listeners.size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it('adopts an already on-air target without waiting for a transition event that will not fire', async () => {
  const obs = new FakeObs();
  await repairObsConfiguration(obs, baseUrl);
  obs.currentScene = 'Mizar · 半场';
  obs.calls = [];
  await switchObsScene(obs, 'halftime', { transition: { kind: 'fade', durationMs: 300 } });
  expect(obs.calls).not.toContain('SetCurrentProgramScene');
  expect(obs.listeners.size).toBe(0);
});
