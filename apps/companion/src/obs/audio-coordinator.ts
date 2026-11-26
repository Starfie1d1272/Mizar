import { AudioMeter } from './audio-meter.js';
import {
  readAudioDevices,
  readAudioDeviceDiagnostics,
  setAudioDevice,
  type AudioDeviceCommand,
} from './audio-device-settings.js';
import {
  commentaryPreparationFinding,
  guardedObs,
  obsAudioModeFailureEvidence,
  obsErrorEvidence,
} from './prepare-readiness.js';
import { createHash, randomUUID } from 'node:crypto';

import type { ObsAudioBindCommand } from '@mizar/protocol/obs';
import { ObsPreparationWriteBlocked } from './video-transaction.js';
import type { ObsAudioRouting } from './audio-routing.js';
import type { GameAudioController } from './audio-policy-controller.js';
import type { MixerChannelStatus, MixerCommand, MixerCommandResult } from '@mizar/protocol/mixer';
import { createCommentaryProbe, isTeamspeak, RemoteCommentary } from './remote-commentary.js';
import {
  AUTO_TEAMSPEAK_TARGET,
  readCommentarySwitch,
  saveCommentarySwitch,
} from './commentary-switch.js';
import { readOwnedCommentaryTarget } from './commentary-owned-target.js';
import { OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';
import {
  configureIndependentAudio,
  prepareIndependentForDesktop,
  readOwnedCommentaryJournal,
} from './audio-setup.js';
import { reconcileManagedAudio } from './managed-audio.js';
import { AudioMigration, type MigrationObserver } from './audio-migration.js';
import type { MusicAudioRecovery } from '../music/device.js';
import {
  recoverAudioModeTransaction,
  switchAudioModeTransaction,
} from './audio-mode-transaction.js';
import { AudioConfigurationConnection } from './audio-configuration-connection.js';
import type { ObsConfigStore } from './config.js';
import { AUDIO_KINDS, assertManagedGlobalAudioSilent, readDesiredSceneItems } from './audio.js';
import { guardedPreparationWrites, type ObsFinding, type ObsRpc } from './reconcile.js';

export interface ObsAudioCoordinatorHost {
  readonly configStore: ObsConfigStore;
  readonly audioRouting: ObsAudioRouting | undefined;
  readonly commentary: { owner: RemoteCommentary; journal: string } | undefined;
  readonly browserBaseUrl: string;
  diagnostic: (stage: string, error: unknown) => void;
  observe: <T>(read: () => Promise<T>) => Promise<T>;
  serial: <T>(operation: () => Promise<T>) => Promise<T>;
  configurationMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  withObs: <T>(
    operation: (obs: ObsRpc, endpoint: string, recovery: ObsRpc) => Promise<T>,
    options?: {
      readonly timeoutMs?: number;
      readonly diagnosticStage?: string;
      readonly observe?: 'audio' | 'browser' | 'video' | 'preparation';
    },
  ) => Promise<T>;
  withReadObs: <T>(
    operation: (obs: ObsRpc, endpoint: string) => Promise<T>,
    timeoutMs?: number,
  ) => Promise<T>;
  captureWarmupGuard: () => Promise<() => boolean>;
  observationValidity: () => () => boolean;
  waitForAutomaticAudioConnection: () => boolean;
  programGeneration: () => number;
  recoveryGeneration: () => number;
}

/** Owns OBS audio device settings, mode transitions, commentary selection, and mixer state. */
export class ObsAudioCoordinator {
  private commentaryChoices = new Map<
    string,
    { window: string; revision: string; endpoint: string; probe: string; until: number }
  >();
  private readonly warnings: Partial<
    Record<'setup' | 'routing' | 'commentary' | 'music', ObsFinding>
  > = {};

  private readonly audioConfiguration: AudioConfigurationConnection;
  private readonly audioMeter: AudioMeter;

  constructor(private readonly host: ObsAudioCoordinatorHost) {
    this.audioConfiguration = new AudioConfigurationConnection(host.configStore);
    this.audioMeter = new AudioMeter(host.configStore, undefined, undefined, (error, password) =>
      host.diagnostic(
        'obs_audio_meter',
        password === undefined
          ? { reason: 'audio_meter_unavailable', redactionContext: 'unavailable' }
          : obsErrorEvidence(error, password),
      ),
    );
  }

  setWarning(slot: 'setup' | 'routing' | 'commentary' | 'music', finding: ObsFinding): void {
    this.warnings[slot] = finding;
  }

  clearWarning(slot: 'setup' | 'routing' | 'commentary' | 'music'): void {
    delete this.warnings[slot];
  }

  warningSnapshot(): Partial<Record<'setup' | 'routing' | 'commentary' | 'music', ObsFinding>> {
    return { ...this.warnings };
  }

  private async runConfigureIndependentAudio(
    obs: ObsRpc,
    endpoint: string,
    observer: MigrationObserver,
  ): Promise<ObsFinding[]> {
    const findings = await configureIndependentAudio(
      obs,
      endpoint,
      observer,
      this.host.commentary!.owner,
      this.host.commentary!.journal,
      this.host.browserBaseUrl,
      async (ids) => this.host.audioRouting?.seedAutomatic(obs, endpoint, ids),
      async () => !(await this.host.audioRouting?.enabled()),
      async (plan) => {
        const routing = await this.host.audioRouting?.commentaryBinding();
        return Boolean(
          routing &&
          routing.revision === plan.routingRevision &&
          routing.binding?.inputUuid === plan.uuid &&
          routing.binding.endpoint === plan.endpoint &&
          routing.binding.collection === plan.collection &&
          routing.game?.inputUuid !== plan.uuid &&
          routing.microphone?.inputUuid !== plan.uuid,
        );
      },
      async () => (await this.host.audioRouting?.managedBindings(obs, endpoint)) ?? null,
    );
    const pending = findings.find((item) => item.code === 'commentary_pending');
    if (pending) this.warnings.commentary = pending;
    else delete this.warnings.commentary;
    return findings;
  }

  private async preflightCommentarySwitch(switchPath: string) {
    const pendingSwitch = await readCommentarySwitch(switchPath);
    if (pendingSwitch?.phase === 'sent') throw new Error('commentary_switch_recovery_required');
    const routingState = await this.host.audioRouting?.modeRecoveryState();
    if (routingState?.transition) throw new Error('audio_mode_pending');
    if (routingState?.desktop && routingState.bindings.remoteCommentary)
      throw new Error('commentary_binding_change_requires_independent');
    return { pendingSwitch, routingState };
  }

  private async readOwnedCommentaryContext(endpoint: string) {
    const journal = this.host.commentary!.journal;
    const [owned, routing, confirmed] = await Promise.all([
      readOwnedCommentaryJournal(journal),
      this.host.audioRouting?.commentaryBinding(),
      readOwnedCommentaryTarget(`${journal}.owned-target`),
    ]);
    const validOwned = Boolean(
      owned?.endpoint === endpoint &&
      owned.collection === OBS_COLLECTION &&
      typeof owned.uuid === 'string' &&
      confirmed?.endpoint === endpoint &&
      confirmed.collection === OBS_COLLECTION &&
      confirmed.uuid === owned.uuid &&
      routing?.binding?.inputUuid === owned.uuid &&
      routing.binding.endpoint === endpoint &&
      routing.binding.collection === OBS_COLLECTION &&
      routing.game?.inputUuid !== owned.uuid &&
      routing.microphone?.inputUuid !== owned.uuid,
    );
    return { owned, routing, confirmed, validOwned };
  }

  clearCommentaryChoices() {
    this.commentaryChoices.clear();
  }

  async recoverAudioMode(
    music: MusicAudioRecovery,
    valid: () => boolean = () => true,
    revision?: string,
  ): Promise<void> {
    if (!this.host.audioRouting || !this.host.commentary)
      throw new Error('audio_routing_unavailable');
    await this.host.configurationMutation(async () => {
      const state = await this.host.audioRouting!.modeRecoveryState();
      if (revision !== undefined && state.revision !== revision)
        throw new Error('audio_revision_changed');
      const migration = new AudioMigration(`${this.host.commentary!.journal}.migration`);
      const pending = await migration.pending();
      if (!state.transition && !pending?.modeId) return;
      await this.audioConfiguration.run((obs, endpoint, observer) =>
        music.withAudioModeRecovery(() =>
          this.recoverAudioModeOnConnection(guardedObs(obs, valid), endpoint, observer, valid),
        ),
      );
    });
  }
  recoverAudioModeOnConnection(
    obs: ObsRpc,
    endpoint: string,
    observer: MigrationObserver,
    valid: () => boolean = () => true,
  ) {
    return recoverAudioModeTransaction(
      {
        routing: this.host.audioRouting!,
        commentary: this.host.commentary!,
        browserBaseUrl: this.host.browserBaseUrl,
      },
      obs,
      endpoint,
      observer,
      valid,
    );
  }

  sampleAudioMeters(valid: () => boolean) {
    const generation = this.host.programGeneration();
    return this.audioMeter.sample(() => valid() && generation === this.host.programGeneration());
  }
  readAudioDevices() {
    return this.host.observe(() =>
      this.host.withReadObs(
        async (obs) => ({
          ...(await readAudioDevices(obs)),
          desktopMode: Boolean(await this.host.audioRouting?.desktopBinding()),
        }),
        12000,
      ),
    );
  }
  readAudioDeviceDiagnostics() {
    return this.host.observe(() => this.host.withReadObs(readAudioDeviceDiagnostics, 12000));
  }
  setAudioDevice(command: AudioDeviceCommand) {
    const generation = this.host.recoveryGeneration();
    const programGeneration = this.host.programGeneration();
    return this.host.configurationMutation(() =>
      this.audioModeRun('audio_device_set', async (connection) => {
        if (!this.host.audioRouting) throw new Error('audio_routing_unavailable');
        const state = await this.host.audioRouting.modeRecoveryState();
        if (state.transition || state.waitingIndependent) throw new Error('audio_mode_pending');
        const obs = guardedObs(
          connection,
          () =>
            generation === this.host.recoveryGeneration() &&
            programGeneration === this.host.programGeneration(),
        );
        return setAudioDevice(obs, command);
      }),
    );
  }
  readAudioRouting() {
    if (!this.host.audioRouting) throw new Error('audio_routing_unavailable');
    return this.host.observe(() =>
      this.host.withReadObs((obs, endpoint) => this.host.audioRouting!.read(obs, endpoint), 12000),
    );
  }
  cancelAudioWait(revision: string) {
    if (!this.host.audioRouting) throw new Error('audio_routing_unavailable');
    return this.host.serial(async () => {
      if (!(await this.host.audioRouting!.cancelIndependentWait(undefined, true, revision)))
        throw new Error('audio_wait_cancelled');
      return { cancelled: true };
    });
  }
  private audioModeRun<T>(
    stage: string,
    operation: (obs: ObsRpc, endpoint: string, observer: MigrationObserver) => Promise<T>,
  ): Promise<T> {
    return this.audioConfiguration.run(operation, (error, password) => {
      this.host.diagnostic(
        stage,
        password === undefined
          ? { ...obsAudioModeFailureEvidence(error), redactionContext: 'unavailable' }
          : obsErrorEvidence(error, password),
      );
    });
  }
  async requestIndependentMode(revision: string, music: MusicAudioRecovery) {
    if (!this.host.audioRouting || !this.host.commentary)
      throw new Error('audio_routing_unavailable');
    await this.host.configurationMutation(() =>
      this.audioModeRun('audio_mode_prepare', async (obs, endpoint, observer) => {
        const before = await this.host.audioRouting!.modeRecoveryState();
        if (before.revision !== revision) throw new Error('audio_revision_changed');
        if (before.transition) throw new Error('audio_mode_pending');
        await music.withAudioModeRecovery(() =>
          this.recoverAudioModeOnConnection(obs, endpoint, observer),
        );
        const collection = (await obs.call('GetSceneCollectionList')).currentSceneCollectionName;
        if (typeof collection !== 'string') throw new Error('audio_setup_context_changed');
        await assertManagedGlobalAudioSilent(obs);
        const preference = await this.host.commentary!.owner.get();
        await this.host.audioRouting!.waitForIndependent(
          revision,
          endpoint,
          collection,
          preference.revision,
          preference.preference.mode === 'disabled',
        );
      }),
    );
    const ready = await this.prepareWaitingIndependent();
    if (!ready) return { waiting: true };
    const result = await this.switchAudioMode(
      ready.revision,
      'independent',
      undefined,
      music,
      ready.id,
    );
    return { waiting: false, ...result };
  }
  async queueIndependentCommentary(valid: () => boolean = () => true): Promise<void> {
    if (!this.host.audioRouting || !this.host.commentary) return;
    const initial = await this.host.audioRouting.modeRecoveryState();
    if (
      initial.desktop ||
      !initial.independentCommentaryDisabled ||
      initial.transition ||
      initial.waitingIndependent
    )
      return;
    const preference = await this.host.commentary.owner.get();
    if (
      preference.preference.mode === 'disabled' ||
      initial.cancelledCommentaryRevision === preference.revision
    )
      return;
    if (this.host.waitForAutomaticAudioConnection()) return;
    await this.host.configurationMutation(() =>
      this.audioConfiguration.run(async (connection, endpoint) => {
        const obs = guardedObs(connection, valid);
        const current = await this.host.audioRouting!.modeRecoveryState();
        if (
          current.revision !== initial.revision ||
          current.desktop ||
          current.transition ||
          current.waitingIndependent ||
          !current.independentCommentaryDisabled ||
          (await this.host.commentary!.owner.get()).revision !== preference.revision
        )
          return;
        const collection = (await obs.call('GetSceneCollectionList')).currentSceneCollectionName;
        if (collection !== OBS_COLLECTION || !obs.ownershipScope)
          throw new Error('audio_setup_context_changed');
        await obs.ownershipScope();
        if (!valid()) throw new Error('OBS 准备请求已失效，请重试。');
        await this.host.audioRouting!.waitForIndependent(
          current.revision,
          endpoint,
          collection,
          preference.revision,
          false,
        );
      }),
    );
  }
  private async prepareWaitingIndependent(
    valid: () => boolean = () => true,
  ): Promise<{ id: string; revision: string } | null> {
    if (!this.host.audioRouting || !this.host.commentary) return null;
    const initial = await this.host.audioRouting.modeRecoveryState();
    if (
      !initial.waitingIndependent ||
      initial.transition ||
      (!initial.desktop && !initial.independentCommentaryDisabled)
    )
      return null;
    return this.host.configurationMutation(() =>
      this.audioModeRun('audio_mode_sources', async (connection, endpoint, observer) => {
        if (!valid()) throw new Error('OBS 准备请求已失效，请重试。');
        const obs = guardedObs(connection, valid);
        const state = await this.host.audioRouting!.modeRecoveryState();
        const wait = state.waitingIndependent;
        if (
          !wait ||
          wait.id !== initial.waitingIndependent!.id ||
          state.transition ||
          (!state.desktop && !state.independentCommentaryDisabled)
        )
          return null;
        const preference = await this.host.commentary!.owner.get();
        if (preference.revision !== wait.commentaryRevision) {
          await this.host.audioRouting!.cancelIndependentWait(wait.id);
          return null;
        }
        if (
          endpoint !== wait.endpoint ||
          (await obs.call('GetSceneCollectionList')).currentSceneCollectionName !== wait.collection
        )
          throw new Error('audio_migration_identity_changed');
        const prepared = await prepareIndependentForDesktop(
          obs,
          endpoint,
          observer,
          this.host.commentary!.owner,
          this.host.commentary!.journal,
          this.host.browserBaseUrl,
          state.bindings,
          state.desktopMicrophone,
          wait.commentaryRevision,
          async () => {
            const current = await this.host.audioRouting!.modeRecoveryState();
            return (
              valid() &&
              current.revision === state.revision &&
              current.waitingIndependent?.id === wait.id &&
              !current.transition &&
              (await this.host.commentary!.owner.get()).revision === wait.commentaryRevision
            );
          },
        );
        if (!prepared) return null;
        const revision = await this.host.audioRouting!.adoptPreparedBindings(
          obs,
          endpoint,
          wait.id,
          state.revision,
          prepared.ids,
          prepared.createdMicrophone,
        );
        return { id: wait.id, revision };
      }),
    );
  }
  switchAudioMode(
    revision: string,
    mode: 'desktop' | 'independent',
    selectionId: string | undefined,
    music: MusicAudioRecovery,
    waitId?: string,
    valid: () => boolean = () => true,
  ) {
    const { audioRouting: routing, commentary, browserBaseUrl } = this.host;
    if (!routing || !commentary) throw new Error('audio_routing_unavailable');
    return this.host.configurationMutation(() =>
      this.audioModeRun('audio_mode_switch', async (obs, endpoint, observer) => {
        const { desktopSettled } = await switchAudioModeTransaction(
          { routing, commentary, browserBaseUrl },
          obs,
          endpoint,
          observer,
          { revision, mode, selectionId, waitId, valid },
          music,
        );
        if (desktopSettled) {
          delete this.warnings.commentary;
          if (this.warnings.routing?.code === 'audio_bindings_required')
            delete this.warnings.routing;
        }
        return {};
      }),
    );
  }
  private mixerRevision(routing: { revision: string; endpoint: string; collection: string }) {
    return createHash('sha256')
      .update(JSON.stringify([routing.revision, routing.endpoint, routing.collection]))
      .digest('hex');
  }
  private mixerRoleBinding(
    routing: Awaited<ReturnType<ObsAudioRouting['read']>>,
    role: 'game' | 'remoteCommentary' | 'microphone',
    endpoint?: string,
  ) {
    if (routing.desktop && role === 'game') {
      const valid = endpoint
        ? routing.desktop.endpoint === endpoint &&
          routing.desktop.collection === routing.collection &&
          routing.candidates.some(
            (input) =>
              input.uuid === routing.desktop!.inputUuid &&
              input.kind === routing.desktop!.inputKind,
          )
        : true;
      return { ...routing.desktop, valid, name: '桌面混音' };
    }
    return routing.desktop && role === 'microphone'
      ? (routing.desktopMicrophone ?? null)
      : routing.bindings[role];
  }
  private async mixerReadObs(obs: ObsRpc, endpoint: string) {
    if (!this.host.audioRouting) throw new Error('audio_routing_unavailable');
    const routing = await this.host.audioRouting.read(obs, endpoint);
    const channels = {} as Record<'game' | 'remoteCommentary' | 'microphone', MixerChannelStatus>;
    const unavailable = (
      name: string,
      control: 'unknown' | 'unbound',
      message?: string,
    ): MixerChannelStatus => ({
      name,
      volume: null,
      muted: null,
      control,
      ...(message ? { message } : {}),
    });
    for (const role of ['game', 'remoteCommentary', 'microphone'] as const) {
      if (routing.transition) {
        channels[role] = unavailable(
          role,
          'unknown',
          '音频模式切换待完成，请回到声音设置重新切换。',
        );
        continue;
      }
      const binding = this.mixerRoleBinding(routing, role, endpoint);
      if (
        role === 'remoteCommentary' &&
        (routing.desktop || routing.independentCommentaryDisabled)
      ) {
        channels[role] = unavailable(
          '远端解说',
          'unbound',
          routing.desktop ? '桌面混音中无法单独调整。' : '远端解说已停用。',
        );
        continue;
      }
      const name =
        binding?.name ??
        ({ game: '游戏', remoteCommentary: '远端解说', microphone: '麦克风' } as const)[role];
      if (!binding || !binding.valid) {
        channels[role] = unavailable(name, binding ? 'unknown' : 'unbound');
        continue;
      }
      const args = { inputUuid: binding.inputUuid };
      const [volume, mute] = await Promise.all([
        obs.call('GetInputVolume', args),
        obs.call('GetInputMute', args),
      ]);
      const known =
        typeof volume.inputVolumeMul === 'number' &&
        Number.isFinite(volume.inputVolumeMul) &&
        typeof mute.inputMuted === 'boolean';
      channels[role] = {
        name,
        volume: known ? (volume.inputVolumeMul as number) : null,
        muted: known ? (mute.inputMuted as boolean) : null,
        control: known ? 'available' : 'unknown',
      };
    }
    return { revision: this.mixerRevision(routing), channels, routing };
  }
  mixerRead() {
    return this.host.observe(() =>
      this.host.withReadObs((obs, endpoint) => this.mixerReadObs(obs, endpoint), 12000),
    );
  }
  mixerWrite(command: MixerCommand, gameAudio?: GameAudioController): Promise<MixerCommandResult> {
    return this.host.serial(() =>
      this.host
        .withObs<MixerCommandResult>(
          async (obs, endpoint) => {
            try {
              const initial = await this.mixerReadObs(obs, endpoint);
              if (
                command.channel === 'music' ||
                initial.revision !== command.revision ||
                initial.channels[command.channel].control !== 'available'
              )
                return { status: 'rejected', message: '音频绑定已变化或不可用，请刷新。' };
              const role = command.channel;
              const binding = this.mixerRoleBinding(initial.routing, role)!;
              const perform = async (recheck: boolean): Promise<MixerCommandResult> => {
                if (recheck) {
                  const current = await this.mixerReadObs(obs, endpoint);
                  if (
                    current.revision !== command.revision ||
                    current.channels[role].control !== 'available'
                  )
                    return { status: 'rejected', message: '音频绑定已变化，请刷新。' };
                }
                const args = { inputUuid: binding.inputUuid };
                if (command.volume !== undefined)
                  await obs.call('SetInputVolume', { ...args, inputVolumeMul: command.volume });
                if (command.muted !== undefined)
                  await obs.call('SetInputMute', { ...args, inputMuted: command.muted });
                const [collectionRes, recoveryState, volumeRes, muteRes] = await Promise.all([
                  obs.call('GetSceneCollectionList'),
                  this.host.audioRouting!.modeRecoveryState(),
                  command.volume !== undefined ? obs.call('GetInputVolume', args) : null,
                  command.muted !== undefined ? obs.call('GetInputMute', args) : null,
                ]);
                const afterRevision =
                  typeof collectionRes.currentSceneCollectionName === 'string'
                    ? this.mixerRevision({
                        revision: recoveryState.revision,
                        endpoint,
                        collection: collectionRes.currentSceneCollectionName,
                      })
                    : null;
                const observedVolume = volumeRes?.inputVolumeMul;
                const observedMuted = muteRes?.inputMuted;
                if (
                  afterRevision !== command.revision ||
                  (command.volume !== undefined &&
                    (typeof observedVolume !== 'number' ||
                      !Number.isFinite(observedVolume) ||
                      Math.fround(observedVolume) !== Math.fround(command.volume))) ||
                  (command.muted !== undefined && observedMuted !== command.muted)
                )
                  return { status: 'unknown', message: '写入结果未确认，请刷新。' };
                return { status: 'confirmed' };
              };
              if (role === 'game' && !initial.routing.desktop) {
                if (!gameAudio) return { status: 'rejected', message: '游戏音频控制不可用。' };
                return await gameAudio.manual(() => perform(true));
              }
              return await perform(false);
            } catch {
              return {
                status: 'unknown',
                message: '音频操作未确认，请刷新。',
              };
            }
          },
          { timeoutMs: 12000, observe: 'audio' },
        )
        .catch(() => ({ status: 'unknown', message: 'OBS 连接未确认。' })),
    );
  }
  bindAudio(command: ObsAudioBindCommand) {
    if (!this.host.audioRouting) throw new Error('audio_routing_unavailable');
    return this.host.serial(() =>
      this.host.withObs(
        async (obs, endpoint) => {
          await this.host.audioRouting!.bind(obs, command, endpoint, async (binding) => {
            if (command.role !== 'remoteCommentary' || !this.host.commentary) return;
            if (
              (await readCommentarySwitch(`${this.host.commentary.journal}.switch`))?.phase ===
              'sent'
            )
              throw new Error('commentary_switch_recovery_required');
            const current = await this.host.commentary.owner.get();
            await this.host.commentary.owner.set(
              binding
                ? {
                    mode: 'existingInput',
                    binding: {
                      endpoint: binding.endpoint,
                      collection: binding.collection,
                      inputUuid: binding.inputUuid,
                    },
                  }
                : { mode: 'disabled' },
              current.revision,
            );
          });
        },
        { timeoutMs: 12000 },
      ),
    );
  }
  async readCommentary() {
    if (!this.host.commentary) throw new Error('commentary_unavailable');
    return this.host.commentary.owner.get();
  }
  /** Explicit audio-only retry; it does not prepare or switch visual scenes. */
  prepareCommentaryAudio() {
    if (!this.host.commentary || !this.host.audioRouting) throw new Error('commentary_unavailable');
    return this.host.configurationMutation(() =>
      this.audioConfiguration.run(async (connection, endpoint, observer) => {
        const state = await this.host.audioRouting!.modeRecoveryState();
        if (
          state.desktop ||
          state.transition ||
          state.waitingIndependent ||
          state.independentCommentaryDisabled
        )
          throw new Error('audio_mode_pending');
        if (await this.host.audioRouting!.requiresManualBindings())
          throw new Error('audio_bindings_required');
        if (
          Object.values(state.bindings).some(
            (binding) => binding && ['game_capture', 'window_capture'].includes(binding.inputKind),
          )
        )
          throw new Error('audio_video_requires_full_preparation');
        const obs = guardedPreparationWrites(connection);
        const preference = await this.host.commentary!.owner.get();
        if (preference.preference.mode === 'existingInput') {
          const bindingUuid = preference.preference.binding.inputUuid;
          const inputs = (await obs.call('GetInputList')).inputs;
          if (!Array.isArray(inputs)) throw new Error('audio_video_requires_full_preparation');
          const selected = inputs.find(
            (input: Record<string, unknown>) => input.inputUuid === bindingUuid,
          ) as Record<string, unknown> | undefined;
          if (!selected || !AUDIO_KINDS.has(String(selected.inputKind)))
            throw new Error('audio_video_requires_full_preparation');
        }
        return this.runConfigureIndependentAudio(obs, endpoint, observer);
      }),
    );
  }

  async prepareProgramAudio(options: {
    prepared: { ready: boolean; audioReady: boolean; findings: ObsFinding[] };
    current: () => boolean;
    checkOutput: () => void;
    preparationObs: (connection: ObsRpc) => ObsRpc;
    audioFailure: (error: unknown, stage: string) => ObsFinding;
    prepareMusic?:
      ((valid: () => boolean, guard: (obs: ObsRpc) => ObsRpc) => Promise<void>) | undefined;
  }): Promise<void> {
    const { prepared, current, checkOutput, preparationObs, audioFailure, prepareMusic } = options;
    if (prepared.ready && prepared.audioReady) delete this.warnings.setup;
    if (prepared.ready && prepared.audioReady && this.host.audioRouting && this.host.commentary) {
      try {
        if (!(await this.host.audioRouting.modePending()))
          await this.audioConfiguration.run(async (connection, endpoint, observer) => {
            const obs = guardedPreparationWrites(preparationObs(connection));
            const state = await this.host.audioRouting!.modeRecoveryState();
            const ids = state.desktop
              ? {
                  ...(state.desktopMicrophone
                    ? { microphone: state.desktopMicrophone.inputUuid }
                    : {}),
                }
              : Object.fromEntries(
                  Object.entries(state.bindings)
                    .filter(([, binding]) => binding !== null)
                    .map(([role, binding]) => [role, binding!.inputUuid]),
                );
            if (
              state.desktop ||
              (state.bindings.game &&
                state.bindings.microphone &&
                (state.bindings.remoteCommentary || state.independentCommentaryDisabled))
            ) {
              await reconcileManagedAudio(
                obs,
                endpoint,
                observer,
                this.host.commentary!.journal,
                this.host.browserBaseUrl,
                ids,
                async () =>
                  (await this.host.audioRouting!.modeRecoveryState()).revision === state.revision,
                state.desktop?.inputUuid,
                [],
                undefined,
                state.independentCommentaryDisabled,
              );
              await new AudioMigration(
                `${this.host.commentary!.journal}.migration`,
              ).forgetCompletedSceneItems(
                `${this.host.commentary!.journal}.dedicated-mode`,
                endpoint,
                OBS_COLLECTION,
              );
              const unwanted = new Set(
                state.desktop
                  ? ['游戏声音', '其他解说']
                  : ['桌面声音', ...(state.independentCommentaryDisabled ? ['其他解说'] : [])],
              );
              for (const { scene, items } of await readDesiredSceneItems(
                obs,
                this.host.browserBaseUrl,
              )) {
                for (const item of items)
                  if (scene.id !== 'waiting' && item.sourceName && unwanted.has(item.sourceName))
                    await obs.call('RemoveSceneItem', {
                      sceneName: scene.sceneName,
                      sceneItemId: item.sceneItemId,
                    });
              }
            }
          });
      } catch (error) {
        prepared.audioReady = false;
        prepared.findings.push(audioFailure(error, 'obs_audio_reconcile'));
      }
    }

    let audioRoutingReady = true;
    let modePending = false;
    let desktopBinding = false;
    let defaultDesktop = false;
    let manualBindingsRequired = false;
    try {
      const routingState = await this.host.audioRouting?.modeRecoveryState();
      modePending = Boolean(routingState?.transition || routingState?.waitingIndependent);
      desktopBinding = Boolean(routingState?.desktop);
      defaultDesktop = Boolean(await this.host.audioRouting?.hasNoEstablishedMode());
      manualBindingsRequired = Boolean(await this.host.audioRouting?.requiresManualBindings());
      if (manualBindingsRequired && !defaultDesktop) {
        this.warnings.routing = {
          code: 'audio_bindings_required',
          message: '旧配置尚未完成音频分路，请在声音设置中选择并准备音频模式。',
        };
        prepared.findings.push(this.warnings.routing);
      } else if (this.warnings.routing?.code !== 'audio_bindings_required') {
        delete this.warnings.routing;
      }
    } catch (error) {
      if (!current()) throw error;
      audioRoutingReady = false;
      this.host.diagnostic('obs_audio_routing', obsErrorEvidence(error));
      this.warnings.routing = {
        code: 'audio_routing_unavailable',
        message: '音频路由未确认，请在声音设置和 OBS 中核对。',
      };
      prepared.findings.push(this.warnings.routing);
    }
    if (modePending && !prepared.findings.some((item) => item.code === 'audio_mode_pending'))
      prepared.findings.push({
        code: 'commentary_pending',
        message: '音频模式切换待完成，请在声音设置中核对并恢复音频。',
      });
    if (
      prepared.ready &&
      prepared.audioReady &&
      this.host.commentary &&
      audioRoutingReady &&
      !manualBindingsRequired &&
      !defaultDesktop &&
      !desktopBinding &&
      !modePending
    ) {
      try {
        const commentary = await this.audioConfiguration.run((connection, endpoint, observer) =>
          this.runConfigureIndependentAudio(
            guardedPreparationWrites(preparationObs(connection)),
            endpoint,
            observer,
          ),
        );
        prepared.findings.push(...commentary);
      } catch (error) {
        if (!current()) throw error;
        if (error instanceof ObsPreparationWriteBlocked) throw error;
        checkOutput();
        this.host.diagnostic('obs_commentary_prepare', obsErrorEvidence(error));
        const uncertain = await readCommentarySwitch(`${this.host.commentary.journal}.switch`)
          .then((value) => value?.phase === 'sent')
          .catch(() => true);
        this.warnings.commentary = commentaryPreparationFinding(error, uncertain);
        prepared.findings.push(this.warnings.commentary);
      }
    }
    if (!current()) throw new Error('OBS 准备请求已失效，请重试。');
    if (prepared.ready && prepareMusic) {
      checkOutput();
      try {
        await prepareMusic(current, preparationObs);
        delete this.warnings.music;
      } catch (error) {
        if (!current() || error instanceof ObsPreparationWriteBlocked) throw error;
        this.host.diagnostic('obs_music_prepare', obsErrorEvidence(error));
        this.warnings.music = {
          code: 'audio_music_prepare_failed',
          message: '场景已准备，音乐来源准备未确认，请在音乐设置中核对。',
        };
      }
      checkOutput();
    }
  }
  /** An unbound owned probe may still carry an earlier target. Do not promise a
   * new choice unless the existing target can already satisfy that choice. */
  private async checkUnboundCommentaryChoice(obs: ObsRpc, endpoint: string, window?: string) {
    const journal = this.host.commentary!.journal;
    const owned = await readOwnedCommentaryJournal(journal);
    if (!owned) return;
    if (owned.endpoint !== endpoint || owned.collection !== OBS_COLLECTION || !owned.uuid)
      throw new Error('commentary_binding_change_requires_independent');
    const inputs = (await obs.call('GetInputList')).inputs;
    if (
      !Array.isArray(inputs) ||
      !inputs.some(
        (input: Record<string, unknown>) =>
          input.inputUuid === owned.uuid && input.inputKind === 'wasapi_process_output_capture',
      )
    )
      throw new Error('commentary_binding_change_requires_independent');
    const settings = (await obs.call('GetInputSettings', { inputUuid: owned.uuid })).inputSettings;
    if (!settings || typeof settings !== 'object')
      throw new Error('commentary_binding_change_requires_independent');
    let current = (settings as Record<string, unknown>).window;
    if (current === undefined) {
      const defaults = (
        await obs.call('GetInputDefaultSettings', {
          inputKind: 'wasapi_process_output_capture',
        })
      ).defaultInputSettings;
      if (!defaults || typeof defaults !== 'object')
        throw new Error('commentary_binding_change_requires_independent');
      current = (defaults as Record<string, unknown>).window;
    }
    if (typeof current !== 'string')
      throw new Error('commentary_binding_change_requires_independent');
    const confirmed = await readOwnedCommentaryTarget(`${journal}.owned-target`);
    if (current === '') {
      if (confirmed) throw new Error('commentary_binding_change_requires_independent');
      return;
    }
    if (
      confirmed?.uuid !== owned.uuid ||
      confirmed.endpoint !== endpoint ||
      confirmed.collection !== OBS_COLLECTION ||
      confirmed.window !== current ||
      (window ? current !== window : !isTeamspeak(current))
    )
      throw new Error('commentary_binding_change_requires_independent');
  }
  listCommentaryApplications() {
    if (!this.host.commentary) throw new Error('commentary_unavailable');
    return this.host.withObs(
      async (obs, endpoint) => {
        const { owner, journal } = this.host.commentary!;
        const state = await owner.get();
        const check = async (idle = false) => {
          const [current, stream, record, collection] = await Promise.all([
            owner.get(),
            obs.call('GetStreamStatus'),
            obs.call('GetRecordStatus'),
            obs.call('GetSceneCollectionList'),
          ]);
          if (
            current.revision !== state.revision ||
            (idle && (stream.outputActive !== false || record.outputActive !== false)) ||
            collection.currentSceneCollectionName !== OBS_COLLECTION
          )
            throw new Error('commentary_context_changed');
        };
        await check();
        const inputs = (await obs.call('GetInputList')).inputs;
        if (!Array.isArray(inputs)) throw new Error('commentary_inputs_unknown');
        const existing = (inputs as Record<string, unknown>[]).find(
          (input) =>
            input.inputKind === 'wasapi_process_output_capture' &&
            typeof input.inputUuid === 'string',
        );
        const probe =
          typeof existing?.inputUuid === 'string'
            ? existing.inputUuid
            : await this.host.configurationMutation(async () => {
                const lease = await this.host.captureWarmupGuard();
                const guard = () => {
                  if (!lease())
                    throw new ObsPreparationWriteBlocked(new Error('commentary_context_changed'));
                };
                return createCommentaryProbe(
                  guardedPreparationWrites(obs.withMutationGuard?.(guard) ?? obs),
                  journal,
                  {
                    endpoint,
                    collection: OBS_COLLECTION,
                    sceneName: obsDesiredScenes(this.host.browserBaseUrl)[0]!.sceneName,
                  },
                  () => check(true),
                );
              });
        const current = this.host.observationValidity();
        const windows = await owner.windows(obs, state.revision, probe);
        await check();
        if (!current()) throw new Error('commentary_context_changed');
        this.commentaryChoices.clear();
        const candidates = windows.map((candidate) => {
          const id = randomUUID();
          this.commentaryChoices.set(id, {
            window: candidate.window,
            revision: state.revision,
            endpoint,
            probe,
            until: Date.now() + 30_000,
          });
          return { id, label: candidate.label };
        });
        return { revision: state.revision, candidates };
      },
      { timeoutMs: 45_000 },
    );
  }
  selectCommentaryApplication(id: string, revision: string) {
    if (!this.host.commentary) throw new Error('commentary_unavailable');
    return this.host.configurationMutation(() =>
      this.audioConfiguration.run(async (obs, endpoint) => {
        const selected = this.commentaryChoices.get(id);
        this.commentaryChoices.clear();
        if (
          !selected ||
          selected.until <= Date.now() ||
          selected.revision !== revision ||
          selected.endpoint !== endpoint ||
          (await this.host.commentary!.owner.get()).revision !== revision
        )
          throw new Error('commentary_selection_changed');
        const [collection, inputs] = await Promise.all([
          obs.call('GetSceneCollectionList'),
          obs.call('GetInputList'),
        ]);
        if (
          collection.currentSceneCollectionName !== OBS_COLLECTION ||
          !Array.isArray(inputs.inputs) ||
          !(inputs.inputs as Record<string, unknown>[]).some(
            (input) =>
              input.inputUuid === selected.probe &&
              input.inputKind === 'wasapi_process_output_capture',
          )
        )
          throw new Error('commentary_selection_changed');
        const candidates = await this.host.commentary!.owner.windows(obs, revision, selected.probe);
        if (!candidates.some((candidate) => candidate.window === selected.window))
          throw new Error('commentary_selection_changed');
        const previous = await this.host.commentary!.owner.get();
        const switchPath = `${this.host.commentary!.journal}.switch`;
        const { pendingSwitch, routingState } = await this.preflightCommentarySwitch(switchPath);
        if (routingState?.desktop) {
          await this.checkUnboundCommentaryChoice(obs, endpoint, selected.window);
          return this.host.commentary!.owner.set(
            { mode: 'application', window: selected.window },
            revision,
          );
        }
        const next = await this.commitOwnedCommentarySwitch(
          obs,
          endpoint,
          revision,
          switchPath,
          previous,
          pendingSwitch,
          { mode: 'application', window: selected.window },
          inputs.inputs,
          async (_uuid, from) => (from !== selected.window ? selected.window : undefined),
        );
        return next;
      }),
    );
  }
  private async commitOwnedCommentarySwitch(
    obs: ObsRpc,
    endpoint: string,
    revision: string,
    switchPath: string,
    previous: Awaited<ReturnType<RemoteCommentary['get']>>,
    pendingSwitch: Awaited<ReturnType<typeof readCommentarySwitch>>,
    preference: { mode: 'application'; window: string } | { mode: 'autoTeamspeak' },
    preloadedInputs: unknown,
    resolveTarget: (uuid: string, from: string) => Promise<string | undefined>,
  ) {
    const { owner } = this.host.commentary!;
    const { owned, routing, confirmed, validOwned } =
      await this.readOwnedCommentaryContext(endpoint);
    let target: { uuid: string; from: string; to: string; routingRevision: string } | undefined;
    if (validOwned && owned?.uuid && confirmed && routing) {
      const inputs = preloadedInputs ?? (await obs.call('GetInputList')).inputs;
      const found =
        Array.isArray(inputs) &&
        (inputs as Record<string, unknown>[]).some(
          (input) =>
            input.inputUuid === owned.uuid && input.inputKind === 'wasapi_process_output_capture',
        );
      if (found) {
        const settings = (await obs.call('GetInputSettings', { inputUuid: owned.uuid }))
          .inputSettings;
        const from =
          settings && typeof settings === 'object'
            ? (settings as Record<string, unknown>).window
            : undefined;
        const matchesExisting =
          previous.preference.mode === 'disabled' ||
          (previous.preference.mode === 'existingInput' &&
            previous.preference.binding.endpoint === endpoint &&
            previous.preference.binding.collection === OBS_COLLECTION &&
            previous.preference.binding.inputUuid === owned.uuid) ||
          (previous.preference.mode === 'application' && previous.preference.window === from) ||
          (preference.mode === 'application' &&
            ((previous.preference.mode === 'autoTeamspeak' && isTeamspeak(from)) ||
              (pendingSwitch?.phase === 'prepared' &&
                pendingSwitch.endpoint === endpoint &&
                pendingSwitch.collection === OBS_COLLECTION &&
                pendingSwitch.uuid === owned.uuid &&
                pendingSwitch.revision === revision &&
                pendingSwitch.from === from &&
                ((previous.preference.mode === 'application' &&
                  pendingSwitch.to === previous.preference.window) ||
                  (previous.preference.mode === 'autoTeamspeak' &&
                    pendingSwitch.to === AUTO_TEAMSPEAK_TARGET)))));
        if (typeof from === 'string' && from === confirmed.window && matchesExisting) {
          const to = await resolveTarget(owned.uuid, from);
          if (to) target = { uuid: owned.uuid, from, to, routingRevision: routing.revision };
        }
      }
    }
    const next = await owner.set(preference, revision);
    if (target)
      await saveCommentarySwitch(switchPath, {
        endpoint,
        collection: OBS_COLLECTION,
        ...target,
        revision: next.revision,
        phase: 'prepared',
      });
    return next;
  }
  setCommentaryMode(mode: 'autoTeamspeak' | 'disabled', revision: string) {
    if (!this.host.commentary) throw new Error('commentary_unavailable');
    if (mode === 'disabled')
      return this.host.serial(async () => {
        if ((await this.host.audioRouting?.modeRecoveryState())?.transition)
          throw new Error('audio_mode_pending');
        if (
          (await readCommentarySwitch(`${this.host.commentary!.journal}.switch`))?.phase === 'sent'
        )
          throw new Error('commentary_switch_recovery_required');
        return this.host.commentary!.owner.set({ mode }, revision);
      });
    return this.host.configurationMutation(() =>
      this.audioConfiguration.run(async (obs, endpoint) => {
        const { owner, journal } = this.host.commentary!;
        const previous = await owner.get();
        if (previous.revision !== revision) throw new Error('commentary_revision_changed');
        const path = `${journal}.switch`;
        const { pendingSwitch, routingState } = await this.preflightCommentarySwitch(path);
        if (routingState?.desktop) {
          await this.checkUnboundCommentaryChoice(obs, endpoint);
          return owner.set({ mode }, revision);
        }
        return this.commitOwnedCommentarySwitch(
          obs,
          endpoint,
          revision,
          path,
          previous,
          pendingSwitch,
          { mode },
          undefined,
          async (uuid, from) => {
            if (
              (await obs.call('GetSceneCollectionList')).currentSceneCollectionName !==
              OBS_COLLECTION
            )
              return undefined;
            const windows = (await owner.windows(obs, revision, uuid)).filter((candidate) =>
              isTeamspeak(candidate.window),
            );
            if (windows.length === 1 && windows[0]!.window !== from) return windows[0]!.window;
            if (windows.length === 0) return AUTO_TEAMSPEAK_TARGET;
            return undefined;
          },
        );
      }),
    );
  }
}
