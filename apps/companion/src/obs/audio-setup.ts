import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import { reconcileManagedAudio } from './managed-audio.js';
import { inspectLegacyAudioTemplate } from './audio-template.js';
import { AudioMigration, type MigrationObserver } from './audio-migration.js';
import {
  createCommentaryProbe,
  isTeamspeak,
  renameLegacyProbe,
  RemoteCommentary,
} from './remote-commentary.js';
import { prepareRemoteCommentary } from './remote-commentary-setup.js';
import type { ObsFinding, ObsRpc } from './reconcile.js';
import type { ObsAudioBinding, ObsAudioRole } from '@mizar/protocol/obs';
import { inspectAudioSceneGraph } from './audio-scene-graph.js';
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

/** Prepare independent paths only after proving that the old desktop mix is ours. */
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
  await renameLegacyProbe(obs, journal, endpoint, OBS_COLLECTION, 'commentary');
  await renameLegacyProbe(obs, `${journal}.game`, endpoint, OBS_COLLECTION, 'game');
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
    let legacy = await inspectLegacyAudioTemplate(obs, baseUrl, target);
    if (!legacy) {
      // A completed migration may be checked again, but is never replayed.
      let owned: { endpoint?: string; collection?: string; uuid?: string } | undefined;
      try {
        owned = JSON.parse(await readFile(`${journal}.game`, 'utf8')) as typeof owned;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (
        owned?.endpoint === endpoint &&
        owned.collection === OBS_COLLECTION &&
        typeof owned.uuid === 'string'
      ) {
        const game = owned.uuid;
        const inputs = records((await obs.call('GetInputList')).inputs);
        const capture = inputs.find(
          (x: Record<string, unknown>) =>
            x.inputName === OBS_CAPTURE_INPUT && x.inputKind === 'game_capture',
        );
        const gameInput = inputs.find(
          (x: Record<string, unknown>) =>
            x.inputUuid === game && x.inputKind === 'wasapi_process_output_capture',
        );
        if (capture && gameInput)
          legacy = await inspectLegacyAudioTemplate(obs, baseUrl, target, game);
        const verified =
          !legacy &&
          capture &&
          gameInput &&
          (await inspectLegacyAudioTemplate(obs, baseUrl, target, game, false));
        if (capture && gameInput && verified) {
          const captureSettings = (
            await obs.call('GetInputSettings', { inputUuid: capture.inputUuid })
          ).inputSettings as Record<string, unknown>;
          const gameSettings = (await obs.call('GetInputSettings', { inputUuid: game }))
            .inputSettings as Record<string, unknown>;
          const expected =
            typeof captureSettings?.window === 'string' &&
            captureSettings.window.split(':').at(-1)?.toLowerCase() === 'cs2.exe'
              ? captureSettings.window
              : 'Counter-Strike 2:SDL_app:cs2.exe';
          let valid =
            gameSettings?.window === expected && (await owner.get()).revision === revision;
          for (const scene of obsDesiredScenes(baseUrl)) {
            const items = records(
              (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
            );
            if (
              [game, target].some((uuid) => {
                const matches = items.filter(
                  (item: Record<string, unknown>) => item.sourceUuid === uuid,
                );
                return matches.length !== 1 || matches[0]!.sceneItemEnabled !== true;
              })
            )
              valid = false;
          }
          if (valid) {
            let changed = false;
            const stop = observer.subscribe(() => {
              changed = true;
            });
            try {
              await onReady?.({
                game,
                remoteCommentary: target,
                microphone: verified.microphoneUuid,
              });
              await rememberOwnedTarget(() => changed);
              await rm(`${journal}.waiting`, { force: true });
              if (changed || targetChanged) {
                await rm(`${journal}.owned-target`, { force: true });
                throw new Error('commentary_owned_target_changed');
              }
              return [];
            } finally {
              stop();
            }
          }
        }
      }
      if (!legacy)
        return [
          {
            code: 'commentary_pending',
            message: '音频路径尚未确认，请检查全局、嵌套或重复的来源，并在声音设置中确认分路。',
          },
        ];
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
    const updated = records((await obs.call('GetInputList')).inputs);
    const gameInput = updated.find((x: Record<string, unknown>) => x.inputUuid === game);
    if (!gameInput || typeof gameInput.inputName !== 'string')
      throw new Error('audio_game_missing');
    const independent: { sceneName: string; sceneItemId: number; sourceUuid: string }[] = [
      ...legacy.microphone,
    ];
    for (const scene of scenes) {
      let items = records(
        (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
      );
      if (!items.some((x: Record<string, unknown>) => x.sourceUuid === game)) {
        await check();
        await obs.call('CreateSceneItem', {
          sceneName: scene.sceneName,
          sourceName: gameInput.inputName,
          sceneItemEnabled: false,
        });
        items = records(
          (await obs.call('GetSceneItemList', { sceneName: scene.sceneName })).sceneItems,
        );
      }
      for (const uuid of [game, target]) {
        const matches = items.filter((x: Record<string, unknown>) => x.sourceUuid === uuid);
        if (
          matches.length !== 1 ||
          matches[0]!.sceneItemEnabled !== false ||
          typeof matches[0]!.sceneItemId !== 'number'
        )
          throw new Error('audio_independent_path_changed');
        independent.push({
          sceneName: scene.sceneName,
          sceneItemId: matches[0]!.sceneItemId,
          sourceUuid: uuid,
        });
      }
    }
    let interrupted = false;
    let migrationComplete = false;
    const stop = observer.subscribe((event) => {
      if (event.type !== 'item' || migrationComplete) interrupted = true;
    });
    try {
      await check();
      const verified = await inspectLegacyAudioTemplate(obs, baseUrl, target, game);
      if (!verified || JSON.stringify(verified) !== JSON.stringify(legacy))
        throw new Error('audio_template_changed');
      const finalGame = (await obs.call('GetInputSettings', { inputUuid: game }))
        .inputSettings as Record<string, unknown>;
      if (finalGame?.window !== window) throw new Error('audio_game_target_changed');
      const finalCommentary = (await obs.call('GetInputSettings', { inputUuid: target }))
        .inputSettings;
      if (JSON.stringify(finalCommentary) !== commentarySnapshot)
        throw new Error('commentary_target_changed');
      await check();
      if (interrupted || targetChanged) throw new Error('audio_setup_observation_changed');
      await migration.migrate(
        obs,
        endpoint,
        {
          endpoint,
          collection: OBS_COLLECTION,
          desktop: legacy.desktop,
          independent,
        },
        observer,
      );
      migrationComplete = true;
      if (interrupted || targetChanged) throw new Error('audio_setup_observation_changed');
      await onReady?.({ game, remoteCommentary: target, microphone: legacy.microphoneUuid });
      await rememberOwnedTarget(() => interrupted);
      await rm(`${journal}.waiting`, { force: true });
      if (interrupted || targetChanged) {
        await rm(`${journal}.owned-target`, { force: true });
        throw new Error('commentary_owned_target_changed');
      }
    } finally {
      stop();
    }
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
  let commentary = omitCommentary ? undefined : validateBinding(bindings.remoteCommentary);
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
      const graph = await inspectAudioSceneGraph(
        obs,
        scenes.map((scene) => scene.sceneName),
      );
      if (
        graph.some((container) =>
          container.items.some(
            (item) =>
              item.sourceUuid === game && (item.sceneItemEnabled || container.otherRoots.size),
          ),
        )
      )
        throw new Error('audio_game_source_shared');
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
    const path = `${journal}.microphone`;
    let saved: { endpoint: string; collection: string; name: string; uuid?: string } | undefined;
    try {
      saved = JSON.parse(await readFile(path, 'utf8')) as typeof saved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (saved) {
      if (
        saved.endpoint !== endpoint ||
        saved.collection !== OBS_COLLECTION ||
        !saved.uuid ||
        !inputs.some(
          (input) =>
            input.inputUuid === saved!.uuid &&
            input.inputKind === 'wasapi_input_capture' &&
            input.inputName === saved!.name,
        )
      )
        throw new Error('audio_microphone_creation_unconfirmed');
      microphone = saved.uuid;
    } else {
      const names = new Set(inputs.map((input) => input.inputName));
      let name = '麦克风';
      for (let index = 2; names.has(name); index++) name = `麦克风 ${index}`;
      saved = { endpoint, collection: OBS_COLLECTION, name };
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(saved)}\n`, { flag: 'wx', mode: 0o600 });
      await check();
      const created = await obs.call('CreateInput', {
        sceneName: scenes[0]!.sceneName,
        inputName: name,
        inputKind: 'wasapi_input_capture',
        inputSettings: { device_id: 'default' },
        sceneItemEnabled: false,
      });
      if (typeof created.inputUuid !== 'string' || !created.inputUuid)
        throw new Error('audio_microphone_creation_unconfirmed');
      microphone = created.inputUuid;
      const temp = `${path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify({ ...saved, uuid: microphone })}\n`, {
          mode: 0o600,
        });
        await rename(temp, path);
      } finally {
        await rm(temp, { force: true });
      }
    }
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
