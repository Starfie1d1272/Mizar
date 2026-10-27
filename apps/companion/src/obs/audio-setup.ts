import { readFile, rm } from 'node:fs/promises';
import { OBS_CAPTURE_INPUT, OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import { inspectLegacyAudioTemplate } from './audio-template.js';
import { AudioMigration, type MigrationObserver } from './audio-migration.js';
import { createCommentaryProbe, RemoteCommentary } from './remote-commentary.js';
import { prepareRemoteCommentary } from './remote-commentary-setup.js';
import type { ObsFinding, ObsRpc } from './reconcile.js';
import type { ObsAudioRole } from '@mizar/protocol/obs';

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
    (uuid, rev) => {
      target = uuid;
      revision = rev;
    },
  );
  if (!target || !revision) return pending;
  const commentarySettings = (await obs.call('GetInputSettings', { inputUuid: target }))
    .inputSettings;
  if (!commentarySettings || typeof commentarySettings !== 'object')
    throw new Error('commentary_settings_unknown');
  const commentarySnapshot = JSON.stringify(commentarySettings);
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
        let valid = gameSettings?.window === expected && (await owner.get()).revision === revision;
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
          await onReady?.({ game, remoteCommentary: target, microphone: verified.microphoneUuid });
          await rm(`${journal}.waiting`, { force: true });
          return [];
        }
      }
    }
    if (!legacy)
      return [
        {
          code: 'commentary_pending',
          message: '桌面混音不是可验证的默认模板，请在 OBS 中核对音频分路。',
        },
      ];
  }
  if (!(await allowMigration()))
    return [
      {
        code: 'commentary_pending',
        message: '已存在手动音频绑定，请在 OBS 中核对分路；未自动迁移桌面音频。',
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
  if (!gameInput || typeof gameInput.inputName !== 'string') throw new Error('audio_game_missing');
  const independent: { sceneName: string; sceneItemId: number; sourceUuid: string }[] = [];
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
  const stop = observer.subscribe((event) => {
    if (event.type !== 'item') interrupted = true;
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
    if (interrupted) throw new Error('audio_setup_observation_changed');
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
    await onReady?.({ game, remoteCommentary: target, microphone: legacy.microphoneUuid });
    await rm(`${journal}.waiting`, { force: true });
  } finally {
    stop();
  }
  return [];
}
