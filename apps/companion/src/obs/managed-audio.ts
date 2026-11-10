import { assertManagedGlobalAudioSilent } from './audio.js';
import {
  AudioMigration,
  type AudioMonitorChange,
  type MigrationObserver,
} from './audio-migration.js';
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

/** Apply the selected roles to direct paths in the dedicated collection. */
export async function reconcileManagedAudio(
  obs: ObsRpc,
  endpoint: string,
  observer: MigrationObserver,
  journal: string,
  baseUrl: string,
  ids: Partial<Record<ObsAudioRole, string>>,
  verify: () => Promise<boolean>,
  desktopUuid?: string,
  monitor: AudioMonitorChange[] = [],
  modeId?: string,
  omitCommentary = false,
): Promise<void> {
  const roleIds = Object.values(ids);
  if (new Set(roleIds).size !== roleIds.length) throw new Error('audio_binding_duplicate');
  if (!desktopUuid && (!ids.game || (!ids.remoteCommentary && !omitCommentary) || !ids.microphone))
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
  let changed = false;
  let preparing = true;
  let migrating = false;
  const snapshots = new Map<string, string>();
  const stop = observer.subscribe((event) => {
    if (
      event.type !== 'item' &&
      !(preparing && event.type === 'identityChanged') &&
      !(migrating && (event.type === 'inputSettings' || event.type === 'monitor')) &&
      !(modeId && event.type === 'outputStarting') &&
      !(modeId && event.type === 'programChanged' && event.managed)
    )
      changed = true;
  });
  const check = async () => {
    const [stream, record, collection] = await Promise.all([
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
      obs.call('GetSceneCollectionList'),
    ]);
    if (
      changed ||
      !(await verify()) ||
      typeof stream.outputActive !== 'boolean' ||
      typeof record.outputActive !== 'boolean' ||
      (!modeId && (stream.outputActive !== false || record.outputActive !== false)) ||
      collection.currentSceneCollectionName !== OBS_COLLECTION
    )
      throw new Error('audio_setup_context_changed');
    await assertManagedGlobalAudioSilent(obs);
  };
  try {
    await check();
    const desktop: {
      sceneName: string;
      sceneItemId: number;
      sourceUuid: string;
    }[] = [];
    const independent: typeof desktop = [];
    const desired = obsDesiredScenes(baseUrl);
    const captureAudio: {
      inputUuid: string;
      inputKind: 'game_capture' | 'window_capture';
      before: boolean;
      applied: boolean;
    }[] = [];
    for (const input of inputs) {
      if (
        (input.inputKind !== 'game_capture' && input.inputKind !== 'window_capture') ||
        typeof input.inputUuid !== 'string'
      )
        continue;
      const settings = (await obs.call('GetInputSettings', { inputUuid: input.inputUuid }))
        .inputSettings as Record<string, unknown>;
      const wanted = !desktopUuid && wantedIds.includes(input.inputUuid);
      if (typeof settings?.capture_audio === 'boolean' && settings.capture_audio !== wanted)
        captureAudio.push({
          inputUuid: input.inputUuid,
          inputKind: input.inputKind,
          before: settings?.capture_audio === true,
          applied: wanted,
        });
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
        if (!wanted && !audioKinds.has(String(input.inputKind))) continue;
        if (
          typeof item.sceneItemId !== 'number' ||
          typeof item.sourceUuid !== 'string' ||
          typeof item.sceneItemEnabled !== 'boolean'
        )
          throw new Error('audio_response_unknown');
        const ref = { sceneName, sceneItemId: item.sceneItemId, sourceUuid: item.sourceUuid };
        if (
          wanted &&
          !item.sceneItemEnabled &&
          (!desktopUuid || item.sourceUuid !== ids.microphone)
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
      if (!desktopUuid || item.sourceUuid !== ids.microphone)
        independent.push({ sceneName, sceneItemId: item.sceneItemId, sourceUuid: item.sourceUuid });
      snapshots.set(key, JSON.stringify(items));
    }
    preparing = false;
    for (const [key, snapshot] of snapshots) {
      const [, sceneName] = key.split('\0');
      if (
        JSON.stringify(
          (
            await obs.call('GetSceneItemList', {
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
  omitCommentary = false,
): Promise<boolean> {
  const inputs = records((await obs.call('GetInputList')).inputs);
  try {
    await assertManagedGlobalAudioSilent(obs);
  } catch {
    return false;
  }
  const wanted = desktop
    ? [desktop, ...(ids.microphone ? [ids.microphone] : [])]
    : [ids.game, ...(omitCommentary ? [] : [ids.remoteCommentary]), ids.microphone];
  if (wanted.some((uuid) => !uuid || !inputs.some((input) => input.inputUuid === uuid)))
    return false;
  if (
    desktop &&
    inputs.find((input) => input.inputUuid === desktop)?.inputKind !== 'wasapi_output_capture'
  )
    return false;
  const names = obsDesiredScenes(baseUrl).map((scene) => scene.sceneName);
  for (const name of names) {
    const items = records((await obs.call('GetSceneItemList', { sceneName: name })).sceneItems);
    const active = items.filter((item) => item.sceneItemEnabled === true);
    if (
      wanted.some((uuid) => {
        const count = active.filter((item) => item.sourceUuid === uuid).length;
        return desktop && uuid === ids.microphone ? count > 1 : count !== 1;
      })
    )
      return false;
    for (const item of active) {
      const input = inputs.find((entry) => entry.inputUuid === item.sourceUuid);
      if (!input) continue;
      if (audioKinds.has(String(input.inputKind)) && !wanted.includes(String(item.sourceUuid)))
        return false;
      if (['game_capture', 'window_capture'].includes(String(input.inputKind))) {
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
        if (captured !== (!desktop && wanted.includes(String(item.sourceUuid)))) return false;
      }
    }
  }
  return true;
}
