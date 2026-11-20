import type { ObsAudioRole } from '@mizar/protocol/obs';
import type { MusicAudioMode, MusicAudioRecovery } from '../music/device.js';
import {
  readMonitorOriginals,
  writeMonitorMode,
  writeMonitorOriginals,
} from '../music/monitor-journal.js';
import type { ObsRpc } from './reconcile.js';
import type { ObsAudioRouting } from './audio-routing.js';
import type { RemoteCommentary } from './remote-commentary.js';
import { AudioMigration, type MigrationObserver } from './audio-migration.js';
import { commentaryTargetReady } from './audio-setup.js';
import { desktopMonitorRelationship } from './audio-monitor-device.js';
import { reconcileManagedAudio, verifyManagedAudioMode } from './managed-audio.js';
import type { AudioMonitorChange } from './audio-monitor-contract.js';
import { guardedObs } from './prepare-readiness.js';
import { OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import { assertManagedGlobalAudioSilent } from './audio.js';
import { inspectAudioSceneGraph } from './audio-scene-graph.js';
import { createMusicDevice } from './music-device.js';

interface AudioModeContext {
  routing: ObsAudioRouting;
  commentary: { owner: RemoteCommentary; journal: string };
  browserBaseUrl: string;
}

/** Settle the stored audio mode using the current OBS identity and readback. */
export async function recoverAudioModeTransaction(
  { routing, commentary, browserBaseUrl }: AudioModeContext,
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
    if (
      !commentaryReady ||
      !music.monitorPlanCompatible(relationship, readMonitorOriginals(transition.musicAfter))
    ) {
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
    await music.commitDesktopMonitorOriginals(
      readMonitorOriginals(transition.musicBefore),
      readMonitorOriginals(transition.musicAfter),
      side,
    );
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

/** Apply the target mode and reconcile its durable recovery records. */
export async function switchAudioModeTransaction(
  context: AudioModeContext,
  connection: ObsRpc,
  endpoint: string,
  observer: MigrationObserver,
  {
    revision,
    mode,
    selectionId,
    waitId,
    valid,
  }: {
    revision: string;
    mode: 'desktop' | 'independent';
    selectionId: string | undefined;
    waitId: string | undefined;
    valid: () => boolean;
  },
  music: MusicAudioMode,
) {
  const { routing, commentary, browserBaseUrl } = context;
  if (!valid()) throw new Error('OBS 准备请求已失效，请重试。');
  const guarded = guardedObs(connection, valid);
  let obsWriteAttempted = false;
  let metadataCommitAttempted = false;
  const obs: ObsRpc = {
    ...guarded,
    call: (type, data, onDispatch) => {
      if (/^(Create|Set|Remove)/.test(type)) obsWriteAttempted = true;
      return guarded.call(type, data, onDispatch);
    },
  };
  const migration = new AudioMigration(`${commentary.journal}.migration`);
  const completedPath = `${commentary.journal}.dedicated-mode`;
  let monitorPending = false;
  const before = await routing.modeRecoveryState();
  if (before.revision !== revision) throw new Error('audio_revision_changed');
  if (before.transition) throw new Error('audio_mode_pending');
  await music.withAudioModeRecovery(() =>
    recoverAudioModeTransaction(context, obs, endpoint, observer, music, valid),
  );
  if (waitId) {
    const waiting = (await routing.modeRecoveryState()).waitingIndependent;
    if (
      !waiting ||
      waiting.id !== waitId ||
      (await commentary.owner.get()).revision !== waiting.commentaryRevision
    )
      throw new Error('audio_wait_cancelled');
  }
  await routing
    .switchMode(
      obs,
      endpoint,
      revision,
      mode,
      selectionId,
      async (ids, desktop, verify, begin, commit) => {
        const [stream, record, collection, inputs] = await Promise.all([
          obs.call('GetStreamStatus'),
          obs.call('GetRecordStatus'),
          obs.call('GetSceneCollectionList'),
          obs.call('GetInputList'),
        ]);
        if (
          typeof stream.outputActive !== 'boolean' ||
          typeof record.outputActive !== 'boolean' ||
          collection.currentSceneCollectionName !== OBS_COLLECTION ||
          !Array.isArray(inputs.inputs)
        )
          throw new Error('audio_setup_context_changed');
        const allInputs = inputs.inputs as Record<string, unknown>[];
        if (!desktop) await assertManagedGlobalAudioSilent(obs);
        const relationship = desktop ? await desktopMonitorRelationship(obs, desktop) : 'different';
        monitorPending = Boolean(desktop && relationship === 'unknown' && music.wantsMonitor());
        const microphoneChanges: AudioMonitorChange[] = [];
        if (desktop && relationship !== 'different' && ids.microphone) {
          const mic = await obs.call('GetInputAudioMonitorType', {
            inputUuid: ids.microphone,
          });
          if (
            mic.monitorType === 'OBS_MONITORING_TYPE_MONITOR_ONLY' ||
            mic.monitorType === 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT'
          )
            microphoneChanges.push({
              kind: 'monitor',
              inputUuid: ids.microphone,
              before: mic.monitorType,
              applied: 'OBS_MONITORING_TYPE_NONE',
            });
          else if (mic.monitorType !== 'OBS_MONITORING_TYPE_NONE')
            throw new Error('audio_microphone_monitor_unknown');
        }
        await migration.recover(obs, endpoint, observer);
        await music.prepareDesktopMix(
          createMusicDevice(obs),
          desktop ? relationship : 'independent',
          async (plan) => {
            const monitorChanges: AudioMonitorChange[] = [
              ...microphoneChanges,
              ...plan.changes.map((change) => ({
                kind: 'monitor' as const,
                inputUuid: change.sourceId,
                before: writeMonitorMode(change.before),
                applied: writeMonitorMode(change.applied),
              })),
            ];
            if (monitorChanges.length) {
              const graph = await inspectAudioSceneGraph(
                obs,
                obsDesiredScenes(browserBaseUrl).map((scene) => scene.sceneName),
              );
              const specials = await obs.call('GetSpecialInputs');
              for (const change of monitorChanges) {
                const input = allInputs.find((value) => value.inputUuid === change.inputUuid);
                const shared = graph.filter(
                  (container) =>
                    container.otherRoots.size &&
                    container.items.some((item) => item.sourceUuid === change.inputUuid),
                );
                if (shared.length || Object.values(specials).includes(input?.inputName))
                  throw new Error(
                    `audio_monitor_shared:${String(input?.inputName ?? change.inputUuid)}`,
                  );
              }
            }
            if (waitId) {
              const waiting = (await routing.modeRecoveryState()).waitingIndependent;
              if (
                !waiting ||
                waiting.id !== waitId ||
                (await commentary.owner.get()).revision !== waiting.commentaryRevision
              )
                throw new Error('audio_wait_cancelled');
            }
            if (
              waitId &&
              ids.remoteCommentary &&
              !(await commentaryTargetReady(
                obs,
                commentary.owner,
                ids.remoteCommentary,
                (await commentary.owner.get()).revision,
              ))
            )
              throw new Error('audio_commentary_unavailable');
            const modeId = await begin(
              writeMonitorOriginals(plan.musicBefore),
              writeMonitorOriginals(plan.musicAfter),
            );
            const extraIndependent: {
              sceneName: string;
              sceneItemId: number;
              sourceUuid: string;
              group?: boolean;
            }[] = [];
            const extraDesktop: typeof extraIndependent = [];
            if (!desktop) {
              const graph = await inspectAudioSceneGraph(
                obs,
                obsDesiredScenes(browserBaseUrl).map((scene) => scene.sceneName),
              );
              const restored = await migration.completedEnabledItems(completedPath);
              const waiting = (await routing.modeRecoveryState()).waitingIndependent;
              const previousDesktop = (await routing.modeRecoveryState()).desktop;
              if (previousDesktop) {
                if (
                  previousDesktop.endpoint !== endpoint ||
                  previousDesktop.collection !== OBS_COLLECTION
                )
                  throw new Error('audio_migration_identity_changed');
                for (const container of graph) {
                  if (!container.activeManagedRoots.size) continue;
                  for (const item of container.items) {
                    if (item.sourceUuid !== previousDesktop.inputUuid || !item.sceneItemEnabled)
                      continue;
                    if (container.otherRoots.size) throw new Error('audio_nested_shared_path');
                    extraDesktop.push({
                      sceneName: container.name,
                      sceneItemId: item.sceneItemId,
                      sourceUuid: item.sourceUuid,
                      ...(container.group ? { group: true } : {}),
                    });
                  }
                }
              }
              const targetIds = [
                ids.game,
                ...(waiting?.omitCommentary ? [] : [ids.remoteCommentary]),
                ...(waiting?.createdMicrophone ? [ids.microphone] : []),
              ];
              for (const scene of obsDesiredScenes(browserBaseUrl))
                for (const uuid of targetIds) {
                  if (!uuid) throw new Error('audio_bindings_incomplete');
                  const active = graph.some(
                    (container) =>
                      container.activeManagedRoots.has(scene.sceneName) &&
                      container.items.some(
                        (item) => item.sourceUuid === uuid && item.sceneItemEnabled,
                      ),
                  );
                  const willRestore = restored.some(
                    (entry) =>
                      entry.sourceUuid === uuid &&
                      graph.some(
                        (container) =>
                          container.name === entry.sceneName &&
                          container.group === Boolean(entry.group) &&
                          container.activeManagedRoots.has(scene.sceneName),
                      ),
                  );
                  if (active || willRestore) continue;
                  const root = graph.find(
                    (container) => !container.group && container.name === scene.sceneName,
                  );
                  const candidate = root?.items.find(
                    (item) => item.sourceUuid === uuid && !item.sceneItemEnabled,
                  );
                  if (!candidate) throw new Error('audio_independent_not_prepared');
                  extraIndependent.push({
                    sceneName: scene.sceneName,
                    sceneItemId: candidate.sceneItemId,
                    sourceUuid: uuid,
                  });
                }
            }
            if (
              !desktop &&
              (await migration.restoreCompleted(
                obs,
                endpoint,
                observer,
                completedPath,
                monitorChanges,
                modeId,
                extraIndependent,
                plan.managedSources,
                extraDesktop,
                Object.values(ids).filter((id): id is string => Boolean(id)),
              ))
            ) {
              // Reverse migration stays pending until the routing state is committed.
            } else {
              await reconcileManagedAudio(
                obs,
                endpoint,
                observer,
                commentary.journal,
                browserBaseUrl,
                ids,
                verify,
                desktop,
                monitorChanges,
                modeId,
                Boolean((await routing.modeRecoveryState()).waitingIndependent?.omitCommentary),
              );
            }
            let changed = false;
            const stop = observer.subscribe((event) => {
              if (event.type !== 'programChanged' || !event.managed) changed = true;
            });
            try {
              if ((await migration.inspectMode(obs, endpoint, observer, modeId)) !== 'applied')
                throw new Error('audio_mode_unconfirmed');
              if (
                !(await verifyManagedAudioMode(
                  obs,
                  browserBaseUrl,
                  ids,
                  desktop,
                  Boolean((await routing.modeRecoveryState()).waitingIndependent?.omitCommentary),
                ))
              ) {
                await migration.recover(obs, endpoint, observer, true);
                throw new Error('audio_mode_target_changed');
              }
              if (desktop) {
                metadataCommitAttempted = true;
                await migration.saveModeBackup(completedPath, modeId);
              }
              metadataCommitAttempted = true;
              await music.commitDesktopMonitorOriginals(plan.musicBefore, plan.musicAfter, 'after');
              if (
                changed ||
                (await migration.inspectMode(obs, endpoint, observer, modeId)) !== 'applied'
              )
                throw new Error('audio_migration_external_change');
              if (
                waitId &&
                ids.remoteCommentary &&
                !(await commentaryTargetReady(
                  obs,
                  commentary.owner,
                  ids.remoteCommentary,
                  (await commentary.owner.get()).revision,
                ))
              )
                throw new Error('audio_commentary_unavailable');
              if (desktop && (await desktopMonitorRelationship(obs, desktop)) !== relationship)
                throw new Error('audio_monitor_device_changed');
              if (changed) throw new Error('audio_migration_external_change');
              await commit(modeId);
            } finally {
              stop();
            }
            if (!desktop) await migration.clearModeBackup(completedPath);
            await migration.clearMode(modeId);
          },
        );
      },
    )
    .catch(async (error: unknown) => {
      // Clear only if no OBS write or mode metadata commit was attempted.
      // An unknown write or uncertain journal remains pending for review.
      if (!obsWriteAttempted && !metadataCommitAttempted) {
        try {
          const current = await routing.modeRecoveryState();
          const transition = current.transition;
          if (
            current.revision === revision &&
            transition &&
            transition !== true &&
            transition.endpoint === endpoint
          ) {
            await migration.discardUnsentMode(transition.id);
            await routing.commitModeTransition(transition.id, 'before');
          }
        } catch {
          // Uncertain storage or journal state remains visible for review.
        }
      }
      throw error;
    });
  const after = mode === 'desktop' ? await routing.modeRecoveryState() : null;
  return { monitorPending, desktopSettled: Boolean(after?.desktop && !after.transition) };
}
