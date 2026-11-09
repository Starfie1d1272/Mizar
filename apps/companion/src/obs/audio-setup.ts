import { readFile, rm } from 'node:fs/promises';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import { reconcileManagedAudio } from './managed-audio.js';
import { ensureManagedAudioSources } from './audio.js';
import { AudioMigration, type MigrationObserver } from './audio-migration.js';
import { createCommentaryProbe, isTeamspeak, RemoteCommentary } from './remote-commentary.js';
import { prepareRemoteCommentary } from './remote-commentary-setup.js';
import type { ObsFinding, ObsRpc } from './reconcile.js';
import type { ObsAudioBinding, ObsAudioRole } from '@mizar/protocol/obs';
import type { CommentarySwitch } from './commentary-switch.js';
import {
  createOwnedCommentaryTarget,
  readOwnedCommentaryTarget,
} from './commentary-owned-target.js';

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((v: unknown) => !v || typeof v !== 'object'))
    throw new Error('audio_response_unknown');
  return value as Record<string, unknown>[];
}

/** Prepare the independent sources inside the dedicated collection. */
export async function configureIndependentAudio(
  obs: ObsRpc,
  endpoint: string,
  observer: MigrationObserver,
  owner: RemoteCommentary,
  journal: string,
  baseUrl: string,
  onReady?: (ids: Record<ObsAudioRole, string>) => Promise<void>,
  allowMigration: () => Promise<boolean> = () => Promise.resolve(true),
  verifySwitch?: (plan: CommentarySwitch) => Promise<boolean>,
  managedBindings?: () => Promise<{ revision: string; ids: Record<ObsAudioRole, string> } | null>,
): Promise<ObsFinding[]> {
  const migration = new AudioMigration(`${journal}.migration`);
  if (await migration.pending())
    return [
      { code: 'commentary_pending', message: '上次音频迁移结果待核对，请先检查 OBS 与迁移记录。' },
    ];
  let target: string | undefined;
  let revision: string | undefined;
  const pending = await prepareRemoteCommentary(
    obs,
    owner,
    journal,
    endpoint,
    baseUrl,
    observer,
    verifySwitch,
    (uuid, rev) => {
      target = uuid;
      revision = rev;
    },
  );
  if (!target || !revision) return pending;
  const targetUuid = target;
  let targetChanged = false;
  const stopTargetObservation = observer.subscribe((event) => {
    if (
      event.type === 'disconnected' ||
      (event.type === 'inputSettings' && event.inputUuid === targetUuid)
    )
      targetChanged = true;
  });
  try {
    const rememberOwnedTarget = async (observedChange: () => boolean) => {
      let owned: { endpoint?: string; collection?: string; uuid?: string } | undefined;
      try {
        owned = JSON.parse(await readFile(journal, 'utf8')) as typeof owned;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (
        owned?.endpoint !== endpoint ||
        owned.collection !== OBS_COLLECTION ||
        owned.uuid !== target
      )
        return;
      const state = await owner.get();
      if (state.revision !== revision) throw new Error('commentary_revision_changed');
      const settings = (await obs.call('GetInputSettings', { inputUuid: target })).inputSettings;
      if (targetChanged || observedChange() || JSON.stringify(settings) !== commentarySnapshot) {
        await rm(`${journal}.owned-target`, { force: true });
        throw new Error('commentary_owned_target_changed');
      }
      const window =
        settings && typeof settings === 'object'
          ? (settings as Record<string, unknown>).window
          : undefined;
      if (typeof window !== 'string' || !window) throw new Error('commentary_settings_unknown');
      const path = `${journal}.owned-target`;
      const previous = await readOwnedCommentaryTarget(path);
      if (previous) {
        if (
          previous.endpoint !== endpoint ||
          previous.collection !== OBS_COLLECTION ||
          previous.uuid !== target ||
          previous.window !== window
        )
          throw new Error('commentary_owned_target_changed');
        if (targetChanged || observedChange()) {
          await rm(path, { force: true });
          throw new Error('commentary_owned_target_changed');
        }
        return;
      }
      const removeUnconfirmed = await createOwnedCommentaryTarget(path, {
        endpoint,
        collection: OBS_COLLECTION,
        uuid: targetUuid,
        window,
      });
      try {
        const after = (await obs.call('GetInputSettings', { inputUuid: target })).inputSettings;
        if (targetChanged || observedChange() || JSON.stringify(after) !== commentarySnapshot)
          throw new Error('commentary_owned_target_changed');
      } catch (error) {
        await removeUnconfirmed();
        throw error;
      }
    };
    const commentarySettings = (await obs.call('GetInputSettings', { inputUuid: target }))
      .inputSettings;
    if (!commentarySettings || typeof commentarySettings !== 'object')
      throw new Error('commentary_settings_unknown');
    const preference = await owner.get();
    const currentWindow = (commentarySettings as Record<string, unknown>).window;
    if (
      preference.revision !== revision ||
      (preference.preference.mode === 'autoTeamspeak' && !isTeamspeak(currentWindow)) ||
      (preference.preference.mode === 'application' &&
        currentWindow !== preference.preference.window)
    )
      throw new Error('commentary_target_changed');
    const commentarySnapshot = JSON.stringify(commentarySettings);
    const selected = await managedBindings?.();
    if (selected) {
      if (selected.ids.remoteCommentary !== target)
        throw new Error('commentary_binding_target_changed');
      await reconcileManagedAudio(
        obs,
        endpoint,
        observer,
        journal,
        baseUrl,
        selected.ids,
        async () => {
          const current = await managedBindings?.();
          return (
            current?.revision === selected.revision &&
            (await owner.get()).revision === revision &&
            !targetChanged
          );
        },
      );
      await rememberOwnedTarget(() => false);
      await rm(`${journal}.waiting`, { force: true });
      return [];
    }
    if (!(await allowMigration()))
      return [
        {
          code: 'commentary_pending',
          message: '请补全游戏、远端解说和麦克风分路，再由 Mizar 完成场景配置。',
        },
      ];
    const scenes = obsDesiredScenes(baseUrl);
    const check = async () => {
      const [state, stream, record, collection] = await Promise.all([
        owner.get(),
        obs.call('GetStreamStatus'),
        obs.call('GetRecordStatus'),
        obs.call('GetSceneCollectionList'),
      ]);
      if (
        state.revision !== revision ||
        stream.outputActive !== false ||
        record.outputActive !== false ||
        collection.currentSceneCollectionName !== OBS_COLLECTION
      )
        throw new Error('audio_setup_context_changed');
    };
    const inputs = records((await obs.call('GetInputList')).inputs);
    const capture = inputs.find(
      (x: Record<string, unknown>) =>
        x.inputName === OBS_CAPTURE_INPUT && x.inputKind === 'game_capture',
    );
    if (!capture || typeof capture.inputUuid !== 'string')
      throw new Error('audio_game_capture_missing');
    const settings = (await obs.call('GetInputSettings', { inputUuid: capture.inputUuid }))
      .inputSettings as Record<string, unknown>;
    const window =
      typeof settings?.window === 'string' &&
      settings.window.split(':').at(-1)?.toLowerCase() === 'cs2.exe'
        ? settings.window
        : 'Counter-Strike 2:SDL_app:cs2.exe';
    const game = await createCommentaryProbe(
      obs,
      `${journal}.game`,
      {
        endpoint,
        collection: OBS_COLLECTION,
        sceneName: scenes[0]!.sceneName,
        label: 'Game Audio',
      },
      check,
    );
    const gameSettings = (await obs.call('GetInputSettings', { inputUuid: game }))
      .inputSettings as Record<string, unknown>;
    if (!gameSettings || (gameSettings.window && gameSettings.window !== window))
      throw new Error('audio_game_target_changed');
    if (!gameSettings.window) {
      await check();
      await obs.call('SetInputSettings', {
        inputUuid: game,
        inputSettings: { window, priority: 2 },
        overlay: true,
      });
    }
    const { microphone } = await ensureManagedAudioSources(obs, baseUrl);
    const ids = { game, remoteCommentary: target, microphone };
    await reconcileManagedAudio(
      obs,
      endpoint,
      observer,
      journal,
      baseUrl,
      ids,
      async () => (await owner.get()).revision === revision && !targetChanged,
    );
    await onReady?.(ids);
    await rememberOwnedTarget(() => false);
    await rm(`${journal}.waiting`, { force: true });

    return [];
  } finally {
    stopTargetObservation();
  }
}

export async function commentaryTargetReady(
  obs: ObsRpc,
  owner: RemoteCommentary,
  uuid: string,
  expectedRevision: string,
): Promise<boolean> {
  const preference = await owner.get();
  if (preference.revision !== expectedRevision || preference.preference.mode === 'disabled')
    return false;
  if (preference.preference.mode === 'existingInput')
    return preference.preference.binding.inputUuid === uuid;
  const settings = (await obs.call('GetInputSettings', { inputUuid: uuid })).inputSettings as
    Record<string, unknown> | undefined;
  const window = settings?.window;
  if (
    typeof window !== 'string' ||
    (preference.preference.mode === 'autoTeamspeak' && !isTeamspeak(window)) ||
    (preference.preference.mode === 'application' && window !== preference.preference.window)
  )
    return false;
  const candidates = await owner.windows(obs, preference.revision, uuid);
  if (candidates.some((candidate) => candidate.window === window)) return true;
  return (
    preference.preference.mode === 'autoTeamspeak' &&
    candidates.filter((candidate) => isTeamspeak(candidate.window)).length === 1
  );
}

/** Prepare disabled independent sources while the desktop path remains active. */
export async function prepareIndependentForDesktop(
  obs: ObsRpc,
  endpoint: string,
  observer: MigrationObserver,
  owner: RemoteCommentary,
  journal: string,
  baseUrl: string,
  bindings: Record<ObsAudioRole, ObsAudioBinding | null>,
  desktopMicrophone: ObsAudioBinding | null,
  expectedCommentaryRevision: string,
  valid: () => Promise<boolean>,
): Promise<{ ids: Partial<Record<ObsAudioRole, string>>; createdMicrophone: boolean } | null> {
  const scenes = obsDesiredScenes(baseUrl);
  const check = async () => {
    const [collection, stream, record, preference] = await Promise.all([
      obs.call('GetSceneCollectionList'),
      obs.call('GetStreamStatus'),
      obs.call('GetRecordStatus'),
      owner.get(),
    ]);
    if (
      collection.currentSceneCollectionName !== OBS_COLLECTION ||
      typeof stream.outputActive !== 'boolean' ||
      typeof record.outputActive !== 'boolean' ||
      preference.revision !== expectedCommentaryRevision ||
      !(await valid())
    )
      throw new Error('audio_setup_context_changed');
  };
  await check();
  const preference = await owner.get();
  const omitCommentary = preference.preference.mode === 'disabled';
  let inputs = records((await obs.call('GetInputList')).inputs);
  const validateBinding = (binding: ObsAudioBinding | null) => {
    if (!binding) return undefined;
    if (
      binding.endpoint !== endpoint ||
      binding.collection !== OBS_COLLECTION ||
      !inputs.some(
        (input) => input.inputUuid === binding.inputUuid && input.inputKind === binding.inputKind,
      )
    )
      throw new Error('audio_binding_changed');
    return binding.inputUuid;
  };
  let commentary =
    omitCommentary || preference.preference.mode === 'existingInput'
      ? undefined
      : validateBinding(bindings.remoteCommentary);
  if (preference.preference.mode === 'existingInput') {
    const binding = preference.preference.binding;
    if (
      binding.endpoint !== endpoint ||
      binding.collection !== OBS_COLLECTION ||
      !inputs.some((input) => input.inputUuid === binding.inputUuid)
    )
      throw new Error('audio_binding_changed');
    commentary = binding.inputUuid;
  }
  if (
    commentary &&
    !(await commentaryTargetReady(obs, owner, commentary, expectedCommentaryRevision))
  )
    return null;
  if (!commentary && !omitCommentary) {
    await prepareRemoteCommentary(
      obs,
      owner,
      journal,
      endpoint,
      baseUrl,
      observer,
      undefined,
      (uuid) => {
        commentary = uuid;
      },
      true,
    );
    if (!commentary) return null;
    inputs = records((await obs.call('GetInputList')).inputs);
  }
  await check();
  let game = validateBinding(bindings.game);
  if (!game) {
    game = await createCommentaryProbe(
      obs,
      `${journal}.game`,
      {
        endpoint,
        collection: OBS_COLLECTION,
        sceneName: scenes[0]!.sceneName,
        label: 'Game Audio',
        allowOutput: true,
      },
      check,
    );
    const settings = (await obs.call('GetInputSettings', { inputUuid: game })).inputSettings as
      Record<string, unknown> | undefined;
    if (!settings) throw new Error('audio_game_target_changed');
    if (!settings.window) {
      for (const scene of scenes) {
        const items = records(
          (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
        );
        if (items.some((item) => item.sourceUuid === game && item.sceneItemEnabled))
          throw new Error('audio_game_source_active');
      }
      const capture = inputs.find(
        (input) => input.inputName === OBS_CAPTURE_INPUT && input.inputKind === 'game_capture',
      );
      const captureSettings = capture
        ? ((await obs.call('GetInputSettings', { inputUuid: capture.inputUuid })).inputSettings as
            Record<string, unknown> | undefined)
        : undefined;
      const target =
        typeof captureSettings?.window === 'string' &&
        captureSettings.window.split(':').at(-1)?.toLowerCase() === 'cs2.exe'
          ? captureSettings.window
          : 'Counter-Strike 2:SDL_app:cs2.exe';
      await check();
      await obs.call('SetInputSettings', {
        inputUuid: game,
        inputSettings: { window: target, priority: 2 },
        overlay: true,
      });
      if (
        (
          (await obs.call('GetInputSettings', { inputUuid: game })).inputSettings as
            Record<string, unknown> | undefined
        )?.window !== target
      )
        throw new Error('audio_game_target_changed');
    }
    inputs = records((await obs.call('GetInputList')).inputs);
  }
  const createdMicrophone = !bindings.microphone && !desktopMicrophone;
  let microphone = validateBinding(bindings.microphone ?? desktopMicrophone);
  if (!microphone) {
    microphone = (await ensureManagedAudioSources(obs, baseUrl)).microphone;
    inputs = records((await obs.call('GetInputList')).inputs);
  }
  const ids = { game, ...(commentary ? { remoteCommentary: commentary } : {}), microphone };
  if (new Set(Object.values(ids)).size !== Object.values(ids).length)
    throw new Error('audio_binding_duplicate');
  for (const scene of scenes) {
    let items = records(
      (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
    );
    for (const uuid of Object.values(ids)) {
      if (items.some((item) => item.sourceUuid === uuid)) continue;
      const input = inputs.find((item) => item.inputUuid === uuid);
      if (!input || typeof input.inputName !== 'string') throw new Error('audio_selection_changed');
      await check();
      await obs.call('CreateSceneItem', {
        sceneName: scene.sceneName,
        sourceName: input.inputName,
        sceneItemEnabled: false,
      });
      items = records(
        (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
      );
      if (!items.some((item) => item.sourceUuid === uuid && item.sceneItemEnabled === false))
        throw new Error('audio_selection_changed');
    }
  }
  await check();
  if (
    commentary &&
    !(await commentaryTargetReady(obs, owner, commentary, expectedCommentaryRevision))
  )
    return null;
  return { ids, createdMicrophone };
}
