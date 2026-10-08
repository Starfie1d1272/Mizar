import {
  OBS_CAPTURE_INPUT,
  OBS_COLLECTION,
  OBS_HEIGHT,
  OBS_WIDTH,
  obsDesiredScenes,
} from './desired-state.js';
import type { ProgramTransition } from '@mizar/protocol/program-scenes';

export interface ObsRpc {
  call(type: string, data?: Record<string, unknown>): Promise<Record<string, unknown>>;
  onTransitionVideoEnded?(listener: (transitionName: string) => void): () => void;
}

export interface ObsSceneSwitchOptions {
  readonly transition: ProgramTransition;
  readonly signal?: AbortSignal;
  readonly valid?: () => boolean;
}

export interface ObsFinding {
  readonly code: string;
  readonly scene?: string;
  readonly message: string;
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
      )
    : [];
}

function names(value: unknown, key: string): string[] {
  return objects(value)
    .map((item) => item[key])
    .filter((name): name is string => typeof name === 'string');
}

const CS2_WINDOW_FALLBACK = 'Counter-Strike 2:SDL_app:cs2.exe';

function isCs2Window(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = value.split(':');
  return (
    parts.length === 3 &&
    parts[0] !== '' &&
    parts[1] !== '' &&
    parts[2]?.toLowerCase() === 'cs2.exe'
  );
}

async function cs2CaptureWindow(obs: ObsRpc): Promise<string> {
  const properties = await obs.call('GetInputPropertiesListPropertyItems', {
    inputName: OBS_CAPTURE_INPUT,
    propertyName: 'window',
  });
  const available = objects(properties.propertyItems).find(
    (item) => item.itemEnabled !== false && isCs2Window(item.itemValue),
  );
  return typeof available?.itemValue === 'string' ? available.itemValue : CS2_WINDOW_FALLBACK;
}

// OBS WebSocket returns collection names as strings, unlike scene/input lists.
function collectionNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function ownedScene(name: string): boolean {
  return name.startsWith('Mizar · ');
}

/** Reload only exact Mizar program URLs, without changing scenes or user settings. */
export async function refreshObsBrowserSources(
  obs: ObsRpc,
  baseUrl: string,
  refreshed: Set<string>,
): Promise<boolean> {
  const collections = await obs.call('GetSceneCollectionList');
  if (collections.currentSceneCollectionName !== OBS_COLLECTION) return false;
  const inputs = objects((await obs.call('GetInputList')).inputs);
  for (const scene of obsDesiredScenes(baseUrl)) {
    if (
      refreshed.has(scene.browserInput) ||
      !inputs.some(
        (input) => input.inputName === scene.browserInput && input.inputKind === 'browser_source',
      )
    )
      continue;
    const result = await obs.call('GetInputSettings', { inputName: scene.browserInput });
    const settings = result.inputSettings as Record<string, unknown> | undefined;
    if (settings?.url !== scene.browserUrl) continue;
    // Recheck ownership after reading settings: an operator may switch collections.
    const current = await obs.call('GetSceneCollectionList');
    if (current.currentSceneCollectionName !== OBS_COLLECTION) return false;
    await obs.call('PressInputPropertiesButton', {
      inputName: scene.browserInput,
      propertyName: 'refreshnocache',
    });
    refreshed.add(scene.browserInput);
  }
  return obsDesiredScenes(baseUrl).every((scene) => refreshed.has(scene.browserInput));
}

const BROWSER_TRANSFORM = {
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
};
const CAPTURE_TRANSFORM = {
  positionX: 0,
  positionY: 0,
  rotation: 0,
  boundsType: 'OBS_BOUNDS_STRETCH',
  boundsWidth: OBS_WIDTH,
  boundsHeight: OBS_HEIGHT,
  cropLeft: 0,
  cropRight: 0,
  cropTop: 0,
  cropBottom: 0,
};

function transformMatches(
  actual: Record<string, unknown> | undefined,
  desired: Record<string, unknown>,
): boolean {
  return Object.entries(desired).every(([key, value]) => actual?.[key] === value);
}

function sceneTransforms(
  scene: ReturnType<typeof obsDesiredScenes>[number],
): [string, Record<string, unknown>][] {
  return scene.composition === 'gameplay_overlay'
    ? [
        [scene.browserInput, BROWSER_TRANSFORM],
        [OBS_CAPTURE_INPUT, CAPTURE_TRANSFORM],
      ]
    : [[scene.browserInput, BROWSER_TRANSFORM]];
}

async function outputActive(obs: ObsRpc): Promise<boolean> {
  const [stream, record] = await Promise.all([
    obs.call('GetStreamStatus'),
    obs.call('GetRecordStatus'),
  ]);
  return stream.outputActive === true || record.outputActive === true;
}

export async function checkObsConfiguration(obs: ObsRpc, baseUrl: string): Promise<ObsFinding[]> {
  const desired = obsDesiredScenes(baseUrl);
  const findings: ObsFinding[] = [];
  const collections = await obs.call('GetSceneCollectionList');
  if (!collectionNames(collections.sceneCollections).includes(OBS_COLLECTION)) {
    findings.push({ code: 'collection_missing', message: 'Mizar 场景集合尚未创建。' });
    return findings;
  }
  if (collections.currentSceneCollectionName !== OBS_COLLECTION) {
    findings.push({
      code: 'collection_inactive',
      message: '当前未使用 Mizar 场景集合。',
    });
    return findings;
  }
  const transitionKinds = new Set(
    objects((await obs.call('GetSceneTransitionList')).transitions).map(
      (item) => item.transitionKind,
    ),
  );
  if (!transitionKinds.has('fade_transition') || !transitionKinds.has('cut_transition'))
    findings.push({
      code: 'transition_missing',
      message: 'Mizar 场景集合缺少淡化或直接切换转场，请在 OBS 中补齐。',
    });
  const video = await obs.call('GetVideoSettings');
  const fps = Number(video.fpsNumerator) / Number(video.fpsDenominator);
  if (
    video.baseWidth !== OBS_WIDTH ||
    video.baseHeight !== OBS_HEIGHT ||
    video.outputWidth !== OBS_WIDTH ||
    video.outputHeight !== OBS_HEIGHT ||
    Math.abs(fps - 60) > 0.01
  )
    findings.push({
      code: 'video_settings',
      message: 'OBS 画布、输出分辨率或帧率与 1920×1080 / 60fps 不一致；请手动检查视频设置。',
    });
  const scenes = await obs.call('GetSceneList');
  const sceneNames = names(scenes.scenes, 'sceneName');
  const inputs = await obs.call('GetInputList');
  const inputKinds = new Map(
    objects(inputs.inputs).map((item) => [String(item.inputName), String(item.inputKind)]),
  );
  if (inputKinds.has(OBS_CAPTURE_INPUT) && inputKinds.get(OBS_CAPTURE_INPUT) !== 'game_capture')
    findings.push({ code: 'source_kind_conflict', message: 'Mizar 游戏采集来源名称冲突。' });
  if (inputKinds.get(OBS_CAPTURE_INPUT) === 'game_capture') {
    const capture = await obs.call('GetInputSettings', { inputName: OBS_CAPTURE_INPUT });
    const settings = capture.inputSettings as Record<string, unknown> | undefined;
    const currentWindow = await cs2CaptureWindow(obs);
    if (
      settings?.capture_mode !== 'window' ||
      !isCs2Window(settings.window) ||
      (currentWindow !== CS2_WINDOW_FALLBACK && settings.window !== currentWindow) ||
      settings.priority !== 2
    )
      findings.push({ code: 'capture_drift', message: 'Mizar 游戏采集来源未指向 CS2。' });
  }
  for (const scene of desired) {
    if (!sceneNames.includes(scene.sceneName)) {
      findings.push({
        code: 'scene_missing',
        scene: scene.sceneName,
        message: `${scene.sceneName} 场景缺失。`,
      });
      continue;
    }
    const items = objects(
      (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
    );
    const itemNames = names(items, 'sourceName');
    for (const source of scene.sources) {
      if (!itemNames.includes(source))
        findings.push({
          code: 'source_missing',
          scene: scene.sceneName,
          message: `${scene.sceneName} 缺少制播来源。`,
        });
      else if (items.find((item) => item.sourceName === source)?.sceneItemEnabled === false)
        findings.push({
          code: 'source_disabled',
          scene: scene.sceneName,
          message: `${scene.sceneName} 的制播来源已关闭。`,
        });
    }
    if (scene.composition === 'gameplay_overlay') {
      const capture = items.find((item) => item.sourceName === OBS_CAPTURE_INPUT);
      const browser = items.find((item) => item.sourceName === scene.browserInput);
      if (capture && browser && Number(browser.sceneItemIndex) < Number(capture.sceneItemIndex))
        findings.push({
          code: 'order_drift',
          scene: scene.sceneName,
          message: `${scene.sceneName} 图层顺序需要修复。`,
        });
    }
    for (const [source, expected] of sceneTransforms(scene)) {
      const item = items.find((candidate) => candidate.sourceName === source);
      if (!item || typeof item.sceneItemId !== 'number') continue;
      const measured = await obs.call('GetSceneItemTransform', {
        sceneName: scene.sceneName,
        sceneItemId: item.sceneItemId,
      });
      const transform = measured.sceneItemTransform as Record<string, unknown> | undefined;
      if (!transformMatches(transform, expected))
        findings.push({
          code: 'transform_drift',
          scene: scene.sceneName,
          message: `${scene.sceneName} 的来源位置或尺寸需要修复。`,
        });
    }
    if (!inputKinds.has(scene.browserInput)) continue;
    if (inputKinds.get(scene.browserInput) !== 'browser_source') {
      findings.push({
        code: 'source_kind_conflict',
        scene: scene.sceneName,
        message: `${scene.sceneName} 来源名称与用户来源冲突。`,
      });
      continue;
    }
    const actual = await obs.call('GetInputSettings', { inputName: scene.browserInput });
    const settings = actual.inputSettings as Record<string, unknown> | undefined;
    if (
      settings?.url !== scene.browserUrl ||
      settings.width !== OBS_WIDTH ||
      settings.height !== OBS_HEIGHT
    )
      findings.push({
        code: 'url_drift',
        scene: scene.sceneName,
        message: `${scene.sceneName} 浏览器源地址或画布尺寸需要修复。`,
      });
  }
  return findings;
}

export async function repairObsConfiguration(obs: ObsRpc, baseUrl: string): Promise<ObsFinding[]> {
  const desired = obsDesiredScenes(baseUrl);
  const before = await checkObsConfiguration(obs, baseUrl);
  if (!before.some((finding) => !['video_settings', 'transition_missing'].includes(finding.code)))
    return before;
  if (await outputActive(obs)) throw new Error('OBS 正在输出；结束输出后可修复制播配置。');
  const collections = await obs.call('GetSceneCollectionList');
  const exists = collectionNames(collections.sceneCollections).includes(OBS_COLLECTION);
  if (!exists) await obs.call('CreateSceneCollection', { sceneCollectionName: OBS_COLLECTION });
  else if (collections.currentSceneCollectionName !== OBS_COLLECTION)
    await obs.call('SetCurrentSceneCollection', { sceneCollectionName: OBS_COLLECTION });
  const scenes = await obs.call('GetSceneList');
  const sceneNames = new Set(names(scenes.scenes, 'sceneName'));
  const inputs = await obs.call('GetInputList');
  const inputKinds = new Map(
    objects(inputs.inputs).map((item) => [String(item.inputName), String(item.inputKind)]),
  );
  if (inputKinds.has(OBS_CAPTURE_INPUT) && inputKinds.get(OBS_CAPTURE_INPUT) !== 'game_capture')
    throw new Error('Mizar 游戏采集来源名称冲突，未执行修复。');
  for (const scene of desired) {
    if (
      inputKinds.has(scene.browserInput) &&
      inputKinds.get(scene.browserInput) !== 'browser_source'
    )
      throw new Error('Mizar 浏览器来源名称冲突，未执行修复。');
  }
  if (inputKinds.get(OBS_CAPTURE_INPUT) === 'game_capture')
    await obs.call('SetInputSettings', {
      inputName: OBS_CAPTURE_INPUT,
      inputSettings: {
        capture_mode: 'window',
        window: await cs2CaptureWindow(obs),
        priority: 2,
        capture_cursor: false,
      },
      overlay: true,
    });
  for (const scene of desired) {
    if (!sceneNames.has(scene.sceneName)) {
      await obs.call('CreateScene', { sceneName: scene.sceneName });
      sceneNames.add(scene.sceneName);
    }
    if (scene.composition === 'gameplay_overlay' && !inputKinds.has(OBS_CAPTURE_INPUT)) {
      await obs.call('CreateInput', {
        sceneName: scene.sceneName,
        inputName: OBS_CAPTURE_INPUT,
        inputKind: 'game_capture',
        inputSettings: {
          capture_mode: 'window',
          window: CS2_WINDOW_FALLBACK,
          priority: 2,
          capture_cursor: false,
        },
        sceneItemEnabled: true,
      });
      inputKinds.set(OBS_CAPTURE_INPUT, 'game_capture');
      await obs.call('SetInputSettings', {
        inputName: OBS_CAPTURE_INPUT,
        inputSettings: { window: await cs2CaptureWindow(obs) },
        overlay: true,
      });
    }
    if (!inputKinds.has(scene.browserInput)) {
      await obs.call('CreateInput', {
        sceneName: scene.sceneName,
        inputName: scene.browserInput,
        inputKind: 'browser_source',
        inputSettings: { url: scene.browserUrl, width: OBS_WIDTH, height: OBS_HEIGHT },
        sceneItemEnabled: true,
      });
      inputKinds.set(scene.browserInput, 'browser_source');
    } else if (inputKinds.get(scene.browserInput) !== 'browser_source') {
      throw new Error('Mizar 来源名称与其它类型的 OBS 来源冲突，未执行修复。');
    } else {
      await obs.call('SetInputSettings', {
        inputName: scene.browserInput,
        inputSettings: { url: scene.browserUrl, width: OBS_WIDTH, height: OBS_HEIGHT },
        overlay: true,
      });
    }
    if (
      scene.composition === 'gameplay_overlay' &&
      inputKinds.get(OBS_CAPTURE_INPUT) !== 'game_capture'
    )
      throw new Error('Mizar 游戏采集来源名称冲突，未执行修复。');
    let items = objects(
      (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
    );
    for (const source of scene.sources) {
      if (!items.some((item) => item.sourceName === source)) {
        await obs.call('CreateSceneItem', {
          sceneName: scene.sceneName,
          sourceName: source,
          sceneItemEnabled: true,
        });
      }
    }
    items = objects(
      (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
    );
    for (const [source, transform] of sceneTransforms(scene)) {
      const item = items.find((candidate) => candidate.sourceName === source);
      if (!item) continue;
      if (item.sceneItemEnabled === false)
        await obs.call('SetSceneItemEnabled', {
          sceneName: scene.sceneName,
          sceneItemId: item.sceneItemId,
          sceneItemEnabled: true,
        });
      await obs.call('SetSceneItemTransform', {
        sceneName: scene.sceneName,
        sceneItemId: item.sceneItemId,
        sceneItemTransform: transform,
      });
      if (source === scene.browserInput && scene.composition === 'gameplay_overlay')
        await obs.call('SetSceneItemIndex', {
          sceneName: scene.sceneName,
          sceneItemId: item.sceneItemId,
          sceneItemIndex: items.length - 1,
        });
    }
  }
  return checkObsConfiguration(obs, baseUrl);
}

export async function switchObsScene(
  obs: ObsRpc,
  sceneId: Parameters<typeof import('./desired-state.js').obsSceneName>[0],
  options: ObsSceneSwitchOptions = { transition: { kind: 'cut', durationMs: 0 } },
) {
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    if (options.valid && !options.valid()) throw new Error('场景切换请求已失效。');
  };
  assertCurrent();
  const name = desiredSceneName(sceneId);
  const collections = await obs.call('GetSceneCollectionList');
  if (collections.currentSceneCollectionName !== OBS_COLLECTION)
    throw new Error('请先检查并修复 Mizar 场景集合。');
  const sceneList = await obs.call('GetSceneList');
  const scenes = names(sceneList.scenes, 'sceneName');
  if (!scenes.includes(name)) throw new Error('目标 OBS 场景尚未就绪，请先检查配置。');
  // OBS emits no transition event when the requested scene is already on air.
  if (sceneList.currentProgramSceneName === name) {
    const progress = await obs.call('GetCurrentSceneTransitionCursor');
    assertCurrent();
    if (progress.transitionCursor === 1) return;
  }
  const transitions = objects((await obs.call('GetSceneTransitionList')).transitions);
  const transition = transitions.find(
    (item) => item.transitionKind === `${options.transition.kind}_transition`,
  );
  if (typeof transition?.transitionName !== 'string')
    throw new Error('OBS 缺少所需的切换或淡化转场，请检查场景集合。');
  assertCurrent();
  await obs.call('SetSceneSceneTransitionOverride', {
    sceneName: name,
    transitionName: transition.transitionName,
    transitionDuration: options.transition.kind === 'fade' ? options.transition.durationMs : null,
  });
  assertCurrent();
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    let finished: Promise<void> | undefined;
    if (options.transition.kind === 'fade') {
      if (!obs.onTransitionVideoEnded) throw new Error('无法确认 OBS 转场完成。');
      finished = new Promise<void>((resolve) => {
        unsubscribe = obs.onTransitionVideoEnded!((transitionName) => {
          if (transitionName === transition.transitionName) resolve();
        });
        cancel = resolve;
        options.signal?.addEventListener('abort', cancel, { once: true });
      });
    }
    await obs.call('SetCurrentProgramScene', { sceneName: name });
    assertCurrent();
    if (finished) {
      await Promise.race([
        finished,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error('OBS 转场完成确认超时。')), 1000);
        }),
      ]);
    }
    assertCurrent();
    const current = await obs.call('GetCurrentProgramScene');
    if (current.currentProgramSceneName !== name) throw new Error('OBS 未切入目标场景。');
  } finally {
    unsubscribe?.();
    if (timer) clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener('abort', cancel);
  }
}

function desiredSceneName(id: Parameters<typeof import('./desired-state.js').obsSceneName>[0]) {
  const scene = obsDesiredScenes('http://127.0.0.1:3000').find((item) => item.id === id);
  if (!scene || !ownedScene(scene.sceneName)) throw new Error('未知 OBS 场景。');
  return scene.sceneName;
}

/** Only the first preparation may reconcile; reconnects preserve operator changes. */
export async function ensureObsConfiguration(
  obs: ObsRpc,
  baseUrl: string,
  firstPreparation: boolean,
): Promise<ObsFinding[]> {
  const findings = await checkObsConfiguration(obs, baseUrl);
  if (!firstPreparation || findings.some((finding) => finding.code === 'source_kind_conflict'))
    return findings;
  const repairable = new Set([
    'collection_missing',
    'collection_inactive',
    'scene_missing',
    'source_missing',
    'url_drift',
    'capture_drift',
    'transform_drift',
    'order_drift',
    'source_disabled',
  ]);
  return findings.some((finding) => repairable.has(finding.code))
    ? repairObsConfiguration(obs, baseUrl)
    : findings;
}
