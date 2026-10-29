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
  ids: Partial<Record<ObsAudioRole, string>>,
  verify: () => Promise<boolean>,
  desktopUuid?: string,
  completedPath?: string,
  monitor: AudioMonitorChange[] = [],
  modeId?: string,
): Promise<void> {
  const roleIds = Object.values(ids);
  if (new Set(roleIds).size !== roleIds.length) throw new Error('audio_binding_duplicate');
  if (!desktopUuid && (!ids.game || !ids.remoteCommentary || !ids.microphone))
    throw new Error('audio_bindings_incomplete');
  const inputs = records((await obs.call('GetInputList')).inputs);
  if (desktopUuid) {
    if (ids.microphone === desktopUuid) throw new Error('audio_binding_duplicate');
    if (
      !inputs.some(
        (input) => input.inputUuid === desktopUuid && input.inputKind === 'wasapi_output_capture',
      )
    )
      throw new Error('audio_desktop_missing');
  }
  const wantedIds = desktopUuid
    ? [desktopUuid, ...(ids.microphone ? [ids.microphone] : [])]
    : roleIds;
  const selected = wantedIds.map((uuid) => {
    const input = inputs.find((value) => value.inputUuid === uuid);
    if (!input || typeof input.inputName !== 'string') throw new Error('audio_selection_changed');
    return input;
  });
  let globalNames = new Set<string>();
  const allowedGlobals = new Set(
    selected
      .filter((input) => input.inputUuid === ids.microphone || input.inputUuid === desktopUuid)
      .map((input) => String(input.inputName)),
  );
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
    const names = Object.values(specials).filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    );
    const conflict = names.find((name) => !allowedGlobals.has(name));
    if (conflict) throw new Error(`audio_global_path_unresolved:${conflict}`);
    globalNames = new Set(names);
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
    const microphoneActive = Boolean(
      ids.microphone &&
      graph.some(
        (container) =>
          container.activeManagedRoots.size &&
          container.items.some(
            (item) => item.sourceUuid === ids.microphone && item.sceneItemEnabled,
          ),
      ),
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
        if (wantedIds.includes(item.sourceUuid)) continue;
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
        if (desktopUuid && !ids.microphone && input.inputKind === 'wasapi_input_capture') continue;
        if (container.otherRoots.size) throw new Error('audio_nested_shared_path');
        desktop.push({
          sceneName: container.name,
          sceneItemId: item.sceneItemId,
          sourceUuid: item.sourceUuid,
          ...(container.group ? { group: true } : {}),
        });
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
        const coveredByNested = graph.some(
          (container) =>
            container.name !== sceneName &&
            container.activeManagedRoots.has(sceneName) &&
            container.items.some(
              (item) => item.sourceUuid === input.inputUuid && item.sceneItemEnabled,
            ),
        );
        if (
          count === 0 &&
          !globalNames.has(String(input.inputName)) &&
          !coveredByNested &&
          (!desktopUuid || input.inputUuid !== ids.microphone || microphoneActive)
        )
          missing.push({ sceneName, input });
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
        if (desktopUuid && !ids.microphone && input.inputKind === 'wasapi_input_capture') continue;
        if (
          typeof item.sceneItemId !== 'number' ||
          typeof item.sourceUuid !== 'string' ||
          typeof item.sceneItemEnabled !== 'boolean'
        )
          throw new Error('audio_response_unknown');
        const ref = { sceneName, sceneItemId: item.sceneItemId, sourceUuid: item.sourceUuid };
        const nestedAlreadyActive = graph.some(
          (container) =>
            container.name !== sceneName &&
            container.activeManagedRoots.has(sceneName) &&
            container.items.some(
              (nested) => nested.sourceUuid === input.inputUuid && nested.sceneItemEnabled,
            ),
        );
        if (
          wanted &&
          !item.sceneItemEnabled &&
          !globalNames.has(String(input.inputName)) &&
          !nestedAlreadyActive &&
          (!desktopUuid || input.inputUuid !== ids.microphone)
        )
          independent.push(ref);
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
    if (modeId || desktop.length || independent.length || captureAudio.length || monitor.length)
      await new AudioMigration(`${journal}.migration`).migrate(
        obs,
        endpoint,
        { endpoint, collection: OBS_COLLECTION, desktop, independent, captureAudio, monitor },
        observer,
        completedPath,
        modeId,
      );
    await check();
  } finally {
    stop();
  }
}

/** Verify the effective managed paths before committing a mode. */
export async function verifyManagedAudioMode(
  obs: ObsRpc,
  baseUrl: string,
  ids: Partial<Record<ObsAudioRole, string>>,
  desktop?: string,
): Promise<boolean> {
  const inputs = records((await obs.call('GetInputList')).inputs);
  const specials = await obs.call('GetSpecialInputs');
  const globalNames = new Set(
    Object.values(specials).filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  );
  const allowedGlobals = new Set(
    inputs
      .filter((input) => input.inputUuid === desktop || input.inputUuid === ids.microphone)
      .map((input) => String(input.inputName)),
  );
  if ([...globalNames].some((name) => !allowedGlobals.has(name))) return false;
  const wanted = desktop ? [desktop] : [ids.game, ids.remoteCommentary];
  if (wanted.some((uuid) => !uuid || !inputs.some((input) => input.inputUuid === uuid)))
    return false;
  if (
    desktop &&
    inputs.find((input) => input.inputUuid === desktop)?.inputKind !== 'wasapi_output_capture'
  )
    return false;
  const names = obsDesiredScenes(baseUrl).map((scene) => scene.sceneName);
  const graph = await inspectAudioSceneGraph(obs, names);
  for (const name of names) {
    const active = graph
      .filter((container) => container.activeManagedRoots.has(name))
      .flatMap((container) => container.items.filter((item) => item.sceneItemEnabled));
    if (
      wanted.some(
        (uuid) =>
          !active.some((item) => item.sourceUuid === uuid) &&
          !globalNames.has(String(inputs.find((input) => input.inputUuid === uuid)?.inputName)),
      )
    )
      return false;
    for (const item of active) {
      const input = inputs.find((entry) => entry.inputUuid === item.sourceUuid);
      if (!input) continue;
      if (
        audioKinds.has(String(input.inputKind)) &&
        !wanted.includes(item.sourceUuid) &&
        item.sourceUuid !== ids.microphone &&
        !(input.inputKind === 'wasapi_input_capture' && !ids.microphone)
      )
        return false;
      if (desktop && ['game_capture', 'window_capture'].includes(String(input.inputKind))) {
        const settings = (await obs.call('GetInputSettings', { inputUuid: item.sourceUuid }))
          .inputSettings as Record<string, unknown> | undefined;
        if (!settings) return false;
        let captured = settings.capture_audio;
        if (captured === undefined) {
          const defaults = (
            await obs.call('GetInputDefaultSettings', { inputKind: input.inputKind })
          ).defaultInputSettings as Record<string, unknown> | undefined;
          captured = defaults?.capture_audio;
        }
        if (captured !== false) return false;
      }
    }
  }
  return true;
}
