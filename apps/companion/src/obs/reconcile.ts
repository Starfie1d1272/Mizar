import {
  OBS_CAPTURE_INPUT,
  OBS_COLLECTION,
  OBS_HEIGHT,
  OBS_WIDTH,
  obsDesiredScenes,
  obsSceneName,
} from './desired-state.js';
import type { ProgramSceneId, ProgramTransition } from '@mizar/protocol/program-scenes';
import {
  assertNoVideoOutput,
  ObsPreparationWriteBlocked,
  ObsVideoError,
} from './video-transaction.js';

export interface ObsSceneItemRef {
  readonly sceneName: string;
  readonly sceneItemId: number;
  readonly sourceUuid: string;
}

export interface ObsRpc {
  /** The call forwards onDispatch to the transport after all asynchronous guards. */
  readonly reportsDispatch?: true;
  /** Original identity key after a registered OBS instance proves a changed connection address. */
  readonly identityEndpoint?: string;
  /** Compose synchronous lease checks at the final mutation dispatch, after identity reads. */
  withMutationGuard?(guard: () => void): ObsRpc;
  /** Global OBS instance plus locally registered UUID graph; never a profile identity. */
  ownershipScope?(): Promise<string>;
  managedInputIdentity?(name: string): Promise<{ uuid: string; kind: string } | null>;
  observeManagedResources?(): Promise<boolean>;
  prepareManagedCollection?(allowChange: boolean, writer: ObsRpc): Promise<void>;
  managedResourcesDrift?(): Promise<boolean>;
  normalizeManagedResources?(
    writer: ObsRpc,
    protectedItems?: readonly ObsSceneItemRef[],
  ): Promise<void>;
  pruneManagedResources?(
    writer: ObsRpc,
    protectedItems?: readonly ObsSceneItemRef[],
  ): Promise<void>;
  /** Audio graph cleanup runs only after its journals and bindings are confirmed. */
  reconcileManagedAudioResources?(writer: ObsRpc): Promise<void>;
  call(
    type: string,
    data?: Record<string, unknown>,
    onDispatch?: () => void,
  ): Promise<Record<string, unknown>>;
  onTransitionVideoEnded?(listener: (transitionName: string) => void): () => void;
}

/** Only these fixed, actionable exit messages may cross the scene-control boundary. */
export class ObsExitSafetyError extends Error {}

export interface ObsSceneSwitchOptions {
  readonly transition: ProgramTransition;
  readonly onStarted?: () => void;
  readonly onCompleted?: () => void;
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

async function cs2CaptureWindow(obs: ObsRpc) {
  const properties = await obs.call('GetInputPropertiesListPropertyItems', {
    inputName: OBS_CAPTURE_INPUT,
    propertyName: 'window',
  });
  const windows = objects(properties.propertyItems).filter(
    (item) => item.itemEnabled !== false && isCs2Window(item.itemValue),
  );
  return {
    source: windows.length === 1 ? ('enumerated' as const) : ('unresolved' as const),
    candidateCount: windows.length,
    window: windows.length === 1 ? (windows[0]!.itemValue as string) : null,
  };
}

/** Recheck only the managed capture target after CS2 starts, before creating a warmup item. */
export async function prepareCaptureWindow(obs: ObsRpc): Promise<boolean> {
  const changed = () =>
    new ObsVideoError(
      'capture_target_changed',
      'OBS 游戏采集目标已变化，请停止输出后检查并修复 Mizar 场景，再重试准备。',
    );
  const identity = async () => {
    if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION)
      throw changed();
    if ((await obs.call('GetSceneList')).currentProgramSceneName !== obsSceneName('waiting'))
      throw changed();
    const inputs = objects((await obs.call('GetInputList')).inputs).filter(
      (item) => item.inputName === OBS_CAPTURE_INPUT,
    );
    if (
      inputs.length !== 1 ||
      inputs[0]?.inputKind !== 'game_capture' ||
      typeof inputs[0]?.inputUuid !== 'string'
    )
      throw changed();
    return inputs[0].inputUuid;
  };
  const uuid = await identity();
  const read = async () =>
    (await obs.call('GetInputSettings', { inputUuid: uuid })).inputSettings as
      Record<string, unknown> | undefined;
  const before = await read();
  if (before?.capture_mode !== 'window') throw changed();
  const target = await cs2CaptureWindow(obs);
  if (target.candidateCount > 1)
    throw new ObsVideoError(
      'capture_target_ambiguous',
      'OBS 检测到多个 CS2 窗口，未自动选择。请关闭多余游戏窗口，再重试准备。',
    );
  if (target.source !== 'enumerated') return false;
  if (before.window === target.window) return true;
  await assertNoVideoOutput(obs);
  const current = await read();
  const latest = await cs2CaptureWindow(obs);
  if (
    current?.capture_mode !== before.capture_mode ||
    current.window !== before.window ||
    latest.source !== 'enumerated' ||
    latest.window !== target.window ||
    (await identity()) !== uuid
  )
    throw changed();
  await guardedPreparationWrites(obs).call('SetInputSettings', {
    inputUuid: uuid,
    inputSettings: { window: target.window },
    overlay: true,
  });
  const confirmed = await read();
  const actual = await cs2CaptureWindow(obs);
  if (
    confirmed?.capture_mode !== 'window' ||
    confirmed.window !== target.window ||
    actual.source !== 'enumerated' ||
    actual.window !== target.window ||
    (await identity()) !== uuid
  )
    throw changed();
  return true;
}

// OBS WebSocket returns collection names as strings, unlike scene/input lists.
function collectionNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function ownedScene(name: string): boolean {
  return obsDesiredScenes('http://127.0.0.1').some((scene) => scene.sceneName === name);
}

/** Reload only exact Mizar program URLs, without changing scenes or user settings. */
export async function refreshObsBrowserSources(
  obs: ObsRpc,
  baseUrl: string,
  refreshed: Set<string>,
  buildId = 'development',
): Promise<boolean> {
  const collections = await obs.call('GetSceneCollectionList');
  if (collections.currentSceneCollectionName !== OBS_COLLECTION) return false;
  const scope = (await obs.ownershipScope?.()) ?? OBS_COLLECTION;
  const inputs = objects((await obs.call('GetInputList')).inputs);
  for (const scene of obsDesiredScenes(baseUrl)) {
    const input = inputs.find(
      (item) => item.inputName === scene.browserInput && item.inputKind === 'browser_source',
    );
    if (!input) continue;
    const uuid = typeof input.inputUuid === 'string' ? input.inputUuid : undefined;
    if (!uuid) continue;
    const key = `${scope}|${baseUrl}|${buildId}|${uuid}`;
    if (refreshed.has(key)) continue;
    const identity = { inputUuid: uuid };
    const result = await obs.call('GetInputSettings', identity);
    const settings = result.inputSettings as Record<string, unknown> | undefined;
    if (settings?.url !== scene.browserUrl) continue;
    // Recheck ownership after reading settings: an operator may switch collections.
    const current = await obs.call('GetSceneCollectionList');
    if (current.currentSceneCollectionName !== OBS_COLLECTION) return false;
    const currentInputs = objects((await obs.call('GetInputList')).inputs);
    if (
      !currentInputs.some(
        (item) =>
          item.inputName === scene.browserInput &&
          item.inputKind === 'browser_source' &&
          item.inputUuid === uuid,
      )
    )
      continue;
    const latest = await obs.call('GetInputSettings', identity);
    if ((latest.inputSettings as Record<string, unknown> | undefined)?.url !== scene.browserUrl)
      continue;
    await assertNoVideoOutput(obs);
    const press = obs.call('PressInputPropertiesButton', {
      ...identity,
      propertyName: 'refreshnocache',
    });
    // A lost reply cannot prove that OBS did not refresh. Do not replay it.
    refreshed.add(key);
    await press;
  }
  return obsDesiredScenes(baseUrl).every((scene) => {
    const input = inputs.find(
      (item) => item.inputName === scene.browserInput && item.inputKind === 'browser_source',
    );
    return (
      input !== undefined &&
      typeof input.inputUuid === 'string' &&
      refreshed.has(`${scope}|${baseUrl}|${buildId}|${input.inputUuid}`)
    );
  });
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

export function guardedPreparationWrites(obs: ObsRpc): ObsRpc {
  return {
    ...obs,
    call: async (type, data, onDispatch) => {
      if (/^(Create|Set|Remove)/.test(type)) {
        try {
          await assertNoVideoOutput(obs);
        } catch (error) {
          throw new ObsPreparationWriteBlocked(error);
        }
      }
      return obs.call(type, data, onDispatch);
    },
  };
}

export async function checkObsConfiguration(
  obs: ObsRpc,
  baseUrl: string,
  hiddenHud: { sceneUuid: string; inputUuid: string; itemId: number } | null = null,
): Promise<ObsFinding[]> {
  const desired = obsDesiredScenes(baseUrl);
  const findings: ObsFinding[] = [];
  const collections = await obs.call('GetSceneCollectionList');
  if (!collectionNames(collections.sceneCollections).includes(OBS_COLLECTION)) {
    findings.push({ code: 'collection_missing', message: '「Mizar 制播」场景集合尚未创建。' });
    return findings;
  }
  if (collections.currentSceneCollectionName !== OBS_COLLECTION) {
    findings.push({
      code: 'collection_inactive',
      message: '当前未使用 「Mizar 制播」场景集合。',
    });
    return findings;
  }
  if (obs.observeManagedResources && !(await obs.observeManagedResources()))
    return [
      { code: 'resource_identity_missing', message: '专用集合尚未登记，不能接管已有同名集合。' },
    ];
  if (obs.managedResourcesDrift && (await obs.managedResourcesDrift()))
    findings.push({
      code: 'managed_collection_drift',
      message: '专用场景集合需要整理，手动增改将在准备时清除。',
    });
  const transitionKinds = new Set(
    objects((await obs.call('GetSceneTransitionList')).transitions).map(
      (item) => item.transitionKind,
    ),
  );
  if (!transitionKinds.has('fade_transition') || !transitionKinds.has('cut_transition'))
    findings.push({
      code: 'transition_missing',
      message: '「Mizar 制播」场景集合缺少淡化或直接切换转场，请在 OBS 中补齐。',
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
      (currentWindow.source === 'enumerated' && settings.window !== currentWindow.window) ||
      settings.priority !== 2
    )
      findings.push({
        code: 'capture_drift',
        message: 'Mizar 游戏采集目标已失效，请停止输出后修复场景。',
      });
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
      else if (
        items.find((item) => item.sourceName === source)?.sceneItemEnabled === false &&
        !(
          hiddenHud &&
          scene.id === 'gameplay' &&
          source === scene.browserInput &&
          objects(scenes.scenes).some(
            (item) => item.sceneName === scene.sceneName && item.sceneUuid === hiddenHud.sceneUuid,
          ) &&
          objects(inputs.inputs).some(
            (item) => item.inputName === source && item.inputUuid === hiddenHud.inputUuid,
          ) &&
          items.find((item) => item.sourceName === source)?.sceneItemId === hiddenHud.itemId
        )
      )
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

export async function repairObsConfiguration(
  obs: ObsRpc,
  baseUrl: string,
  options: {
    readonly allowCollectionChange?: boolean;
    readonly force?: boolean;
    readonly protectedItems?: readonly ObsSceneItemRef[];
  } = {},
): Promise<ObsFinding[]> {
  const desired = obsDesiredScenes(baseUrl);
  const before = await checkObsConfiguration(obs, baseUrl);
  if (
    options.allowCollectionChange === false &&
    before.some((finding) => ['collection_missing', 'collection_inactive'].includes(finding.code))
  )
    return before;
  if (
    !options.force &&
    !before.some((finding) => !['video_settings', 'transition_missing'].includes(finding.code))
  )
    return before;
  await assertNoVideoOutput(obs);
  obs = guardedPreparationWrites(obs);
  const collections = await obs.call('GetSceneCollectionList');
  const exists = collectionNames(collections.sceneCollections).includes(OBS_COLLECTION);
  if (
    options.allowCollectionChange === false &&
    (!exists || collections.currentSceneCollectionName !== OBS_COLLECTION)
  )
    throw new Error('OBS 场景集合已改变，请在 OBS 中选择「Mizar 制播」后重新检查。');
  if (!obs.prepareManagedCollection) throw new Error('OBS 专用集合管理不可用。');
  await obs.prepareManagedCollection(options.allowCollectionChange !== false, obs);
  await obs.normalizeManagedResources?.(obs, options.protectedItems);
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
  if (inputKinds.get(OBS_CAPTURE_INPUT) === 'game_capture') {
    const target = await cs2CaptureWindow(obs);
    await obs.call('SetInputSettings', {
      inputName: OBS_CAPTURE_INPUT,
      inputSettings: {
        capture_mode: 'window',
        ...(target.source === 'enumerated' ? { window: target.window } : {}),
        priority: 2,
        capture_cursor: false,
      },
      overlay: true,
    });
  }
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
          capture_audio: false,
        },
        sceneItemEnabled: true,
      });
      inputKinds.set(OBS_CAPTURE_INPUT, 'game_capture');
      const target = await cs2CaptureWindow(obs);
      if (target.source === 'enumerated')
        await obs.call('SetInputSettings', {
          inputName: OBS_CAPTURE_INPUT,
          inputSettings: { window: target.window },
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
        overlay: false,
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
      if (
        item.sceneItemEnabled === false &&
        !options.protectedItems?.some(
          (ref) =>
            ref.sceneName === scene.sceneName &&
            ref.sceneItemId === item.sceneItemId &&
            ref.sourceUuid === item.sourceUuid,
        )
      )
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
  await obs.pruneManagedResources?.(obs, options.protectedItems);
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
    throw new Error('请先检查并修复 「Mizar 制播」场景集合。');
  const sceneList = await obs.call('GetSceneList');
  const scenes = names(sceneList.scenes, 'sceneName');
  if (!scenes.includes(name)) throw new Error('目标 OBS 场景尚未就绪，请先检查配置。');
  // A target owns only its actual visual dependencies, not whole-collection readiness.
  const items = objects((await obs.call('GetSceneItemList', { sceneName: name })).sceneItems);
  const desired = obsDesiredScenes('http://127.0.0.1').find((scene) => scene.id === sceneId)!;
  for (const source of desired.sources) {
    const matches = items.filter((item) => item.sourceName === source);
    const identity = await obs.managedInputIdentity?.(source);
    if (
      matches.length !== 1 ||
      matches[0]?.sceneItemEnabled !== true ||
      (obs.managedInputIdentity && (!identity || matches[0]?.sourceUuid !== identity.uuid))
    )
      throw new ObsVideoError(
        'scene_target_unavailable',
        '目标场景的画面来源未确认，请核对该场景。',
      );
  }
  for (const item of items.filter(
    (item) => ['音乐', '音效'].includes(String(item.sourceName)) && item.sceneItemEnabled !== false,
  )) {
    const identity = await obs.managedInputIdentity?.(String(item.sourceName));
    const transform = (
      await obs.call('GetSceneItemTransform', { sceneName: name, sceneItemId: item.sceneItemId })
    ).sceneItemTransform as Record<string, unknown> | undefined;
    if (
      !identity ||
      identity.uuid !== item.sourceUuid ||
      identity.kind !== 'ffmpeg_source' ||
      transform?.boundsType !== 'OBS_BOUNDS_NONE' ||
      transform.scaleX !== 0 ||
      transform.scaleY !== 0
    )
      throw new ObsVideoError(
        'scene_music_layout_unconfirmed',
        '目标场景的音乐纯音频布局未确认，请核对该场景。',
      );
  }
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
    options.onStarted?.();
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
    assertCurrent();
    if (current.currentProgramSceneName !== name) throw new Error('OBS 未切入目标场景。');
    options.onCompleted?.();
  } finally {
    unsubscribe?.();
    if (timer) clearTimeout(timer);
    if (cancel) options.signal?.removeEventListener('abort', cancel);
  }
}

/** Align the explicit preparation target only while its original scene and lease remain valid. */
export async function alignPreparationScene(
  obs: ObsRpc,
  activeScene: () => Parameters<typeof import('./desired-state.js').obsSceneName>[0],
  valid: () => boolean,
): Promise<void> {
  const target = activeScene();
  const initial = (await obs.call('GetCurrentProgramScene')).currentProgramSceneName;
  if (typeof initial !== 'string') throw new Error('OBS 当前场景状态未确认。');
  if (!valid() || activeScene() !== target) throw new Error('OBS 准备请求已失效，请重试。');
  if (initial === desiredSceneName(target)) return;
  const stable: ObsRpc = guardedPreparationWrites({
    ...obs,
    call: async (type, data, onDispatch) => {
      if (type === 'SetCurrentProgramScene') {
        const current = (await obs.call('GetCurrentProgramScene')).currentProgramSceneName;
        if (current !== initial) throw new Error('OBS 当前场景已变化，请重试。');
      }
      if (!valid() || activeScene() !== target) throw new Error('OBS 准备请求已失效，请重试。');
      return obs.call(type, data, onDispatch);
    },
  });
  await switchObsScene(stable, target, { transition: { kind: 'cut', durationMs: 0 }, valid });
}

function desiredSceneName(id: Parameters<typeof import('./desired-state.js').obsSceneName>[0]) {
  const scene = obsDesiredScenes('http://127.0.0.1:3000').find((item) => item.id === id);
  if (!scene || !ownedScene(scene.sceneName)) throw new Error('未知 OBS 场景。');
  return scene.sceneName;
}

/** Restore owned scenes only in the active Mizar collection; never take over another collection. */
export async function ensureObsConfiguration(
  obs: ObsRpc,
  baseUrl: string,
  activeScene: () => ProgramSceneId = () => 'waiting',
  allowCollectionChange = false,
  protectedItems: readonly ObsSceneItemRef[] = [],
): Promise<ObsFinding[]> {
  const findings = await checkObsConfiguration(obs, baseUrl);
  const collectionChanged = findings.some((finding) =>
    ['collection_missing', 'collection_inactive'].includes(finding.code),
  );
  if (allowCollectionChange) {
    // Explicit preparation owns the complete template, including manual edits
    // that do not affect the lightweight runtime readiness checks.
    const repaired = await repairObsConfiguration(obs, baseUrl, { force: true, protectedItems });
    if (
      collectionChanged &&
      !repaired.some((item) =>
        ['scene_missing', 'source_kind_conflict', 'transition_missing'].includes(item.code),
      )
    ) {
      await assertNoVideoOutput(obs);
      await switchObsScene(guardedPreparationWrites(obs), activeScene());
    }
    return repaired;
  }
  if (collectionChanged) return findings;
  const repairable = new Set([
    'managed_collection_drift',
    'source_kind_conflict',
    'resource_identity_missing',
    'scene_missing',
    'source_missing',
    'url_drift',
    'capture_drift',
    'transform_drift',
    'order_drift',
    'source_disabled',
  ]);
  if (findings.some((finding) => repairable.has(finding.code)))
    return repairObsConfiguration(obs, baseUrl, { allowCollectionChange: false, protectedItems });
  return findings;
}
