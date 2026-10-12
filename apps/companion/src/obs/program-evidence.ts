import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import type { ObsRpc } from './reconcile.js';

export interface ObsProgramEvidence {
  readonly state: 'measured' | 'changed' | 'failed';
  readonly collection: 'mizar' | 'other';
  readonly sceneId: ProgramSceneId | null;
  readonly composition: 'gameplay_overlay' | 'full_screen_graphic' | null;
  readonly studio?: {
    enabled: boolean | null;
    previewSceneId: ProgramSceneId | null;
    previewMatchesProgram: boolean | null;
  };
  readonly layers?: readonly {
    role: 'capture' | 'browser' | 'group' | 'scene' | 'other';
    enabled: boolean | null;
    index: number | null;
    transform: Record<string, number | string | boolean | null>;
  }[];
  readonly layersTruncated?: boolean;
  readonly sources: readonly {
    role: 'capture' | 'browser';
    present: boolean;
    enabled: boolean | null;
  }[];
  readonly capture: null | {
    kind: 'game_capture' | 'other' | 'missing';
    mode: 'window' | 'other' | null;
    target: 'cs2.exe' | 'other' | null;
    targetAvailable: boolean | null;
    cs2WindowCount: number;
    videoActive: boolean | null;
    videoShowing: boolean | null;
    width: number | null;
    height: number | null;
    // OBS source activity and dimensions do not prove the hook or process identity.
    processIdentity: 'unavailable';
    frameHealth: 'unverified';
  };
}

function objects(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : [];
}
const bool = (value: unknown) => (typeof value === 'boolean' ? value : null);
const dimension = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1_000_000
    ? value
    : null;
function transformEvidence(value: unknown): Record<string, number | string | boolean | null> {
  const transform = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  return {
    cropToBounds: bool(transform.cropToBounds),
    ...Object.fromEntries(
      [
        'positionX',
        'positionY',
        'rotation',
        'scaleX',
        'scaleY',
        'sourceWidth',
        'sourceHeight',
        'width',
        'height',
        'cropLeft',
        'cropRight',
        'cropTop',
        'cropBottom',
        'boundsWidth',
        'boundsHeight',
        'alignment',
        'boundsAlignment',
      ].map((key) => [key, finite(transform[key])]),
    ),
    boundsType: [
      'OBS_BOUNDS_NONE',
      'OBS_BOUNDS_STRETCH',
      'OBS_BOUNDS_SCALE_INNER',
      'OBS_BOUNDS_SCALE_OUTER',
      'OBS_BOUNDS_SCALE_TO_WIDTH',
      'OBS_BOUNDS_SCALE_TO_HEIGHT',
      'OBS_BOUNDS_MAX_ONLY',
    ].includes(String(transform.boundsType))
      ? String(transform.boundsType)
      : null,
  };
}
function cs2Window(value: unknown): boolean {
  return (
    typeof value === 'string' &&
    value.split(':').length === 3 &&
    value.split(':')[2]?.toLowerCase() === 'cs2.exe'
  );
}

/** Read only owned inputs; never export arbitrary scene names, window titles or settings. */
export async function readObsProgramEvidence(
  obs: ObsRpc,
  baseUrl: string,
  currentScene: string | null,
): Promise<ObsProgramEvidence> {
  const [collections, scenes] = await Promise.all([
    obs.call('GetSceneCollectionList'),
    obs.call('GetSceneList').catch(() => null),
  ]);
  const collection = collections.currentSceneCollectionName;
  const scene =
    collection === OBS_COLLECTION
      ? obsDesiredScenes(baseUrl).find((item) => item.sceneName === currentScene)
      : undefined;
  const evidence: ObsProgramEvidence = {
    state:
      typeof scenes?.currentProgramSceneName === 'string' &&
      scenes.currentProgramSceneName !== currentScene
        ? 'changed'
        : 'measured',
    collection: collection === OBS_COLLECTION ? 'mizar' : 'other',
    sceneId: scene?.id ?? null,
    composition: scene?.composition ?? null,
    studio: {
      // GetSceneList returns null Preview when Studio Mode is disabled.
      enabled:
        scenes === null
          ? null
          : typeof scenes.currentPreviewSceneName === 'string'
            ? true
            : scenes.currentPreviewSceneName === null
              ? false
              : null,
      previewSceneId:
        collection === OBS_COLLECTION
          ? (obsDesiredScenes(baseUrl).find(
              (item) => item.sceneName === scenes?.currentPreviewSceneName,
            )?.id ?? null)
          : null,
      previewMatchesProgram:
        typeof scenes?.currentPreviewSceneName === 'string' &&
        typeof scenes.currentProgramSceneName === 'string'
          ? scenes.currentPreviewSceneName === scenes.currentProgramSceneName
          : null,
    },
    sources: [],
    capture: null,
  };
  if (!scene) return evidence;
  const items = objects(
    (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
  );
  const sources = scene.sources.map((name) => {
    const item = items.find((candidate) => candidate.sourceName === name);
    return {
      role: name === OBS_CAPTURE_INPUT ? ('capture' as const) : ('browser' as const),
      present: item !== undefined,
      enabled: bool(item?.sceneItemEnabled),
    };
  });
  // OBS includes live transforms in this response. Project only numeric geometry
  // and known roles; arbitrary source names, types and plugin settings stay local.
  const layers = items.slice(0, 32).map((item) => ({
    role:
      item.sourceName === OBS_CAPTURE_INPUT
        ? ('capture' as const)
        : item.sourceName === scene.browserInput
          ? ('browser' as const)
          : item.isGroup === true
            ? ('group' as const)
            : item.sourceType === 'OBS_SOURCE_TYPE_SCENE'
              ? ('scene' as const)
              : ('other' as const),
    enabled: bool(item.sceneItemEnabled),
    index: finite(item.sceneItemIndex),
    transform: transformEvidence(item.sceneItemTransform),
  }));
  let capture: ObsProgramEvidence['capture'] = null;
  if (scene.composition === 'gameplay_overlay') {
    const inputs = objects((await obs.call('GetInputList')).inputs);
    const input = inputs.find((candidate) => candidate.inputName === OBS_CAPTURE_INPUT);
    capture = {
      kind: input ? (input.inputKind === 'game_capture' ? 'game_capture' : 'other') : 'missing',
      mode: null,
      target: null,
      targetAvailable: null,
      cs2WindowCount: 0,
      videoActive: null,
      videoShowing: null,
      width: null,
      height: null,
      processIdentity: 'unavailable',
      frameHealth: 'unverified',
    };
    if (capture.kind === 'game_capture') {
      const settings = (await obs.call('GetInputSettings', { inputName: OBS_CAPTURE_INPUT }))
        .inputSettings as Record<string, unknown> | undefined;
      const windows = objects(
        (
          await obs.call('GetInputPropertiesListPropertyItems', {
            inputName: OBS_CAPTURE_INPUT,
            propertyName: 'window',
          })
        ).propertyItems,
      ).filter((item) => item.itemEnabled !== false);
      const activity = await obs.call('GetSourceActive', { sourceName: OBS_CAPTURE_INPUT });
      const item = items.find((candidate) => candidate.sourceName === OBS_CAPTURE_INPUT);
      const transform =
        typeof item?.sceneItemId === 'number'
          ? ((
              await obs.call('GetSceneItemTransform', {
                sceneName: scene.sceneName,
                sceneItemId: item.sceneItemId,
              })
            ).sceneItemTransform as Record<string, unknown> | undefined)
          : undefined;
      capture = {
        ...capture,
        mode: settings?.capture_mode === 'window' ? 'window' : 'other',
        target:
          typeof settings?.window === 'string'
            ? cs2Window(settings.window)
              ? 'cs2.exe'
              : 'other'
            : null,
        targetAvailable:
          typeof settings?.window === 'string'
            ? windows.some((candidate) => candidate.itemValue === settings.window)
            : null,
        cs2WindowCount: windows.filter((candidate) => cs2Window(candidate.itemValue)).length,
        videoActive: bool(activity.videoActive),
        videoShowing: bool(activity.videoShowing),
        width: dimension(transform?.sourceWidth),
        height: dimension(transform?.sourceHeight),
      };
    }
  }
  const after = await obs.call('GetCurrentProgramScene');
  const afterCollection = await obs.call('GetSceneCollectionList');
  return {
    ...evidence,
    sources,
    layers,
    layersTruncated: items.length > 32,
    capture,
    state:
      evidence.state === 'measured' &&
      after.currentProgramSceneName === currentScene &&
      afterCollection.currentSceneCollectionName === collection
        ? 'measured'
        : 'changed',
  };
}
