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
  readonly expectedDelaySeconds: number;
  readonly leadSeconds: number;
}

/** Operator-only hints share the Program cursor while retaining their own payload. */
export interface ObserverAssistProjection {
  readonly cursor: ProjectionCursor;
  readonly availability: 'unavailable' | 'available';
  readonly observer?: ObserverHintSettings & {
    readonly state: 'connecting' | 'ready' | 'paused' | 'unavailable';
    readonly timingBasis: 'estimated';
    readonly waitingReason: string | null;
    readonly nextWindowSeconds: number | null;
    readonly measuredDelaySeconds: number | null;
    readonly hints: readonly ObserverHint[];
  };
}

export type ObserverProgramView = Pick<ProgramProjection, 'cursor' | 'status'> & {
  readonly match: { readonly matchId: string } | null;
  readonly map: Pick<ProgramProjection['map'], 'name'>;
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
  matched: boolean;
  retired: boolean;
}

/** Private event projection. Program deaths provide independent same-player time anchors. */
export class ObserverHintTimeline {
  private kills: BufferedKill[] = [];
  private context = '';
  private generation: number | undefined;
  private previous = new Map<string, boolean>();
  private seenReceive: number | null = null;
  private anchors: { offset: number; delay: number; victim: string }[] = [];
  private lastAnchorAt = 0;
  private boundary = '';
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
  private programDeaths = 0;
  private candidateCount = 0;
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
    state?: string;
    lastErrorCode?: string;
  } = { connected: false, generation: 0, fresh: false };

  getDiagnostics() {
    const delays = this.anchors.map((a) => a.delay);
    return {
      source: { ...this.sourceHealth },
      programSource: { ...this.programSource },
      configuration: this.configuration === null ? null : { ...this.configuration },
      lastEventReceivedMonotonicMs: this.lastReceivedMs,
      eventCounts: { ...this.eventCounts },
      acceptedDeaths: this.acceptedDeaths,
      discarded: { ...this.discarded },
      buffered: this.kills.length,
      pending: this.kills.filter((k) => !k.retired && !k.matched).length,
      nextDueMonotonicMs: this.nextDueMs,
      nextWindowInMs:
        this.nextWindowMs === null ? null : Math.max(0, this.nextWindowMs - this.lastNow),
      programDeathChanges: this.programDeaths,
      matchingCandidates: this.candidateCount,
      anchors: delays.length,
      measuredDelayMs: delays.length
        ? {
            min: Math.min(...delays),
            max: Math.max(...delays),
            spread: Math.max(...delays) - Math.min(...delays),
          }
        : null,
      lastReset: { ...this.lastReset },
      blocked: this.blocked,
    };
  }
  private discard(reason: string) {
    this.discarded[reason] = (this.discarded[reason] ?? 0) + 1;
  }
  private reset(reason: string, now: number) {
    if (this.lastReset.reason !== reason || this.kills.length || this.anchors.length)
      this.lastReset = { reason, atMonotonicMs: now };
    this.clear();
    this.earliest = now;
  }

  clear() {
    this.kills = [];
    this.anchors = [];
    this.previous.clear();
    this.seenReceive = null;
    this.lastAnchorAt = 0;
    this.nextDueMs = null;
    this.nextWindowMs = null;
  }
  settingsChanged(now: number) {
    this.reset('settings-changed', now);
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
      this.reset('source-generation', event.cursor.observedMonotonicMs);
      this.generation = event.cursor.generation;
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
    if (this.kills.some((k) => k.event.cursor.sequence === event.cursor.sequence)) {
      this.discard('duplicate');
      return;
    }
    this.acceptedDeaths++;
    this.kills.push({
      event,
      sourceMs: event.cursor.observedMonotonicMs,
      matched: false,
      retired: false,
    });
    if (this.kills.length > 4096) {
      this.kills.shift();
      this.discard('capacity');
    }
  }
  project(
    program: ObserverProgramView,
    settings: ObserverHintSettings,
    now: number,
    source: typeof this.sourceHealth,
  ): ObserverAssistProjection {
    this.lastNow = now;
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
        timingBasis: 'estimated',
        waitingReason: this.blocked,
        nextWindowSeconds: null,
        measuredDelaySeconds: null,
        hints: [],
      },
    });
    if (!settings.enabled) {
      this.blocked = 'disabled';
      this.reset('disabled', now);
      return { cursor: program.cursor, availability: 'unavailable' };
    }
    const context = [
      program.match?.matchId,
      program.cursor.liveSessionId,
      program.cursor.programSourceGeneration,
      program.cursor.mapEpoch,
      program.map.name,
    ].join(':');
    const paused = ['paused', 'timeout_ct', 'timeout_t'].includes(program.clock?.phase ?? '');
    const boundary = paused ? 'paused' : 'active';
    if (
      context !== this.context ||
      boundary !== this.boundary ||
      (this.generation !== undefined && this.generation !== source.generation)
    ) {
      // Both pause and resume require newly received events.
      this.reset(
        context !== this.context
          ? 'program-context'
          : boundary !== this.boundary
            ? boundary
            : 'source-generation',
        now,
      );
      this.context = context;
      this.boundary = boundary;
      this.generation = source.generation;
    }
    if (!source.connected) {
      this.blocked = 'source-disconnected';
      this.reset(this.blocked, now);
      return empty('connecting');
    }
    if (paused) {
      this.blocked = 'paused';
      this.reset(this.blocked, now);
      return empty('paused');
    }
    if (
      !source.fresh ||
      source.sameMap === false ||
      program.status.telemetry !== 'fresh' ||
      program.coverage.allPlayers !== 'present' ||
      !program.map.name ||
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
      this.reset(this.blocked, now);
      return empty('unavailable');
    }
    const players = program.players.filter((p) => p.lineupEvidence === 'current');
    if (players.length !== 10 || new Set(players.map((p) => p.sourcePlayerId)).size !== 10) {
      this.blocked = 'identity-unavailable';
      this.reset(this.blocked, now);
      return empty('unavailable');
    }
    this.blocked = null;
    const alive = new Map(
      players
        .filter((p) => p.lifeState !== 'unknown')
        .map((p) => [p.sourcePlayerId, p.lifeState === 'alive']),
    );
    if (program.cursor.programReceiveSequence !== this.seenReceive) {
      const fallen = [...alive]
        .filter(([id, live]) => !live && this.previous.get(id) === true)
        .map(([id]) => id);
      this.programDeaths += fallen.length;
      for (const victim of fallen) {
        const candidates = this.kills.filter(
          (k) =>
            !k.matched &&
            k.event.victim.sourcePlayerId === victim &&
            k.event.cursor.mapName === program.map.name &&
            Math.abs(
              now - k.event.cursor.observedMonotonicMs - settings.expectedDelaySeconds * 1000,
            ) < 15000,
        );
        this.candidateCount += candidates.length;
        if (candidates.length !== 1) {
          this.discard(candidates.length ? 'ambiguous-match' : 'no-match');
          continue;
        }
        const kill = candidates[0]!;
        kill.matched = true;
        if (!players.some((p) => p.sourcePlayerId === kill.event.attacker!.sourcePlayerId))
          continue;
        this.anchors.push({ offset: now - kill.sourceMs, delay: now - kill.sourceMs, victim });
        this.anchors = this.anchors.slice(-5);
        this.lastAnchorAt = now;
      }
      this.previous = alive;
      this.seenReceive = program.cursor.programReceiveSequence;
    }
    if (now - this.lastAnchorAt > 180000) {
      this.anchors = [];
    }
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
    this.nextDueMs = null;
    this.nextWindowMs = null;
    for (const kill of [...this.kills].sort((a, b) => a.sourceMs - b.sourceMs)) {
      // A Program-confirmed death remains a calibration anchor, never a future hint.
      const due = kill.sourceMs + settings.expectedDelaySeconds * 1000;
      if (now >= due && !kill.retired) {
        kill.retired = true;
        this.discard('expired');
      }
      if (kill.matched || kill.retired) continue;
      if (kill.event.cursor.mapName !== program.map.name) {
        kill.retired = true;
        this.discard('map-mismatch');
        continue;
      }
      const attacker = players.find(
        (p) => p.sourcePlayerId === kill.event.attacker!.sourcePlayerId,
      );
      const victim = players.find((p) => p.sourcePlayerId === kill.event.victim.sourcePlayerId);
      if (!attacker || !victim) {
        kill.retired = true;
        this.discard('event-identity');
        continue;
      }
      // Suppress only the event entering its window, not later rounds for this player.
      if (now >= due - settings.leadSeconds * 1000 && victim.lifeState === 'dead') {
        kill.retired = true;
        this.discard('victim-already-dead');
        continue;
      }
      if (this.nextDueMs === null || due < this.nextDueMs) {
        this.nextDueMs = due;
        this.nextWindowMs = due - settings.leadSeconds * 1000;
      }
      if (now < due - settings.leadSeconds * 1000) continue;
      hints.push({
        id: `${this.generation}:${kill.event.cursor.sequence}`,
        remainingSeconds: Math.max(0, (due - now) / 1000),
        attacker: ref(attacker),
        victim: ref(victim),
      });
    }
    return {
      cursor: program.cursor,
      availability: 'available',
      observer: {
        ...settings,
        state: 'ready',
        timingBasis: 'estimated',
        waitingReason:
          this.nextDueMs === null ? 'waiting-event' : hints.length ? null : 'buffering',
        nextWindowSeconds:
          this.nextWindowMs === null ? null : Math.max(0, (this.nextWindowMs - now) / 1000),
        measuredDelaySeconds: this.anchors.length
          ? this.anchors.reduce((sum, a) => sum + a.delay, 0) / this.anchors.length / 1000
          : null,
        hints: hints.slice(0, 6),
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
