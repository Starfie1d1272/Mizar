import { randomUUID } from 'node:crypto';
import {
  DEFAULT_OBJECTIVE_CLOCK_LEASE_MS,
  createMapPlayerStatsAccumulator,
  createObjectiveTimingState,
  createInitialRuntimeState,
  getProgramSourceFreshness,
  reduceRuntime,
  type LiveSessionBinding,
  type MapExecutionResetReason,
  type RuntimeContinuityPolicy,
  type RuntimeDisposition,
  type RuntimeReduceResult,
  type ProgramSourceFreshness,
  type RuntimeState,
  type RuntimeTime,
  type RuntimeTransition,
  type TrustedProgramRoundEvents,
} from '@mizar/core/runtime';
import type { MatchContext } from '@mizar/core/match-context';
import {
  addSeriesProgressIssue,
  createSeriesProgress,
  isSeriesProgressCheckpointCompatible,
  makeSeriesProgressCheckpoint,
  refreshSeriesProgressMetadata,
  reconcileSeriesProgressResults,
  seriesCheckpointIdentity,
  syncSeriesProgress as reduceSeriesProgress,
  type OperatorCommand,
  type SeriesMapObservation,
  type SeriesProgress,
  type SeriesProgressCheckpoint,
  type SeriesProgressCheckpointStore,
  type SeriesProgressEvent,
  type SeriesSideProof,
} from '@mizar/core/series-progress';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import type { ContextOrigin } from '../match-context/index.js';

export const PROGRAM_RUNTIME_RECENT_TRANSITIONS_MAX = 32;
export const PRODUCTION_RUNTIME_CONTINUITY_POLICY: RuntimeContinuityPolicy = Object.freeze({
  staleAfterMs: 20_000,
  objectiveClockLeaseMs: DEFAULT_OBJECTIVE_CLOCK_LEASE_MS,
});

function hasSeriesFacts(progress: SeriesProgress): boolean {
  return (
    progress.currentMapOrder !== null ||
    progress.maps.some(
      (map) =>
        map.executionMapEpoch !== null ||
        map.status !== 'pending' ||
        map.finalScore !== null ||
        map.roundHistory.rounds.length > 0,
    )
  );
}

export interface ProgramRuntimeOptions {
  readonly producerInstanceId: string;
  readonly liveSession?: LiveSessionBinding;
  readonly continuityPolicy?: RuntimeContinuityPolicy;
  readonly seriesProgressCheckpointStore?: SeriesProgressCheckpointStore;
  readonly onSeriesProgressDiagnostic?: (diagnostic: { readonly code: string }) => void;
}

export interface ProgramRuntimeSnapshot {
  readonly producerInstanceId: string;
  readonly sourceGeneration: number;
  readonly continuityPolicy: RuntimeContinuityPolicy;
  readonly current: RuntimeState;
  readonly seriesProgress: SeriesProgress | null;
  readonly lastDisposition?: RuntimeDisposition;
  readonly recentTransitions: readonly RuntimeTransition[];
}

export interface SeriesOperatorCommandResult {
  readonly ok: boolean;
  readonly progress: SeriesProgress | null;
  readonly code: 'series_unbound' | 'operator_bind_applied' | 'operator_bind_rejected';
}

/** The sole Companion composition owner for the mutable Core RuntimeState. */
export class ProgramRuntime {
  private readonly continuityPolicy: RuntimeContinuityPolicy;
  private state: RuntimeState;
  private lastDisposition: RuntimeDisposition | undefined;
  private readonly recentTransitions: RuntimeTransition[] = [];
  private readonly seriesProgressCheckpointStore: SeriesProgressCheckpointStore | undefined;
  private readonly onSeriesProgressDiagnostic:
    ((diagnostic: { readonly code: string }) => void) | undefined;
  private seriesContext: MatchContext | undefined;
  private seriesOrigin: ContextOrigin | undefined;
  private fixtureSeriesProgressActive = false;
  private transientSession = false;
  private seriesProgress: SeriesProgress | undefined;
  private seriesSideProof: SeriesSideProof | null = null;
  private readonly pendingSeriesEvents: SeriesProgressEvent[] = [];
  private restorePending = false;
  private deliveryRestoreAwaitingTelemetry = false;
  private fixtureTelemetrySuppressed = false;
  // An execution remains owned even while its context is temporarily absent.
  private executionOwner: { matchId: string; fixture: boolean } | undefined;
  private executionAwaitingObservation = false;
  private executionOwnerUnknown = false;
  private managedSourceId: string | undefined;
  private restoredManagedSourceId: string | undefined;
  private explicitSourceOwner: { sourceId?: string; matchId: string; mapEpoch: number } | undefined;
  private executionConflict = false;
  private unknownNewExecution = false;
  private suspendedProduction:
    { owner: { matchId: string; fixture: boolean } | undefined; unknown: boolean } | undefined;
  private previousBoundaryOwner: { runtimeSeq: number; matchId: string } | undefined;
  private restoredExecutionProof: SeriesProgressCheckpoint['executionOwner'];
  private restoredExecutionMatchId: string | undefined;
  private unverifiedSeriesProgress: SeriesProgress | undefined;

  constructor(options: ProgramRuntimeOptions | string) {
    const normalizedOptions: ProgramRuntimeOptions =
      typeof options === 'string' ? { producerInstanceId: options } : options;
    this.continuityPolicy =
      normalizedOptions.continuityPolicy ?? PRODUCTION_RUNTIME_CONTINUITY_POLICY;
    this.seriesProgressCheckpointStore = normalizedOptions.seriesProgressCheckpointStore;
    this.onSeriesProgressDiagnostic = normalizedOptions.onSeriesProgressDiagnostic;
    this.state = createInitialRuntimeState(
      normalizedOptions.producerInstanceId,
      normalizedOptions.liveSession,
    );
  }

  /** Switch the sole runtime to a fresh isolated session; no telemetry survives. */
  resetSession(transient: boolean): void {
    const previous = this.state;
    const wasTransient = this.transientSession;
    const priorOwner = this.executionOwner;
    const priorConflict = this.executionConflict;
    const priorUnknown = this.executionOwnerUnknown;
    if (transient && !wasTransient)
      this.suspendedProduction = {
        owner: this.executionOwner,
        unknown: this.executionOwnerUnknown,
      };
    const suspended = !transient && wasTransient ? this.suspendedProduction : undefined;
    this.transientSession = transient;
    this.state = {
      ...createInitialRuntimeState(previous.producerInstanceId, {
        kind: 'bound',
        liveSessionId: randomUUID(),
      }),
      runtimeSeq: previous.runtimeSeq + 1,
      programSource: { kind: 'cs2-gsi', generation: previous.programSource.generation + 1 },
      objectiveTiming: createObjectiveTimingState(previous.programSource.generation + 1, 0),
    };
    this.lastDisposition = undefined;
    this.recentTransitions.length = 0;
    this.clearFixtureSeriesProgress();
    this.deliveryRestoreAwaitingTelemetry = false;
    this.restorePending = false;
    this.executionOwner = undefined;
    this.executionAwaitingObservation = false;
    this.executionOwnerUnknown = false;
    this.managedSourceId = undefined;
    this.restoredManagedSourceId = undefined;
    this.explicitSourceOwner = undefined;
    this.executionConflict = false;
    this.unknownNewExecution = false;
    if (!transient && wasTransient) {
      this.executionOwner = suspended?.owner;
      this.executionConflict = Boolean(suspended?.owner);
      this.executionOwnerUnknown = Boolean(
        suspended?.unknown || (!suspended?.owner && previous.programTelemetry),
      );
      this.suspendedProduction = undefined;
    } else if (!transient) {
      this.executionOwner = priorOwner;
      this.executionConflict = priorConflict;
      this.executionOwnerUnknown = priorUnknown;
    }
    this.previousBoundaryOwner = undefined;
    this.restoredExecutionProof = undefined;
    this.restoredExecutionMatchId = undefined;
    this.unverifiedSeriesProgress = undefined;
  }

  /** Restore identities only before the first observation; never restore telemetry or clocks. */
  restoreDeliveryContinuity(input: {
    readonly liveSessionId: string | null;
    readonly programSourceGeneration: number;
    readonly mapEpoch: number;
    readonly mapName: string | null;
    readonly managedSourceId?: string;
  }): void {
    if (this.state.runtimeSeq !== 0) throw new Error('runtime_already_started');
    this.deliveryRestoreAwaitingTelemetry = true;
    this.executionAwaitingObservation = true;
    // Legacy continuity records carry no proof of map-execution ownership.
    this.executionOwnerUnknown = true;
    this.restoredManagedSourceId = input.managedSourceId;
    this.unknownNewExecution = false;
    this.state = {
      ...this.state,
      liveSession:
        input.liveSessionId === null
          ? { kind: 'unbound' }
          : { kind: 'bound', liveSessionId: input.liveSessionId },
      programSource: { kind: 'cs2-gsi', generation: input.programSourceGeneration },
      map: { epoch: input.mapEpoch, ...(input.mapName === null ? {} : { name: input.mapName }) },
      playerStats: createMapPlayerStatsAccumulator(input.mapEpoch),
      objectiveTiming: createObjectiveTimingState(input.programSourceGeneration, input.mapEpoch),
    };
  }

  acceptObservation(observation: TelemetryObservation): RuntimeReduceResult {
    this.fixtureTelemetrySuppressed = false;
    return this.apply({
      kind: 'program-telemetry',
      sourceGeneration: this.state.programSource.generation,
      observation,
    });
  }

  /** Accept only batches already sealed by a source that proves round coverage. */
  acceptTrustedRoundEvents(events: TrustedProgramRoundEvents): RuntimeReduceResult {
    return this.apply({ kind: 'program-round-events', events });
  }

  advanceProgramSourceGeneration(at: RuntimeTime): RuntimeReduceResult {
    return this.apply({
      kind: 'advance-program-source-generation',
      nextGeneration: this.state.programSource.generation + 1,
      at,
    });
  }

  resetMapExecution(reason: MapExecutionResetReason, at: RuntimeTime): RuntimeReduceResult {
    return this.apply({
      kind: 'reset-map-execution',
      reason,
      at,
    });
  }

  getCurrentState(): RuntimeState {
    return this.state;
  }

  getLastDisposition(): RuntimeDisposition | undefined {
    return this.lastDisposition;
  }

  /**
   * Feeds the current MatchContext and already-proven side mapping into the
   * single Companion-owned SeriesProgress state. The identity/lineup owners
   * remain outside this class; they provide evidence only.
   */
  synchronizeSeriesProgress(
    context: MatchContext | undefined,
    sideProof: SeriesSideProof | null,
    origin?: ContextOrigin,
  ): SeriesProgress | null {
    const effectiveOrigin =
      origin ?? (this.fixtureSeriesProgressActive ? 'fixture' : this.seriesOrigin);

    if (context === undefined) {
      if (this.fixtureSeriesProgressActive || this.seriesOrigin === 'fixture') {
        this.fixtureTelemetrySuppressed = false;
      }
      this.fixtureSeriesProgressActive = false;
      this.seriesOrigin = undefined;
      this.seriesContext = undefined;
      this.seriesProgress = undefined;
      this.seriesSideProof = null;
      this.pendingSeriesEvents.length = 0;
      this.restorePending = false;
      return null;
    }

    const matchChanged =
      this.seriesContext !== undefined &&
      (this.seriesContext.matchId !== context.matchId || this.seriesOrigin !== effectiveOrigin);
    if (
      this.executionOwner &&
      (this.executionOwner.matchId !== context.matchId ||
        this.executionOwner.fixture !== (effectiveOrigin === 'fixture'))
    )
      this.executionConflict = true;
    if (matchChanged) {
      this.pendingSeriesEvents.length = 0;
      if (
        (this.fixtureSeriesProgressActive || this.seriesOrigin === 'fixture') &&
        effectiveOrigin !== 'fixture'
      ) {
        this.fixtureTelemetrySuppressed = false;
        this.fixtureSeriesProgressActive = false;
      }
    }

    this.seriesContext = context;
    this.seriesOrigin = effectiveOrigin;
    if (effectiveOrigin === 'fixture') {
      this.fixtureSeriesProgressActive = true;
    }

    let shouldPersist = false;
    if (this.seriesProgress === undefined || matchChanged) {
      let initial = createSeriesProgress(context);
      this.unverifiedSeriesProgress = undefined;
      this.restoredExecutionProof = undefined;
      this.restoredExecutionMatchId = undefined;
      let checkpoint;
      if (!this.transientSession && effectiveOrigin !== 'fixture') {
        try {
          checkpoint = this.seriesProgressCheckpointStore?.load();
        } catch {
          this.reportSeriesDiagnostic('checkpoint_read_failed');
        }
      }
      if (checkpoint !== undefined) {
        if (isSeriesProgressCheckpointCompatible(checkpoint, context)) {
          if (checkpoint.executionOwner) {
            initial = checkpoint.progress;
            this.restorePending = true;
            this.unverifiedSeriesProgress = checkpoint.unverifiedProgress;
            if (!this.executionOwner) this.executionOwnerUnknown = true;
          } else {
            const unverified = checkpoint.unverifiedProgress ?? checkpoint.progress;
            this.unverifiedSeriesProgress = hasSeriesFacts(unverified) ? unverified : undefined;
            this.restorePending = false;
            if (hasSeriesFacts(checkpoint.progress)) {
              this.executionOwnerUnknown = true;
              this.unknownNewExecution = false;
            }
          }
          this.restoredExecutionProof = checkpoint.executionOwner;
          this.restoredExecutionMatchId = checkpoint.identity.matchId;
        } else {
          if (checkpoint.executionOwner || hasSeriesFacts(checkpoint.progress)) {
            this.executionOwnerUnknown = true;
            this.unknownNewExecution = false;
          }
          initial = addSeriesProgressIssue(initial, {
            code: 'checkpoint_incompatible',
            severity: 'warning',
            message:
              'Series Progress checkpoint 与当前 match identity 或 map plan 不兼容，已忽略。',
            mapOrder: null,
            mapEpoch: this.state.map.epoch,
          });
          shouldPersist = true;
          this.restorePending = false;
        }
      } else {
        if (!this.transientSession && effectiveOrigin !== 'fixture') {
          shouldPersist = true;
        }
        this.restorePending = false;
      }
      this.seriesProgress = initial;
    } else {
      const currentIdentity = makeSeriesProgressCheckpoint(this.seriesProgress).identity;
      const contextIdentity = seriesCheckpointIdentity(context);
      if (
        currentIdentity.matchId !== contextIdentity.matchId ||
        currentIdentity.format !== contextIdentity.format ||
        currentIdentity.entryAId !== contextIdentity.entryAId ||
        currentIdentity.entryBId !== contextIdentity.entryBId ||
        currentIdentity.mapPlanFingerprint !== contextIdentity.mapPlanFingerprint
      ) {
        const pristine = this.canUpdateSeriesPlan();
        if (pristine) {
          this.seriesProgress = createSeriesProgress(context);
        } else
          this.seriesProgress = addSeriesProgressIssue(this.seriesProgress, {
            code: 'context_result_conflict',
            severity: 'warning',
            message: 'MatchContext 刷新与本地已冻结 SeriesProgress 冲突，保留本地事实。',
            mapOrder: null,
            mapEpoch: this.state.map.epoch,
          });
        shouldPersist = true;
      }
    }

    const refreshed = refreshSeriesProgressMetadata(this.seriesProgress, context);
    if (refreshed !== this.seriesProgress) {
      this.seriesProgress = refreshed;
      shouldPersist = true;
    }
    if (effectiveOrigin === 'online' || effectiveOrigin === 'cache') {
      const reconciled = reconcileSeriesProgressResults(this.seriesProgress, context);
      if (reconciled !== this.seriesProgress) {
        this.seriesProgress = reconciled;
        shouldPersist = true;
      }
    }
    this.seriesSideProof = sideProof;
    const proof = this.restoredExecutionProof;
    if (
      this.executionOwnerUnknown &&
      !this.executionConflict &&
      !this.executionAwaitingObservation &&
      proof &&
      this.restoredExecutionMatchId === context.matchId &&
      effectiveOrigin !== 'fixture' &&
      this.state.liveSession.kind === 'bound' &&
      proof.liveSessionId === this.state.liveSession.liveSessionId &&
      proof.programSourceGeneration === this.state.programSource.generation &&
      proof.mapEpoch === this.state.map.epoch &&
      proof.mapName === this.state.map.name &&
      proof.mapName === this.state.programTelemetry?.telemetry.map?.name &&
      proof.managedSourceId !== undefined &&
      proof.managedSourceId === this.managedSourceId
    ) {
      this.executionOwner = { matchId: context.matchId, fixture: false };
      this.executionOwnerUnknown = false;
      this.executionConflict = false;
    }
    if (
      this.executionAwaitingObservation ||
      this.executionOwnerUnknown ||
      this.fixtureTelemetrySuppressed
    ) {
      if (shouldPersist && !this.transientSession && effectiveOrigin !== 'fixture')
        this.persistSeriesProgress();
      return this.seriesProgress;
    }
    const executionMatches =
      !this.executionConflict &&
      this.executionOwner?.matchId === context.matchId &&
      this.executionOwner.fixture === (effectiveOrigin === 'fixture');
    if (!this.executionOwner && this.state.programTelemetry?.telemetry.map?.name) {
      this.executionOwner = { matchId: context.matchId, fixture: effectiveOrigin === 'fixture' };
      shouldPersist = true;
    } else if (!executionMatches) {
      this.pendingSeriesEvents.length = 0;
      if (shouldPersist && !this.transientSession && effectiveOrigin !== 'fixture')
        this.persistSeriesProgress();
      return this.seriesProgress;
    }
    const before = this.seriesProgress;
    const events = this.pendingSeriesEvents.splice(0, this.pendingSeriesEvents.length);
    const observation = this.seriesObservation();
    const restoring = this.restorePending && observation.mapName !== null;
    const reduced = reduceSeriesProgress(before, {
      allowMapCreation: context.status !== 'finished' && context.status !== 'cancelled',
      events,
      observation,
      sideProof,
      restore: restoring,
    });
    this.seriesProgress = reduced.progress;
    if (restoring) this.restorePending = false;
    if (reduced.changed && !this.transientSession && effectiveOrigin !== 'fixture')
      shouldPersist = true;
    if (shouldPersist && !this.transientSession && effectiveOrigin !== 'fixture')
      this.persistSeriesProgress();
    return this.seriesProgress;
  }

  canUpdateSeriesPlan(): boolean {
    if (!this.seriesProgress) return true;
    return (
      this.seriesProgress.currentMapOrder === null &&
      this.seriesProgress.score.a === 0 &&
      this.seriesProgress.score.b === 0 &&
      this.seriesProgress.maps.every(
        (map) =>
          map.executionMapEpoch === null &&
          map.status === 'pending' &&
          map.finalScore === null &&
          map.roundHistory.rounds.length === 0,
      )
    );
  }

  getSeriesProgress(): SeriesProgress | null {
    return this.seriesProgress ?? null;
  }

  async flushSeriesProgressCheckpoint(strict = false): Promise<void> {
    if (this.seriesProgressCheckpointStore === undefined) return;
    try {
      await this.seriesProgressCheckpointStore.flush();
    } catch (error) {
      this.reportSeriesDiagnostic('checkpoint_write_failed');
      if (strict) throw error;
    }
  }

  executeOperatorCommand(command: OperatorCommand): SeriesOperatorCommandResult {
    this.synchronizeSeriesProgress(this.seriesContext, this.seriesSideProof, this.seriesOrigin);
    if (this.seriesContext === undefined || this.seriesProgress === undefined) {
      return { ok: false, progress: null, code: 'series_unbound' };
    }

    if (command.reason.trim().length === 0) {
      return {
        ok: false,
        progress: this.seriesProgress,
        code: 'operator_bind_rejected',
      };
    }

    if (
      this.executionAwaitingObservation ||
      (this.executionOwnerUnknown && !this.unknownNewExecution) ||
      (!this.executionOwnerUnknown &&
        (this.executionOwner?.matchId !== this.seriesContext.matchId ||
          this.executionOwner.fixture !== (this.seriesOrigin === 'fixture')))
    ) {
      return { ok: false, progress: this.seriesProgress, code: 'operator_bind_rejected' };
    }

    const event: SeriesProgressEvent = {
      kind: 'operator-map-bind',
      sourceGeneration: this.state.programSource.generation,
      mapEpoch: this.state.map.epoch,
      mapOrder: command.mapOrder,
      mapName: this.state.map.name ?? this.state.programTelemetry?.telemetry.map?.name ?? null,
      reason: command.reason,
    };
    const reduced = reduceSeriesProgress(this.seriesProgress, {
      events: [event],
      observation: this.seriesObservation(),
      sideProof: this.seriesSideProof,
    });
    this.seriesProgress = reduced.progress;
    const target = this.seriesProgress.maps.find((map) => map.mapOrder === command.mapOrder);
    const ok =
      target?.status === 'current' &&
      target.executionMapEpoch === this.state.map.epoch &&
      this.seriesProgress.currentMapOrder === command.mapOrder &&
      this.seriesProgress.bindingState === 'bound';
    if (ok && this.executionOwnerUnknown && this.unknownNewExecution) {
      this.executionOwner = {
        matchId: this.seriesContext.matchId,
        fixture: this.seriesOrigin === 'fixture',
      };
      this.executionOwnerUnknown = false;
      this.unknownNewExecution = false;
      this.executionConflict = false;
      this.pendingSeriesEvents.length = 0;
      this.explicitSourceOwner = {
        ...(this.managedSourceId ? { sourceId: this.managedSourceId } : {}),
        matchId: this.seriesContext.matchId,
        mapEpoch: this.state.map.epoch,
      };
    }
    if (reduced.changed && !this.fixtureSeriesProgressActive && this.seriesOrigin !== 'fixture') {
      this.persistSeriesProgress();
    }
    return {
      ok,
      progress: this.seriesProgress,
      code: ok ? 'operator_bind_applied' : 'operator_bind_rejected',
    };
  }

  /**
   * Dedicated fixture-only Series driver for development / qualification sample playback (e.g. RivalsRehearsal).
   * Explicitly sets the SeriesProgress for the current fixture stage from stage MatchContext.
   * Also enters a "telemetry suppressed" state until the next stage observation is received,
   * preventing previous stage's sample observation (e.g. Ancient) from polluting result or intermap stages.
   *
   * Fixture-only series progress never reads or writes production checkpoint stores.
   */
  activateFixtureSeriesProgress(context: MatchContext): SeriesProgress {
    this.seriesContext = context;
    this.seriesOrigin = 'fixture';
    this.fixtureSeriesProgressActive = true;
    this.seriesProgress = createSeriesProgress(context);
    this.fixtureTelemetrySuppressed = true;
    this.pendingSeriesEvents.length = 0;
    // Preserve fixture ownership even if the fixture exits before another frame.
    this.executionOwner = { matchId: context.matchId, fixture: true };
    this.executionConflict = false;
    this.executionAwaitingObservation = true;
    this.executionOwnerUnknown = false;
    return this.seriesProgress;
  }

  /**
   * Resets any fixture-only Series driver state when leaving rehearsal/fixture mode.
   */
  clearFixtureSeriesProgress(): void {
    this.fixtureSeriesProgressActive = false;
    this.seriesOrigin = undefined;
    this.fixtureTelemetrySuppressed = false;
    this.seriesProgress = undefined;
    this.seriesContext = undefined;
    this.seriesSideProof = null;
    this.pendingSeriesEvents.length = 0;
  }

  async close(): Promise<void> {
    await this.flushSeriesProgressCheckpoint(true);
  }

  getSourceFreshness(nowMonotonicMs: number): ProgramSourceFreshness {
    return getProgramSourceFreshness(this.state, nowMonotonicMs, this.continuityPolicy);
  }

  isExecutionOwnedBy(matchId: string, origin: ContextOrigin | undefined): boolean {
    return (
      !this.executionAwaitingObservation &&
      !this.executionOwnerUnknown &&
      !this.executionConflict &&
      !this.fixtureTelemetrySuppressed &&
      this.executionOwner?.matchId === matchId &&
      this.executionOwner.fixture === (origin === 'fixture')
    );
  }

  getManagedSourceId(): string | undefined {
    return this.managedSourceId;
  }

  getExecutionOwnerMatchId(runtimeSeq: number): string | undefined {
    if (this.executionOwner && !this.executionOwner.fixture) return this.executionOwner.matchId;
    return this.previousBoundaryOwner?.runtimeSeq === runtimeSeq
      ? this.previousBoundaryOwner.matchId
      : undefined;
  }

  /** Called only for the first frame of a committed Host-verified managed source. */
  activateManagedSource(
    matchId: string,
    sourceId: string,
    observation: TelemetryObservation,
  ): { boundary?: RuntimeReduceResult } | undefined {
    const preview = reduceRuntime(
      this.state,
      {
        kind: 'program-telemetry',
        sourceGeneration: this.state.programSource.generation,
        observation,
      },
      this.continuityPolicy,
    );
    if (preview.disposition.kind !== 'accepted') return undefined;
    this.pendingSeriesEvents.length = 0;
    const boundary =
      this.state.map.epoch > 0 &&
      this.state.map.name === observation.telemetry.map?.name &&
      !preview.transitions.some((transition) => transition.kind === 'map_execution_changed')
        ? this.resetMapExecution('restore', {
            utc: observation.receive.receivedAt,
            monotonicMs: observation.receive.receivedMonotonicMs,
          })
        : undefined;
    this.executionOwner = { matchId, fixture: false };
    this.executionConflict = false;
    this.executionOwnerUnknown = false;
    this.unknownNewExecution = false;
    this.executionAwaitingObservation = true;
    this.managedSourceId = sourceId;
    return boundary ? { boundary } : {};
  }

  markSourceUnverified(): void {
    if (this.executionOwner) this.executionConflict = true;
    else this.executionOwnerUnknown = true;
  }

  retireManagedSource(): void {
    this.markSourceUnverified();
    this.managedSourceId = undefined;
    this.explicitSourceOwner = undefined;
  }

  isExplicitSourceOwner(sourceId: string, matchId: string): boolean {
    return (
      this.explicitSourceOwner?.sourceId === sourceId &&
      this.explicitSourceOwner.matchId === matchId &&
      this.explicitSourceOwner.mapEpoch === this.state.map.epoch
    );
  }

  markUnverifiedNewExecution(): void {
    this.executionOwner = undefined;
    this.executionOwnerUnknown = true;
    this.executionConflict = true;
    this.unknownNewExecution = true;
  }

  resumeManagedSource(sourceId: string, matchId: string): boolean {
    const proof = this.restoredExecutionProof;
    if (
      !this.executionOwnerUnknown ||
      this.executionConflict ||
      this.restoredExecutionMatchId !== matchId ||
      !proof ||
      proof.managedSourceId !== sourceId ||
      this.restoredManagedSourceId !== sourceId ||
      this.state.liveSession.kind !== 'bound' ||
      proof.liveSessionId !== this.state.liveSession.liveSessionId ||
      proof.programSourceGeneration !== this.state.programSource.generation ||
      proof.mapEpoch !== this.state.map.epoch ||
      proof.mapName !== this.state.map.name
    )
      return false;
    this.managedSourceId = sourceId;
    return true;
  }

  getSnapshot(): ProgramRuntimeSnapshot {
    return {
      producerInstanceId: this.state.producerInstanceId,
      sourceGeneration: this.state.programSource.generation,
      continuityPolicy: this.continuityPolicy,
      current: this.state,
      seriesProgress: this.seriesProgress ?? null,
      ...(this.lastDisposition === undefined ? {} : { lastDisposition: this.lastDisposition }),
      recentTransitions: this.recentTransitions.slice(),
    };
  }

  private apply(input: Parameters<typeof reduceRuntime>[1]): RuntimeReduceResult {
    const result = reduceRuntime(this.state, input, this.continuityPolicy);
    this.state = result.state;
    if (result.transitions.some((transition) => transition.kind === 'map_execution_changed')) {
      if (this.explicitSourceOwner) this.executionConflict = true;
      this.explicitSourceOwner = undefined;
      this.previousBoundaryOwner =
        this.executionOwner && !this.executionOwner.fixture
          ? { runtimeSeq: result.state.runtimeSeq, matchId: this.executionOwner.matchId }
          : undefined;
      if (this.executionConflict || this.executionOwnerUnknown) {
        this.executionOwner = undefined;
        this.executionOwnerUnknown = true;
        this.unknownNewExecution = true;
      }
      this.executionAwaitingObservation = input.kind !== 'program-telemetry';
    }
    if (
      input.kind === 'program-telemetry' &&
      result.disposition.kind === 'accepted' &&
      input.observation.telemetry.map?.name
    )
      this.executionAwaitingObservation = false;
    if (input.kind === 'program-telemetry' && result.disposition.kind === 'accepted')
      this.deliveryRestoreAwaitingTelemetry = false;
    this.lastDisposition = result.disposition;
    this.queueSeriesEvents(result.transitions);
    if (result.transitions.length > 0) {
      this.recentTransitions.push(...result.transitions);
      const overflow = this.recentTransitions.length - PROGRAM_RUNTIME_RECENT_TRANSITIONS_MAX;
      if (overflow > 0) this.recentTransitions.splice(0, overflow);
    }
    return result;
  }

  private queueSeriesEvents(transitions: readonly RuntimeTransition[]): void {
    for (const transition of transitions) {
      const sourceGeneration =
        'sourceGeneration' in transition
          ? transition.sourceGeneration
          : this.state.programSource.generation;
      let event: SeriesProgressEvent | undefined;
      switch (transition.kind) {
        case 'round_started':
          break;
        case 'round_ended':
          event = {
            kind: 'round-ended',
            sourceGeneration,
            mapEpoch: transition.mapEpoch,
            roundNumber: transition.roundNumber ?? null,
            winnerSide: transition.winnerSide ?? 'unknown',
            winCondition: 'unknown',
          };
          break;
        case 'map_ended':
          event = {
            kind: 'map-ended',
            sourceGeneration,
            mapEpoch: transition.mapEpoch,
            finalScore: {
              ct: this.state.programTelemetry?.telemetry.map?.sides?.ct?.score ?? null,
              t: this.state.programTelemetry?.telemetry.map?.sides?.t?.score ?? null,
            },
          };
          break;
        case 'map_execution_changed':
          event = {
            kind: 'map-execution-changed',
            sourceGeneration,
            mapEpoch: transition.mapEpoch,
            previousMapEpoch: transition.previousMapEpoch,
            previousMapName: transition.previousMapName ?? null,
            mapName: transition.mapName ?? null,
            resetReason:
              transition.reason === 'explicit-reset'
                ? transition.resetReason
                : transition.reason === 'observed-same-map-restart'
                  ? 'same-map-restart'
                  : null,
          };
          break;
      }
      if (event !== undefined) this.pendingSeriesEvents.push(event);
    }
    const overflow = this.pendingSeriesEvents.length - 64;
    if (overflow > 0) this.pendingSeriesEvents.splice(0, overflow);
  }

  private seriesObservation(): SeriesMapObservation {
    if (this.fixtureTelemetrySuppressed) {
      return {
        sourceGeneration: this.state.programSource.generation,
        mapEpoch: this.state.map.epoch,
        mapName: null,
        mapEnded: false,
        roundNumber: null,
        score: { ct: null, t: null },
        roundWins: [],
      };
    }
    const map = this.state.programTelemetry?.telemetry.map;
    return {
      sourceGeneration: this.state.programSource.generation,
      mapEpoch: this.state.map.epoch,
      mapName: this.deliveryRestoreAwaitingTelemetry
        ? null
        : (map?.name ?? this.state.map.name ?? null),
      mapEnded: map?.phase === 'gameover',
      roundNumber: map?.roundNumber ?? null,
      score: {
        ct: map?.sides?.ct?.score ?? null,
        t: map?.sides?.t?.score ?? null,
      },
      roundWins: map?.roundWins ?? [],
    };
  }

  private persistSeriesProgress(): void {
    if (
      this.seriesProgress === undefined ||
      this.seriesProgressCheckpointStore === undefined ||
      this.transientSession ||
      this.fixtureSeriesProgressActive ||
      this.seriesOrigin === 'fixture'
    ) {
      return;
    }
    try {
      const executionOwner =
        this.executionOwner?.matchId === this.seriesProgress.matchId &&
        !this.executionOwner.fixture &&
        !this.executionOwnerUnknown &&
        !this.executionConflict &&
        !this.executionAwaitingObservation &&
        this.state.liveSession.kind === 'bound' &&
        this.state.map.epoch > 0 &&
        this.state.map.name
          ? {
              liveSessionId: this.state.liveSession.liveSessionId,
              programSourceGeneration: this.state.programSource.generation,
              mapEpoch: this.state.map.epoch,
              mapName: this.state.map.name,
              ...(this.managedSourceId ? { managedSourceId: this.managedSourceId } : {}),
            }
          : !this.executionConflict &&
              !this.unknownNewExecution &&
              (this.executionOwnerUnknown ||
                (this.state.runtimeSeq === 0 && !this.state.programTelemetry)) &&
              this.restoredExecutionMatchId === this.seriesProgress.matchId
            ? this.restoredExecutionProof
            : undefined;
      const result = this.seriesProgressCheckpointStore.save({
        ...makeSeriesProgressCheckpoint(this.seriesProgress),
        ...(executionOwner ? { executionOwner } : {}),
        ...(this.unverifiedSeriesProgress
          ? { unverifiedProgress: this.unverifiedSeriesProgress }
          : {}),
      });
      if (result instanceof Promise) {
        void result.catch(() => this.reportSeriesDiagnostic('checkpoint_write_failed'));
      }
    } catch {
      this.reportSeriesDiagnostic('checkpoint_write_failed');
    }
  }

  private reportSeriesDiagnostic(code: string): void {
    try {
      this.onSeriesProgressDiagnostic?.({ code });
    } catch {
      // Series diagnostics must not interrupt the Runtime mutation path.
    }
  }
}

export function createProgramRuntime(
  producerInstanceId: string,
  options: Omit<ProgramRuntimeOptions, 'producerInstanceId'> = {},
): ProgramRuntime {
  return new ProgramRuntime({ producerInstanceId, ...options });
}
