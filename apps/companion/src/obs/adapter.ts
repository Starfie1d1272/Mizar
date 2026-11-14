import type { AudioMonitorChange } from './audio-monitor-contract.js';
import { writeMonitorMode, writeMonitorOriginals } from '../music/monitor-journal.js';
import { AudioMeter } from './audio-meter.js';
import { ObsObservationConnection } from './observation-connection.js';
import {
  readAudioDevices,
  readAudioDeviceDiagnostics,
  setAudioDevice,
  type AudioDeviceCommand,
} from './audio-device-settings.js';
import {
  captureAudioCollectionTransfer,
  applyAudioCollectionTransfer,
  audioCollectionTransferError,
} from './audio-collection-transfer.js';
import { gameBackgroundReady } from './game-background.js';
import { prepareCaptureAudio } from './capture-audio-preparation.js';
import { ObsCaptureWarmup, ObsCaptureWarmupError } from './capture-warmup.js';
import { readCaptureInitialization, type CaptureInitialization } from './capture-initialization.js';
import type { ObsCaptureDiagnostic, ObsConnectionFacts } from '@mizar/protocol/obs';
import {
  assertNoVideoOutput,
  ObsPreparationWriteBlocked,
  ObsVideoError,
  ObsVideoTransaction,
} from './video-transaction.js';
import { obsFindingReadiness } from './prepare-readiness.js';
import { ObsActionError } from './action-error.js';
import { BpOverlayOwner } from './bp-overlay.js';
import { diagnosticValue } from '../support/session-journal.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { EventSubscription, OBSWebSocket } from 'obs-websocket-js';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import type {
  ObsAudioBindCommand,
  ObsOutputCommand,
  ObsOutputPhase,
  ObsOutputsStatus,
} from '@mizar/protocol/obs';
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
  commentaryTargetReady,
  configureIndependentAudio,
  prepareIndependentForDesktop,
} from './audio-setup.js';
import { reconcileManagedAudio, verifyManagedAudioMode } from './managed-audio.js';
import { AudioMigration, type MigrationObserver } from './audio-migration.js';
import type { MusicAudioMode, MusicAudioRecovery } from '../music/device.js';
import { createMusicDevice } from './music-device.js';
import { recoverAudioModeTransaction } from './audio-mode-recovery.js';
import { assertDesktopDeviceRoute, desktopMonitorRelationship } from './audio-monitor-device.js';
import { inspectAudioSceneGraph } from './audio-scene-graph.js';
import { AudioConfigurationConnection } from './audio-configuration-connection.js';
import { ObsOutputController, ObsOutputError } from './outputs.js';
import { readObsProgramEvidence, type ObsProgramEvidence } from './program-evidence.js';
import {
  ObsConfigStore,
  discoverObsExecutable,
  isObsProcessRunning,
  type ObsConfig,
} from './config.js';
import {
  assertManagedGlobalAudioSilent,
  checkObsAudio,
  ensureManagedAudioSources,
  setupObsAudio,
} from './audio.js';
import {
  ObsExitSafetyError,
  checkObsConfiguration,
  repairObsConfiguration,
  alignPreparationScene,
  guardedPreparationWrites,
  prepareCaptureWindow,
  refreshObsBrowserSources,
  switchObsScene,
  type ObsFinding,
  type ObsRpc,
  type ObsSceneSwitchOptions,
} from './reconcile.js';

export function obsFailureKind(
  error: unknown,
): 'authentication' | 'refused' | 'timeout' | 'unknown' {
  const value = error as { code?: unknown; message?: unknown } | null;
  const message = typeof value?.message === 'string' ? value.message.toLowerCase() : '';
  if (value?.code === 4009 || /authentication|invalid password|password required/.test(message))
    return 'authentication';
  if (value?.code === 'ECONNREFUSED' || message.includes('econnrefused')) return 'refused';
  if (/timeout|timed out|超时/.test(message)) return 'timeout';
  return 'unknown';
}
export function obsErrorEvidence(error: unknown, password = ''): unknown {
  const redact = (value: unknown): unknown => {
    if (typeof value === 'string')
      return password ? value.replaceAll(password, '[redacted]') : value;
    if (Array.isArray(value)) return value.map(redact);
    if (typeof value === 'object' && value !== null)
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, redact(field)]));
    return value;
  };
  return redact(diagnosticValue(error, '', new Set(), password ? [password] : []));
}

export function obsAudioModeFailureEvidence(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const exactReasons = [
    'audio_desktop_choice_required',
    'audio_selection_changed',
    'audio_revision_changed',
    'audio_mode_already_desktop',
    'audio_commentary_unavailable',
    'audio_mode_pending',
    'audio_mode_target_changed',
    'audio_migration_identity_changed',
    'audio_migration_external_change',
    'audio_migration_backup_conflict',
    'audio_migration_recovery_required',
    'audio_migration_write_uncertain',
    'audio_setup_context_changed',
    'audio_configuration_timeout',
    'audio_configuration_disconnected',
    'audio_configuration_busy',
  ];
  const parameterReasons = [
    'audio_nested_shared_path',
    'audio_video_path_unresolved',
    'audio_monitor_shared',
    'audio_global_path_unresolved',
  ];
  return {
    code:
      exactReasons.find((code) => message === code) ??
      parameterReasons.find((code) => message === code || message.startsWith(`${code}:`)) ??
      'hidden',
    failureKind: obsFailureKind(error),
    detailStatus: 'classification_only',
    message: '此摘要仅含安全分类，不包含原始错误详情。',
  };
}

export interface ObsStatus {
  readonly connection: 'connected' | 'unavailable' | 'password_required' | 'invalid_password';
  readonly connectionFailure?: ReturnType<typeof obsFailureKind>;
  readonly facts?: ObsConnectionFacts;
  readonly currentScene: string | null;
  readonly port: number;
  readonly streaming: boolean | null;
  /** Absent on older observations; consumers must treat absence as unknown. */
  readonly streamPhase?: ObsOutputPhase;
  readonly recording: boolean | null;
  /** Absent on older observations; consumers must treat absence as unknown. */
  readonly recordPhase?: ObsOutputPhase;
  /** True while a stream or recording command is in flight. */
  readonly outputPending?: boolean;
  readonly passwordConfigured: boolean;
  readonly video: null | { readonly canvas: string; readonly output: string; readonly fps: number };
  readonly findings: readonly ObsFinding[];
  readonly programEvidence?: ObsProgramEvidence | null;
}

const TIMEOUT_MS = 4000;
const PROGRAM_EVIDENCE_MS = 750;

function guardedObs(obs: ObsRpc, valid: () => boolean): ObsRpc {
  const assertCurrent = () => {
    if (!valid()) throw new Error('OBS 准备请求已失效，请重试。');
  };
  const guarded = obs.withMutationGuard?.(assertCurrent) ?? obs;
  return {
    ...guarded,
    call: (type, data, onDispatch) => {
      assertCurrent();
      return guarded.call(type, data, onDispatch);
    },
  };
}

export class ObsAdapter {
  private readonly outputs: ObsOutputController;
  private readonly observations = new ObsObservationConnection();
  private readonly audioConfiguration: AudioConfigurationConnection;
  private readonly audioMeter: AudioMeter;
  private readonly bpOwner = new BpOverlayOwner();
  private programChanged: (kind: 'disconnected' | 'changed') => void = () => undefined;
  private expectedScene: string | undefined;
  private expectedCollection: string | undefined;
  private programGeneration = 0;
  private entryPermit:
    | {
        id: string;
        outputEpoch: number;
        configurationEpoch: number;
        programGeneration: number;
        valid: () => boolean;
      }
    | undefined;
  onProgramChanged(callback: (kind: 'disconnected' | 'changed') => void): void {
    this.programChanged = callback;
  }
  private bpClient: OBSWebSocket | undefined;
  private bpDisconnect: (() => void) | undefined;
  onBpDisconnect(callback: () => void): void {
    this.bpDisconnect = callback;
  }
  private configurationPending = false;
  private preparationController: AbortController | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private findings: ObsFinding[] = [
    { code: 'configuration_unchecked', message: '请检查 OBS 场景配置。' },
  ];
  private audioPreparationWarnings: Partial<
    Record<'setup' | 'routing' | 'commentary' | 'music', ObsFinding>
  > = {};
  private commentaryTimer: ReturnType<typeof setTimeout> | undefined;
  private commentaryTask: Promise<void> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryClosed = false;
  private recoveryGeneration = 0;
  private recoveryPaused = false;
  private browserRecoveryPermission:
    { recovery: number; program: number; production: () => boolean } | undefined;
  private browserRefreshSubmitted = false;
  private recoveryTask: Promise<void> | undefined;
  private readonly submittedBrowserRefreshes = new Set<string>();
  private commentaryChoices = new Map<
    string,
    { window: string; revision: string; endpoint: string; probe: string; until: number }
  >();
  constructor(
    private readonly configStore: ObsConfigStore,
    private readonly browserBaseUrl: string,
    private readonly diagnostic: (stage: string, error: unknown) => void = () => undefined,
    private readonly audioRouting?: ObsAudioRouting,
    private readonly commentary?: { owner: RemoteCommentary; journal: string },
    private readonly videoTransaction?: ObsVideoTransaction,
    private readonly captureWarmup?: ObsCaptureWarmup,
    private readonly buildId = process.env.MIZAR_APP_VERSION ?? 'development',
  ) {
    this.audioConfiguration = new AudioConfigurationConnection(configStore);
    this.audioMeter = new AudioMeter(configStore, undefined, undefined, (error, password) =>
      this.diagnostic(
        'obs_audio_meter',
        password === undefined
          ? { reason: 'audio_meter_unavailable', redactionContext: 'unavailable' }
          : obsErrorEvidence(error, password),
      ),
    );
    this.outputs = new ObsOutputController(
      configStore,
      (error, password) => diagnostic('obs_output', obsErrorEvidence(error, password)),
      (kind, name) => {
        if (kind === 'disconnected') {
          this.expectedScene = undefined;
          this.expectedCollection = undefined;
          this.programGeneration++;
          this.entryPermit = undefined;
          this.browserRecoveryPermission = undefined;
          this.programChanged('disconnected');
          return;
        }
        if (kind === 'scene' && this.expectedCollection) return;
        if (kind === 'scene' && this.expectedScene !== undefined && name === this.expectedScene) {
          this.expectedScene = undefined;
          return;
        }
        if (
          (kind === 'collection' || kind === 'collection-changing') &&
          this.expectedCollection !== undefined &&
          // Changing reports the collection being left; Changed reports the target.
          (kind === 'collection-changing' || name === this.expectedCollection)
        ) {
          if (kind === 'collection') this.expectedCollection = undefined;
          return;
        }
        this.programGeneration++;
        this.entryPermit = undefined;
        this.browserRecoveryPermission = undefined;
        this.programChanged('changed');
      },
      (event, data) => this.bpOwner.observePreparationEvent(event, data),
    );
  }

  /** Guard an explicit capture warmup against output, ownership and exit changes. */
  async captureWarmupGuard(): Promise<() => boolean> {
    const status = await this.outputs.read();
    const idle = (value: ObsOutputsStatus) =>
      [value.stream, value.record].every(
        (output) => output.active === false && output.phase === 'idle' && output.pending === null,
      );
    const outputGeneration = this.outputs.captureWarmupGeneration();
    if (outputGeneration === null || !idle(status))
      throw new ObsVideoError(
        'capture_output_unavailable',
        this.outputs.captureWarmupBlockReason() ?? 'OBS 输出状态正在变化，请等待稳定后重试。',
      );
    const recoveryGeneration = this.recoveryGeneration;
    return () =>
      this.outputs.captureWarmupGeneration() === outputGeneration &&
      this.recoveryGeneration === recoveryGeneration &&
      idle(this.outputs.snapshot());
  }

  private async preparationStatus(): Promise<NonNullable<ObsOutputsStatus['preparation']> | null> {
    let capture = await this.captureWarmup?.status().catch(() => 'cleanup_pending' as const);
    if (capture && this.captureWarmup)
      capture = await this.withObs(async (obs, endpoint) =>
        (await this.captureWarmup!.affectsCurrentCollection(obs, endpoint)) ? capture : null,
      ).catch(() => 'cleanup_pending' as const);
    return capture ?? (this.configurationPending ? 'checking' : null);
  }

  outputObservationEpoch(): number {
    return this.outputs.outputObservationEpoch();
  }

  async outputStatus(): Promise<ObsOutputsStatus> {
    const outputs = await this.outputs.read().catch(() => this.outputs.snapshot());
    return { ...outputs, preparation: await this.preparationStatus() };
  }

  outputCommand(
    command: ObsOutputCommand,
    valid: () => boolean = () => true,
  ): Promise<ObsOutputsStatus> {
    const run = async () => {
      try {
        if (!valid())
          throw new ObsOutputError('obs_output_stale', '输出请求已取消，未发送到 OBS。');
        if (command.action === 'start') {
          if (this.configurationPending)
            throw new ObsOutputError('obs_output_busy', 'OBS 正在准备配置，请等待状态确认。');
          const preparation = await this.preparationStatus();
          if (preparation)
            throw new ObsOutputError(
              'obs_output_busy',
              preparation === 'checking'
                ? '正在检查 OBS 游戏画面，请等待准备完成后开始输出。'
                : 'OBS 游戏画面检查未完成，请重新检查后开始输出。',
            );
        }
        await this.outputs.command(command, valid);
      } catch (error) {
        const config = await this.configStore.read();
        this.diagnostic('obs_output_command', obsErrorEvidence(error, config.password));
        throw error;
      }
      return { ...this.outputs.snapshot(), preparation: await this.preparationStatus() };
    };
    return command.action === 'stop' ? run() : this.serial(run);
  }

  private configurationMutation<T>(run: () => Promise<T>, serialize = true): Promise<T> {
    if (this.configurationPending || this.outputs.busy)
      return Promise.reject(
        new ObsOutputError('obs_output_busy', 'OBS 正在处理操作，请等待状态确认。'),
      );
    this.configurationPending = true;
    return (serialize ? this.serial(run) : run()).finally(() => {
      this.configurationPending = false;
    });
  }

  configure(config: ObsConfig): Promise<void> {
    return this.configurationMutation(async () => {
      this.bpOwner.invalidate();
      const bpClient = this.bpClient;
      this.bpClient = undefined;
      await bpClient?.disconnect().catch(() => undefined);
      this.bpDisconnect?.();
      await this.configStore.save(config);
      this.audioRouting?.invalidateSelections();
      this.commentaryChoices.clear();
      this.outputs.reset();
      this.observations.reset();
    });
  }

  pauseAutomatic(): void {
    this.recoveryPaused = true;
    this.entryPermit = undefined;
    this.browserRecoveryPermission = undefined;
    this.recoveryGeneration++;
    clearTimeout(this.recoveryTimer);
    clearTimeout(this.commentaryTimer);
    this.recoveryTimer = undefined;
    this.commentaryTimer = undefined;
  }

  resumeAutomatic(): void {
    this.recoveryPaused = false;
  }

  private preparationValidity(): () => boolean {
    // A completed observation owns its snapshot; an older pending read cannot replace it.
    const findings = this.findings;
    const program = this.programGeneration;
    const output = this.outputs.outputObservationEpoch();
    const recovery = this.recoveryGeneration;
    const configuration = this.outputs.preparationConfigurationEpoch();
    const observation = this.observationGeneration;
    return () =>
      findings === this.findings &&
      output === this.outputs.outputObservationEpoch() &&
      observation === this.observationGeneration &&
      !this.observationWriteActive &&
      !this.recoveryClosed &&
      !this.recoveryPaused &&
      this.outputs.canObservePreparation() &&
      configuration === this.outputs.preparationConfigurationEpoch() &&
      program === this.programGeneration &&
      recovery === this.recoveryGeneration;
  }

  async settleAutomatic(): Promise<void> {
    await Promise.all([this.queue, this.recoveryTask, this.commentaryTask]);
  }

  startBrowserRecovery(production: () => boolean = () => true): void {
    if (this.recoveryClosed || this.recoveryPaused) return;
    this.browserRecoveryPermission = {
      recovery: this.recoveryGeneration,
      program: this.programGeneration,
      production,
    };
    this.browserRefreshSubmitted = false;
    this.runBrowserRecovery();
  }

  private runBrowserRecovery(): void {
    if (
      this.recoveryClosed ||
      this.recoveryPaused ||
      this.browserRefreshSubmitted ||
      this.recoveryTask ||
      this.recoveryTimer
    )
      return;
    const attempt = () => {
      const permission = this.browserRecoveryPermission;
      const valid = () =>
        permission !== undefined &&
        this.browserRecoveryPermission === permission &&
        !this.recoveryClosed &&
        !this.recoveryPaused &&
        permission.recovery === this.recoveryGeneration &&
        permission.program === this.programGeneration &&
        permission.production();
      this.recoveryTimer = undefined;
      if (permission === undefined) return;
      this.recoveryTask = this.serial(async () => {
        // Keep the existing program observer connected across recovery retries.
        await this.outputs.read();
        if (!valid()) return false;
        return this.withObs(
          (obs) =>
            refreshObsBrowserSources(
              guardedObs(obs, valid),
              this.browserBaseUrl,
              this.submittedBrowserRefreshes,
              this.buildId,
            ),
          TIMEOUT_MS,
          undefined,
          false,
          true,
        );
      })
        .then((complete) => {
          if (valid()) this.browserRefreshSubmitted = complete;
        })
        .catch(() => undefined)
        .finally(() => {
          this.recoveryTask = undefined;
          if (valid() && !this.browserRefreshSubmitted) {
            this.recoveryTimer = setTimeout(attempt, 5000);
            this.recoveryTimer.unref();
          } else if (this.browserRecoveryPermission !== permission) {
            this.runBrowserRecovery();
          }
        });
    };
    attempt();
  }

  startCommentaryRecovery(
    music?: MusicAudioRecovery,
    mayPrepare: () => boolean = () => true,
  ): void {
    if (
      !this.commentary ||
      this.recoveryClosed ||
      this.recoveryPaused ||
      this.commentaryTimer ||
      this.commentaryTask
    )
      return;
    const attempt = () => {
      if (this.recoveryClosed || this.recoveryPaused) return;
      const generation = this.recoveryGeneration;
      const programGeneration = this.programGeneration;
      const valid = () =>
        !this.recoveryClosed &&
        !this.recoveryPaused &&
        generation === this.recoveryGeneration &&
        programGeneration === this.programGeneration &&
        mayPrepare();
      this.commentaryTimer = undefined;
      this.commentaryTask = (async () => {
        if (music && this.audioRouting) {
          try {
            if (!valid()) return;
            // Leave incomplete mode transactions for the next explicit
            // operator action. Recovery can itself change audible paths.
            await this.queueIndependentCommentary(valid);
            if (!valid()) return;
            // Switching the live mix remains an explicit operator action.
          } catch (error) {
            this.diagnostic('audio_mode_recovery', error);
          }
        }
      })()
        .catch((error) => this.diagnostic('commentary_recovery', error))
        .finally(() => {
          this.commentaryTask = undefined;
          if (!this.recoveryClosed && !this.recoveryPaused) {
            this.commentaryTimer = setTimeout(attempt, 5000);
            this.commentaryTimer.unref();
          }
        });
    };
    attempt();
  }
  async recoverAudioMode(
    music: MusicAudioRecovery,
    valid: () => boolean = () => true,
    revision?: string,
  ): Promise<void> {
    if (!this.audioRouting || !this.commentary) throw new Error('audio_routing_unavailable');
    await this.configurationMutation(async () => {
      const state = await this.audioRouting!.modeRecoveryState();
      if (revision !== undefined && state.revision !== revision)
        throw new Error('audio_revision_changed');
      const migration = new AudioMigration(`${this.commentary!.journal}.migration`);
      const pending = await migration.pending();
      if (!state.transition && !pending?.modeId) return;
      await this.audioConfiguration.run((obs, endpoint, observer) =>
        music.withAudioModeRecovery(() =>
          this.recoverAudioModeOnConnection(
            guardedObs(obs, valid),
            endpoint,
            observer,
            music,
            valid,
          ),
        ),
      );
    });
  }
  private recoverAudioModeOnConnection(
    obs: ObsRpc,
    endpoint: string,
    observer: MigrationObserver,
    music: MusicAudioRecovery,
    valid: () => boolean = () => true,
  ) {
    return recoverAudioModeTransaction(
      {
        routing: this.audioRouting!,
        commentary: this.commentary!,
        browserBaseUrl: this.browserBaseUrl,
      },
      obs,
      endpoint,
      observer,
      music,
      valid,
    );
  }
  async close(): Promise<void> {
    this.recoveryClosed = true;
    if (this.commentaryTimer) clearTimeout(this.commentaryTimer);
    await this.commentaryTask;
    await this.outputs.close();
    await this.observations.close();
    const bpClient = this.bpClient;
    this.bpClient = undefined;
    await bpClient?.disconnect().catch(() => undefined);
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await this.recoveryTask;
  }

  private observationGeneration = 0;
  private observationWriteActive = false;
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.observationGeneration++;
      this.observationWriteActive = true;
      try {
        return await operation();
      } finally {
        this.observationWriteActive = false;
        this.observationGeneration++;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private observationValidity(): () => boolean {
    const generation = this.observationGeneration;
    const output = this.outputs.outputObservationEpoch();
    const program = this.programGeneration;
    const recovery = this.recoveryGeneration;
    const configuration = this.outputs.preparationConfigurationEpoch();
    return () =>
      !this.recoveryClosed &&
      !this.observationWriteActive &&
      output === this.outputs.outputObservationEpoch() &&
      generation === this.observationGeneration &&
      program === this.programGeneration &&
      recovery === this.recoveryGeneration &&
      configuration === this.outputs.preparationConfigurationEpoch();
  }

  /** Observation sockets never hold the mutation queue; mixed-generation results are discarded. */
  private async observe<T>(read: () => Promise<T>): Promise<T> {
    await this.outputs.read().catch(() => undefined);
    const current = this.observationValidity();
    const result = await read();
    if (!current())
      throw new ObsVideoError('obs_observation_changed', 'OBS 状态已变化，请重新检查。');
    return result;
  }

  private withReadObs<T>(
    operation: (obs: ObsRpc, endpoint: string, recovery: ObsRpc) => Promise<T>,
    timeoutMs = TIMEOUT_MS,
    diagnosticStage?: string,
    commitObservation?: (value: T) => void,
  ): Promise<T> {
    return this.withObs(
      operation,
      timeoutMs,
      diagnosticStage,
      false,
      false,
      false,
      true,
      commitObservation,
      true,
    );
  }

  private async withObs<T>(
    operation: (obs: ObsRpc, endpoint: string, recovery: ObsRpc) => Promise<T>,
    timeoutMs = TIMEOUT_MS,
    diagnosticStage?: string,
    observeAudioIdentity = false,
    observeBrowserIdentity = false,
    observeVideoIdentity = false,
    observePreparationIdentity = false,
    commitObservation?: (value: T) => void,
    readOnly = false,
  ): Promise<T> {
    const observation = this.observationGeneration;
    const config = await this.configStore.read();
    if (
      readOnly &&
      (this.recoveryClosed ||
        this.observationWriteActive ||
        observation !== this.observationGeneration)
    )
      throw new ObsVideoError('obs_observation_changed', 'OBS 状态已变化，请重新检查。');
    const borrowed = readOnly ? this.observations.acquire(config) : undefined;
    const client = borrowed?.client ?? new OBSWebSocket();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let stage = 'obs_connect';
    let active = true;
    const preparationEvents = [
      'ConnectionClosed',
      'ExitStarted',
      'CurrentSceneCollectionChanging',
      'CurrentSceneCollectionChanged',
      'CurrentProgramSceneChanged',
      'SceneCreated',
      'SceneRemoved',
      'SceneNameChanged',
      'SceneItemCreated',
      'SceneItemRemoved',
      'SceneItemEnableStateChanged',
      'SceneItemTransformChanged',
      'SceneItemListReindexed',
      'InputCreated',
      'InputRemoved',
      'InputNameChanged',
      'CurrentProfileChanging',
      'CurrentProfileChanged',
    ] as const;
    const invalidateAudio = () => {
      // This socket owns only its observation. Persistent output/configuration
      // epochs revoke shared readiness; a late close here cannot erase a newer check.
      active = false;
    };
    const invalidatePreparationSettings = (data: { inputUuid?: string }) => {
      if (this.outputs.preparationSettingsChanged(data)) invalidateAudio();
    };
    const invalidateBrowser = () => {
      active = false;
      this.browserRecoveryPermission = undefined;
    };
    try {
      const task = (async () => {
        await (borrowed?.ready ??
          client.connect(
            `ws://${config.host}:${config.port}`,
            config.password,
            observePreparationIdentity
              ? {
                  eventSubscriptions:
                    EventSubscription.All | EventSubscription.SceneItemTransformChanged,
                }
              : undefined,
          ));
        if (!active || (borrowed && !borrowed.current()))
          throw new Error('obs_operation_cancelled');
        if (observeAudioIdentity) {
          client.on('CurrentSceneCollectionChanging', invalidateAudio);
          client.on('InputRemoved', invalidateAudio);
          client.on('InputSettingsChanged', invalidateAudio);
          client.on('ConnectionClosed', invalidateAudio);
        }
        if (observeBrowserIdentity) {
          client.on('InputRemoved', invalidateBrowser);
          client.on('InputSettingsChanged', invalidateBrowser);
          client.on('ConnectionClosed', invalidateBrowser);
        }
        if (observeVideoIdentity) {
          client.on('CurrentProfileChanging', invalidateAudio);
          client.on('CurrentProfileChanged', invalidateAudio);
          client.on('ConnectionClosed', invalidateAudio);
        }
        if (observePreparationIdentity) {
          for (const event of preparationEvents) client.on(event, invalidateAudio);
          client.on('InputSettingsChanged', invalidatePreparationSettings);
        }
        stage = 'obs_request';
        const rpc: ObsRpc = {
          reportsDispatch: true,
          ...(borrowed ? { observationContext: borrowed.context } : {}),
          onTransitionVideoEnded: (listener) => {
            const onEnded = (event: { transitionName: string }) => listener(event.transitionName);
            client.on('SceneTransitionVideoEnded', onEnded);
            return () => client.off('SceneTransitionVideoEnded', onEnded);
          },
          call: async (type, data, onDispatch) => {
            if (readOnly && !/^Get[A-Z]/.test(type))
              throw new Error('obs_observation_write_forbidden');
            if (!active || (borrowed && !borrowed.current()))
              throw new Error('obs_operation_cancelled');
            if (
              type === 'SetCurrentProgramScene' &&
              typeof (data?.sceneUuid ?? data?.sceneName) === 'string'
            ) {
              const expected = (data?.sceneUuid ?? data?.sceneName) as string;
              this.expectedScene = expected;
              const timer = setTimeout(() => {
                if (this.expectedScene === expected) this.expectedScene = undefined;
              }, 2000);
              timer.unref();
            }
            if (
              (type === 'SetCurrentSceneCollection' || type === 'CreateSceneCollection') &&
              typeof data?.sceneCollectionName === 'string'
            ) {
              this.expectedCollection = data.sceneCollectionName;
              const expected = data.sceneCollectionName;
              const timer = setTimeout(() => {
                if (this.expectedCollection === expected) this.expectedCollection = undefined;
              }, 2000);
              timer.unref();
            }
            onDispatch?.();
            const result = await (
              client.call as (
                name: string,
                args?: Record<string, unknown>,
              ) => Promise<Record<string, unknown>>
            )(type, data);
            if (!active || (borrowed && !borrowed.current()))
              throw new Error('obs_operation_cancelled');
            return result;
          },
        };
        const endpoint = `ws://${config.host}:${config.port}`;
        const managed = await this.configStore.managedResources.bind(
          rpc,
          endpoint,
          this.browserBaseUrl,
        );
        const result = await operation(managed, managed.identityEndpoint ?? endpoint, rpc);
        if (!active || (borrowed && !borrowed.current()))
          throw new Error('obs_operation_cancelled');
        commitObservation?.(result);
        return result;
      })();
      return await Promise.race([
        task,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            active = false;
            if (borrowed) this.observations.retire(borrowed);
            reject(new Error('OBS 操作超时，请检查连接。'));
          }, timeoutMs);
        }),
      ]);
    } catch (error) {
      this.diagnostic(diagnosticStage ?? stage, obsErrorEvidence(error, config.password));
      throw error;
    } finally {
      active = false;
      if (timeout) clearTimeout(timeout);
      if (observeAudioIdentity) {
        client.off('CurrentSceneCollectionChanging', invalidateAudio);
        client.off('InputRemoved', invalidateAudio);
        client.off('InputSettingsChanged', invalidateAudio);
        client.off('ConnectionClosed', invalidateAudio);
      }
      if (observeBrowserIdentity) {
        client.off('InputRemoved', invalidateBrowser);
        client.off('InputSettingsChanged', invalidateBrowser);
        client.off('ConnectionClosed', invalidateBrowser);
      }
      if (observeVideoIdentity) {
        client.off('CurrentProfileChanging', invalidateAudio);
        client.off('CurrentProfileChanged', invalidateAudio);
        client.off('ConnectionClosed', invalidateAudio);
      }
      if (observePreparationIdentity)
        for (const event of preparationEvents) client.off(event, invalidateAudio);
      client.off('InputSettingsChanged', invalidatePreparationSettings);
      if (!borrowed) await client.disconnect().catch(() => undefined);
    }
  }

  private statusPending: Promise<ObsStatus> | undefined;
  status(): Promise<ObsStatus> {
    this.statusPending ??= this.observe(() => this.readStatus()).finally(() => {
      this.statusPending = undefined;
    });
    return this.statusPending;
  }

  private async bindingFindings(obs: ObsRpc, endpoint: string): Promise<ObsFinding[]> {
    if (!(await this.audioRouting?.enabled())) return [];
    return (await this.audioRouting!.invalidBindings(obs, endpoint)).map((role) => ({
      code: `audio_binding:${role}`,
      message: `${role} 音频来源已失效，请在音频分路中核对。`,
    }));
  }
  private async configurationFindings(
    obs: ObsRpc,
    endpoint: string,
    visual?: ObsFinding[],
    includeAudio = true,
  ): Promise<ObsFinding[]> {
    const inputGeneration = this.outputs.preparationInputsGeneration();
    this.outputs.observePreparationInputs((await obs.call('GetInputList')).inputs, inputGeneration);
    const findings =
      visual ??
      (await checkObsConfiguration(
        obs,
        this.browserBaseUrl,
        await this.bpOwner.hiddenHud(obs, this.browserBaseUrl),
      ));
    if (
      this.captureWarmup &&
      (await this.captureWarmup.affectsCurrentCollection(obs, endpoint).catch(() => true))
    )
      findings.push({
        code: 'capture_warmup_pending',
        message: '上次游戏画面检查仍待清理，请停止 OBS 输出后重新配置 Mizar 场景。',
      });
    if (
      findings.some((item) =>
        ['collection_missing', 'collection_inactive', 'scene_missing'].includes(item.code),
      )
    )
      return findings;
    return includeAudio ? [...findings, ...(await this.audioFindings(obs, endpoint))] : findings;
  }

  private audioCheckFailure(error: unknown): ObsFinding[] {
    this.diagnostic('obs_audio_check', obsErrorEvidence(error));
    return [
      ...Object.values(this.audioPreparationWarnings),
      { code: 'audio_check_failed', message: 'OBS 音频检查未完成，请在声音设置和 OBS 中核对。' },
    ];
  }

  private async audioFindings(obs: ObsRpc, endpoint: string): Promise<ObsFinding[]> {
    try {
      const audio = [...(await checkObsAudio(obs)), ...(await this.bindingFindings(obs, endpoint))];
      if (await this.audioRouting?.modePending())
        audio.push({
          code: 'commentary_pending',
          message: '音频模式切换待核对，请在声音设置和 OBS 中检查。',
        });
      const warnings = { ...this.audioPreparationWarnings };
      if (
        warnings.routing?.code === 'audio_bindings_required' &&
        (await this.audioRouting?.managedBindings(obs, endpoint).catch(() => null))
      )
        delete warnings.routing;
      for (const warning of Object.values(warnings))
        if (warning && !audio.some((item) => item.code === warning.code)) audio.push(warning);
      return audio;
    } catch (error) {
      return this.audioCheckFailure(error);
    }
  }

  private async readStatus(): Promise<ObsStatus> {
    const preparationCurrent = this.preparationValidity();
    const config = await this.configStore.read();
    let facts: ObsConnectionFacts = {
      executable: 'unknown',
      process: 'unknown',
      listener: 'unknown',
      authentication: 'unknown',
      resources: 'unknown',
    };
    let status: ObsStatus = {
      connection: 'unavailable',
      currentScene: null,
      port: config.port,
      streaming: null,
      streamPhase: 'unknown',
      recording: null,
      recordPhase: 'unknown',
      outputPending: true,
      passwordConfigured: Boolean(config.password),
      video: null,
      findings: [],
      programEvidence: null,
    };
    const findings: ObsFinding[] = [];
    let outputsObserved = false;
    const query = async (code: string, message: string, read: () => Promise<void>) => {
      try {
        await read();
      } catch (error) {
        this.diagnostic(`obs_${code}`, obsErrorEvidence(error, config.password));
        findings.push({ code, message });
      }
    };
    try {
      await this.withReadObs(
        async (obs, endpoint) => {
          status = { ...status, connection: 'connected' };
          facts = {
            ...facts,
            process: 'running',
            listener: 'reachable',
            authentication: 'accepted',
          };
          await Promise.all([
            query(
              'scene_query_failed',
              'OBS 已连接，但当前场景尚未确认。请重新检查。',
              async () => {
                const scene = await obs.call('GetCurrentProgramScene');
                if (typeof scene.currentProgramSceneName !== 'string')
                  throw new Error('obs_scene_response_invalid');
                status = { ...status, currentScene: scene.currentProgramSceneName };
              },
            ),
            query(
              'output_query_failed',
              'OBS 已连接，但输出状态尚未确认。请在 OBS 核对后重新检查。',
              async () => {
                const outputs = await this.outputs.read();
                outputsObserved = true;
                status = {
                  ...status,
                  streaming: outputs.stream.active,
                  streamPhase: outputs.stream.phase,
                  recording: outputs.record.active,
                  recordPhase: outputs.record.phase,
                  outputPending: outputs.stream.pending !== null || outputs.record.pending !== null,
                };
                if (outputs.stream.active === null || outputs.record.active === null)
                  throw new Error('obs_output_state_unknown');
              },
            ),
            query(
              'video_query_failed',
              'OBS 已连接，但视频设置尚未确认。请重新检查。',
              async () => {
                const video = await obs.call('GetVideoSettings');
                const values = [
                  video.baseWidth,
                  video.baseHeight,
                  video.outputWidth,
                  video.outputHeight,
                  video.fpsNumerator,
                  video.fpsDenominator,
                ];
                if (
                  !values.every(
                    (value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
                  )
                )
                  throw new Error('obs_video_response_invalid');
                status = {
                  ...status,
                  video: {
                    canvas: `${String(video.baseWidth)}×${String(video.baseHeight)}`,
                    output: `${String(video.outputWidth)}×${String(video.outputHeight)}`,
                    fps: Number(video.fpsNumerator) / Number(video.fpsDenominator),
                  },
                };
              },
            ),
            query(
              'configuration_check_failed',
              'OBS 已连接，但场景或音频检查未完成。请重新检查。',
              async () => {
                const configuration = await this.configurationFindings(obs, endpoint);
                findings.push(...configuration);
                facts = {
                  ...facts,
                  resources: obsFindingReadiness(configuration).blockingFindings.length
                    ? 'needs_configuration'
                    : 'ready',
                };
              },
            ),
          ]);
        },
        2500,
        undefined,
        () => {
          // Commit before finishing this observation; the slower program evidence
          // below cannot renew a configuration snapshot invalidated in the meantime.
          if (preparationCurrent()) {
            this.findings = [...findings];
          }
        },
      );
    } catch (error) {
      // A failed observation cannot revoke a newer confirmed snapshot. The
      // persistent event owner still invalidates actual disconnect/configuration changes.
      const kind = obsFailureKind(error);
      if (status.connection === 'connected') {
        findings.push({
          code: 'status_query_failed',
          message: 'OBS 已连接，但部分状态查询未完成。请重新检查，不必修改密码。',
        });
      } else {
        status = {
          ...status,
          connection:
            kind === 'authentication'
              ? config.password
                ? 'invalid_password'
                : 'password_required'
              : 'unavailable',
          connectionFailure: kind,
        };
        facts = {
          ...facts,
          listener:
            kind === 'authentication' ? 'reachable' : kind === 'refused' ? 'refused' : 'unknown',
          authentication:
            kind === 'authentication' ? (config.password ? 'rejected' : 'required') : 'unknown',
        };
        if (process.platform === 'win32') {
          await Promise.all([
            query('process_query_failed', 'OBS 运行状态尚未确认。', async () => {
              const running = await isObsProcessRunning();
              facts = { ...facts, process: running ? 'running' : 'stopped' };
            }),
            query('executable_query_failed', 'OBS 程序位置尚未确认。', async () => {
              const path = await discoverObsExecutable(config.executablePath);
              facts = { ...facts, executable: path ? 'found' : 'not_found' };
            }),
          ]);
        }
      }
    }
    // Evidence has its own deadline and cannot erase confirmed base observations.
    let programEvidence: ObsProgramEvidence | null = null;
    if (status.connection === 'connected') {
      let timer: ReturnType<typeof setTimeout> | undefined;
      programEvidence = await Promise.race([
        this.withReadObs(
          (obs) => readObsProgramEvidence(obs, this.browserBaseUrl, status.currentScene),
          PROGRAM_EVIDENCE_MS,
          'obs_program_check',
        ).catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), PROGRAM_EVIDENCE_MS + 50);
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
    }
    // Other status reads can take time. Use the latest observed output events.
    if (outputsObserved) {
      const outputs = this.outputs.snapshot();
      status = {
        ...status,
        streaming: outputs.stream.active,
        streamPhase: outputs.stream.phase,
        recording: outputs.record.active,
        recordPhase: outputs.record.phase,
        outputPending: outputs.stream.pending !== null || outputs.record.pending !== null,
      };
    }
    return { ...status, facts, findings: [...findings], programEvidence };
  }

  private previewPending: Promise<{ scene: string; image: string } | null> | null = null;
  confidencePreview(): Promise<{ scene: string; image: string } | null> {
    if (this.previewPending) return this.previewPending;
    this.previewPending = this.observe(() =>
      this.withReadObs(async (obs) => {
        const current = await obs.call('GetCurrentProgramScene');
        const scene = current.currentProgramSceneName;
        if (typeof scene !== 'string') return null;
        const screenshot = await obs.call('GetSourceScreenshot', {
          sourceName: scene,
          imageFormat: 'jpeg',
          imageWidth: 640,
          imageHeight: 360,
          imageCompressionQuality: 70,
        });
        const after = await obs.call('GetCurrentProgramScene');
        const image = screenshot.imageData;
        return after.currentProgramSceneName === scene &&
          typeof image === 'string' &&
          image.startsWith('data:image/jpeg;base64,') &&
          image.length < 1_000_000
          ? { scene, image }
          : null;
      }),
    )
      .catch(() => null)
      .finally(() => {
        this.previewPending = null;
      });
    return this.previewPending;
  }

  check(): Promise<readonly ObsFinding[]> {
    return this.observe(async () => {
      const current = this.preparationValidity();
      const findings = await this.withReadObs(
        (obs, endpoint) => this.configurationFindings(obs, endpoint),
        12_000,
        undefined,
        (findings) => {
          if (!current()) return;
          this.findings = findings;
        },
      );
      return findings;
    });
  }
  recoverCaptureWarmup(valid: () => boolean): Promise<readonly ObsFinding[]> {
    return this.configurationMutation(async () => {
      if (!valid())
        throw new ObsCaptureWarmupError('capture_warmup_changed', '制作状态已变化，请重新检查。');
      if (!this.captureWarmup)
        throw new ObsCaptureWarmupError('capture_warmup_unavailable', 'OBS 游戏画面检查不可用。');
      const pending = (await this.captureWarmup.status()) !== null;
      const lease = pending ? await this.captureWarmupGuard() : undefined;
      this.findings = await this.withObs(async (obs, endpoint) => {
        if (lease)
          await this.captureWarmup!.recoverCurrentCollection(
            obs,
            endpoint,
            () => valid() && lease(),
          );
        return this.configurationFindings(guardedObs(obs, valid), endpoint);
      }, 12_000);
      return this.findings;
    });
  }
  sampleAudioMeters(valid: () => boolean) {
    const generation = this.programGeneration;
    return this.audioMeter.sample(() => valid() && generation === this.programGeneration);
  }
  readAudioDevices() {
    return this.observe(() =>
      this.withReadObs(
        async (obs) => ({
          ...(await readAudioDevices(obs)),
          desktopMode: Boolean(await this.audioRouting?.desktopBinding()),
        }),
        12000,
      ),
    );
  }
  readAudioDeviceDiagnostics() {
    return this.observe(() => this.withReadObs(readAudioDeviceDiagnostics, 12000));
  }
  setAudioDevice(command: AudioDeviceCommand) {
    const generation = this.recoveryGeneration;
    const programGeneration = this.programGeneration;
    return this.configurationMutation(() =>
      this.audioModeRun('audio_device_set', async (connection) => {
        if (!this.audioRouting) throw new Error('audio_routing_unavailable');
        const state = await this.audioRouting.modeRecoveryState();
        if (state.transition || state.waitingIndependent) throw new Error('audio_mode_pending');
        const obs = guardedObs(
          connection,
          () =>
            generation === this.recoveryGeneration && programGeneration === this.programGeneration,
        );
        return setAudioDevice(
          obs,
          command,
          command.role === 'desktop' && state.desktop
            ? async (uuid) => {
                if (uuid !== state.desktop!.inputUuid) throw new Error('audio_devices_changed');
                await assertDesktopDeviceRoute(obs, uuid, command.deviceId);
              }
            : undefined,
        );
      }),
    );
  }
  readAudioRouting() {
    if (!this.audioRouting) throw new Error('audio_routing_unavailable');
    return this.observe(() =>
      this.withReadObs((obs, endpoint) => this.audioRouting!.read(obs, endpoint), 12000),
    );
  }
  cancelAudioWait(revision: string) {
    if (!this.audioRouting) throw new Error('audio_routing_unavailable');
    return this.serial(async () => {
      if (!(await this.audioRouting!.cancelIndependentWait(undefined, true, revision)))
        throw new Error('audio_wait_cancelled');
      return { cancelled: true };
    });
  }
  private audioModeRun<T>(
    stage: string,
    operation: (obs: ObsRpc, endpoint: string, observer: MigrationObserver) => Promise<T>,
  ): Promise<T> {
    return this.audioConfiguration.run(operation, (error, password) => {
      this.diagnostic(
        stage,
        password === undefined
          ? { ...obsAudioModeFailureEvidence(error), redactionContext: 'unavailable' }
          : obsErrorEvidence(error, password),
      );
    });
  }
  async requestIndependentMode(revision: string, music: MusicAudioMode) {
    if (!this.audioRouting || !this.commentary) throw new Error('audio_routing_unavailable');
    await this.configurationMutation(() =>
      this.audioModeRun('audio_mode_prepare', async (obs, endpoint, observer) => {
        const before = await this.audioRouting!.modeRecoveryState();
        if (before.revision !== revision) throw new Error('audio_revision_changed');
        if (before.transition) throw new Error('audio_mode_pending');
        await music.withAudioModeRecovery(() =>
          this.recoverAudioModeOnConnection(obs, endpoint, observer, music),
        );
        const collection = (await obs.call('GetSceneCollectionList')).currentSceneCollectionName;
        if (typeof collection !== 'string') throw new Error('audio_setup_context_changed');
        await assertManagedGlobalAudioSilent(obs);
        const preference = await this.commentary!.owner.get();
        await this.audioRouting!.waitForIndependent(
          revision,
          endpoint,
          collection,
          preference.revision,
          preference.preference.mode === 'disabled',
        );
      }),
    );
    const ready = await this.prepareWaitingIndependent();
    if (!ready) return { waiting: true, monitorPending: false };
    const result = await this.switchAudioMode(
      ready.revision,
      'independent',
      undefined,
      music,
      ready.id,
    );
    return { waiting: false, ...result };
  }
  private async queueIndependentCommentary(valid: () => boolean = () => true): Promise<void> {
    if (!this.audioRouting || !this.commentary) return;
    const initial = await this.audioRouting.modeRecoveryState();
    if (
      initial.desktop ||
      !initial.independentCommentaryDisabled ||
      initial.transition ||
      initial.waitingIndependent
    )
      return;
    const preference = await this.commentary.owner.get();
    if (
      preference.preference.mode === 'disabled' ||
      initial.cancelledCommentaryRevision === preference.revision
    )
      return;
    await this.configurationMutation(() =>
      this.audioConfiguration.run(async (connection, endpoint) => {
        const obs = guardedObs(connection, valid);
        const current = await this.audioRouting!.modeRecoveryState();
        if (
          current.revision !== initial.revision ||
          current.desktop ||
          current.transition ||
          current.waitingIndependent ||
          !current.independentCommentaryDisabled ||
          (await this.commentary!.owner.get()).revision !== preference.revision
        )
          return;
        const collection = (await obs.call('GetSceneCollectionList')).currentSceneCollectionName;
        if (collection !== OBS_COLLECTION || !obs.ownershipScope)
          throw new Error('audio_setup_context_changed');
        await obs.ownershipScope();
        if (!valid()) throw new Error('OBS 准备请求已失效，请重试。');
        await this.audioRouting!.waitForIndependent(
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
    if (!this.audioRouting || !this.commentary) return null;
    const initial = await this.audioRouting.modeRecoveryState();
    if (
      !initial.waitingIndependent ||
      initial.transition ||
      (!initial.desktop && !initial.independentCommentaryDisabled)
    )
      return null;
    return this.configurationMutation(() =>
      this.audioModeRun('audio_mode_sources', async (connection, endpoint, observer) => {
        if (!valid()) throw new Error('OBS 准备请求已失效，请重试。');
        const obs = guardedObs(connection, valid);
        const state = await this.audioRouting!.modeRecoveryState();
        const wait = state.waitingIndependent;
        if (
          !wait ||
          wait.id !== initial.waitingIndependent!.id ||
          state.transition ||
          (!state.desktop && !state.independentCommentaryDisabled)
        )
          return null;
        const preference = await this.commentary!.owner.get();
        if (preference.revision !== wait.commentaryRevision) {
          await this.audioRouting!.cancelIndependentWait(wait.id);
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
          this.commentary!.owner,
          this.commentary!.journal,
          this.browserBaseUrl,
          state.bindings,
          state.desktopMicrophone,
          wait.commentaryRevision,
          async () => {
            const current = await this.audioRouting!.modeRecoveryState();
            return (
              valid() &&
              current.revision === state.revision &&
              current.waitingIndependent?.id === wait.id &&
              !current.transition &&
              (await this.commentary!.owner.get()).revision === wait.commentaryRevision
            );
          },
        );
        if (!prepared) return null;
        const revision = await this.audioRouting!.adoptPreparedBindings(
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
    music: MusicAudioMode,
    waitId?: string,
    valid: () => boolean = () => true,
  ) {
    if (!this.audioRouting || !this.commentary) throw new Error('audio_routing_unavailable');
    return this.configurationMutation(() =>
      this.audioModeRun('audio_mode_switch', async (connection, endpoint, observer) => {
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
        const completedPath = `${this.commentary!.journal}.dedicated-mode`;
        let monitorPending = false;
        const before = await this.audioRouting!.modeRecoveryState();
        if (before.revision !== revision) throw new Error('audio_revision_changed');
        if (before.transition) throw new Error('audio_mode_pending');
        await music.withAudioModeRecovery(() =>
          this.recoverAudioModeOnConnection(obs, endpoint, observer, music),
        );
        if (waitId) {
          const waiting = (await this.audioRouting!.modeRecoveryState()).waitingIndependent;
          if (
            !waiting ||
            waiting.id !== waitId ||
            (await this.commentary!.owner.get()).revision !== waiting.commentaryRevision
          )
            throw new Error('audio_wait_cancelled');
        }
        await this.audioRouting!.switchMode(
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
            const relationship = desktop
              ? await desktopMonitorRelationship(obs, desktop)
              : 'different';
            monitorPending = Boolean(desktop && relationship === 'unknown' && music.wantsMonitor());
            const microphoneChanges: AudioMonitorChange[] = [];
            if (desktop && relationship !== 'different' && ids.microphone) {
              const mic = await obs.call('GetInputAudioMonitorType', { inputUuid: ids.microphone });
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
            await new AudioMigration(`${this.commentary!.journal}.migration`).recover(
              obs,
              endpoint,
              observer,
            );
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
                    obsDesiredScenes(this.browserBaseUrl).map((scene) => scene.sceneName),
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
                  const waiting = (await this.audioRouting!.modeRecoveryState()).waitingIndependent;
                  if (
                    !waiting ||
                    waiting.id !== waitId ||
                    (await this.commentary!.owner.get()).revision !== waiting.commentaryRevision
                  )
                    throw new Error('audio_wait_cancelled');
                }
                if (
                  waitId &&
                  ids.remoteCommentary &&
                  !(await commentaryTargetReady(
                    obs,
                    this.commentary!.owner,
                    ids.remoteCommentary,
                    (await this.commentary!.owner.get()).revision,
                  ))
                )
                  throw new Error('audio_commentary_unavailable');
                const modeId = await begin(
                  writeMonitorOriginals(plan.musicBefore),
                  writeMonitorOriginals(plan.musicAfter),
                );
                const migration = new AudioMigration(`${this.commentary!.journal}.migration`);
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
                    obsDesiredScenes(this.browserBaseUrl).map((scene) => scene.sceneName),
                  );
                  const restored = await migration.completedEnabledItems(completedPath);
                  const waiting = (await this.audioRouting!.modeRecoveryState()).waitingIndependent;
                  const previousDesktop = (await this.audioRouting!.modeRecoveryState()).desktop;
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
                  for (const scene of obsDesiredScenes(this.browserBaseUrl))
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
                    this.commentary!.journal,
                    this.browserBaseUrl,
                    ids,
                    verify,
                    desktop,
                    monitorChanges,
                    modeId,
                    Boolean(
                      (await this.audioRouting!.modeRecoveryState()).waitingIndependent
                        ?.omitCommentary,
                    ),
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
                      this.browserBaseUrl,
                      ids,
                      desktop,
                      Boolean(
                        (await this.audioRouting!.modeRecoveryState()).waitingIndependent
                          ?.omitCommentary,
                      ),
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
                  await music.commitDesktopMonitorOriginals(
                    plan.musicBefore,
                    plan.musicAfter,
                    'after',
                  );
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
                      this.commentary!.owner,
                      ids.remoteCommentary,
                      (await this.commentary!.owner.get()).revision,
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
        ).catch(async (error: unknown) => {
          // Clear only if no OBS write or mode metadata commit was attempted.
          // An unknown write or uncertain journal remains pending for review.
          if (!obsWriteAttempted && !metadataCommitAttempted) {
            try {
              const current = await this.audioRouting!.modeRecoveryState();
              const transition = current.transition;
              if (
                current.revision === revision &&
                transition &&
                transition !== true &&
                transition.endpoint === endpoint
              ) {
                const migration = new AudioMigration(`${this.commentary!.journal}.migration`);
                await migration.discardUnsentMode(transition.id);
                await this.audioRouting!.commitModeTransition(transition.id, 'before');
              }
            } catch {
              // Uncertain storage or journal state remains visible for review.
            }
          }
          throw error;
        });
        if (mode === 'desktop') {
          const after = await this.audioRouting!.modeRecoveryState();
          if (after.desktop && !after.transition) {
            delete this.audioPreparationWarnings.commentary;
            if (this.audioPreparationWarnings.routing?.code === 'audio_bindings_required')
              delete this.audioPreparationWarnings.routing;
          }
        }
        return { monitorPending };
      }),
    );
  }
  private mixerRevision(routing: { revision: string; endpoint: string; collection: string }) {
    return createHash('sha256')
      .update(JSON.stringify([routing.revision, routing.endpoint, routing.collection]))
      .digest('hex');
  }
  private async mixerReadObs(obs: ObsRpc, endpoint: string) {
    if (!this.audioRouting) throw new Error('audio_routing_unavailable');
    const routing = await this.audioRouting.read(obs, endpoint);
    const channels = {} as Record<'game' | 'remoteCommentary' | 'microphone', MixerChannelStatus>;
    for (const role of ['game', 'remoteCommentary', 'microphone'] as const) {
      if (routing.transition) {
        channels[role] = {
          name: role,
          volume: null,
          muted: null,
          control: 'unknown',
          message: '音频模式切换待完成，请回到声音设置重新切换。',
        };
        continue;
      }
      const binding =
        routing.desktop && role === 'game'
          ? {
              ...routing.desktop,
              valid:
                routing.desktop.endpoint === endpoint &&
                routing.desktop.collection === routing.collection &&
                routing.candidates.some(
                  (input) =>
                    input.uuid === routing.desktop!.inputUuid &&
                    input.kind === routing.desktop!.inputKind,
                ),
              name: '桌面混音',
            }
          : routing.desktop && role === 'microphone'
            ? (routing.desktopMicrophone ?? null)
            : routing.bindings[role];
      if (
        !routing.desktop &&
        routing.independentCommentaryDisabled &&
        role === 'remoteCommentary'
      ) {
        channels[role] = {
          name: '远端解说',
          volume: null,
          muted: null,
          control: 'unbound',
          message: '远端解说已停用。',
        };
        continue;
      }
      if (routing.desktop && role === 'remoteCommentary') {
        channels[role] = {
          name: '远端解说',
          volume: null,
          muted: null,
          control: 'unbound',
          message: '桌面混音中无法单独调整。',
        };
        continue;
      }
      const name =
        binding?.name ??
        ({ game: '游戏', remoteCommentary: '远端解说', microphone: '麦克风' } as const)[role];
      if (!binding || !binding.valid) {
        channels[role] = {
          name,
          volume: null,
          muted: null,
          control: binding ? 'unknown' : 'unbound',
        };
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
    return this.observe(() =>
      this.withReadObs((obs, endpoint) => this.mixerReadObs(obs, endpoint), 12000),
    );
  }
  mixerWrite(command: MixerCommand, gameAudio?: GameAudioController): Promise<MixerCommandResult> {
    return this.serial(() =>
      this.withObs<MixerCommandResult>(
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
            const binding =
              role === 'game' && initial.routing.desktop
                ? initial.routing.desktop
                : role === 'microphone' && initial.routing.desktop
                  ? initial.routing.desktopMicrophone!
                  : initial.routing.bindings[role]!;
            const perform = async (): Promise<MixerCommandResult> => {
              const current = await this.mixerReadObs(obs, endpoint);
              if (
                current.revision !== command.revision ||
                current.channels[role].control !== 'available'
              )
                return { status: 'rejected', message: '音频绑定已变化，请刷新。' };
              const args = { inputUuid: binding.inputUuid };
              if (command.volume !== undefined) {
                await obs.call('SetInputVolume', { ...args, inputVolumeMul: command.volume });
              }
              if (command.muted !== undefined) {
                await obs.call('SetInputMute', { ...args, inputMuted: command.muted });
              }
              const after = await this.mixerReadObs(obs, endpoint);
              const observed = after.channels[role];
              if (
                after.revision !== command.revision ||
                observed.control !== 'available' ||
                (command.volume !== undefined &&
                  (observed.volume === null ||
                    Math.fround(observed.volume) !== Math.fround(command.volume))) ||
                (command.muted !== undefined && observed.muted !== command.muted)
              )
                return { status: 'unknown', message: '写入结果未确认，请刷新。' };
              return { status: 'confirmed' };
            };
            if (role === 'game' && !initial.routing.desktop) {
              if (!gameAudio) return { status: 'rejected', message: '游戏音频控制不可用。' };
              return await gameAudio.manual(perform);
            }
            return await perform();
          } catch {
            return {
              status: 'unknown',
              message: '音频操作未确认，请刷新。',
            };
          }
        },
        12000,
        undefined,
        true,
      ).catch(() => ({ status: 'unknown', message: 'OBS 连接未确认。' })),
    );
  }
  bindAudio(command: ObsAudioBindCommand) {
    if (!this.audioRouting) throw new Error('audio_routing_unavailable');
    return this.serial(() =>
      this.withObs(async (obs, endpoint) => {
        await this.audioRouting!.bind(obs, command, endpoint, async (binding) => {
          if (command.role !== 'remoteCommentary' || !this.commentary) return;
          if ((await readCommentarySwitch(`${this.commentary.journal}.switch`))?.phase === 'sent')
            throw new Error('commentary_switch_recovery_required');
          const current = await this.commentary.owner.get();
          await this.commentary.owner.set(
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
      }, 12000),
    );
  }
  async readCommentary() {
    if (!this.commentary) throw new Error('commentary_unavailable');
    return this.commentary.owner.get();
  }
  /** Explicit audio-only retry; it does not prepare or switch visual scenes. */
  prepareCommentaryAudio() {
    if (!this.commentary || !this.audioRouting) throw new Error('commentary_unavailable');
    return this.configurationMutation(() =>
      this.audioConfiguration.run(async (connection, endpoint, observer) => {
        const state = await this.audioRouting!.modeRecoveryState();
        if (
          state.desktop ||
          state.transition ||
          state.waitingIndependent ||
          state.independentCommentaryDisabled
        )
          throw new Error('audio_mode_pending');
        if (await this.audioRouting!.requiresManualBindings())
          throw new Error('audio_bindings_required');
        if (
          Object.values(state.bindings).some(
            (binding) => binding && ['game_capture', 'window_capture'].includes(binding.inputKind),
          )
        )
          throw new Error('audio_video_requires_full_preparation');
        const obs = guardedPreparationWrites(connection);
        const preference = await this.commentary!.owner.get();
        if (preference.preference.mode === 'existingInput') {
          const bindingUuid = preference.preference.binding.inputUuid;
          const inputs = (await obs.call('GetInputList')).inputs;
          if (!Array.isArray(inputs)) throw new Error('audio_video_requires_full_preparation');
          const selected = inputs.find(
            (input: Record<string, unknown>) => input.inputUuid === bindingUuid,
          ) as Record<string, unknown> | undefined;
          if (
            !selected ||
            ![
              'wasapi_output_capture',
              'wasapi_input_capture',
              'wasapi_process_output_capture',
            ].includes(String(selected.inputKind))
          )
            throw new Error('audio_video_requires_full_preparation');
        }
        const findings = await configureIndependentAudio(
          obs,
          endpoint,
          observer,
          this.commentary!.owner,
          this.commentary!.journal,
          this.browserBaseUrl,
          async (ids) => this.audioRouting?.seedAutomatic(obs, endpoint, ids),
          async () => !(await this.audioRouting?.enabled()),
          async (plan) => {
            const routing = await this.audioRouting?.commentaryBinding();
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
          async () => (await this.audioRouting?.managedBindings(obs, endpoint)) ?? null,
        );
        const pending = findings.find((item) => item.code === 'commentary_pending');
        if (pending) this.audioPreparationWarnings.commentary = pending;
        else delete this.audioPreparationWarnings.commentary;
        return findings;
      }),
    );
  }
  /** An unbound owned probe may still carry an earlier target. Do not promise a
   * new choice unless the existing target can already satisfy that choice. */
  private async checkUnboundCommentaryChoice(obs: ObsRpc, endpoint: string, window?: string) {
    const journal = this.commentary!.journal;
    let owned: { endpoint?: string; collection?: string; uuid?: string };
    try {
      owned = JSON.parse(await readFile(journal, 'utf8')) as typeof owned;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
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
    if (!this.commentary) throw new Error('commentary_unavailable');
    return this.withObs(async (obs, endpoint) => {
      const { owner, journal } = this.commentary!;
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
          : await this.configurationMutation(async () => {
              const lease = await this.captureWarmupGuard();
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
                  sceneName: obsDesiredScenes(this.browserBaseUrl)[0]!.sceneName,
                },
                () => check(true),
              );
            });
      const current = this.observationValidity();
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
    }, 45_000);
  }
  selectCommentaryApplication(id: string, revision: string) {
    if (!this.commentary) throw new Error('commentary_unavailable');
    return this.configurationMutation(() =>
      this.audioConfiguration.run(async (obs, endpoint) => {
        const selected = this.commentaryChoices.get(id);
        this.commentaryChoices.clear();
        if (
          !selected ||
          selected.until <= Date.now() ||
          selected.revision !== revision ||
          selected.endpoint !== endpoint ||
          (await this.commentary!.owner.get()).revision !== revision
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
        const candidates = await this.commentary!.owner.windows(obs, revision, selected.probe);
        if (!candidates.some((candidate) => candidate.window === selected.window))
          throw new Error('commentary_selection_changed');
        const previous = await this.commentary!.owner.get();
        const switchPath = `${this.commentary!.journal}.switch`;
        const pendingSwitch = await readCommentarySwitch(switchPath);
        if (pendingSwitch?.phase === 'sent') throw new Error('commentary_switch_recovery_required');
        const routingState = await this.audioRouting?.modeRecoveryState();
        if (routingState?.transition) throw new Error('audio_mode_pending');
        if (routingState?.desktop && routingState.bindings.remoteCommentary)
          throw new Error('commentary_binding_change_requires_independent');
        if (routingState?.desktop) {
          await this.checkUnboundCommentaryChoice(obs, endpoint, selected.window);
          return this.commentary!.owner.set(
            { mode: 'application', window: selected.window },
            revision,
          );
        }
        let owned: { endpoint?: string; collection?: string; uuid?: string } | undefined;
        try {
          owned = JSON.parse(await readFile(this.commentary!.journal, 'utf8')) as typeof owned;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        let from: string | undefined;
        const routing = await this.audioRouting?.commentaryBinding();
        const confirmed = await readOwnedCommentaryTarget(
          `${this.commentary!.journal}.owned-target`,
        );
        if (
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
          routing.microphone?.inputUuid !== owned.uuid &&
          (inputs.inputs as Record<string, unknown>[]).some(
            (input) =>
              input.inputUuid === owned.uuid && input.inputKind === 'wasapi_process_output_capture',
          )
        ) {
          const settings = (await obs.call('GetInputSettings', { inputUuid: owned.uuid }))
            .inputSettings;
          if (settings && typeof settings === 'object') {
            const value = (settings as Record<string, unknown>).window;
            if (
              typeof value === 'string' &&
              value !== selected.window &&
              value === confirmed.window &&
              ((previous.preference.mode === 'autoTeamspeak' && isTeamspeak(value)) ||
                (previous.preference.mode === 'application' &&
                  previous.preference.window === value) ||
                previous.preference.mode === 'disabled' ||
                (previous.preference.mode === 'existingInput' &&
                  previous.preference.binding.endpoint === endpoint &&
                  previous.preference.binding.collection === OBS_COLLECTION &&
                  previous.preference.binding.inputUuid === owned.uuid) ||
                (pendingSwitch?.phase === 'prepared' &&
                  pendingSwitch.endpoint === endpoint &&
                  pendingSwitch.collection === OBS_COLLECTION &&
                  pendingSwitch.uuid === owned.uuid &&
                  pendingSwitch.revision === revision &&
                  pendingSwitch.from === value &&
                  ((previous.preference.mode === 'application' &&
                    pendingSwitch.to === previous.preference.window) ||
                    (previous.preference.mode === 'autoTeamspeak' &&
                      pendingSwitch.to === AUTO_TEAMSPEAK_TARGET))))
            )
              from = value;
          }
        }
        const next = await this.commentary!.owner.set(
          { mode: 'application', window: selected.window },
          revision,
        );
        if (from && owned?.uuid && routing)
          await saveCommentarySwitch(switchPath, {
            endpoint,
            collection: OBS_COLLECTION,
            uuid: owned.uuid,
            from,
            to: selected.window,
            revision: next.revision,
            routingRevision: routing.revision,
            phase: 'prepared',
          });
        return next;
      }),
    );
  }
  setCommentaryMode(mode: 'autoTeamspeak' | 'disabled', revision: string) {
    if (!this.commentary) throw new Error('commentary_unavailable');
    if (mode === 'disabled')
      return this.serial(async () => {
        if ((await this.audioRouting?.modeRecoveryState())?.transition)
          throw new Error('audio_mode_pending');
        if ((await readCommentarySwitch(`${this.commentary!.journal}.switch`))?.phase === 'sent')
          throw new Error('commentary_switch_recovery_required');
        return this.commentary!.owner.set({ mode }, revision);
      });
    return this.configurationMutation(() =>
      this.audioConfiguration.run(async (obs, endpoint) => {
        const { owner, journal } = this.commentary!;
        const previous = await owner.get();
        if (previous.revision !== revision) throw new Error('commentary_revision_changed');
        const path = `${journal}.switch`;
        const pending = await readCommentarySwitch(path);
        if (pending?.phase === 'sent') throw new Error('commentary_switch_recovery_required');
        const routingState = await this.audioRouting?.modeRecoveryState();
        if (routingState?.transition) throw new Error('audio_mode_pending');
        if (routingState?.desktop && routingState.bindings.remoteCommentary)
          throw new Error('commentary_binding_change_requires_independent');
        if (routingState?.desktop) {
          await this.checkUnboundCommentaryChoice(obs, endpoint);
          return owner.set({ mode }, revision);
        }
        let owned: { endpoint?: string; collection?: string; uuid?: string } | undefined;
        try {
          owned = JSON.parse(await readFile(journal, 'utf8')) as typeof owned;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const routing = await this.audioRouting?.commentaryBinding();
        const confirmed = await readOwnedCommentaryTarget(`${journal}.owned-target`);
        let target: { uuid: string; from: string; to: string; routingRevision: string } | undefined;
        if (
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
          routing.microphone?.inputUuid !== owned.uuid &&
          (previous.preference.mode === 'application' ||
            previous.preference.mode === 'disabled' ||
            (previous.preference.mode === 'existingInput' &&
              previous.preference.binding.endpoint === endpoint &&
              previous.preference.binding.collection === OBS_COLLECTION &&
              previous.preference.binding.inputUuid === owned.uuid))
        ) {
          const [collection, inputs, settings] = await Promise.all([
            obs.call('GetSceneCollectionList'),
            obs.call('GetInputList'),
            obs.call('GetInputSettings', { inputUuid: owned.uuid }),
          ]);
          const found =
            Array.isArray(inputs.inputs) &&
            (inputs.inputs as Record<string, unknown>[]).some(
              (input) =>
                input.inputUuid === owned.uuid &&
                input.inputKind === 'wasapi_process_output_capture',
            );
          const from =
            settings.inputSettings && typeof settings.inputSettings === 'object'
              ? (settings.inputSettings as Record<string, unknown>).window
              : undefined;
          if (
            collection.currentSceneCollectionName === OBS_COLLECTION &&
            found &&
            from === confirmed.window &&
            (previous.preference.mode === 'disabled' ||
              previous.preference.mode === 'existingInput' ||
              from === previous.preference.window)
          ) {
            const windows = (await owner.windows(obs, revision, owned.uuid)).filter((candidate) =>
              isTeamspeak(candidate.window),
            );
            if (windows.length === 1 && windows[0]!.window !== from)
              target = {
                uuid: owned.uuid,
                from,
                to: windows[0]!.window,
                routingRevision: routing.revision,
              };
            else if (windows.length === 0)
              target = {
                uuid: owned.uuid,
                from,
                to: AUTO_TEAMSPEAK_TARGET,
                routingRevision: routing.revision,
              };
          }
        }
        const next = await owner.set({ mode }, revision);
        if (target)
          await saveCommentarySwitch(path, {
            endpoint,
            collection: OBS_COLLECTION,
            ...target,
            revision: next.revision,
            phase: 'prepared',
          });
        return next;
      }),
    );
  }
  videoPreflight(valid: () => boolean): Promise<void> {
    return this.observe(() =>
      this.withObs(
        async (obs, endpoint) => {
          if (!valid()) throw new Error('OBS 准备请求已失效，请重试。');
          const lease = await this.captureWarmupGuard();
          await assertNoVideoOutput(obs);
          if (!valid() || !lease())
            throw new ObsVideoError('preparation_output_changed', 'OBS 输出状态已变化，请重试。');
          if (!this.videoTransaction) throw new Error('OBS 视频准备不可用。');
          await this.videoTransaction.preflight(obs, endpoint);
          if (!valid() || !lease())
            throw new ObsVideoError('preparation_output_changed', 'OBS 输出状态已变化，请重试。');
        },
        12000,
        undefined,
        false,
        false,
        true,
      ),
    );
  }

  prepareVideo(valid: () => boolean): Promise<string | null> {
    return this.configurationMutation(() =>
      this.withObs(
        async (obs, endpoint) => {
          if (!valid()) throw new Error('OBS 准备请求已失效，请重试。');
          if (!this.videoTransaction) throw new Error('OBS 视频准备不可用。');
          const lease = await this.captureWarmupGuard();
          await assertNoVideoOutput(obs);
          if (!lease())
            throw new ObsVideoError('preparation_output_changed', 'OBS 输出状态已变化，请重试。');
          const guarded: ObsRpc = {
            ...obs,
            call: (type, data, onDispatch) => {
              if (/^(Create|Set|Remove)/.test(type) && !lease())
                throw new ObsPreparationWriteBlocked(
                  new ObsVideoError('preparation_output_changed', 'OBS 输出状态已变化，请重试。'),
                );
              return obs.call(type, data, onDispatch);
            },
          };
          const id = await this.videoTransaction.prepare(
            guarded,
            endpoint,
            () => valid() && lease(),
          );
          if (!valid() || !lease()) {
            if (id) {
              try {
                await this.videoTransaction.restore(guarded, endpoint, id);
              } catch (error) {
                throw new ObsVideoError(
                  'restore_pending',
                  'OBS 视频设置恢复待完成，请检查输出后重试。',
                  { cause: error },
                );
              }
            }
            throw new ObsVideoError('preparation_output_changed', 'OBS 输出状态已变化，请重试。');
          }
          return id;
        },
        12000,
        undefined,
        false,
        false,
        true,
      ),
    );
  }

  restoreVideo(id?: string, valid: () => boolean = () => true): Promise<void> {
    return this.configurationMutation(async () => {
      if (!valid()) throw new ObsVideoError('preparation_changed', 'OBS 视频恢复已取消。');
      if (!this.videoTransaction || !(await this.videoTransaction.pending())) return;
      const lease = await this.captureWarmupGuard();
      await this.withObs(
        (obs, endpoint) =>
          this.videoTransaction!.restore(
            {
              ...obs,
              call: (type, data, onDispatch) => {
                if (/^(Create|Set|Remove)/.test(type) && (!valid() || !lease()))
                  throw new ObsPreparationWriteBlocked(
                    new ObsVideoError(
                      'preparation_output_changed',
                      'OBS 输出状态已变化，视频设置待恢复。',
                    ),
                  );
                return obs.call(type, data, onDispatch);
              },
            },
            endpoint,
            id,
          ),
        12000,
        undefined,
        false,
        false,
        true,
      );
    });
  }

  ensure(
    activeScene: () => ProgramSceneId = () => 'waiting',
    valid: () => boolean = () => false,
    entry?: { id: string; valid: () => boolean },
    prepareMusic?: (valid: () => boolean, guard: (obs: ObsRpc) => ObsRpc) => Promise<void>,
  ): Promise<readonly ObsFinding[]> {
    const generation = this.programGeneration;
    const controller = new AbortController();
    const current = () =>
      !controller.signal.aborted && valid() && generation === this.programGeneration;
    return this.configurationMutation(async () => {
      this.preparationController = controller;
      if (entry) this.entryPermit = undefined;
      if (!current()) throw new Error('OBS 准备请求已失效，请重试。');
      await this.outputs.read();
      if (!current()) throw new Error('OBS 准备请求已失效，请重试。');
      const outputEpoch = this.outputs.preparationOutputEpoch();
      const checkOutput = () => {
        const reason = this.outputs.captureWarmupBlockReason();
        if (reason || this.outputs.preparationOutputEpoch() !== outputEpoch)
          throw new ObsVideoError(
            'preparation_output_changed',
            reason ?? 'OBS 输出状态已变化，请重试。',
          );
      };
      const confirmOutput = async (obs: ObsRpc) => {
        checkOutput();
        await assertNoVideoOutput(obs);
        checkOutput();
        if (!current() || (entry && !entry.valid()))
          throw new Error('OBS 准备请求已失效，请重试。');
      };
      if (entry) await this.withObs(confirmOutput);
      const preparationObs = (connection: ObsRpc): ObsRpc => {
        const assertPreparation = () => {
          if (!current()) throw new Error('OBS 准备请求已失效，请重试。');
          try {
            checkOutput();
          } catch (error) {
            throw new ObsPreparationWriteBlocked(error);
          }
        };
        // Managed resources put this lock at transport dispatch, after identity
        // reads. A stalled read cannot occupy the scene-control queue.
        if (connection.withMutationGuard)
          return guardedObs(
            connection.withMutationGuard(assertPreparation, (send) => this.serial(send)),
            current,
          );
        // Raw recovery sockets have no managed-resource preflight to exclude.
        return {
          ...connection,
          withMutationGuard: (guard) =>
            preparationObs({
              ...connection,
              call: (type, data, onDispatch) => {
                if (/^(Create|Set|Remove|Press|Trigger)/.test(type)) guard();
                return connection.call(type, data, onDispatch);
              },
            }),
          call: (type, data, onDispatch) => {
            const send = () => {
              assertPreparation();
              return connection.call(type, data, onDispatch);
            };
            return /^(Create|Set|Remove|Press|Trigger)/.test(type) ? this.serial(send) : send();
          },
        };
      };
      const audioFailure = (error: unknown, stage: string): ObsFinding => {
        if (!current() || error instanceof ObsPreparationWriteBlocked) throw error;
        checkOutput();
        this.diagnostic(stage, obsErrorEvidence(error));
        return (this.audioPreparationWarnings.setup = {
          code: 'audio_prepare_failed',
          message: '场景已准备，音频准备未确认，请在声音设置和 OBS 中核对。',
        });
      };
      let audioBlocked: ObsFinding | undefined;
      try {
        if (this.audioRouting && this.commentary)
          await this.withObs(
            (obs, endpoint) =>
              captureAudioCollectionTransfer(
                preparationObs(obs),
                this.audioRouting!,
                endpoint,
                this.commentary!.journal,
              ),
            TIMEOUT_MS,
          );
        if (await this.audioRouting?.modePending())
          audioBlocked = {
            code: 'audio_mode_pending',
            message: '音频切换尚未完成，请在声音设置中恢复。',
          };
      } catch (error) {
        audioBlocked = audioFailure(error, 'obs_audio_transfer');
      }
      const visualPreparation = await this.withObs(async (connection, endpoint, recovery) => {
        const obs = preparationObs(connection);
        // Select and prove the visual collection first. Unrelated old collections
        // keep their recovery evidence but do not own this graph.
        await obs.prepareManagedCollection?.(true, guardedPreparationWrites(obs));
        await this.captureWarmup?.recoverCurrentCollection(
          preparationObs(recovery),
          endpoint,
          () =>
            current() &&
            (!entry || entry.valid()) &&
            this.outputs.preparationOutputEpoch() === outputEpoch,
        );
        const protectedItems: { sceneName: string; sceneItemId: number; sourceUuid: string }[] = [];
        const protectedCaptureAudio = new Set<string>();
        const protectedSourceUuids = new Set<string>();
        let audioResponsibilityUnknown = false;
        if (this.commentary) {
          try {
            const responsibility = await new AudioMigration(
              `${this.commentary.journal}.migration`,
            ).visualResponsibilities(
              endpoint,
              OBS_COLLECTION,
              `${this.commentary.journal}.dedicated-mode`,
            );
            protectedItems.push(...responsibility.items);
            for (const uuid of responsibility.sourceUuids) protectedSourceUuids.add(uuid);
            for (const path of [this.commentary.journal, `${this.commentary.journal}.game`]) {
              const pending = await readCommentarySwitch(`${path}.switch`);
              if (pending?.endpoint === endpoint && pending.collection === OBS_COLLECTION) {
                protectedSourceUuids.add(pending.uuid);
                audioBlocked ??= {
                  code: 'audio_mode_pending',
                  message: '音频切换尚未完成，请在声音设置中恢复。',
                };
              }
            }
            for (const uuid of responsibility.captureAudio) protectedCaptureAudio.add(uuid);
            if (responsibility.pending)
              audioBlocked ??= {
                code: 'audio_mode_pending',
                message: '音频切换尚未完成，请在声音设置中恢复。',
              };
          } catch (error) {
            audioResponsibilityUnknown = true;
            audioBlocked = audioFailure(error, 'obs_audio_responsibility');
            // Unknown audio duties cannot authorize source destruction. Preserve
            // existing source lifetimes and shared enable fields, not other visuals.
            const inputs = (await obs.call('GetInputList')).inputs as { inputUuid: string }[];
            for (const input of inputs) protectedSourceUuids.add(input.inputUuid);
            const scenes = (await obs.call('GetSceneList')).scenes as { sceneName: string }[];
            for (const scene of scenes) {
              const items = (await obs.call('GetSceneItemList', { sceneName: scene.sceneName }))
                .sceneItems as { sceneItemId: number; sourceUuid: string; sourceName: string }[];
              for (const item of items)
                if (protectedSourceUuids.has(item.sourceUuid))
                  protectedItems.push({
                    sceneName: scene.sceneName,
                    sceneItemId: item.sceneItemId,
                    sourceUuid: item.sourceUuid,
                  });
            }
          }
        }
        const visualProtection = { items: protectedItems, sourceUuids: [...protectedSourceUuids] };
        const visual = await repairObsConfiguration(obs, this.browserBaseUrl, visualProtection);
        if (
          visual.some((item) =>
            [
              'collection_missing',
              'collection_inactive',
              'scene_missing',
              'source_kind_conflict',
            ].includes(item.code),
          )
        )
          return { findings: visual, ready: false, visualProtection };
        if (entry)
          await prepareCaptureAudio(
            obs,
            (uuid) => !audioResponsibilityUnknown && !protectedCaptureAudio.has(uuid),
          );
        return { findings: visual, ready: true, visualProtection };
      }, 30_000);
      // Audio owns a separate connection and deadline. Its timeout retires that
      // socket before we settle the warning; it cannot spend the visual budget.
      const prepared = { ...visualPreparation, audioReady: false };
      if (prepared.ready && audioBlocked) prepared.findings.push(audioBlocked);
      if (prepared.ready && !audioBlocked) {
        try {
          const audio = await this.withObs(async (connection, endpoint) => {
            const obs = preparationObs(connection);
            const visualProtection = prepared.visualProtection;
            const audioObs = guardedPreparationWrites(obs);
            await obs.reconcileManagedAudioResources?.(audioObs, visualProtection);
            if (this.audioRouting) {
              await applyAudioCollectionTransfer(
                audioObs,
                this.audioRouting,
                endpoint,
                obsDesiredScenes(this.browserBaseUrl)[0]!.sceneName,
                async (bindings) => {
                  if (!this.commentary) return;
                  const preference = await this.commentary.owner.get();
                  if (preference.preference.mode !== 'existingInput') return;
                  const selected = preference.preference.binding;
                  const next = bindings.remoteCommentary;
                  if (!next) throw new Error('audio_collection_transfer_commentary_missing');
                  if (
                    selected.endpoint === endpoint &&
                    selected.collection === OBS_COLLECTION &&
                    selected.inputUuid === next.inputUuid
                  )
                    return;
                  const previous = (await this.audioRouting!.collectionTransferState()).bindings
                    .remoteCommentary;
                  if (
                    !previous ||
                    selected.collection !== previous.collection ||
                    selected.endpoint !== previous.endpoint ||
                    selected.inputUuid !== previous.inputUuid
                  )
                    throw new Error('audio_collection_transfer_commentary_changed');
                  await this.commentary.owner.set(
                    {
                      mode: 'existingInput',
                      binding: { endpoint, collection: OBS_COLLECTION, inputUuid: next.inputUuid },
                    },
                    preference.revision,
                  );
                },
              ).catch((error: unknown) => {
                throw audioCollectionTransferError(error);
              });
            }
            if (this.audioRouting && (await this.audioRouting.hasNoEstablishedMode()))
              await setupObsAudio(audioObs, this.browserBaseUrl);
            else await ensureManagedAudioSources(audioObs, this.browserBaseUrl);
            if (this.audioRouting && !(await this.audioRouting.modePending())) {
              const previous = await this.audioRouting.commentaryBinding();
              await this.audioRouting.refreshManagedBindings(
                audioObs,
                endpoint,
                async (replacements) => {
                  if (!this.commentary) return;
                  await new AudioMigration(
                    `${this.commentary.journal}.migration`,
                  ).rebindCompletedInputs(
                    audioObs,
                    `${this.commentary.journal}.dedicated-mode`,
                    endpoint,
                    OBS_COLLECTION,
                    replacements,
                  );
                },
              );
              const next = await this.audioRouting.commentaryBinding();
              if (
                this.commentary &&
                previous.binding &&
                next.binding &&
                previous.binding.inputUuid !== next.binding.inputUuid
              ) {
                const preference = await this.commentary.owner.get();
                if (
                  preference.preference.mode === 'existingInput' &&
                  preference.preference.binding.endpoint === endpoint &&
                  preference.preference.binding.collection === OBS_COLLECTION &&
                  preference.preference.binding.inputUuid === previous.binding.inputUuid
                )
                  await this.commentary.owner.set(
                    {
                      mode: 'existingInput',
                      binding: {
                        endpoint,
                        collection: OBS_COLLECTION,
                        inputUuid: next.binding.inputUuid,
                      },
                    },
                    preference.revision,
                  );
              }
              await this.audioRouting.establishDefaultDesktop(audioObs, endpoint);
            }
            const audio = await checkObsAudio(obs);
            audio.push(...(await this.bindingFindings(obs, endpoint)));
            return audio;
          }, 30_000);
          prepared.findings.push(...audio);
          prepared.audioReady = true;
        } catch (error) {
          prepared.findings.push(audioFailure(error, 'obs_audio_prepare'));
        }
      }
      if (!current()) throw new Error('OBS 准备请求已失效，请重试。');
      this.findings = prepared.findings;
      if (prepared.ready && prepared.audioReady) delete this.audioPreparationWarnings.setup;
      if (prepared.ready && prepared.audioReady && this.audioRouting && this.commentary) {
        try {
          if (!(await this.audioRouting.modePending()))
            await this.audioConfiguration.run(async (connection, endpoint, observer) => {
              const obs = guardedPreparationWrites(preparationObs(connection));
              const state = await this.audioRouting!.modeRecoveryState();
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
                  this.commentary!.journal,
                  this.browserBaseUrl,
                  ids,
                  async () =>
                    (await this.audioRouting!.modeRecoveryState()).revision === state.revision,
                  state.desktop?.inputUuid,
                  [],
                  undefined,
                  state.independentCommentaryDisabled,
                );
                await new AudioMigration(
                  `${this.commentary!.journal}.migration`,
                ).forgetCompletedSceneItems(
                  `${this.commentary!.journal}.dedicated-mode`,
                  endpoint,
                  OBS_COLLECTION,
                );
                // OBS destroys a source when its final scene reference disappears.
                // Keep one disabled reference in waiting to retain alternate-mode
                // devices, instead of leaving disabled duplicates in every scene.
                const unwanted = new Set(
                  state.desktop
                    ? ['游戏声音', '其他解说']
                    : ['桌面声音', ...(state.independentCommentaryDisabled ? ['其他解说'] : [])],
                );
                for (const scene of obsDesiredScenes(this.browserBaseUrl)) {
                  const items = (await obs.call('GetSceneItemList', { sceneName: scene.sceneName }))
                    .sceneItems as { sourceName: string; sceneItemId: number }[];
                  for (const item of items)
                    if (scene.id !== 'waiting' && unwanted.has(item.sourceName))
                      await obs.call('RemoveSceneItem', {
                        sceneName: scene.sceneName,
                        sceneItemId: item.sceneItemId,
                      });
                }
              }
            });
        } catch (error) {
          prepared.audioReady = false;
          this.findings = [...this.findings, audioFailure(error, 'obs_audio_reconcile')];
        }
      }

      let audioRoutingReady = true;
      let modePending = false;
      let desktopBinding = false;
      let defaultDesktop = false;
      let manualBindingsRequired = false;
      try {
        modePending = Boolean(await this.audioRouting?.modePending());
        desktopBinding = Boolean(await this.audioRouting?.desktopBinding());
        defaultDesktop = Boolean(await this.audioRouting?.hasNoEstablishedMode());
        manualBindingsRequired = Boolean(await this.audioRouting?.requiresManualBindings());
        if (manualBindingsRequired && !defaultDesktop) {
          this.audioPreparationWarnings.routing = {
            code: 'audio_bindings_required',
            message: '旧配置尚未完成音频分路，请在声音设置中选择并准备音频模式。',
          };
          this.findings = [...this.findings, this.audioPreparationWarnings.routing];
        } else if (this.audioPreparationWarnings.routing?.code !== 'audio_bindings_required')
          delete this.audioPreparationWarnings.routing;
      } catch (error) {
        if (!current()) throw error;
        audioRoutingReady = false;
        this.diagnostic('obs_audio_routing', obsErrorEvidence(error));
        this.audioPreparationWarnings.routing = {
          code: 'audio_routing_unavailable',
          message: '音频路由未确认，请在声音设置和 OBS 中核对。',
        };
        this.findings = [...this.findings, this.audioPreparationWarnings.routing];
      }
      if (modePending && !this.findings.some((item) => item.code === 'audio_mode_pending'))
        this.findings = [
          ...this.findings,
          {
            code: 'commentary_pending',
            message: '音频模式切换待完成，请在声音设置中核对并恢复音频。',
          },
        ];
      if (
        prepared.ready &&
        prepared.audioReady &&
        this.commentary &&
        audioRoutingReady &&
        !manualBindingsRequired &&
        !defaultDesktop &&
        !desktopBinding &&
        !modePending
      ) {
        try {
          const commentary = await this.audioConfiguration.run((connection, endpoint, observer) =>
            configureIndependentAudio(
              guardedPreparationWrites(preparationObs(connection)),
              endpoint,
              observer,
              this.commentary!.owner,
              this.commentary!.journal,
              this.browserBaseUrl,
              async (ids) =>
                this.audioRouting?.seedAutomatic(preparationObs(connection), endpoint, ids),
              async () => !(await this.audioRouting?.enabled()),
              async (plan) => {
                const routing = await this.audioRouting?.commentaryBinding();
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
              async () =>
                (await this.audioRouting?.managedBindings(preparationObs(connection), endpoint)) ??
                null,
            ),
          );
          const pending = commentary.find((item) => item.code === 'commentary_pending');
          if (pending) this.audioPreparationWarnings.commentary = pending;
          else delete this.audioPreparationWarnings.commentary;
          this.findings = [...this.findings, ...commentary];
        } catch (error) {
          if (!current()) throw error;
          if (error instanceof ObsPreparationWriteBlocked) throw error;
          checkOutput();
          this.diagnostic('obs_commentary_prepare', obsErrorEvidence(error));
          const audioReason = error instanceof Error ? error.message : '';
          const audioHelp: Record<string, string> = {
            audio_global_path_unresolved:
              'OBS 仍启用了全局音频，请先关闭重复的全局采集，再重试自动配置。',
            audio_nested_path_unresolved:
              'Mizar 场景包含嵌套音频路径，请先将音频改为直接来源，再重试自动配置。',
            audio_video_path_unresolved:
              '画面来源仍附带采集声音，请将它选为对应音频分路，或关闭附带音频后重试。',
            audio_bindings_incomplete: '已选择的音频来源已失效，请在声音设置中重新选择。',
            audio_game_target_changed:
              '游戏声音来源的目标已变化，请在声音设置中重新选择游戏声音并录制试听。',
            audio_game_capture_missing:
              '未找到游戏画面来源，请先核对游戏采集，再选择游戏声音来源。',
            audio_game_missing: '游戏声音来源已不存在，请在声音设置中重新选择并录制试听。',
          };
          const uncertain = await readCommentarySwitch(`${this.commentary.journal}.switch`)
            .then((value) => value?.phase === 'sent')
            .catch(() => true);
          this.audioPreparationWarnings.commentary = {
            code: audioReason.startsWith('audio_game_') ? audioReason : 'commentary_pending',
            message:
              audioHelp[audioReason] ??
              (uncertain
                ? '解说来源切换结果待核对，请在 OBS 中检查后处理。'
                : '场景已准备，音频分路尚未确认。请在声音设置中核对来源并录制试听。'),
          };
          this.findings = [...this.findings, this.audioPreparationWarnings.commentary];
        }
      }
      if (!current()) throw new Error('OBS 准备请求已失效，请重试。');
      if (prepared.ready && prepareMusic) {
        checkOutput();
        try {
          await prepareMusic(current, preparationObs);
          delete this.audioPreparationWarnings.music;
        } catch (error) {
          if (!current() || error instanceof ObsPreparationWriteBlocked) throw error;
          this.diagnostic('obs_music_prepare', obsErrorEvidence(error));
          this.audioPreparationWarnings.music = {
            code: 'audio_music_prepare_failed',
            message: '场景已准备，音乐来源准备未确认，请在音乐设置中核对。',
          };
        }
        checkOutput();
      }
      if (prepared.ready)
        await this.withObs((obs) =>
          alignPreparationScene(preparationObs(obs), activeScene, this.browserBaseUrl, current),
        );
      // Observe audio on its own deadline before the final visual snapshot.
      // A late/failed audio read is a warning, never a visual entry veto. Shared
      // identity, enabled state and layout still belong to the final check below.
      let audioFindings: ObsFinding[];
      try {
        audioFindings = await this.withObs((obs, endpoint) => this.audioFindings(obs, endpoint));
      } catch (error) {
        if (!current()) throw error;
        checkOutput();
        audioFindings = this.audioCheckFailure(error);
      }
      // Owned writes may advance configuration freshness. Recheck their final result
      // rather than attaching a new generation to the earlier visual snapshot.
      const configurationEpoch = this.outputs.preparationConfigurationEpoch();
      this.entryPermit = undefined;
      const findings = await this.withObs(
        (obs, endpoint) => this.configurationFindings(obs, endpoint, undefined, false),
        12_000,
        undefined,
        false,
        false,
        false,
        true,
      );
      findings.push(...audioFindings);
      this.findings = findings;
      if (!current()) throw new Error('OBS 准备请求已失效，请重试。');
      if (entry) {
        await this.withObs(confirmOutput);
        if (
          prepared.ready &&
          this.outputs.canObservePreparation() &&
          configurationEpoch === this.outputs.preparationConfigurationEpoch() &&
          obsFindingReadiness(findings).blockingFindings.length === 0
        )
          this.entryPermit = {
            id: entry.id,
            outputEpoch,
            configurationEpoch,
            programGeneration: generation,
            valid: entry.valid,
          };
      }
      return this.findings;
    }, false).finally(() => {
      if (this.preparationController === controller) this.preparationController = undefined;
    });
  }
  verifyEntryPermit(id: string): Promise<void> {
    return this.serial(async () => {
      const permit = this.entryPermit;
      const check = () => {
        const reason = this.outputs.captureWarmupBlockReason();
        if (
          !permit ||
          permit.id !== id ||
          this.entryPermit !== permit ||
          !permit.valid() ||
          !this.outputs.canObservePreparation() ||
          permit.configurationEpoch !== this.outputs.preparationConfigurationEpoch() ||
          permit.programGeneration !== this.programGeneration ||
          permit.outputEpoch !== this.outputs.preparationOutputEpoch() ||
          reason
        )
          throw new ObsVideoError(
            'preparation_output_changed',
            reason ?? '启动准备已失效，请重新启动工作台。',
          );
      };
      check();
      await this.withObs(async (obs) => {
        await assertNoVideoOutput(obs);
        check();
      });
      check();
    });
  }
  repair(
    activeScene: () => ProgramSceneId,
    valid: () => boolean = () => false,
    prepareMusic?: (valid: () => boolean, guard: (obs: ObsRpc) => ObsRpc) => Promise<void>,
  ): Promise<readonly ObsFinding[]> {
    return this.ensure(activeScene, valid, undefined, prepareMusic);
  }
  gameBackgroundReady(): Promise<boolean> {
    return this.observe(() =>
      this.withReadObs((obs) => gameBackgroundReady(obs)).catch(() => false),
    );
  }
  beginCaptureWarmup(preparationId: string, valid: () => boolean) {
    const generation = this.programGeneration;
    return this.serial(async () => {
      if (!this.captureWarmup)
        throw new ObsCaptureWarmupError('capture_warmup_unavailable', 'OBS 游戏画面检查不可用。');
      if (!valid())
        throw new ObsCaptureWarmupError('capture_warmup_changed', 'OBS 准备请求已失效，请重试。');
      await this.outputs.read();
      if (this.outputs.hasRunningOutput()) return { transactionId: null, startedAt: Date.now() };
      const preparationLease = await this.captureWarmupGuard();
      const recovery = this.recoveryGeneration;
      const outputEpoch = this.outputs.preparationOutputEpoch();
      const current = () =>
        valid() &&
        generation === this.programGeneration &&
        recovery === this.recoveryGeneration &&
        outputEpoch === this.outputs.preparationOutputEpoch() &&
        this.outputs.captureWarmupBlockReason() === null;
      return this.withObs(async (connection, endpoint) => {
        if (!current())
          throw new ObsCaptureWarmupError('capture_warmup_changed', 'OBS 准备请求已失效，请重试。');
        await this.captureWarmup!.recoverCurrentCollection(connection, endpoint, preparationLease);
        const obs = guardedObs(connection, current);
        if (!(await prepareCaptureWindow(obs)))
          return {
            state: 'waiting' as const,
            reason: 'target_unavailable' as const,
            message: 'OBS 尚未发现可用的 CS2 窗口，请确认游戏已启动，再重试准备。',
          };
        // Our target write emits InputSettingsChanged. Acquire the warmup lease afterwards.
        const lease = await this.captureWarmupGuard();
        return this.captureWarmup!.begin(connection, endpoint, preparationId, current, lease);
      }, 30_000);
    });
  }
  releaseCaptureWarmup(id: string): Promise<void> {
    return this.serial(async () => {
      if (!this.captureWarmup)
        throw new ObsCaptureWarmupError('capture_warmup_unavailable', 'OBS 游戏画面检查不可用。');
      // A completed release stays successful even if output started afterwards.
      if (!(await this.captureWarmup.pending(id))) return;
      const lease = await this.captureWarmupGuard();
      return this.withObs(
        (obs, endpoint) => this.captureWarmup!.release(obs, endpoint, id, lease),
        12_000,
      );
    });
  }
  async captureWarmupMatches(id: string, since: number): Promise<boolean> {
    return this.captureWarmup?.matches(id, since) ?? false;
  }
  captureInitialization(
    diagnostic: ObsCaptureDiagnostic,
    id: string | null,
  ): Promise<CaptureInitialization> {
    return this.observe(async () => {
      await this.outputs.read();
      const observing = id === null || this.outputs.hasRunningOutput();
      return this.withReadObs(async (obs) => {
        if (!observing && (!this.captureWarmup || !(await this.captureWarmup.confirm(obs, id!))))
          throw new ObsCaptureWarmupError(
            'capture_warmup_changed',
            'OBS 游戏画面检查已中断，请重新检测。',
          );
        const result = await readCaptureInitialization(obs, diagnostic);
        if (!observing && !(await this.captureWarmup!.confirm(obs, id!)))
          throw new ObsCaptureWarmupError(
            'capture_warmup_changed',
            'OBS 游戏画面检查已中断，请重新检测。',
          );
        return result;
      });
    });
  }
  setBpCompactVisible(visible: boolean, valid: () => boolean = () => true): Promise<void> {
    return this.serial(async () => {
      if (!valid()) throw new Error('OBS 切场请求已失效。');
      await this.outputs.read();
      if (!valid()) throw new Error('OBS 切场请求已失效。');
      let client = this.bpClient;
      if (!client) {
        const config = await this.configStore.read();
        client = new OBSWebSocket();
        const current = client;
        const invalidate = () => {
          if (this.bpClient !== current) return;
          this.bpOwner.invalidate();
          this.bpClient = undefined;
          this.bpDisconnect?.();
        };
        client.on('ConnectionClosed', invalidate);
        client.on('CurrentSceneCollectionChanging', () => {
          this.bpOwner.invalidate();
          this.bpDisconnect?.();
        });
        client.on('SceneItemEnableStateChanged', (event) => {
          if (this.bpOwner.observeItem(event.sceneUuid, event.sceneItemId, event.sceneItemEnabled))
            this.bpDisconnect?.();
        });
        client.on('SceneItemRemoved', (event) => {
          if (this.bpOwner.observeRemoval(event.sceneUuid, event.sceneItemId))
            this.bpDisconnect?.();
        });
        client.on('SceneRemoved', (event) => {
          if (this.bpOwner.observeSceneRemoval(event.sceneUuid)) this.bpDisconnect?.();
        });
        let connectTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            client.connect(`ws://${config.host}:${config.port}`, config.password),
            new Promise<never>((_, reject) => {
              connectTimer = setTimeout(() => reject(new Error('OBS 连接超时。')), TIMEOUT_MS);
            }),
          ]);
          this.bpClient = client;
        } catch (error) {
          await client.disconnect().catch(() => undefined);
          throw error;
        } finally {
          if (connectTimer) clearTimeout(connectTimer);
        }
      }
      const rpc: ObsRpc = {
        reportsDispatch: true,
        call: (type, data, onDispatch) => {
          if (!valid()) throw new Error('OBS 切场请求已失效。');
          onDispatch?.();
          return (
            client.call as (
              name: string,
              args?: Record<string, unknown>,
            ) => Promise<Record<string, unknown>>
          )(type, data);
        },
      };
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.configStore
            .read()
            .then(async (config) =>
              this.bpOwner.set(
                this.bpOwner.preparationRpc(
                  await this.configStore.managedResources.bind(
                    rpc,
                    `ws://${config.host}:${config.port}`,
                    this.browserBaseUrl,
                  ),
                  this.browserBaseUrl,
                ),
                this.browserBaseUrl,
                visible,
              ),
            ),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('OBS 操作超时，请检查连接。')), TIMEOUT_MS);
          }),
        ]);
        if (!visible && this.bpClient === client) {
          this.bpClient = undefined;
          await client.disconnect().catch(() => undefined);
        }
      } catch (error) {
        this.entryPermit = undefined;
        this.bpOwner.invalidate();
        if (this.bpClient === client) this.bpClient = undefined;
        await client.disconnect().catch(() => undefined);
        throw error;
      } finally {
        if (timer) clearTimeout(timer);
      }
    });
  }
  switchScene(id: ProgramSceneId, options?: ObsSceneSwitchOptions): Promise<void> {
    // A new Take supersedes preparation. It waits only for already-dispatched
    // conflicting writes, never for unrelated audio reads or their deadlines.
    this.preparationController?.abort();
    return this.serial(() =>
      this.withObs(async (obs) => {
        if (options?.reconcileCollection) {
          const guarded = guardedObs(obs, () => options.valid?.() !== false);
          await guarded.activateManagedCollection?.();
        }
        await switchObsScene(obs, id, this.browserBaseUrl, options);
      }),
    );
  }

  restoreProgram(valid: () => boolean = () => true): Promise<void> {
    return this.serial(async () => {
      if (!(await this.configStore.managedResources.hasPendingReturn())) return;
      await this.withObs(async (obs) => {
        await guardedObs(obs, valid).restoreManagedCollection?.();
      });
    });
  }
  switchToWaitingForExit(options: ObsSceneSwitchOptions): Promise<void> {
    this.preparationController?.abort();
    return this.serial(async () => {
      try {
        await this.withObs(async (obs) => {
          const collection = await obs.call('GetSceneCollectionList');
          if (typeof collection.currentSceneCollectionName !== 'string')
            throw new Error('OBS 场景集合状态未确认。');
          if (collection.currentSceneCollectionName !== OBS_COLLECTION) return;
          const scene = await obs.call('GetCurrentProgramScene');
          if (typeof scene.currentProgramSceneName !== 'string')
            throw new Error('OBS 当前场景状态未确认。');
          if (
            !obsDesiredScenes(this.browserBaseUrl).some(
              (item) => item.sceneName === scene.currentProgramSceneName,
            )
          )
            return;
          await switchObsScene(obs, 'waiting', this.browserBaseUrl, options);
        });
      } catch (error) {
        // A fresh native absence proof also covers a previously used OBS that
        // the operator has closed. Disconnection alone never proves output stopped.
        let running: boolean;
        try {
          running = await isObsProcessRunning();
        } catch (probeError) {
          this.diagnostic('obs_exit_process_probe', obsErrorEvidence(probeError));
          throw new ObsExitSafetyError(
            'OBS 运行状态未确认，制作尚未结束。请连接 OBS 后重试退出；若 OBS 已关闭，请查看诊断并重试。',
            { cause: error },
          );
        }
        if (running)
          throw new ObsExitSafetyError(
            'OBS 等待画面未确认，制作尚未结束。请连接 OBS 后重试退出；若无法连接，请在 OBS 中确认停止推流与录制并关闭 OBS 后重试。',
            { cause: error },
          );
        if (options.valid && !options.valid())
          throw new Error('退出请求已失效，请重试。', { cause: error });
      }
    });
  }
  setupAudio(): Promise<void> {
    return this.configurationMutation(async () => {
      if ((await this.audioRouting?.enabled()) || (await this.audioRouting?.desktopBinding()))
        throw new ObsActionError('audio_routing_enabled');
      await this.withObs(async (obs) => {
        await setupObsAudio(guardedPreparationWrites(obs), this.browserBaseUrl);
        const findings = await checkObsAudio(obs);
        if (
          findings.some(
            (item) =>
              item.code === 'audio_missing' ||
              item.code === 'game_audio_missing' ||
              item.code.startsWith('audio_scene:'),
          )
        )
          throw new Error('audio_setup_unconfirmed');
      }, 12_000);
      delete this.audioPreparationWarnings.setup;
    });
  }
  async launchTarget(): Promise<string> {
    const config = await this.configStore.read();
    const path = await discoverObsExecutable(config.executablePath);
    if (!path) throw new ObsActionError('executable_missing');
    return path;
  }

  async open(): Promise<void> {
    const path = await this.launchTarget();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(path, [], {
        cwd: dirname(path),
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
      child.once('error', (cause) => reject(new ObsActionError('executable_failed', { cause })));
    });
  }
}
