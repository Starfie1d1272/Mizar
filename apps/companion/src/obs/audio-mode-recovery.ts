import type { ObsAudioRole } from '@mizar/protocol/obs';
import type { MusicAudioRecovery } from '../music/device.js';
import type { ObsRpc } from './reconcile.js';
import type { ObsAudioRouting } from './audio-routing.js';
import type { RemoteCommentary } from './remote-commentary.js';
import { AudioMigration, type MigrationObserver } from './audio-migration.js';
import { commentaryTargetReady } from './audio-setup.js';
import { desktopMonitorRelationship } from './audio-monitor-device.js';
import { verifyManagedAudioMode } from './managed-audio.js';

/** Settle the stored audio mode using the current OBS identity and readback. */
export async function recoverAudioModeTransaction(
  {
    routing,
    commentary,
    browserBaseUrl,
  }: {
    routing: ObsAudioRouting;
    commentary: { owner: RemoteCommentary; journal: string };
    browserBaseUrl: string;
  },
  obs: ObsRpc,
  endpoint: string,
  observer: MigrationObserver,
  music: MusicAudioRecovery,
  valid: () => boolean,
) {
  const state = await routing.modeRecoveryState();
  const migration = new AudioMigration(`${commentary.journal}.migration`);
  const completedPath = `${commentary.journal}.dedicated-mode`;
  const pending = await migration.pending();
  if (!state.transition) {
    if (!pending?.modeId) return;
    if (pending.modeId !== state.revision) throw new Error('audio_migration_mode_mismatch');
    if (!state.desktop) await migration.clearModeBackup(completedPath);
    await migration.clearMode(pending.modeId);
    return;
  }
  if (state.transition === true) throw new Error('audio_mode_legacy_pending');
  const transition = state.transition;
  if (
    transition.endpoint !== endpoint ||
    (await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== transition.collection
  )
    throw new Error('audio_migration_identity_changed');
  if (pending && pending.modeId !== transition.id) throw new Error('audio_migration_mode_mismatch');
  const outcome = pending
    ? await migration.inspectMode(obs, endpoint, observer, transition.id)
    : 'before';
  let side: 'before' | 'after' = 'before';
  let targetIds: Partial<Record<ObsAudioRole, string>> = {};
  if (pending && outcome === 'applied') {
    const inputList = (await obs.call('GetInputList')).inputs;
    if (!Array.isArray(inputList)) throw new Error('audio_response_unknown');
    const ids: Partial<Record<ObsAudioRole, string>> = {};
    for (const role of ['game', 'remoteCommentary', 'microphone'] as const) {
      const binding =
        role === 'microphone' && transition.targetDesktop
          ? transition.targetMicrophone
          : state.bindings[role];
      if (
        binding &&
        binding.endpoint === endpoint &&
        binding.collection === transition.collection &&
        inputList.some(
          (value: Record<string, unknown>) =>
            value.inputUuid === binding.inputUuid && value.inputKind === binding.inputKind,
        )
      )
        ids[role] = binding.inputUuid;
    }
    const commentaryReady =
      transition.targetDesktop ||
      transition.omitCommentary ||
      !state.waitingIndependent ||
      (Boolean(ids.remoteCommentary) &&
        (await commentaryTargetReady(
          obs,
          commentary.owner,
          ids.remoteCommentary!,
          state.waitingIndependent.commentaryRevision,
        )));
    const relationship = transition.targetDesktop
      ? await desktopMonitorRelationship(obs, transition.targetDesktop.inputUuid)
      : 'independent';
    if (!commentaryReady || !music.monitorPlanCompatible(relationship, transition.musicAfter)) {
      await migration.recover(obs, endpoint, observer, true);
    } else {
      if (
        !(await verifyManagedAudioMode(
          obs,
          browserBaseUrl,
          ids,
          transition.targetDesktop?.inputUuid,
          transition.omitCommentary,
        ))
      ) {
        await migration.recover(obs, endpoint, observer, true);
      } else {
        if (transition.targetDesktop) await migration.saveModeBackup(completedPath, transition.id);
        targetIds = ids;
        side = 'after';
      }
    }
  } else if (pending && outcome === 'mixed') {
    await migration.recover(obs, endpoint, observer, true);
  }
  let changed = false;
  const stop = observer.subscribe((event) => {
    if (event.type !== 'programChanged' || !event.managed) changed = true;
  });
  try {
    await music.commitDesktopMonitorOriginals(transition.musicBefore, transition.musicAfter, side);
    if (
      pending &&
      (await migration.inspectMode(obs, endpoint, observer, transition.id)) !==
        (side === 'after' ? 'applied' : 'before')
    )
      throw new Error('audio_mode_target_changed');
    if (
      side === 'after' &&
      !(await verifyManagedAudioMode(
        obs,
        browserBaseUrl,
        targetIds,
        transition.targetDesktop?.inputUuid,
        transition.omitCommentary,
      ))
    )
      throw new Error('audio_mode_target_changed');
    if (changed || !valid()) throw new Error('audio_migration_external_change');
    await routing.commitModeTransition(transition.id, side);
  } finally {
    stop();
  }
  if (side === 'after' && !transition.targetDesktop) await migration.clearModeBackup(completedPath);
  if (side === 'before' && !state.desktop)
    await migration.clearModeBackup(completedPath, transition.id);
  await migration.clearMode(transition.id);
}
