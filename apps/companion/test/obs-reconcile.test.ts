import { expect, it, vi } from 'vitest';
import {
  assertBpCompactOff,
  BpOverlayOwner,
  BP_COMPACT_INPUT,
  setBpCompactVisible,
} from '../src/obs/bp-overlay.js';
import { ensureObsAudio } from '../src/obs/audio.js';
import { PROGRAM_SCENES } from '@mizar/protocol/program-scenes';
import {
  OBS_COLLECTION,
  OBS_CAPTURE_INPUT,
  obsSceneName,
  obsDesiredScenes,
} from '../src/obs/desired-state.js';
import {
  checkObsConfiguration,
  repairObsConfiguration,
  ensureObsConfiguration,
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
  itemChanged: ((sceneName: string, id: number, enabled: boolean) => void) | undefined;
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
        scenes: [...this.scenes.keys()].map((sceneName) => ({
          sceneName,
          sceneUuid: `uuid:${sceneName}`,
        })),
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
          inputUuid: `uuid:${inputName}`,
        })),
      };
    if (type === 'GetSpecialInputs') return {};
    if (type === 'GetInputMute') return { inputMuted: false };
    if (type === 'GetInputVolume') return { inputVolumeMul: 1 };
    if (type === 'GetInputAudioTracks') return { inputAudioTracks: { '1': true } };
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
    if (type === 'GetSourceActive') return { videoActive: true, videoShowing: true };
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
      this.itemChanged?.(name, Number(data.sceneItemId), Boolean(data.sceneItemEnabled));
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
  const onStarted = vi.fn(),
    onCompleted = vi.fn();
  await switchObsScene(obs, 'gameplay', {
    transition: { kind: 'cut', durationMs: 0 },
    onStarted,
    onCompleted,
  });
  expect(obs.calls.at(-1)).toBe('GetCurrentProgramScene');
  expect(onStarted).toHaveBeenCalledOnce();
  expect(onCompleted).toHaveBeenCalledOnce();
  await switchObsScene(obs, 'gameplay', {
    transition: { kind: 'cut', durationMs: 0 },
    onStarted,
    onCompleted,
  });
  expect(onStarted).toHaveBeenCalledOnce();
  expect(onCompleted).toHaveBeenCalledOnce();
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

it('does not take over a collection changed between automatic detection and repair', async () => {
  const obs = new FakeObs();
  await repairObsConfiguration(obs, baseUrl);
  obs.inputs.get(obsDesiredScenes(baseUrl)[0]!.browserInput)!.settings.url = 'https://old.example';
  const call = obs.call.bind(obs);
  let collectionReads = 0;
  vi.spyOn(obs, 'call').mockImplementation((type, data) => {
    if (type === 'GetSceneCollectionList' && ++collectionReads === 2)
      obs.collection = 'User Collection';
    return call(type, data);
  });
  obs.calls = [];
  expect((await ensureObsConfiguration(obs, baseUrl))[0]?.code).toBe('collection_inactive');
  expect(obs.calls.filter((type) => /^(Set|Create|Remove)/.test(type))).toEqual([]);
});

it('automatically prepares a new collection and default audio, without duplicating them on recheck', async () => {
  const obs = new FakeObs();
  await ensureObsConfiguration(obs, baseUrl);
  expect(obs.collection).toBe(OBS_COLLECTION);
  expect(obs.currentScene).toBe(obsSceneName('waiting'));
  expect(await ensureObsAudio(obs, baseUrl)).toEqual([]);
  expect(obs.inputs.get('Mizar · Desktop Audio')?.kind).toBe('wasapi_output_capture');
  expect(obs.inputs.get('Mizar · Microphone')?.kind).toBe('wasapi_input_capture');
  for (const scene of obsDesiredScenes(baseUrl)) {
    expect(
      obs.scenes
        .get(scene.sceneName)
        ?.filter((item) => item.sourceName.startsWith('Mizar · Desktop Audio')),
    ).toHaveLength(1);
    expect(
      obs.scenes
        .get(scene.sceneName)
        ?.filter((item) => item.sourceName.startsWith('Mizar · Microphone')),
    ).toHaveLength(1);
  }
  obs.calls = [];
  await ensureObsConfiguration(obs, baseUrl);
  await ensureObsAudio(obs, baseUrl);
  expect(obs.calls.filter((type) => /^(Set|Create|Remove)/.test(type))).toEqual([]);
});

it('does not configure a new collection or audio while OBS is outputting', async () => {
  const obs = new FakeObs();
  obs.outputActive = true;
  await expect(ensureObsConfiguration(obs, baseUrl)).rejects.toThrow('正在输出');
  expect(obs.collection).toBe('User Collection');
  expect(obs.calls.filter((type) => /^(Set|Create|Remove)/.test(type))).toEqual([]);
  obs.outputActive = false;
  await ensureObsConfiguration(obs, baseUrl);
  obs.outputActive = true;
  obs.calls = [];
  await expect(ensureObsAudio(obs, baseUrl)).rejects.toThrow('正在输出');
  expect(obs.calls.filter((type) => /^(Set|Create|Remove)/.test(type))).toEqual([]);
});

it('ignores unused custom audio when preparing managed scenes', async () => {
  const obs = new FakeObs();
  await ensureObsConfiguration(obs, baseUrl);
  obs.inputs.set('My microphone', {
    kind: 'wasapi_input_capture',
    settings: { device_id: 'custom' },
  });
  obs.calls = [];
  const findings = await ensureObsAudio(obs, baseUrl);
  expect(findings).toEqual([]);
  expect(obs.inputs.has('Mizar · Desktop Audio')).toBe(true);
  expect(obs.inputs.get('My microphone')!.settings).toEqual({ device_id: 'custom' });
});

it('reports an audio name collision and leaves the existing source untouched', async () => {
  const obs = new FakeObs();
  await ensureObsConfiguration(obs, baseUrl);
  obs.inputs.set('Mizar · Microphone', { kind: 'image_source', settings: {} });
  obs.calls = [];
  expect((await ensureObsAudio(obs, baseUrl))[0]?.code).toBe('audio_source_conflict');
  expect(obs.calls.filter((type) => /^(Set|Create|Remove)/.test(type))).toEqual([]);
});

it('does not duplicate game-capture audio with default desktop capture', async () => {
  const obs = new FakeObs();
  await ensureObsConfiguration(obs, baseUrl);
  obs.inputs.get(OBS_CAPTURE_INPUT)!.settings.capture_audio = true;
  obs.calls = [];
  await ensureObsAudio(obs, baseUrl);
  expect(obs.inputs.has('Mizar · Desktop Audio')).toBe(false);
  expect(obs.inputs.get(OBS_CAPTURE_INPUT)!.settings.capture_audio).toBe(true);
  expect(obs.calls.filter((type) => /^(Set|Create|Remove)/.test(type))).toEqual([]);
});

it('takes and closes the compact source only after verifying gameplay and HUD state', async () => {
  const obs = new FakeObs();
  await repairObsConfiguration(obs, baseUrl);
  const scene = obsSceneName('gameplay');
  obs.currentScene = scene;
  await expect(setBpCompactVisible(obs, baseUrl, true)).rejects.toThrow('HUD');
  const hud = obs.scenes
    .get(scene)!
    .find((item) => item.sourceName === 'Mizar · gameplay · Program')!;
  hud.sceneItemEnabled = false;
  await setBpCompactVisible(obs, baseUrl, true);
  await expect(assertBpCompactOff(obs)).rejects.toThrow('先关闭');
  expect(
    obs.scenes.get(scene)!.find((item) => item.sourceName === BP_COMPACT_INPUT)?.sceneItemEnabled,
  ).toBe(true);
  await setBpCompactVisible(obs, baseUrl, true);
  expect(
    obs.scenes.get(scene)!.filter((item) => item.sourceName === BP_COMPACT_INPUT),
  ).toHaveLength(1);
  await setBpCompactVisible(obs, baseUrl, false);
  expect(
    obs.scenes.get(scene)!.find((item) => item.sourceName === BP_COMPACT_INPUT)?.sceneItemEnabled,
  ).toBe(false);
  obs.scenes.set(
    scene,
    obs.scenes.get(scene)!.filter((item) => item.sourceName !== BP_COMPACT_INPUT),
  );
  await setBpCompactVisible(obs, baseUrl, true);
  expect(
    obs.scenes.get(scene)!.find((item) => item.sourceName === BP_COMPACT_INPUT)?.sceneItemEnabled,
  ).toBe(true);
  obs.currentScene = obsSceneName('waiting');
  await expect(setBpCompactVisible(obs, baseUrl, true)).rejects.toThrow('受管比赛画面');
});

it('temporarily hides only the owned HUD and restores it after repeated Take and close', async () => {
  const obs = new FakeObs();
  await repairObsConfiguration(obs, baseUrl);
  const scene = obsSceneName('gameplay');
  obs.currentScene = scene;
  const owner = new BpOverlayOwner();
  obs.itemChanged = (name, id, enabled) => owner.observeItem(name, id, enabled);
  const hud = obs.scenes
    .get(scene)!
    .find((item) => item.sourceName === 'Mizar · gameplay · Program')!;
  await owner.set(obs, baseUrl, true);
  expect(hud.sceneItemEnabled).toBe(false);
  await owner.set(obs, baseUrl, true);
  await owner.set(obs, baseUrl, false);
  expect(hud.sceneItemEnabled).toBe(true);
});

it('does not restore after an operator changes HUD or the observation connection is lost', async () => {
  const obs = new FakeObs();
  await repairObsConfiguration(obs, baseUrl);
  const scene = obsSceneName('gameplay');
  obs.currentScene = scene;
  const owner = new BpOverlayOwner();
  obs.itemChanged = (name, id, enabled) => owner.observeItem(name, id, enabled);
  const hud = obs.scenes
    .get(scene)!
    .find((item) => item.sourceName === 'Mizar · gameplay · Program')!;
  await owner.set(obs, baseUrl, true);
  await obs.call('SetSceneItemEnabled', {
    sceneName: scene,
    sceneItemId: hud.sceneItemId,
    sceneItemEnabled: true,
  });
  await obs.call('SetSceneItemEnabled', {
    sceneName: scene,
    sceneItemId: hud.sceneItemId,
    sceneItemEnabled: false,
  });
  await owner.set(obs, baseUrl, false);
  expect(hud.sceneItemEnabled).toBe(false);
  hud.sceneItemEnabled = true;
  await owner.set(obs, baseUrl, true);
  owner.invalidate();
  await expect(owner.set(obs, baseUrl, false)).rejects.toThrow('状态待确认');
  expect(hud.sceneItemEnabled).toBe(false);
});

it('restores the HUD when the compact source was removed while on air', async () => {
  const obs = new FakeObs();
  await repairObsConfiguration(obs, baseUrl);
  const scene = obsSceneName('gameplay');
  obs.currentScene = scene;
  const owner = new BpOverlayOwner();
  obs.itemChanged = (name, id, enabled) => owner.observeItem(name, id, enabled);
  const hud = obs.scenes
    .get(scene)!
    .find((item) => item.sourceName === 'Mizar · gameplay · Program')!;
  await owner.set(obs, baseUrl, true);
  obs.scenes.set(
    scene,
    obs.scenes.get(scene)!.filter((item) => item.sourceName !== BP_COMPACT_INPUT),
  );
  await owner.set(obs, baseUrl, true);
  expect(
    obs.scenes.get(scene)!.filter((item) => item.sourceName === BP_COMPACT_INPUT),
  ).toHaveLength(1);
  obs.scenes.set(
    scene,
    obs.scenes.get(scene)!.filter((item) => item.sourceName !== BP_COMPACT_INPUT),
  );
  await owner.set(obs, baseUrl, false);
  expect(hud.sceneItemEnabled).toBe(true);
});

it('keeps an initially hidden HUD hidden and never restores a replacement item', async () => {
  const obs = new FakeObs();
  await repairObsConfiguration(obs, baseUrl);
  const scene = obsSceneName('gameplay');
  obs.currentScene = scene;
  const owner = new BpOverlayOwner();
  obs.itemChanged = (name, id, enabled) => owner.observeItem(name, id, enabled);
  const hud = obs.scenes
    .get(scene)!
    .find((item) => item.sourceName === 'Mizar · gameplay · Program')!;
  hud.sceneItemEnabled = false;
  await owner.set(obs, baseUrl, true);
  await owner.set(obs, baseUrl, false);
  expect(hud.sceneItemEnabled).toBe(false);
  hud.sceneItemEnabled = true;
  await owner.set(obs, baseUrl, true);
  obs.scenes.set(
    scene,
    obs.scenes.get(scene)!.filter((item) => item.sceneItemId !== hud.sceneItemId),
  );
  owner.observeRemoval(scene, hud.sceneItemId);
  obs.addItem(scene, 'Mizar · gameplay · Program');
  const replacement = obs.scenes
    .get(scene)!
    .find((item) => item.sourceName === 'Mizar · gameplay · Program')!;
  replacement.sceneItemEnabled = false;
  await expect(owner.set(obs, baseUrl, false)).rejects.toThrow('状态待确认');
  expect(replacement.sceneItemEnabled).toBe(false);
});

it('does not duplicate window-capture audio with default desktop capture', async () => {
  const obs = new FakeObs();
  await ensureObsConfiguration(obs, baseUrl);
  obs.inputs.set('Window', { kind: 'window_capture', settings: { capture_audio: true } });
  obs.scenes
    .get(obsSceneName('gameplay'))!
    .push({
      sourceName: 'Window',
      sceneItemId: obs.nextId++,
      sceneItemIndex: 2,
      sceneItemEnabled: true,
    });
  obs.calls = [];
  await ensureObsAudio(obs, baseUrl);
  expect(obs.inputs.has('Mizar · Desktop Audio')).toBe(false);
  expect(obs.inputs.get('Window')!.settings.capture_audio).toBe(true);
  expect(obs.calls.filter((type) => /^(Set|Create|Remove)/.test(type))).toEqual([]);
});
