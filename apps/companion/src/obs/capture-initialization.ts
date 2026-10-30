import type { ObsCaptureDiagnostic } from '@mizar/protocol/obs';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsSceneName } from './desired-state.js';
import type { ObsRpc } from './reconcile.js';

export type CaptureInitializationReason =
  | 'source_unavailable'
  | 'target_unavailable'
  | 'target_ambiguous'
  | 'source_inactive'
  | 'zero_size'
  | 'hook_pending'
  | 'hook_failed'
  | 'evidence_unknown';

export interface CaptureInitialization {
  state: 'initialized' | 'waiting' | 'failed' | 'unknown';
  reason: CaptureInitializationReason | null;
  captureDiagnostic: ObsCaptureDiagnostic;
}

const objects = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object')
    : [];
const cs2Window = (value: unknown) =>
  typeof value === 'string' &&
  value.split(':').length === 3 &&
  value.toLowerCase().endsWith(':cs2.exe');

/** Read current managed source facts without switching the user's OBS program or preview. */
export async function readCaptureInitialization(
  obs: ObsRpc,
  diagnostic: ObsCaptureDiagnostic,
): Promise<CaptureInitialization> {
  const result = (
    state: CaptureInitialization['state'],
    reason: CaptureInitializationReason | null,
  ) => ({ state, reason, captureDiagnostic: diagnostic }) as const;
  if (diagnostic.state === 'needs_attention' && diagnostic.reason !== 'hook_pending')
    return result('failed', 'hook_failed');
  if ((await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION)
    return result('unknown', 'source_unavailable');
  const input = objects((await obs.call('GetInputList')).inputs).filter(
    (item) => item.inputName === OBS_CAPTURE_INPUT && item.inputKind === 'game_capture',
  );
  if (input.length !== 1 || typeof input[0]?.inputUuid !== 'string')
    return result('unknown', 'source_unavailable');
  const settings = (await obs.call('GetInputSettings', { inputName: OBS_CAPTURE_INPUT }))
    .inputSettings as Record<string, unknown> | undefined;
  if (settings?.capture_mode !== 'window' || !cs2Window(settings.window))
    return result('unknown', 'target_unavailable');
  const windows = objects(
    (
      await obs.call('GetInputPropertiesListPropertyItems', {
        inputName: OBS_CAPTURE_INPUT,
        propertyName: 'window',
      })
    ).propertyItems,
  ).filter((item) => item.itemEnabled !== false && cs2Window(item.itemValue));
  if (windows.length > 1) return result('failed', 'target_ambiguous');
  if (windows.length !== 1 || windows[0]?.itemValue !== settings.window)
    return result('waiting', 'target_unavailable');
  const sceneName = obsSceneName('gameplay');
  const items = objects((await obs.call('GetSceneItemList', { sceneName })).sceneItems).filter(
    (item) => item.sourceName === OBS_CAPTURE_INPUT && item.sceneItemEnabled === true,
  );
  if (items.length !== 1 || typeof items[0]?.sceneItemId !== 'number')
    return result('unknown', 'source_unavailable');
  const activity = await obs.call('GetSourceActive', { sourceName: OBS_CAPTURE_INPUT });
  if (activity.videoShowing !== true)
    return result(activity.videoShowing === false ? 'waiting' : 'unknown', 'source_inactive');
  const transform = (
    await obs.call('GetSceneItemTransform', {
      sceneName,
      sceneItemId: items[0].sceneItemId,
    })
  ).sceneItemTransform as Record<string, unknown> | undefined;
  if (
    typeof transform?.sourceWidth !== 'number' ||
    !Number.isFinite(transform.sourceWidth) ||
    typeof transform.sourceHeight !== 'number' ||
    !Number.isFinite(transform.sourceHeight)
  )
    return result('unknown', 'evidence_unknown');
  if (transform.sourceWidth <= 0 || transform.sourceHeight <= 0)
    return result('waiting', 'zero_size');
  if (diagnostic.state === 'needs_attention') return result('waiting', 'hook_pending');
  // Recheck identity and collection after all observations to reject mid-read changes.
  const current = objects((await obs.call('GetInputList')).inputs).find(
    (item) => item.inputName === OBS_CAPTURE_INPUT,
  );
  const finalSettings = (await obs.call('GetInputSettings', { inputName: OBS_CAPTURE_INPUT }))
    .inputSettings as Record<string, unknown> | undefined;
  const finalActivity = await obs.call('GetSourceActive', { sourceName: OBS_CAPTURE_INPUT });
  const finalItems = objects((await obs.call('GetSceneItemList', { sceneName })).sceneItems).filter(
    (item) => item.sourceName === OBS_CAPTURE_INPUT && item.sceneItemEnabled === true,
  );
  const finalWindows = objects(
    (
      await obs.call('GetInputPropertiesListPropertyItems', {
        inputName: OBS_CAPTURE_INPUT,
        propertyName: 'window',
      })
    ).propertyItems,
  ).filter((item) => item.itemEnabled !== false && cs2Window(item.itemValue));
  const finalTransform = (
    await obs.call('GetSceneItemTransform', { sceneName, sceneItemId: items[0].sceneItemId })
  ).sceneItemTransform as Record<string, unknown> | undefined;
  if (
    current?.inputUuid !== input[0].inputUuid ||
    finalSettings?.capture_mode !== 'window' ||
    finalSettings.window !== settings.window ||
    finalActivity.videoShowing !== true ||
    finalItems.length !== 1 ||
    finalItems[0]?.sceneItemId !== items[0].sceneItemId ||
    finalWindows.length !== 1 ||
    finalWindows[0]?.itemValue !== settings.window ||
    typeof finalTransform?.sourceWidth !== 'number' ||
    !Number.isFinite(finalTransform.sourceWidth) ||
    finalTransform.sourceWidth <= 0 ||
    typeof finalTransform.sourceHeight !== 'number' ||
    !Number.isFinite(finalTransform.sourceHeight) ||
    finalTransform.sourceHeight <= 0 ||
    (await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== OBS_COLLECTION
  )
    return result('unknown', 'evidence_unknown');
  return result('initialized', null);
}
