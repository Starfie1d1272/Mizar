import {
  AudioMigration,
  type AudioMonitorChange,
  type MigrationObserver,
} from './audio-migration.js';
import { inspectAudioSceneGraph } from './audio-scene-graph.js';
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
  completedPath?: string,
  monitor: AudioMonitorChange[] = [],
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
  let migrating = false;
  const snapshots = new Map<string, string>();
  const stop = observer.subscribe((event) => {
    if (
      event.type !== 'item' &&
      !(preparing && event.type === 'identityChanged') &&
      !(migrating && (event.type === 'inputSettings' || event.type === 'monitor'))
    )
      changed = true;
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
    const desktop: {
      sceneName: string;
      sceneItemId: number;
      sourceUuid: string;
      group?: boolean;
    }[] = [];
    const independent: typeof desktop = [];
    const desired = obsDesiredScenes(baseUrl);
    const graph = await inspectAudioSceneGraph(
      obs,
      desired.map((scene) => scene.sceneName),
    );
    const captureAudio: {
      inputUuid: string;
      inputKind: 'game_capture' | 'window_capture';
      before: boolean;
      applied: boolean;
    }[] = [];
    if (desktopUuid) {
      for (const input of inputs) {
        if (
          (input.inputKind !== 'game_capture' && input.inputKind !== 'window_capture') ||
          typeof input.inputUuid !== 'string'
        )
          continue;
        const references = graph.filter((container) =>
          container.items.some((item) => item.sourceUuid === input.inputUuid),
        );
        if (
          !references.some(
            (container) =>
              container.activeManagedRoots.size &&
              container.items.some(
                (item) => item.sourceUuid === input.inputUuid && item.sceneItemEnabled,
              ),
          )
        )
          continue;
        const settings = (await obs.call('GetInputSettings', { inputUuid: input.inputUuid }))
          .inputSettings as Record<string, unknown>;
        if (settings?.capture_audio !== true) continue;
        if (references.some((container) => container.otherRoots.size))
          throw new Error('audio_video_path_unresolved');
        captureAudio.push({
          inputUuid: input.inputUuid,
          inputKind: input.inputKind,
          before: true,
          applied: false,
        });
      }
    }
    // Check nested paths before creating or changing any scene references.
    for (const container of graph) {
      if (!container.activeManagedRoots.size || desired.some((s) => s.sceneName === container.name))
        continue;
      for (const item of container.items) {
        if (!item.sceneItemEnabled) continue;
        const input = inputs.find((value) => value.inputUuid === item.sourceUuid);
        if (!input) continue;
        if (wantedIds.includes(item.sourceUuid)) throw new Error('audio_nested_target_unresolved');
        if (['game_capture', 'window_capture'].includes(String(input.inputKind))) {
          const settings = (await obs.call('GetInputSettings', { inputUuid: item.sourceUuid }))
            .inputSettings as Record<string, unknown>;
          if (
            settings?.capture_audio === true &&
            !captureAudio.some((entry) => entry.inputUuid === item.sourceUuid)
          )
            throw new Error('audio_video_path_unresolved');
        }
        if (!audioKinds.has(String(input.inputKind))) continue;
        if (container.otherRoots.size) throw new Error('audio_nested_shared_path');
        // Restoring an existing nested reference needs a persistent reverse plan;
        // do not replace it with a new direct scene reference in the meantime.
        throw new Error('audio_nested_path_unresolved');
      }
      snapshots.set(
        `${container.group ? 'group' : 'scene'}\0${container.name}`,
        JSON.stringify(container.items),
      );
    }
    const missing: { sceneName: string; input: Record<string, unknown> }[] = [];
    for (const { sceneName } of desired) {
      const items = records((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
      for (const input of selected) {
        const count = items.filter((item) => item.sourceUuid === input.inputUuid).length;
        if (count > 1) throw new Error('audio_duplicate_path');
        if (count === 0) missing.push({ sceneName, input });
      }
      snapshots.set(`scene\0${sceneName}`, JSON.stringify(items));
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
          if (
            settings?.capture_audio === true &&
            !captureAudio.some((entry) => entry.inputUuid === input.inputUuid)
          )
            throw new Error('audio_video_path_unresolved');
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
    for (const { sceneName, input } of missing) {
      await check();
      const key = `scene\0${sceneName}`;
      if (
        JSON.stringify((await obs.call('GetSceneItemList', { sceneName })).sceneItems) !==
        snapshots.get(key)
      )
        throw new Error('audio_scene_changed');
      await obs.call('CreateSceneItem', {
        sceneName,
        sourceName: input.inputName,
        sceneItemEnabled: false,
      });
      const items = records((await obs.call('GetSceneItemList', { sceneName })).sceneItems);
      const matches = items.filter((item) => item.sourceUuid === input.inputUuid);
      const item = matches[0];
      if (
        matches.length !== 1 ||
        typeof item?.sceneItemId !== 'number' ||
        typeof item.sourceUuid !== 'string' ||
        item.sceneItemEnabled !== false
      )
        throw new Error('audio_selection_changed');
      independent.push({ sceneName, sceneItemId: item.sceneItemId, sourceUuid: item.sourceUuid });
      snapshots.set(key, JSON.stringify(items));
    }
    preparing = false;
    for (const [key, snapshot] of snapshots) {
      const [kind, sceneName] = key.split('\0');
      if (
        JSON.stringify(
          (
            await obs.call(kind === 'group' ? 'GetGroupSceneItemList' : 'GetSceneItemList', {
              sceneName,
            })
          ).sceneItems,
        ) !== snapshot
      )
        throw new Error('audio_scene_changed');
    }
    await check();
    migrating = true;
    if (desktop.length || independent.length || captureAudio.length || monitor.length)
      await new AudioMigration(`${journal}.migration`).migrate(
        obs,
        endpoint,
        { endpoint, collection: OBS_COLLECTION, desktop, independent, captureAudio, monitor },
        observer,
        completedPath,
      );
    await check();
  } finally {
    stop();
  }
}
