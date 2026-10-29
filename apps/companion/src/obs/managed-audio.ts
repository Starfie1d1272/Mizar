import { AudioMigration, type MigrationObserver } from './audio-migration.js';
import { OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import type { ObsRpc } from './reconcile.js';
import type { ObsAudioRole } from '@mizar/protocol/obs';

const audioKinds = new Set([
  'wasapi_output_capture',
  'wasapi_input_capture',
  'wasapi_process_output_capture',
]);
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object'))
    throw new Error('audio_response_unknown');
  return value as Record<string, unknown>[];
}

/** Apply the selected roles to Mizar scene references without editing shared source settings. */
export async function reconcileManagedAudio(
  obs: ObsRpc,
  endpoint: string,
  observer: MigrationObserver,
  journal: string,
  baseUrl: string,
  ids: Record<ObsAudioRole, string>,
  verify: () => Promise<boolean>,
  desktopUuid?: string,
): Promise<void> {
  if (new Set(Object.values(ids)).size !== 3) throw new Error('audio_binding_duplicate');
  const inputs = records((await obs.call('GetInputList')).inputs);
  if (desktopUuid) {
    if (Object.values(ids).includes(desktopUuid)) throw new Error('audio_binding_duplicate');
    if (
      !inputs.some(
        (input) => input.inputUuid === desktopUuid && input.inputKind === 'wasapi_output_capture',
      )
    )
      throw new Error('audio_desktop_missing');
  }
  const wantedIds = desktopUuid ? [desktopUuid, ids.microphone] : Object.values(ids);
  const selected = wantedIds.map((uuid) => {
    const input = inputs.find((value) => value.inputUuid === uuid);
    if (!input || typeof input.inputName !== 'string') throw new Error('audio_selection_changed');
    return input;
  });
  let changed = false;
  let preparing = true;
  const snapshots = new Map<string, string>();
  const stop = observer.subscribe((event) => {
    if (event.type !== 'item' && !(preparing && event.type === 'identityChanged')) changed = true;
  });
  const check = async () => {
    const [stream, record, collection, specials] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
      obs.call('GetSceneCollectionList'),
      obs.call('GetSpecialInputs'),
    ]);
    if (
      changed ||
      !(await verify()) ||
      stream.outputActive !== false ||
      record.outputActive !== false ||
      collection.currentSceneCollectionName !== OBS_COLLECTION
    )
      throw new Error('audio_setup_context_changed');
    if (Object.values(specials).some((value) => typeof value === 'string' && value.length))
      throw new Error('audio_global_path_unresolved');
  };
  try {
    await check();
    const desktop: { sceneName: string; sceneItemId: number; sourceUuid: string }[] = [];
    const independent: typeof desktop = [];
    for (const { sceneName } of obsDesiredScenes(baseUrl)) {
      let items = records((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
      if (
        items.some(
          (item) =>
            item.sceneItemEnabled !== false &&
            (item.isGroup === true || item.sourceType === 'OBS_SOURCE_TYPE_SCENE'),
        )
      )
        throw new Error('audio_nested_path_unresolved');
      for (const input of selected) {
        if (!items.some((item) => item.sourceUuid === input.inputUuid)) {
          await check();
          await obs.call('CreateSceneItem', {
            sceneName,
            sourceName: input.inputName,
            sceneItemEnabled: false,
          });
          items = records((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
        }
        if (items.filter((item) => item.sourceUuid === input.inputUuid).length !== 1)
          throw new Error('audio_duplicate_path');
      }
      snapshots.set(sceneName, JSON.stringify(items));
      for (const item of items) {
        const input = inputs.find((value) => value.inputUuid === item.sourceUuid);
        if (!input) continue;
        const wanted = wantedIds.includes(String(input.inputUuid));
        if (
          ['game_capture', 'window_capture'].includes(String(input.inputKind)) &&
          !wanted &&
          item.sceneItemEnabled !== false
        ) {
          const settings = (await obs.call('GetInputSettings', { inputUuid: input.inputUuid }))
            .inputSettings as Record<string, unknown>;
          if (settings?.capture_audio === true) throw new Error('audio_video_path_unresolved');
        }
        if (!wanted && !audioKinds.has(String(input.inputKind))) continue;
        if (
          typeof item.sceneItemId !== 'number' ||
          typeof item.sourceUuid !== 'string' ||
          typeof item.sceneItemEnabled !== 'boolean'
        )
          throw new Error('audio_response_unknown');
        const ref = { sceneName, sceneItemId: item.sceneItemId, sourceUuid: item.sourceUuid };
        if (wanted && !item.sceneItemEnabled) independent.push(ref);
        if (!wanted && item.sceneItemEnabled) desktop.push(ref);
      }
    }
    preparing = false;
    for (const [sceneName, snapshot] of snapshots)
      if (
        JSON.stringify((await obs.call('GetSceneItemList', { sceneName })).sceneItems) !== snapshot
      )
        throw new Error('audio_scene_changed');
    await check();
    if (desktop.length || independent.length)
      await new AudioMigration(`${journal}.migration`).migrate(
        obs,
        endpoint,
        { endpoint, collection: OBS_COLLECTION, desktop, independent },
        observer,
      );
    await check();
  } finally {
    stop();
  }
}
