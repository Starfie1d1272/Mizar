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
  readonly map: Pick<ProgramProjection['map'], 'name' | 'roundNumber'>;
  readonly clock: Pick<NonNullable<ProgramProjection['clock']>, 'phase'> | null;
  readonly coverage: Pick<ProgramProjection['coverage'], 'allPlayers'>;
  readonly players: readonly Pick<
    ProgramPlayerProjection,
    'sourcePlayerId' | 'lineupEvidence' | 'lifeState' | 'displayName' | 'observerSlot'
  >[];
};
interface BufferedKill {
  event: PlayerDeathGameEvent;
  sourceMs: number;
  retired: boolean;
  enteredWindow: boolean;
  shownDueMs: number | null;
}

export class ObserverHintTimeline {
  private kills: BufferedKill[] = [];
  private pendingMap: {
    name: string;
    since: number;
    execution: number | undefined;
    generation: number;
    conflicted: boolean;
  } | null = null;
  private context = '';
  private contextIdentity: { match: string; session: string | null; map: string } | null = null;
  private generation: number | undefined;
  private lastDeathSequence = -1;
  private sourceExecution: number | undefined;
  private sourceExecutionGeneration: number | undefined;
  private sourceExecutionChanged = false;
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
  private compensatedDeaths = 0;
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
      timingBasis: {
        localResidence: this.compensatedDeaths,
        receipt: this.acceptedDeaths - this.compensatedDeaths,
      },
      endedAfterGeneration: { ...this.endedAfterGeneration },
      discarded: { ...this.discarded },
      buffered: this.kills.length,
      pending: this.kills.filter((k) => !k.retired).length,
      nextDueMonotonicMs: this.nextDueMs,
      nextWindowInMs:
        this.nextWindowMs === null ? null : Math.max(0, this.nextWindowMs - this.lastNow),
      lastReset: { ...this.lastReset },
      blocked: this.blocked,
    };
  }
  private discard(reason: string) {
    this.discarded[reason] = (this.discarded[reason] ?? 0) + 1;
  }
  private finish(kill: BufferedKill, reason: string) {
    this.discard(reason);
    if (kill.shownDueMs !== null)
      this.endedAfterGeneration[reason] = (this.endedAfterGeneration[reason] ?? 0) + 1;
    kill.retired = true;
  }
  private reset(reason: string, now: number) {
    if (this.lastReset.reason !== reason || this.kills.length)
      this.lastReset = { reason, atMonotonicMs: now };
    this.clear();
    this.earliest = now;
  }

  resetForMap(now: number) {
    this.reset('map-connection', now);
  }

  clear() {
    this.kills = [];
    this.sourceExecution = undefined;
    this.sourceExecutionGeneration = undefined;
    this.sourceExecutionChanged = false;
    this.nextDueMs = null;
    this.nextWindowMs = null;
  }
  consume(event: GameEventObservation) {
    if (event.cursor.role !== 'lookahead') return;
    this.lastReceivedMs = event.cursor.observedMonotonicMs;
    this.eventCounts[event.kind] = (this.eventCounts[event.kind] ?? 0) + 1;
    this.recentEventKinds.push(event.kind);
    if (this.recentEventKinds.length > 64) {
      const oldest = this.recentEventKinds.shift()!;
      this.eventCounts[oldest]!--;
      if (this.eventCounts[oldest] === 0) delete this.eventCounts[oldest];
    }
    if (this.generation !== undefined && event.cursor.generation < this.generation) {
      this.discard('old-generation');
      return;
    }
    if (this.generation !== event.cursor.generation) {
      this.advanceGeneration(event.cursor.generation);
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
    this.lastDeathSequence = event.cursor.sequence;
    this.acceptedDeaths++;
    if (event.cursor.sourceArrivalMonotonicMs !== undefined) this.compensatedDeaths++;
    this.kills.push({
      event,
      sourceMs: event.cursor.sourceArrivalMonotonicMs ?? event.cursor.observedMonotonicMs,
      retired: false,
      enteredWindow: false,
      shownDueMs: null,
    });
    if (this.kills.length > 4096) {
      const oldest = this.kills.shift()!;
      if (!oldest.retired) this.finish(oldest, 'capacity');
    }
  }
  private advanceGeneration(generation: number) {
    this.generation = generation;
    this.lastDeathSequence = -1;
    this.kills = [];
  }

  private observeExecution(execution: number | undefined, generation: number) {
    if (execution === undefined) return;
    if (
      this.sourceExecutionGeneration === generation &&
      this.sourceExecution !== undefined &&
      execution !== this.sourceExecution
    ) {
      this.sourceExecutionChanged = true;
      this.kills = [];
    }
    this.sourceExecution = execution;
    this.sourceExecutionGeneration = generation;
  }

  project(
    program: ObserverProgramView,
    settings: ObserverHintSettings,
    now: number,
    source: typeof this.sourceHealth,
    sourceExecution?: number,
  ): ObserverAssistProjection {
    this.lastNow = now;
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
    this.sourceHealth = { ...source };
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
        (this.pendingMap.conflicted ||
          this.pendingMap.generation !== source.generation ||
          (this.pendingMap.execution !== undefined &&
            sourceExecution !== undefined &&
            this.pendingMap.generation === source.generation &&
            this.pendingMap.execution !== sourceExecution));
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
      this.reset('program-context', now);
      if (pendingConflict) {
        this.sourceExecution = sourceExecution;
        this.sourceExecutionGeneration = source.generation;
        this.sourceExecutionChanged = true;
      }
      this.pendingMap = null;
      this.kills = pending;
      this.context = context;
      this.contextIdentity = {
        match: program.match.matchId,
        session: program.cursor.liveSessionId,
        map: program.map.name,
      };
    }
    if (this.generation === undefined || source.generation > this.generation) {
      this.advanceGeneration(source.generation);
    }
    if (source.generation !== this.generation) {
      this.blocked = 'source-generation-mismatch';
      return empty('unavailable');
    }
    if (source.sameMap === true) this.observeExecution(sourceExecution, source.generation);
    if (!source.connected) {
      this.blocked = 'source-disconnected';
      return empty('connecting');
    }
    if (
      !source.fresh ||
      source.sameMap === false ||
      program.status.telemetry !== 'fresh' ||
      program.coverage.allPlayers !== 'present' ||
      !program.map.name ||
      !program.match ||
      program.status.identity === 'mismatch'
    ) {
      this.blocked = !source.fresh
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
        } else if (
          this.pendingMap.generation !== source.generation ||
          (this.pendingMap.execution !== undefined &&
            sourceExecution !== undefined &&
            this.pendingMap.execution !== sourceExecution)
        ) {
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
    if (this.sourceExecutionChanged) {
      this.blocked = 'source-execution-ahead';
      return empty('unavailable');
    }
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
      const window = Math.max(kill.sourceMs, due - leadMs);
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
        id: `${kill.event.cursor.generation}:${kill.event.cursor.sequence}`,
        remainingSeconds: Math.max(0, (due - now) / 1000),
        attacker: ref(attacker),
        victim: ref(victim),
      });
    }
    if (paused) {
      this.blocked = 'program-paused';
      return empty('paused');
    }
    return {
      cursor: program.cursor,
      availability: 'available',
      observer: {
        ...settings,
        state: 'ready',
        waitingReason:
          this.nextDueMs === null ? 'waiting-event' : hints.length ? null : 'buffering',
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
