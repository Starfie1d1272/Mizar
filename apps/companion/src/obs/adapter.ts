import { RepeatedDiagnostic } from '../support/repeated-diagnostic.js';

import { ObsObservationConnection } from './observation-connection.js';

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
import { ObsAudioCoordinator } from './audio-coordinator.js';
import {
  guardedObs,
  obsAudioModeFailureEvidence,
  obsErrorEvidence,
  obsFailureKind,
  obsFindingReadiness,
} from './prepare-readiness.js';
export { obsAudioModeFailureEvidence, obsErrorEvidence, obsFailureKind };
import { requireSupportedObs } from './version-support.js';
import { ObsActionError } from './action-error.js';
import { readLocalObsConnection } from './local-connection.js';
import { BpOverlayOwner } from './bp-overlay.js';

import { spawn } from 'node:child_process';
import { dirname } from 'node:path';
import { EventSubscription, OBSWebSocket } from 'obs-websocket-js';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import type { ObsOutputCommand, ObsOutputPhase, ObsOutputsStatus } from '@mizar/protocol/obs';
import type { ObsAudioRouting } from './audio-routing.js';
import type { RemoteCommentary } from './remote-commentary.js';
import { readCommentarySwitch } from './commentary-switch.js';
import { OBS_COLLECTION, obsDesiredScenes } from './desired-state.js';

import { AudioMigration } from './audio-migration.js';
import type { MusicAudioRecovery } from '../music/device.js';

import { ObsOutputController, ObsOutputError } from './outputs.js';
import { readObsProgramEvidence, type ObsProgramEvidence } from './program-evidence.js';
import {
  ObsConfigStore,
  discoverObsExecutable,
  isObsProcessRunning,
  type ObsConfig,
} from './config.js';
import {
  checkObsAudio,
  ensureManagedAudioSources,
  readDesiredSceneItems,
  setupObsAudio,
  syncManagedMicrophoneAcrossScenes,
  type ObsInventorySnapshot,
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

export class ObsAdapter {
  private readonly outputs: ObsOutputController;
  private readonly observations = new ObsObservationConnection();
  readonly audio: ObsAudioCoordinator;
  private readonly bpOwner = new BpOverlayOwner();
  private programChanged: (kind: 'disconnected' | 'changed') => void = () => undefined;
  private configurationChanged: () => void = () => undefined;
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
  onConfigurationChanged(callback: () => void): void {
    this.configurationChanged = callback;
  }
  onBpDisconnect(callback: () => void): void {
    this.bpOwner.onDisconnect(callback);
  }
  private configurationPending = false;
  private preparationController: AbortController | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private findings: ObsFinding[] = [
    { code: 'configuration_unchecked', message: '请检查 OBS 场景配置。' },
  ];

  private commentaryTimer: ReturnType<typeof setTimeout> | undefined;
  private commentaryTask: Promise<void> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryClosed = false;
  private recoveryGeneration = 0;
  private recoveryPaused = false;
  private browserRecoveryPermission:
    | { recovery: number; program: number; production: () => boolean; submitted: boolean }
    | undefined;
  private recoveryTask: Promise<void> | undefined;
  private readonly submittedBrowserRefreshes = new Set<string>();
  private micSyncPending:
    { sceneName: string; sceneItemId: number; enabled: boolean } | 'reconcile' | undefined;
  private micSyncRunning = false;
  private readonly confidenceFailures = new RepeatedDiagnostic((stage, evidence) =>
    this.diagnostic(stage, evidence),
  );
  private readonly browserRecoveryFailures = new RepeatedDiagnostic((stage, evidence) =>
    this.diagnostic(stage, evidence),
  );

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
    this.audio = new ObsAudioCoordinator({
      configStore: this.configStore,
      audioRouting: this.audioRouting,
      commentary: this.commentary,
      browserBaseUrl: this.browserBaseUrl,
      diagnostic: (stage, error) => this.diagnostic(stage, error),
      observe: (read) => this.observe(read),
      serial: (operation) => this.serial(operation),
      configurationMutation: (operation) => this.configurationMutation(operation),
      withObs: (operation, options) => this.withObs(operation, options),
      withReadObs: (operation, timeoutMs) =>
        this.withReadObs(operation, timeoutMs === undefined ? undefined : { timeoutMs }),
      captureWarmupGuard: () => this.captureWarmupGuard(),
      observationValidity: () => this.observationValidity(),
      waitForAutomaticAudioConnection: () => this.waitForAutomaticAudioConnection(),
      programGeneration: () => this.programGeneration,
      recoveryGeneration: () => this.recoveryGeneration,
    });
    this.outputs = new ObsOutputController(
      configStore,
      (error, password) => diagnostic('obs_output', obsErrorEvidence(error, password)),
      (kind, name) => {
        if (kind === 'outputs-idle') {
          this.runBrowserRecovery();
          return;
        }
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
        this.programChanged('changed');
      },
      (event, data) => this.bpOwner.observePreparationEvent(event, data),
      (event) => {
        if (this.recoveryClosed) return;
        if (event.kind === 'collection-ready') {
          this.scheduleMicrophoneSync('reconcile');
          return;
        }
        if (!obsDesiredScenes(this.browserBaseUrl).some((s) => s.sceneName === event.sceneName))
          return;
        this.scheduleMicrophoneSync({
          sceneName: event.sceneName,
          sceneItemId: event.sceneItemId,
          enabled: event.sceneItemEnabled,
        });
      },
      () => this.configurationChanged(),
    );
  }

  private scheduleMicrophoneSync(
    next: { sceneName: string; sceneItemId: number; enabled: boolean } | 'reconcile',
  ): void {
    if (this.recoveryClosed) return;
    if (next !== 'reconcile' || this.micSyncPending === undefined) this.micSyncPending = next;
    if (this.micSyncRunning) return;
    this.micSyncRunning = true;
    void this.serial(async () => {
      try {
        while (this.micSyncPending && !this.recoveryClosed) {
          const target = this.micSyncPending;
          this.micSyncPending = undefined;
          await this.withObs((obs) =>
            syncManagedMicrophoneAcrossScenes(
              obs,
              this.browserBaseUrl,
              target === 'reconcile' ? undefined : target,
            ),
          ).catch(() => undefined);
        }
      } finally {
        this.micSyncRunning = false;
      }
    }).catch(() => undefined);
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

  waitForAutomaticAudioConnection(): boolean {
    return this.outputs.waitForAutomaticAudioConnection();
  }

  setOnOutputBusy(handler: () => void): void {
    this.outputs.setOnOutputBusy(handler);
  }

  async outputStatus(includePreparation = true): Promise<ObsOutputsStatus> {
    const outputs = await this.outputs.read().catch(() => this.outputs.snapshot());
    return includePreparation
      ? { ...outputs, preparation: await this.preparationStatus() }
      : outputs;
  }

  outputCommand(
    command: ObsOutputCommand,
    valid: () => boolean = () => true,
  ): Promise<ObsOutputsStatus> {
    const run = async () => {
      try {
        if (!valid())
          throw new ObsOutputError('obs_output_stale', '输出请求已取消，未发送到 OBS。');
        let current = valid;
        if (command.action === 'start') {
          this.outputs.notifyOutputBusy();
          if (this.configurationPending)
            throw new ObsOutputError('obs_output_busy', 'OBS 正在准备配置，请等待状态确认。');
          let preparation = await this.preparationStatus();
          if (preparation === 'cleanup_pending' && command.output === 'stream') {
            const stream = (await this.outputs.read()).stream;
            if (command.expectedRevision !== stream.revision)
              throw new ObsOutputError('obs_output_stale', 'OBS 状态已变化，请核对后重新操作。');
            const generation = this.programGeneration;
            current = () => valid() && generation === this.programGeneration;
            try {
              await this.recoverCaptureWarmup(current, false);
            } catch (error) {
              if (error instanceof ObsCaptureWarmupError || error instanceof ObsVideoError)
                throw new ObsOutputError('obs_output_busy', error.message, { cause: error });
              throw error;
            }
            preparation = await this.preparationStatus();
          }
          if (preparation)
            throw new ObsOutputError(
              'obs_output_busy',
              preparation === 'checking'
                ? '正在检查 OBS 游戏画面，请等待准备完成后开始输出。'
                : 'OBS 游戏画面检查未完成，请重新检查后开始输出。',
            );
        }
        await this.outputs.command(command, current);
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
    return this.configurationMutation(() => this.commitConnectionConfig(config));
  }

  useLocalConnection(valid: () => boolean, automatic = false): Promise<void> {
    return this.configurationMutation(async () => {
      if (automatic && !(await this.configStore.isUnconfigured())) return;
      if (!valid()) throw new Error('local_obs_changed');
      const saved = await this.configStore.read();
      const { config, stillCurrent } = await readLocalObsConnection(saved.executablePath);
      if (!valid()) throw new Error('local_obs_changed');
      const client = new OBSWebSocket();
      const authenticate = async (password: string) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            client.connect(`ws://127.0.0.1:${config.port}`, password, { eventSubscriptions: 0 }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error('local_obs_authentication_failed')),
                TIMEOUT_MS,
              );
            }),
          ]);
          return true;
        } catch {
          return false;
        } finally {
          clearTimeout(timer);
          await client.disconnect().catch(() => undefined);
        }
      };
      const savedVerified =
        saved.port === config.port &&
        saved.password !== config.password &&
        (await authenticate(saved.password));
      if (!savedVerified && (!valid() || !(await authenticate(config.password))))
        throw new Error('local_obs_authentication_failed');
      if (!(await stillCurrent()) || !valid()) throw new Error('local_obs_changed');
      await this.commitConnectionConfig(
        savedVerified ? { ...config, password: saved.password } : config,
      );
    });
  }

  private async commitConnectionConfig(config: ObsConfig): Promise<void> {
    await this.bpOwner.close(true);
    await this.configStore.save(config);
    this.audioRouting?.invalidateSelections();
    this.audio.clearCommentaryChoices();
    this.outputs.reset();
    this.observations.reset();
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
      submitted: false,
    };
    this.runBrowserRecovery();
  }

  private runBrowserRecovery(): void {
    if (
      this.recoveryClosed ||
      this.recoveryPaused ||
      !this.browserRecoveryPermission ||
      this.browserRecoveryPermission.submitted ||
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
      if (!valid()) return;
      if (!this.outputs.hasConfirmedIdleOutputs()) {
        this.outputs.waitForAutomaticAudioConnection();
        return;
      }
      this.recoveryTask = this.serial(async () => {
        // Keep the existing program observer connected across recovery retries.
        await this.outputs.read();
        if (!valid() || !this.outputs.hasConfirmedIdleOutputs()) return false;
        return this.withObs(
          (obs) =>
            refreshObsBrowserSources(
              guardedObs(obs, valid),
              this.browserBaseUrl,
              this.submittedBrowserRefreshes,
              this.buildId,
            ),
          { timeoutMs: TIMEOUT_MS, observe: 'browser' },
        );
      })
        .then((complete) => {
          if (valid()) {
            permission!.submitted = complete;
            if (complete) this.browserRecoveryFailures.clear();
          }
        })
        .catch((error) => {
          if (this.outputs.hasConfirmedIdleOutputs()) {
            const kind = obsFailureKind(error);
            this.browserRecoveryFailures.record('obs_browser_recovery', kind, { kind });
          }
        })
        .finally(() => {
          this.recoveryTask = undefined;
          if (valid() && !permission?.submitted && this.outputs.hasConfirmedIdleOutputs()) {
            this.recoveryTimer = setTimeout(attempt, 15_000);
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
            await this.audio.queueIndependentCommentary(valid);
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

  async close(): Promise<void> {
    this.recoveryClosed = true;
    this.micSyncPending = undefined;
    if (this.commentaryTimer) clearTimeout(this.commentaryTimer);
    await this.commentaryTask;
    await this.outputs.close();
    await this.observations.close();
    await this.bpOwner.close();
    if (this.recoveryTimer) clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    await this.recoveryTask;
    await this.queue;
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
    options: {
      timeoutMs?: number;
      diagnosticStage?: string;
      commitObservation?: (value: T) => void;
    } = {},
  ): Promise<T> {
    return this.withObs(operation, { ...options, observe: 'preparation', readOnly: true });
  }

  private async withObs<T>(
    operation: (obs: ObsRpc, endpoint: string, recovery: ObsRpc) => Promise<T>,
    options: {
      timeoutMs?: number;
      diagnosticStage?: string;
      observe?: 'audio' | 'browser' | 'video' | 'preparation';
      commitObservation?: (value: T) => void;
      readOnly?: boolean;
    } = {},
  ): Promise<T> {
    const {
      timeoutMs = TIMEOUT_MS,
      diagnosticStage,
      observe,
      commitObservation,
      readOnly = false,
    } = options;
    const observeAudioIdentity = observe === 'audio';
    const observeBrowserIdentity = observe === 'browser';
    const observeVideoIdentity = observe === 'video';
    const observePreparationIdentity = observe === 'preparation';
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
    const invalidateBrowser = () => {
      active = false;
      this.browserRecoveryPermission = undefined;
    };
    const listeners: [string, (...args: unknown[]) => void][] = [
      ...(observeAudioIdentity
        ? (
            [
              'CurrentSceneCollectionChanging',
              'InputRemoved',
              'InputSettingsChanged',
              'ConnectionClosed',
            ] as const
          ).map((e) => [e, invalidateAudio] as [string, (...args: unknown[]) => void])
        : []),
      ...(observeBrowserIdentity
        ? (['InputRemoved', 'InputSettingsChanged', 'ConnectionClosed'] as const).map(
            (e) => [e, invalidateBrowser] as [string, (...args: unknown[]) => void],
          )
        : []),
      ...(observeVideoIdentity
        ? (['CurrentProfileChanging', 'CurrentProfileChanged', 'ConnectionClosed'] as const).map(
            (e) => [e, invalidateAudio] as [string, (...args: unknown[]) => void],
          )
        : []),
      ...(observePreparationIdentity
        ? [
            ...preparationEvents.map(
              (e) => [e, invalidateAudio] as [string, (...args: unknown[]) => void],
            ),
            [
              'InputSettingsChanged',
              (data: unknown) => {
                if (this.outputs.preparationSettingsChanged(data as { inputUuid?: string }))
                  invalidateAudio();
              },
            ] as [string, (...args: unknown[]) => void],
          ]
        : []),
    ];
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
        for (const [event, listener] of listeners)
          client.on(event as keyof OBSWebSocket['listeners'], listener as never);
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
            const markExpected = (
              field: 'expectedScene' | 'expectedCollection',
              value: unknown,
            ) => {
              if (typeof value !== 'string') return;
              this[field] = value;
              setTimeout(() => {
                if (this[field] === value) this[field] = undefined;
              }, 2000).unref();
            };
            if (type === 'SetCurrentProgramScene')
              markExpected('expectedScene', data?.sceneUuid ?? data?.sceneName);
            if (type === 'SetCurrentSceneCollection' || type === 'CreateSceneCollection')
              markExpected('expectedCollection', data?.sceneCollectionName);
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
      for (const [event, listener] of listeners)
        client.off(event as keyof OBSWebSocket['listeners'], listener as never);
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
    includeAudio = true,
  ): Promise<ObsFinding[]> {
    try {
      await requireSupportedObs(obs);
    } catch (error) {
      if (!(error instanceof ObsVideoError)) throw error;
      this.diagnostic('obs_version_check', obsErrorEvidence(error));
      return [{ code: error.code, message: error.message }];
    }
    const inputGeneration = this.outputs.preparationInputsGeneration();
    let observedInputs = false;
    const observeInputs = (inputs: unknown) => {
      this.outputs.observePreparationInputs(inputs, inputGeneration);
      observedInputs = true;
    };
    const snapshot: ObsInventorySnapshot = {};
    const findings = await checkObsConfiguration(
      obs,
      this.browserBaseUrl,
      await this.bpOwner.hiddenHud(obs, this.browserBaseUrl),
      observeInputs,
      snapshot,
    );
    if (!observedInputs) observeInputs((await obs.call('GetInputList')).inputs);
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
    return includeAudio
      ? [...findings, ...(await this.audioFindings(obs, endpoint, snapshot))]
      : findings;
  }

  private audioCheckFailure(error: unknown): ObsFinding[] {
    this.diagnostic('obs_audio_check', obsErrorEvidence(error));
    return [
      ...Object.values(this.audio.warningSnapshot()),
      { code: 'audio_check_failed', message: 'OBS 音频检查未完成，请在声音设置和 OBS 中核对。' },
    ];
  }

  private async audioFindings(
    obs: ObsRpc,
    endpoint: string,
    snapshot?: ObsInventorySnapshot,
  ): Promise<ObsFinding[]> {
    try {
      const audio = [
        ...(await checkObsAudio(obs, snapshot)),
        ...(await this.bindingFindings(obs, endpoint)),
      ];
      if (await this.audioRouting?.modePending())
        audio.push({
          code: 'commentary_pending',
          message: '音频模式切换待核对，请在声音设置和 OBS 中检查。',
        });
      const warnings = this.audio.warningSnapshot();
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
        async (obs) => {
          status = { ...status, connection: 'connected' };
          facts = {
            ...facts,
            process: 'running',
            listener: 'reachable',
            authentication: 'accepted',
            resources: this.findings.some((item) => item.code === 'configuration_unchecked')
              ? 'unknown'
              : obsFindingReadiness(this.findings).blockingFindings.length
                ? 'needs_configuration'
                : 'ready',
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
          ]);
        },
        { timeoutMs: 2500 },
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
              const path = await discoverObsExecutable(config.executablePath).catch(
                (error: unknown) => {
                  if (!(error instanceof ObsActionError) || error.code !== 'executable_ambiguous')
                    throw error;
                  findings.push({ code: error.code, message: error.message });
                  return undefined;
                },
              );
              if (path === undefined) return;
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
          { timeoutMs: PROGRAM_EVIDENCE_MS, diagnosticStage: 'obs_program_check' },
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
    return {
      ...status,
      facts,
      findings: status.connection === 'connected' ? [...this.findings, ...findings] : [...findings],
      programEvidence,
    };
  }

  private previewPending: Promise<{
    preview: { scene: string; image: string } | null;
    reason?: 'scene_changing' | 'disconnected' | 'unavailable';
  }> | null = null;
  confidencePreview(): Promise<{
    preview: { scene: string; image: string } | null;
    reason?: 'scene_changing' | 'disconnected' | 'unavailable';
  }> {
    if (this.previewPending) return this.previewPending;
    this.previewPending = this.withObs(
      async (obs) => {
        const current = await obs.call('GetCurrentProgramScene');
        const scene = current.currentProgramSceneName;
        if (typeof scene !== 'string') return { preview: null, reason: 'unavailable' as const };
        const screenshot = await obs.call('GetSourceScreenshot', {
          sourceName: scene,
          imageFormat: 'jpeg',
          imageWidth: 640,
          imageHeight: 360,
          imageCompressionQuality: 70,
        });
        const after = await obs.call('GetCurrentProgramScene');
        if (after.currentProgramSceneName !== scene)
          return { preview: null, reason: 'scene_changing' as const };
        const image = screenshot.imageData;
        if (
          typeof image === 'string' &&
          image.startsWith('data:image/jpeg;base64,') &&
          image.length < 1_000_000
        ) {
          this.confidenceFailures.clear();
          return { preview: { scene, image } };
        }
        return { preview: null, reason: 'unavailable' as const };
      },
      { timeoutMs: TIMEOUT_MS },
    )
      .catch((error) => {
        const kind = obsFailureKind(error);
        const reason =
          kind === 'refused' || kind === 'authentication'
            ? ('disconnected' as const)
            : error instanceof ObsVideoError && error.code === 'obs_observation_changed'
              ? ('scene_changing' as const)
              : ('unavailable' as const);
        this.confidenceFailures.record('obs_confidence_preview', reason, {
          reason,
          kind,
        });
        return { preview: null, reason };
      })
      .finally(() => {
        this.previewPending = null;
      });
    return this.previewPending;
  }

  check(): Promise<readonly ObsFinding[]> {
    return this.observe(async () => {
      const current = this.preparationValidity();
      return this.withReadObs((obs, endpoint) => this.configurationFindings(obs, endpoint), {
        timeoutMs: 12_000,
        commitObservation: (findings) => {
          if (current()) this.findings = findings;
        },
      });
    });
  }
  recoverCaptureWarmup(valid: () => boolean, serialize = true): Promise<readonly ObsFinding[]> {
    return this.configurationMutation(async () => {
      if (!valid())
        throw new ObsCaptureWarmupError('capture_warmup_changed', '制作状态已变化，请重新检查。');
      if (!this.captureWarmup)
        throw new ObsCaptureWarmupError('capture_warmup_unavailable', 'OBS 游戏画面检查不可用。');
      const pending = (await this.captureWarmup.status()) !== null;
      const lease = pending ? await this.captureWarmupGuard() : undefined;
      this.findings = await this.withObs(
        async (obs, endpoint) => {
          if (lease)
            await this.captureWarmup!.recoverCurrentCollection(
              obs,
              endpoint,
              () => valid() && lease(),
            );
          return this.configurationFindings(guardedObs(obs, valid), endpoint);
        },
        { timeoutMs: 12_000 },
      );
      this.configurationChanged();
      return this.findings;
    }, serialize);
  }
  videoPreflight(valid: () => boolean): Promise<void> {
    return this.observe(() =>
      this.withObs(
        async (obs, endpoint) => {
          if (!valid()) throw new Error('OBS 准备请求已失效，请重试。');
          await requireSupportedObs(obs);
          const lease = await this.captureWarmupGuard();
          await assertNoVideoOutput(obs);
          if (!valid() || !lease())
            throw new ObsVideoError('preparation_output_changed', 'OBS 输出状态已变化，请重试。');
          if (!this.videoTransaction) throw new Error('OBS 视频准备不可用。');
          await this.videoTransaction.preflight(obs, endpoint);
          if (!valid() || !lease())
            throw new ObsVideoError('preparation_output_changed', 'OBS 输出状态已变化，请重试。');
        },
        { timeoutMs: 12_000, observe: 'video' },
      ),
    );
  }

  private videoGuardedObs(obs: ObsRpc, ok: () => boolean, message: string): ObsRpc {
    return {
      ...obs,
      call: (type, data, onDispatch) => {
        if (/^(Create|Set|Remove)/.test(type) && !ok())
          throw new ObsPreparationWriteBlocked(
            new ObsVideoError('preparation_output_changed', message),
          );
        return obs.call(type, data, onDispatch);
      },
    };
  }

  private async syncCommentaryExistingBinding(
    endpoint: string,
    nextUuid: string,
    expectedPreviousUuid?: string,
  ): Promise<boolean> {
    if (!this.commentary) return true;
    const preference = await this.commentary.owner.get();
    if (preference.preference.mode !== 'existingInput') return true;
    const selected = preference.preference.binding;
    if (expectedPreviousUuid) {
      if (
        selected.endpoint !== endpoint ||
        selected.collection !== OBS_COLLECTION ||
        selected.inputUuid !== expectedPreviousUuid
      )
        return true;
    } else if (
      selected.endpoint === endpoint &&
      selected.collection === OBS_COLLECTION &&
      selected.inputUuid === nextUuid
    ) {
      return true;
    } else {
      const previous = (await this.audioRouting!.collectionTransferState()).bindings
        .remoteCommentary;
      if (
        !previous ||
        selected.collection !== previous.collection ||
        selected.endpoint !== previous.endpoint ||
        selected.inputUuid !== previous.inputUuid
      )
        return false;
    }
    await this.commentary.owner.set(
      {
        mode: 'existingInput',
        binding: { endpoint, collection: OBS_COLLECTION, inputUuid: nextUuid },
      },
      preference.revision,
    );
    return true;
  }

  prepareVideo(valid: () => boolean): Promise<string | null> {
    return this.configurationMutation(() =>
      this.withObs(
        async (obs, endpoint) => {
          if (!valid()) throw new Error('OBS 准备请求已失效，请重试。');
          await requireSupportedObs(obs);
          if (!this.videoTransaction) throw new Error('OBS 视频准备不可用。');
          const lease = await this.captureWarmupGuard();
          await assertNoVideoOutput(obs);
          if (!lease())
            throw new ObsVideoError('preparation_output_changed', 'OBS 输出状态已变化，请重试。');
          const guarded = this.videoGuardedObs(obs, lease, 'OBS 输出状态已变化，请重试。');
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
        { timeoutMs: 12_000, observe: 'video' },
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
            this.videoGuardedObs(
              obs,
              () => valid() && lease(),
              'OBS 输出状态已变化，视频设置待恢复。',
            ),
            endpoint,
            id,
          ),
        { timeoutMs: 12_000, observe: 'video' },
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
      await this.withObs(requireSupportedObs);
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
        const warning: ObsFinding = {
          code: 'audio_prepare_failed',
          message: '场景已准备，音频准备未确认，请在声音设置和 OBS 中核对。',
        };
        this.audio.setWarning('setup', warning);
        return warning;
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
            { timeoutMs: TIMEOUT_MS },
          );
        if (await this.audioRouting?.modePending())
          audioBlocked = {
            code: 'audio_mode_pending',
            message: '音频切换尚未完成，请在声音设置中恢复。',
          };
      } catch (error) {
        audioBlocked = audioFailure(error, 'obs_audio_transfer');
      }
      const visualPreparation = await this.withObs(
        async (connection, endpoint, recovery) => {
          const obs = preparationObs(connection);
          await requireSupportedObs(obs);
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
          const protectedItems: { sceneName: string; sceneItemId: number; sourceUuid: string }[] =
            [];
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
              for (const { scene, items } of await readDesiredSceneItems(
                obs,
                this.browserBaseUrl,
              )) {
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
          const visualProtection = {
            items: protectedItems,
            sourceUuids: [...protectedSourceUuids],
          };
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
        },
        { timeoutMs: 30_000 },
      );
      // Audio owns a separate connection and deadline. Its timeout retires that
      // socket before we settle the warning; it cannot spend the visual budget.
      const prepared = { ...visualPreparation, audioReady: false };
      if (prepared.ready && audioBlocked) prepared.findings.push(audioBlocked);
      if (prepared.ready && !audioBlocked) {
        try {
          const audio = await this.withObs(
            async (connection, endpoint) => {
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
                    const next = bindings.remoteCommentary;
                    if (this.commentary && !next)
                      throw new Error('audio_collection_transfer_commentary_missing');
                    if (
                      next &&
                      !(await this.syncCommentaryExistingBinding(endpoint, next.inputUuid))
                    )
                      throw new Error('audio_collection_transfer_commentary_changed');
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
                  previous.binding &&
                  next.binding &&
                  previous.binding.inputUuid !== next.binding.inputUuid
                )
                  await this.syncCommentaryExistingBinding(
                    endpoint,
                    next.binding.inputUuid,
                    previous.binding.inputUuid,
                  );
                await this.audioRouting.establishDefaultDesktop(audioObs, endpoint);
              }
              const audio = await checkObsAudio(obs);
              audio.push(...(await this.bindingFindings(obs, endpoint)));
              return audio;
            },
            { timeoutMs: 30_000 },
          );
          prepared.findings.push(...audio);
          prepared.audioReady = true;
        } catch (error) {
          prepared.findings.push(audioFailure(error, 'obs_audio_prepare'));
        }
      }
      if (!current()) throw new Error('OBS 准备请求已失效，请重试。');
      this.findings = prepared.findings;
      await this.audio.prepareProgramAudio({
        prepared,
        current,
        checkOutput,
        preparationObs,
        audioFailure,
        prepareMusic,
      });
      this.findings = prepared.findings;
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
        (obs, endpoint) => this.configurationFindings(obs, endpoint, false),
        { timeoutMs: 12_000, observe: 'preparation' },
      );
      findings.push(...audioFindings);
      this.findings = findings;
      this.configurationChanged();
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
      return this.withObs(
        async (connection, endpoint) => {
          if (!current())
            throw new ObsCaptureWarmupError(
              'capture_warmup_changed',
              'OBS 准备请求已失效，请重试。',
            );
          await this.captureWarmup!.recoverCurrentCollection(
            connection,
            endpoint,
            preparationLease,
          );
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
        },
        { timeoutMs: 30_000 },
      );
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
        { timeoutMs: 12_000 },
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
      if (!valid() || this.recoveryClosed) throw new Error('OBS 切场请求已失效。');
      await this.outputs.read();
      const config = await this.configStore.read();
      const endpoint = `ws://${config.host}:${config.port}`;
      try {
        await this.bpOwner.setConnected(
          endpoint,
          config.password,
          this.browserBaseUrl,
          visible,
          () => valid() && !this.recoveryClosed,
          (rpc) => this.configStore.managedResources.bind(rpc, endpoint, this.browserBaseUrl),
          TIMEOUT_MS,
        );
      } catch (error) {
        this.entryPermit = undefined;
        throw error;
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
      await this.withObs(
        async (obs) => {
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
        },
        { timeoutMs: 12_000 },
      );
      this.audio.clearWarning('setup');
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
