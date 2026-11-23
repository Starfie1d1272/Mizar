import type { ProjectionCursor } from './cursor.js';
import type { ProgramSafeRuntimeView } from './program-safe-runtime.js';
import type { ProgramProjection, ProgramPlayerProjection } from './program.js';
import type { PlayerDeathGameEvent, GameEventObservation } from '../game-events/index.js';

export interface ObserverHint {
  readonly id: string;
  readonly remainingSeconds: number;
  readonly attacker: { readonly name: string; readonly observerSlot: number | null };
  readonly victim: { readonly name: string; readonly observerSlot: number | null };
}
export interface ObserverHintSettings {
  readonly enabled: boolean;
  readonly leadSeconds: number;
  readonly delaySeconds: number;
}

/** Operator-only hints share the Program cursor while retaining their own payload. */
export interface ObserverAssistProjection {
  readonly cursor: ProjectionCursor;
  readonly availability: 'unavailable' | 'available';
  readonly observer?: ObserverHintSettings & {
    readonly state: 'connecting' | 'ready' | 'paused' | 'unavailable';
    readonly waitingReason: string | null;
    readonly nextWindowSeconds: number | null;
    readonly hints: readonly ObserverHint[];
  };
}

export type ObserverProgramView = Pick<ProgramProjection, 'cursor' | 'status'> & {
  readonly match: { readonly matchId: string } | null;
  readonly map: Pick<ProgramProjection['map'], 'name' | 'roundNumber'> & {
    readonly phase?: ProgramProjection['map']['phase'];
  };
  readonly clock: Pick<NonNullable<ProgramProjection['clock']>, 'phase'> | null;
  readonly coverage: Pick<ProgramProjection['coverage'], 'allPlayers'>;
  readonly players: readonly Pick<
    ProgramPlayerProjection,
    'sourcePlayerId' | 'lineupEvidence' | 'lifeState' | 'displayName' | 'observerSlot'
  >[];
};
interface BufferedKill {
  id: string;
  event: PlayerDeathGameEvent;
  sourceMs: number;
  retired: boolean;
  enteredWindow: boolean;
  published: boolean;
  shownDueMs: number | null;
}
/** A next-map kill held outside the single scheduling buffer until Program confirms its execution. */
interface StagedKill {
  event: PlayerDeathGameEvent;
  sourceMs: number;
  observedMonotonicMs: number;
}
interface StagedExecution {
  match: string;
  session: string | null;
  generation: number;
  mapName: string;
  execution: number;
  lastSequence: number;
  kills: StagedKill[];
}
const STAGED_CAPACITY = 512;
const STAGED_MAX_AGE_MS = 15 * 60_000;

function isExecutionCompatible(
  previous: number | undefined,
  next: number | undefined,
  allowResetZero = false,
): boolean {
  return (
    previous === undefined ||
    next === undefined ||
    next === previous ||
    (allowResetZero && next === 0)
  );
}

function isPendingMapConflict(
  pending: { execution: number | undefined; generation: number; conflicted: boolean },
  generation: number,
  execution: number | undefined,
): boolean {
  return (
    pending.conflicted ||
    pending.generation !== generation ||
    (pending.execution !== undefined && execution !== undefined && pending.execution !== execution)
  );
}

export class ObserverHintTimeline {
  private kills: BufferedKill[] = [];
  private staged: StagedExecution | null = null;
  private stagedReleased = 0;
  private pendingMap: {
    name: string;
    since: number;
    execution: number | undefined;
    generation: number;
    conflicted: boolean;
  } | null = null;
  private context = '';
  private lastReadyScope: string | undefined;
  private awaitingNextMap = false;
  private sealedSource:
    | {
        health: ObserverHintTimeline['sourceHealth'];
        execution: number | undefined;
      }
    | undefined;
  private contextIdentity: { match: string; session: string | null; map: string } | null = null;
  private generation: number | undefined;
  private lastDeathSequence = -1;
  private lastAcceptedRound: number | undefined;
  private sourceExecution: number | undefined;
  private sourceExecutionGeneration: number | undefined;
  private sourceExecutionFence: {
    sawNonLive: boolean;
    maxRound: number | null;
  } | null = null;
  private earliest = -Infinity;
  private lastNow = 0;
  private programSource = { generation: 0, mapEpoch: 0, receiveSequence: null as number | null };
  private configuration: ObserverHintSettings | null = null;
  private blocked: string | null = 'disabled';
  private lastReset = { reason: 'initial', atMonotonicMs: 0 };
  private eventCounts: Record<string, number> = {};
  private recentEventKinds: GameEventObservation['kind'][] = [];
  private discarded: Record<string, number> = {};
  private acceptedDeaths = 0;
  private enteredWindow = 0;
  private generatedHints = 0;
  private publishedHints = 0;
  private compensatedDeaths = 0;
  private ended: Record<string, number> = {};
  private expiredBeforeWindow = 0;
  private endedAfterGeneration: Record<string, number> = {};
  private lastReceivedMs: number | null = null;
  private nextDueMs: number | null = null;
  private nextWindowMs: number | null = null;
  private sourceHealth: {
    connected: boolean;
    generation: number;
    fresh: boolean;
    freshness?: 'fresh' | 'stale' | 'unknown';
    lastReceiveMonotonicMs?: number | null;
    receiveAgeMs?: number | null;
    sameMap?: boolean;
    normalDrain?: boolean;
    mapName?: string;
    state?: string;
    lastErrorCode?: string;
  } = { connected: false, generation: 0, fresh: false };

  getDiagnostics() {
    return {
      source: { ...this.sourceHealth },
      programSource: { ...this.programSource },
      configuration: this.configuration === null ? null : { ...this.configuration },
      lastEventReceivedMonotonicMs: this.lastReceivedMs,
      eventCounts: { ...this.eventCounts },
      acceptedDeaths: this.acceptedDeaths,
      enteredWindow: this.enteredWindow,
      generatedHints: this.generatedHints,
      publishedHints: this.publishedHints,
      timingBasis: {
        localResidence: this.compensatedDeaths,
        receipt: this.acceptedDeaths - this.compensatedDeaths,
      },
      ended: { ...this.ended },
      expiredBeforeWindow: this.expiredBeforeWindow,
      endedAfterGeneration: { ...this.endedAfterGeneration },
      discarded: { ...this.discarded },
      staged: this.staged?.kills.length ?? 0,
      stagedReleased: this.stagedReleased,
      buffered: this.kills.length,
      pending: this.kills.filter((k) => !k.retired).length,
      nextDueMonotonicMs: this.nextDueMs,
      nextWindowInMs:
        this.nextWindowMs === null ? null : Math.max(0, this.nextWindowMs - this.lastNow),
      lastReset: { ...this.lastReset },
      blocked: this.blocked,
    };
  }
  recordPublished(hints: readonly ObserverHint[]) {
    for (const hint of hints) {
      const kill = this.kills.find(({ id }) => id === hint.id);
      if (!kill || kill.published) continue;
      kill.published = true;
      this.publishedHints++;
    }
  }
  private discard(reason: string) {
    this.discarded[reason] = (this.discarded[reason] ?? 0) + 1;
  }
  private finish(kill: BufferedKill, reason: string) {
    this.discard(reason);
    this.ended[reason] = (this.ended[reason] ?? 0) + 1;
    if (reason === 'expired' && !kill.enteredWindow) this.expiredBeforeWindow++;
    if (kill.shownDueMs !== null)
      this.endedAfterGeneration[reason] = (this.endedAfterGeneration[reason] ?? 0) + 1;
    kill.retired = true;
  }
  private replaceBuffered(reason: string, retained: BufferedKill[] = []) {
    const keep = retained.length ? new Set(retained) : undefined;
    for (const kill of this.kills) {
      if (!kill.retired && !keep?.has(kill)) this.finish(kill, reason);
    }
    this.kills = retained;
  }

  private reset(reason: string, now: number, retained?: BufferedKill[]) {
    if (this.lastReset.reason !== reason || this.kills.length)
      this.lastReset = { reason, atMonotonicMs: now };
    this.earliest = now;
    this.replaceBuffered(reason, retained);
    this.lastReadyScope = undefined;
    this.sealedSource = undefined;
    this.lastAcceptedRound = undefined;
    this.sourceExecution = undefined;
    this.sourceExecutionGeneration = undefined;
    this.sourceExecutionFence = null;
    this.nextDueMs = null;
    this.nextWindowMs = null;
  }

  resetForMap(now: number) {
    this.reset('map-connection', now);
  }
  consume(event: GameEventObservation) {
    if (event.cursor.role !== 'lookahead') return;
    if (this.awaitingNextMap && this.stage(event)) return;
    this.countReceived(event);
    if (this.generation !== undefined && event.cursor.generation < this.generation) {
      this.discard('old-generation');
      return;
    }
    if (this.generation !== event.cursor.generation) {
      const continuous =
        this.canRetainAcrossGeneration() &&
        isExecutionCompatible(this.sourceExecution, event.cursor.sourceMapExecution, true) &&
        event.cursor.mapName === this.contextIdentity?.map &&
        (this.lastAcceptedRound === undefined ||
          event.cursor.roundsCompleted === undefined ||
          event.cursor.roundsCompleted >= this.lastAcceptedRound);
      this.advanceGeneration(event.cursor.generation, continuous);
    }
    if (event.kind !== 'player-death') return;
    if (!event.attacker?.sourcePlayerId || !event.victim.sourcePlayerId) {
      this.discard('missing-identity');
      return;
    }
    if (!event.cursor.ticksPerSecond || event.cursor.observedMonotonicMs < this.earliest) {
      this.discard('invalid-or-before-boundary');
      return;
    }
    if (event.cursor.sequence <= this.lastDeathSequence) {
      this.discard('duplicate');
      return;
    }
    if (
      this.lastAcceptedRound !== undefined &&
      event.cursor.roundsCompleted !== undefined &&
      event.cursor.roundsCompleted < this.lastAcceptedRound
    ) {
      // A round regression proves the match restarted (e.g. during a disconnect).
      this.replaceBuffered('source-execution');
      this.lastAcceptedRound = undefined;
      this.sourceExecutionFence ??= { sawNonLive: false, maxRound: null };
    }
    if (event.cursor.roundsCompleted !== undefined) {
      this.lastAcceptedRound =
        this.lastAcceptedRound === undefined
          ? event.cursor.roundsCompleted
          : Math.max(this.lastAcceptedRound, event.cursor.roundsCompleted);
    }
    this.lastDeathSequence = event.cursor.sequence;
    this.acceptedDeaths++;
    if (event.cursor.sourceArrivalMonotonicMs !== undefined) this.compensatedDeaths++;
    this.kills.push({
      id: `${event.cursor.generation}:${event.cursor.sequence}`,
      event,
      sourceMs: event.cursor.sourceArrivalMonotonicMs ?? event.cursor.observedMonotonicMs,
      retired: false,
      enteredWindow: false,
      published: false,
      shownDueMs: null,
    });
    if (this.kills.length > 4096) {
      const oldest = this.kills.shift()!;
      if (!oldest.retired) this.finish(oldest, 'capacity');
    }
  }
  private canRetainAcrossGeneration(): boolean {
    return (
      !this.awaitingNextMap &&
      !this.sealedSource &&
      this.contextIdentity !== null &&
      this.sourceExecutionFence === null &&
      this.kills.some((kill) => !kill.retired)
    );
  }
  private advanceGeneration(generation: number, retain = false) {
    this.generation = generation;
    this.lastDeathSequence = -1;
    if (!retain) this.replaceBuffered('source-generation');
  }

  private countReceived(event: GameEventObservation) {
    this.lastReceivedMs = event.cursor.observedMonotonicMs;
    this.eventCounts[event.kind] = (this.eventCounts[event.kind] ?? 0) + 1;
    this.recentEventKinds.push(event.kind);
    if (this.recentEventKinds.length > 64) {
      const oldest = this.recentEventKinds.shift()!;
      this.eventCounts[oldest]!--;
      if (this.eventCounts[oldest] === 0) delete this.eventCounts[oldest];
    }
  }

  /**
   * Hold an event that can only belong to the execution Program has not confirmed yet.
   * Returning false leaves the verified tail of the current map on the normal path.
   */
  private stage(event: GameEventObservation): boolean {
    const context = this.contextIdentity;
    if (!context) {
      this.discard('staged-context-missing');
      return true;
    }
    if (event.cursor.mapName === context.map && event.cursor.generation === this.generation)
      return false;
    this.countReceived(event);
    if (event.kind !== 'player-death') return true;
    const execution = event.cursor.sourceMapExecution;
    if (!event.cursor.mapName || execution === undefined) {
      this.discard('staged-map-missing');
      return true;
    }
    if (!event.attacker?.sourcePlayerId || !event.victim.sourcePlayerId) {
      this.discard('staged-missing-identity');
      return true;
    }
    if (!event.cursor.ticksPerSecond) {
      this.discard('staged-invalid-cursor');
      return true;
    }
    if (
      this.staged &&
      (this.staged.generation !== event.cursor.generation ||
        this.staged.execution !== execution ||
        this.staged.mapName !== event.cursor.mapName)
    ) {
      this.discardStaged('staged-superseded');
    }
    if (!this.staged) {
      this.staged = {
        match: context.match,
        session: context.session,
        generation: event.cursor.generation,
        mapName: event.cursor.mapName,
        execution,
        lastSequence: -1,
        kills: [],
      };
    }
    if (event.cursor.sequence <= this.staged.lastSequence) {
      this.discard('staged-duplicate');
      return true;
    }
    if (this.staged.kills.length >= STAGED_CAPACITY) {
      this.discard('staged-capacity');
      return true;
    }
    this.staged.lastSequence = event.cursor.sequence;
    this.staged.kills.push({
      event,
      sourceMs: event.cursor.sourceArrivalMonotonicMs ?? event.cursor.observedMonotonicMs,
      observedMonotonicMs: event.cursor.observedMonotonicMs,
    });
    return true;
  }

  private discardStaged(reason: string) {
    const count = this.staged?.kills.length ?? 0;
    if (count) this.discarded[reason] = (this.discarded[reason] ?? 0) + count;
    this.staged = null;
  }

  private expireStaged(now: number) {
    if (!this.staged) return;
    const kept = this.staged.kills.filter((kill) => {
      if (now - kill.observedMonotonicMs <= STAGED_MAX_AGE_MS) return true;
      this.discard('staged-expired');
      return false;
    });
    if (!kept.length) this.staged = null;
    else this.staged.kills = kept;
  }

  /**
   * Hand staged kills to the single scheduling buffer only once Program names the same
   * match, session, map and source generation. The event objects keep their own cursor,
   * channel and world evidence.
   */
  private releaseStaged(
    program: ObserverProgramView,
    source: typeof this.sourceHealth,
    execution: number | undefined,
  ) {
    const staged = this.staged;
    if (!staged) return;
    if (
      program.match?.matchId !== staged.match ||
      program.cursor.liveSessionId !== staged.session
    ) {
      this.discardStaged('staged-context-changed');
      return;
    }
    if (program.map.name !== staged.mapName) {
      this.discardStaged('staged-map-mismatch');
      return;
    }
    if (
      source.generation !== staged.generation ||
      execution !== staged.execution ||
      !source.connected ||
      !source.fresh ||
      source.sameMap !== true
    ) {
      this.discardStaged('staged-source-mismatch');
      return;
    }
    for (const kill of staged.kills) {
      if (kill.event.cursor.sequence <= this.lastDeathSequence) {
        this.discard('duplicate');
        continue;
      }
      this.lastDeathSequence = kill.event.cursor.sequence;
      this.acceptedDeaths++;
      this.stagedReleased++;
      if (kill.event.cursor.sourceArrivalMonotonicMs !== undefined) this.compensatedDeaths++;
      this.kills.push({
        ...kill,
        id: `${kill.event.cursor.generation}:${kill.event.cursor.sequence}`,
        retired: false,
        enteredWindow: false,
        published: false,
        shownDueMs: null,
      });
    }
    this.staged = null;
  }

  private isLivePhase(program: ObserverProgramView): boolean {
    return (
      program.map.phase === 'live' ||
      (program.map.phase === undefined && program.clock?.phase === 'live')
    );
  }
  private engageExecutionFence(program: ObserverProgramView) {
    this.sourceExecutionFence = {
      sawNonLive: program.map.phase === 'warmup' || !this.isLivePhase(program),
      maxRound: program.map.roundNumber ?? null,
    };
  }
  private observeExecution(
    execution: number | undefined,
    generation: number,
    program: ObserverProgramView,
  ) {
    if (execution === undefined) return;
    const generationChanged =
      this.sourceExecutionGeneration === undefined || generation > this.sourceExecutionGeneration;
    if (!isExecutionCompatible(this.sourceExecution, execution, generationChanged)) {
      this.lastAcceptedRound = undefined;
      this.engageExecutionFence(program);
      // Retain kills already received on this new generation/execution regardless of consume/project order.
      const retained = this.kills.filter(
        (kill) =>
          !kill.retired &&
          kill.event.cursor.generation === generation &&
          (kill.event.cursor.sourceMapExecution === undefined ||
            kill.event.cursor.sourceMapExecution === execution),
      );
      this.replaceBuffered('source-execution', retained);
    }
    this.sourceExecution = execution;
    this.sourceExecutionGeneration = generation;
  }
  private reconcileExecutionFence(program: ObserverProgramView) {
    const fence = this.sourceExecutionFence;
    if (!fence || program.status.telemetry !== 'fresh') return;
    const round = program.map.roundNumber ?? null;
    const previousMax = fence.maxRound;
    if (round !== null) {
      fence.maxRound = previousMax === null ? round : Math.max(previousMax, round);
    }
    if (program.map.phase === 'warmup' || !this.isLivePhase(program)) {
      fence.sawNonLive = true;
      return;
    }
    if (
      fence.sawNonLive ||
      (previousMax !== null &&
        round !== null &&
        (round < previousMax || (previousMax === 0 && round > 0)))
    ) {
      this.sourceExecutionFence = null;
    }
  }

  project(
    program: ObserverProgramView,
    settings: ObserverHintSettings,
    now: number,
    source: typeof this.sourceHealth,
    sourceExecution?: number,
    waitingForNextMap = false,
  ): ObserverAssistProjection {
    this.awaitingNextMap = waitingForNextMap;
    this.lastNow = now;
    this.expireStaged(now);
    const delayMs = settings.delaySeconds * 1000;
    const previousDelayMs = (this.configuration?.delaySeconds ?? settings.delaySeconds) * 1000;
    this.kills = this.kills.filter((kill) => {
      const due = kill.shownDueMs ?? kill.sourceMs + Math.min(previousDelayMs, delayMs);
      if (kill.retired || now < due) return !kill.retired;
      this.finish(kill, 'expired');
      return false;
    });
    this.nextDueMs = null;
    this.nextWindowMs = null;
    this.configuration = { ...settings };
    this.programSource = {
      generation: program.cursor.programSourceGeneration,
      mapEpoch: program.cursor.mapEpoch,
      receiveSequence: program.cursor.programReceiveSequence,
    };
    if (!waitingForNextMap && this.sealedSource && !source.normalDrain)
      this.reset('drain-ended', now);
    this.sourceHealth = { ...source };
    if (waitingForNextMap && this.sealedSource) {
      source = this.sealedSource.health;
      sourceExecution = this.sealedSource.execution;
    }
    const empty = (
      state: NonNullable<ObserverAssistProjection['observer']>['state'],
    ): ObserverAssistProjection => ({
      cursor: program.cursor,
      availability: 'unavailable',
      observer: {
        ...settings,
        state,
        waitingReason: this.blocked,
        nextWindowSeconds: null,
        hints: [],
      },
    });
    if (!settings.enabled) {
      if (this.blocked !== 'disabled') this.reset('disabled', now);
      this.discardStaged('staged-disabled');
      this.blocked = 'disabled';
      return { cursor: program.cursor, availability: 'unavailable' };
    }
    const context = [
      program.match?.matchId,
      program.cursor.liveSessionId,
      program.cursor.mapEpoch,
      program.map.name,
    ].join(':');
    if (program.match && program.map.name && context !== this.context) {
      const prior = this.contextIdentity;
      const pendingConflict =
        prior?.match === program.match.matchId &&
        prior.session === program.cursor.liveSessionId &&
        this.pendingMap?.name === program.map.name &&
        isPendingMapConflict(this.pendingMap, source.generation, sourceExecution);
      const pending =
        prior &&
        prior.match === program.match.matchId &&
        prior.session === program.cursor.liveSessionId &&
        prior.map !== program.map.name &&
        source.sameMap === true &&
        this.pendingMap?.name === program.map.name &&
        !pendingConflict
          ? this.kills.filter(
              (k) =>
                k.event.cursor.mapName === program.map.name &&
                k.event.cursor.observedMonotonicMs >= this.pendingMap!.since,
            )
          : [];
      this.reset('program-context', now, pending);
      if (pendingConflict) {
        this.sourceExecution = sourceExecution;
        this.engageExecutionFence(program);
      }
      this.pendingMap = null;
      this.context = context;
      this.contextIdentity = {
        match: program.match.matchId,
        session: program.cursor.liveSessionId,
        map: program.map.name,
      };
    }
    const generationChanged = this.generation === undefined || source.generation > this.generation;
    if (generationChanged) {
      this.advanceGeneration(source.generation, this.canRetainAcrossGeneration());
    }
    if (source.generation !== this.generation) {
      this.blocked = 'source-generation-mismatch';
      return empty('unavailable');
    }
    if (!waitingForNextMap) this.releaseStaged(program, source, sourceExecution);
    if (source.sameMap === true) {
      this.observeExecution(sourceExecution, source.generation, program);
    }
    this.reconcileExecutionFence(program);
    const scope = JSON.stringify([
      context,
      program.cursor.programSourceGeneration,
      source.generation,
      sourceExecution,
    ]);
    const draining =
      source.normalDrain === true && source.sameMap === true && this.lastReadyScope === scope;
    if (waitingForNextMap && !draining) {
      this.blocked = 'waiting-next-map';
      return empty('connecting');
    }
    if (draining) this.sealedSource ??= { health: source, execution: sourceExecution };
    if (!source.connected && !draining) {
      this.blocked = 'source-disconnected';
      return empty('connecting');
    }
    if (
      (!source.fresh && !draining) ||
      source.sameMap === false ||
      program.status.telemetry !== 'fresh' ||
      program.coverage.allPlayers !== 'present' ||
      !program.map.name ||
      !program.match ||
      program.status.identity === 'mismatch'
    ) {
      this.blocked =
        !source.fresh && !draining
          ? 'source-stale'
          : source.sameMap === false
            ? 'source-map-mismatch'
            : program.status.telemetry !== 'fresh'
              ? 'program-stale'
              : !program.map.name
                ? 'map-missing'
                : 'identity-unavailable';
      if (source.sameMap === false && source.mapName) {
        if (this.pendingMap?.name !== source.mapName) {
          this.pendingMap = {
            name: source.mapName,
            since: now,
            execution: sourceExecution,
            generation: source.generation,
            conflicted: false,
          };
        } else if (isPendingMapConflict(this.pendingMap, source.generation, sourceExecution)) {
          this.pendingMap.conflicted = true;
        }
      }
      return empty('unavailable');
    }
    const players = program.players.filter((p) => p.lineupEvidence === 'current');
    if (players.length !== 10 || new Set(players.map((p) => p.sourcePlayerId)).size !== 10) {
      this.blocked = 'identity-unavailable';
      return empty('unavailable');
    }
    this.blocked = null;
    if (this.sourceExecutionFence) {
      this.blocked = 'source-execution-ahead';
      return empty('unavailable');
    }
    if (
      source.connected &&
      source.fresh &&
      source.sameMap === true &&
      sourceExecution !== undefined
    )
      this.lastReadyScope = scope;
    const paused = ['paused', 'timeout_ct', 'timeout_t'].includes(program.clock?.phase ?? '');
    const leadMs = settings.leadSeconds * 1000;
    const ref = (player: ObserverProgramView['players'][number]) => ({
      name: (player.displayName ?? '选手').slice(0, 256),
      observerSlot:
        player.observerSlot !== null &&
        players.filter((p) => p.observerSlot === player.observerSlot).length === 1 &&
        Number.isInteger(player.observerSlot) &&
        player.observerSlot >= 0 &&
        player.observerSlot <= 9
          ? player.observerSlot
          : null,
    });
    const hints: ObserverHint[] = [];
    for (const kill of this.kills) {
      const due = kill.shownDueMs ?? kill.sourceMs + delayMs;
      const window = Math.max(kill.event.cursor.observedMonotonicMs, due - leadMs);
      if (kill.event.cursor.mapName !== program.map.name) {
        this.finish(kill, 'map-mismatch');
        continue;
      }
      const attacker = players.find(
        (p) => p.sourcePlayerId === kill.event.attacker!.sourcePlayerId,
      );
      const victim = players.find((p) => p.sourcePlayerId === kill.event.victim.sourcePlayerId);
      if (!attacker || !victim) {
        this.finish(kill, 'event-identity');
        continue;
      }
      const eventRound = kill.event.cursor.roundsCompleted;
      const programRound = program.map.roundNumber;
      if (eventRound === undefined || programRound === null) continue;
      if (
        eventRound < programRound ||
        (eventRound === programRound && victim.lifeState === 'dead')
      ) {
        this.finish(kill, 'program-already-past-event');
        continue;
      }
      if (paused || eventRound !== programRound || victim.lifeState !== 'alive') continue;
      if (this.nextDueMs === null || due < this.nextDueMs) {
        this.nextDueMs = due;
        this.nextWindowMs = window;
      }
      if (now < window) continue;
      if (!kill.enteredWindow) {
        kill.enteredWindow = true;
        this.enteredWindow++;
      }
      if (hints.length >= 6) continue;
      if (kill.shownDueMs === null) this.generatedHints++;
      kill.shownDueMs = due;
      hints.push({
        id: kill.id,
        remainingSeconds: Math.max(0, (due - now) / 1000),
        attacker: ref(attacker),
        victim: ref(victim),
      });
    }
    if (paused) {
      this.blocked = 'program-paused';
      return empty('paused');
    }
    if (draining && this.nextDueMs === null && !this.kills.some((kill) => !kill.retired)) {
      this.blocked = 'waiting-next-map';
      return empty('connecting');
    }
    return {
      cursor: program.cursor,
      availability: 'available',
      observer: {
        ...settings,
        state: 'ready',
        waitingReason: draining
          ? 'normal-drain'
          : this.nextDueMs === null
            ? 'waiting-event'
            : hints.length
              ? null
              : 'buffering',
        nextWindowSeconds:
          this.nextWindowMs === null ? null : Math.max(0, (this.nextWindowMs - now) / 1000),
        hints,
      },
    };
  }
}

export function projectObserverAssist(runtime: ProgramSafeRuntimeView): ObserverAssistProjection {
  return {
    cursor: runtime.cursor,
    availability: 'unavailable',
  };
}
