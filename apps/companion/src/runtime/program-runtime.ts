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
} from '@mizar/core/runtime';
import type { MatchContext } from '@mizar/core/match-context';
import {
  addSeriesProgressIssue,
  createSeriesProgress,
  isSeriesProgressCheckpointCompatible,
  makeSeriesProgressCheckpoint,
  seriesCheckpointIdentity,
  syncSeriesProgress as reduceSeriesProgress,
  type OperatorCommand,
  type SeriesMapObservation,
  type SeriesProgress,
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
  private seriesProgress: SeriesProgress | undefined;
  private seriesSideProof: SeriesSideProof | null = null;
  private readonly pendingSeriesEvents: SeriesProgressEvent[] = [];
  private restorePending = false;
  private deliveryRestoreAwaitingTelemetry = false;
  private fixtureTelemetrySuppressed = false;

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

  /** Restore identities only before the first observation; never restore telemetry or clocks. */
  restoreDeliveryContinuity(input: {
    readonly liveSessionId: string | null;
    readonly programSourceGeneration: number;
    readonly mapEpoch: number;
    readonly mapName: string | null;
  }): void {
    if (this.state.runtimeSeq !== 0) throw new Error('runtime_already_started');
    this.deliveryRestoreAwaitingTelemetry = true;
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
      let checkpoint;
      if (effectiveOrigin !== 'fixture') {
        try {
          checkpoint = this.seriesProgressCheckpointStore?.load();
        } catch {
          this.reportSeriesDiagnostic('checkpoint_read_failed');
        }
      }
      if (checkpoint !== undefined) {
        if (isSeriesProgressCheckpointCompatible(checkpoint, context)) {
          initial = checkpoint.progress;
          this.restorePending = true;
        } else {
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
        if (effectiveOrigin !== 'fixture') {
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
        const pristine =
          this.seriesProgress.currentMapOrder === null &&
          this.seriesProgress.score.a === 0 &&
          this.seriesProgress.score.b === 0 &&
          this.seriesProgress.maps.every(
            (map) =>
              map.executionMapEpoch === null &&
              map.status === 'pending' &&
              map.finalScore === null &&
              map.roundHistory.rounds.length === 0,
          );
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

    this.seriesSideProof = sideProof;
    const before = this.seriesProgress;
    const events = this.pendingSeriesEvents.splice(0, this.pendingSeriesEvents.length);
    const observation = this.seriesObservation();
    const restoring = this.restorePending && observation.mapName !== null;
    const reduced = reduceSeriesProgress(before, {
      events,
      observation,
      sideProof,
      restore: restoring,
    });
    this.seriesProgress = reduced.progress;
    if (restoring) this.restorePending = false;
    if (reduced.changed && effectiveOrigin !== 'fixture') shouldPersist = true;
    if (shouldPersist && effectiveOrigin !== 'fixture') this.persistSeriesProgress();
    return this.seriesProgress;
  }

  getSeriesProgress(): SeriesProgress | null {
    return this.seriesProgress ?? null;
  }

  async flushSeriesProgressCheckpoint(): Promise<void> {
    if (this.seriesProgressCheckpointStore === undefined) return;
    try {
      await this.seriesProgressCheckpointStore.flush();
    } catch {
      this.reportSeriesDiagnostic('checkpoint_write_failed');
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
    if (reduced.changed && !this.fixtureSeriesProgressActive && this.seriesOrigin !== 'fixture') {
      this.persistSeriesProgress();
    }

    const target = this.seriesProgress.maps.find((map) => map.mapOrder === command.mapOrder);
    const ok =
      target?.status === 'current' &&
      target.executionMapEpoch === this.state.map.epoch &&
      this.seriesProgress.currentMapOrder === command.mapOrder &&
      this.seriesProgress.bindingState === 'bound';
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
    await this.flushSeriesProgressCheckpoint();
  }

  getSourceFreshness(nowMonotonicMs: number): ProgramSourceFreshness {
    return getProgramSourceFreshness(this.state, nowMonotonicMs, this.continuityPolicy);
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
      this.fixtureSeriesProgressActive ||
      this.seriesOrigin === 'fixture'
    ) {
      return;
    }
    try {
      const result = this.seriesProgressCheckpointStore.save(
        makeSeriesProgressCheckpoint(this.seriesProgress),
      );
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
