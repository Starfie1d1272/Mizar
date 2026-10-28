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
    readonly calibrationState: 'uncalibrated' | 'measured' | 'held' | 'reacquiring';
    readonly effectiveDelaySeconds: number;
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
  shownDueMs: number | null;
}

interface ClockPoint {
  round: number;
  remaining: number;
  received: number;
  generation: number;
  segment: number;
}
interface ClockBoundary {
  round: number;
  received: number;
  generation: number;
}
interface ClockInput {
  round: number;
  remaining: number;
  received: number;
  generation: number;
}

/** Private event projection; clock comparisons use receive times from this process. */
export class ObserverHintTimeline {
  private kills: BufferedKill[] = [];
  private pendingMap: {
    name: string;
    since: number;
    execution: number | undefined;
    conflicted: boolean;
  } | null = null;
  private context = '';
  private contextIdentity: { match: string; session: string | null; map: string } | null = null;
  private generation: number | undefined;
  private previous = new Map<string, boolean>();
  private seenReceive: number | null = null;
  private sourceClocks: ClockPoint[] = [];
  private sourceExecution: number | undefined;
  private sourceExecutionChanged = false;
  private freezeEnds: ClockBoundary[] = [];
  private programPhase: {
    phase: string;
    round: number;
    received: number;
    generation: number;
  } | null = null;
  private freezeOffset: { delay: number; round: number; generation: number } | null = null;
  private lastProgramClock: ClockInput | null = null;
  private clockSegment = 0;
  private clockEvidence: {
    delay: number;
    time: number;
    remaining: number;
    round: number;
    segment: number;
  }[] = [];
  private effectiveDelayMs: number | null = null;
  private lastEvidenceAt: number | null = null;
  private evidenceCount = 0;
  private evidenceSpreadMs: number | null = null;
  private estimateReason = 'awaiting-evidence';
  private continuityLost = false;
  private continuityEstablished = false;
  private lastHealthCheckAt: number | null = null;
  private lastProgramSequence: number | null = null;
  private lastProgramProgressAt: number | null = null;
  private lastSourceReceiveMs: number | null = null;
  private lastSourceProgressAt: number | null = null;
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
      discarded: { ...this.discarded },
      buffered: this.kills.length,
      pending: this.kills.filter((k) => !k.retired && !k.matched).length,
      nextDueMonotonicMs: this.nextDueMs,
      nextWindowInMs:
        this.nextWindowMs === null ? null : Math.max(0, this.nextWindowMs - this.lastNow),
      programDeathChanges: this.programDeaths,
      matchingCandidates: this.candidateCount,
      anchors: this.evidenceCount,
      calibration: {
        state: this.calibrationState(this.lastNow),
        effectiveDelayMs: this.effectiveDelayMs,
        evidenceCount: this.evidenceCount,
        evidenceSpreadMs: this.evidenceSpreadMs,
        lastEvidenceMonotonicMs: this.lastEvidenceAt,
        reason: this.estimateReason,
        continuity: this.continuityLost
          ? 'lost'
          : this.continuityEstablished
            ? 'observed'
            : 'unknown',
      },
      lastReset: { ...this.lastReset },
      blocked: this.blocked,
    };
  }
  private discard(reason: string) {
    this.discarded[reason] = (this.discarded[reason] ?? 0) + 1;
  }
  private reset(reason: string, now: number) {
    if (this.lastReset.reason !== reason || this.kills.length || this.effectiveDelayMs !== null)
      this.lastReset = { reason, atMonotonicMs: now };
    this.clear();
    this.earliest = now;
  }

  clear() {
    this.kills = [];
    this.sourceClocks = [];
    this.sourceExecution = undefined;
    this.sourceExecutionChanged = false;
    this.freezeEnds = [];
    this.programPhase = null;
    this.freezeOffset = null;
    this.lastProgramClock = null;
    this.clockEvidence = [];
    this.clockSegment++;
    this.effectiveDelayMs = null;
    this.lastEvidenceAt = null;
    this.evidenceCount = 0;
    this.evidenceSpreadMs = null;
    this.estimateReason = 'awaiting-evidence';
    this.continuityLost = false;
    this.continuityEstablished = false;
    this.lastHealthCheckAt = null;
    this.lastProgramSequence = null;
    this.lastProgramProgressAt = null;
    this.lastSourceReceiveMs = null;
    this.lastSourceProgressAt = null;
    this.previous.clear();
    this.seenReceive = null;
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
      this.generation = event.cursor.generation;
      this.lastSourceReceiveMs = null;
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
    if (
      this.kills.some(
        (k) =>
          k.event.cursor.generation === event.cursor.generation &&
          k.event.cursor.sequence === event.cursor.sequence,
      )
    ) {
      this.discard('duplicate');
      return;
    }
    this.acceptedDeaths++;
    this.kills.push({
      event,
      sourceMs: event.cursor.observedMonotonicMs,
      matched: false,
      retired: false,
      shownDueMs: null,
    });
    if (this.kills.length > 4096) {
      this.kills.shift();
      this.discard('capacity');
    }
  }
  private calibrationState(now: number): 'uncalibrated' | 'measured' | 'held' | 'reacquiring' {
    if (this.effectiveDelayMs === null) return 'uncalibrated';
    const age = this.lastEvidenceAt === null ? Infinity : now - this.lastEvidenceAt;
    if (this.continuityLost || (age > 180000 && !this.continuityEstablished)) return 'reacquiring';
    return age <= 60000 ? 'measured' : 'held';
  }

  private observeContinuity(now: number, sequence: number | null, received: number | null) {
    if (
      this.effectiveDelayMs !== null &&
      this.lastHealthCheckAt !== null &&
      now - this.lastHealthCheckAt > 30000 &&
      this.continuityEstablished
    )
      this.continuityLost = true;
    this.lastHealthCheckAt = now;
    if (sequence !== null && sequence !== this.lastProgramSequence) {
      if (this.lastProgramSequence !== null && sequence < this.lastProgramSequence)
        this.continuityLost = true;
      this.lastProgramSequence = sequence;
      this.lastProgramProgressAt = now;
    }
    if (received !== null && received <= now && received !== this.lastSourceReceiveMs) {
      if (this.lastSourceReceiveMs !== null) {
        if (received < this.lastSourceReceiveMs) this.continuityLost = true;
        else if (this.lastProgramProgressAt !== null) this.continuityEstablished = true;
      }
      this.lastSourceReceiveMs = received;
      this.lastSourceProgressAt = now;
    }
    if (
      this.continuityEstablished &&
      (this.lastProgramProgressAt === null ||
        now - this.lastProgramProgressAt > 30000 ||
        this.lastSourceProgressAt === null ||
        now - this.lastSourceProgressAt > 30000)
    )
      this.continuityLost = true;
  }

  private observeClock(
    source: ClockInput | undefined,
    program: ClockInput | undefined,
    now: number,
    freezeEnd?: ClockBoundary,
    sourceExecution?: number,
    phase?: { phase: string; round: number; received: number; generation: number },
  ) {
    if (sourceExecution !== undefined) {
      if (this.sourceExecution !== undefined && sourceExecution !== this.sourceExecution) {
        this.sourceExecutionChanged = true;
        this.sourceClocks = [];
        this.clockEvidence = [];
        this.freezeEnds = [];
        this.freezeOffset = null;
      }
      this.sourceExecution = sourceExecution;
    }
    if (this.sourceExecutionChanged) return;
    if (
      freezeEnd &&
      !this.freezeEnds.some(
        (p) => p.generation === freezeEnd.generation && p.received === freezeEnd.received,
      )
    ) {
      this.freezeEnds.push(freezeEnd);
      this.freezeEnds = this.freezeEnds.filter((p) => p.received >= now - 780000).slice(-128);
    }
    if (phase && phase.received !== this.programPhase?.received) {
      const previousPhase = this.programPhase;
      if (
        previousPhase?.phase === 'freezetime' &&
        phase.phase === 'live' &&
        previousPhase.round === phase.round &&
        previousPhase.generation === phase.generation &&
        phase.received > previousPhase.received &&
        phase.received - previousPhase.received <= 2000
      ) {
        const candidates = this.freezeEnds.filter(
          (p) =>
            p.round === phase.round &&
            phase.received >= p.received &&
            phase.received - p.received <= 600000,
        );
        this.freezeOffset =
          candidates.length === 1
            ? {
                delay: phase.received - candidates[0]!.received,
                round: phase.round,
                generation: candidates[0]!.generation,
              }
            : null;
      }
      this.programPhase = phase;
    } else if (!phase) this.programPhase = null;
    const last = this.sourceClocks.at(-1);
    if (source && (!last || source.received !== last.received)) {
      const elapsed = last ? (source.received - last.received) / 1000 : 0;
      const advanced = last ? last.remaining - source.remaining : 0;
      if (
        !last ||
        source.generation !== last.generation ||
        source.round !== last.round ||
        elapsed <= 0 ||
        elapsed > 2 ||
        advanced <= 0 ||
        Math.abs(advanced - elapsed) > 0.35
      ) {
        this.clockSegment++;
      }
      this.sourceClocks.push({ ...source, segment: this.clockSegment });
      this.sourceClocks = this.sourceClocks.filter((p) => p.received >= now - 780000).slice(-16000);
    } else if (!source && last && last.segment === this.clockSegment) {
      this.clockSegment++;
    }
    if (!program) {
      this.lastProgramClock = null;
      this.clockEvidence = [];
      return;
    }
    if (this.lastProgramClock && program.received === this.lastProgramClock.received) return;
    const previous = this.lastProgramClock;
    this.lastProgramClock = program;
    if (
      !previous ||
      previous.generation !== program.generation ||
      previous.round !== program.round
    ) {
      this.clockEvidence = [];
      return;
    }
    const elapsed = (program.received - previous.received) / 1000;
    const advanced = previous.remaining - program.remaining;
    if (elapsed <= 0 || elapsed > 2 || advanced <= 0 || Math.abs(advanced - elapsed) > 0.35) {
      this.clockEvidence = [];
      return;
    }
    const candidates: { delay: number; segment: number }[] = [];
    for (let i = 1; i < this.sourceClocks.length; i++) {
      const a = this.sourceClocks[i - 1]!;
      const b = this.sourceClocks[i]!;
      if (
        a.segment !== b.segment ||
        a.round !== program.round ||
        b.round !== program.round ||
        a.remaining < program.remaining ||
        b.remaining > program.remaining
      )
        continue;
      const fraction = (a.remaining - program.remaining) / (a.remaining - b.remaining);
      const sourceTime = a.received + fraction * (b.received - a.received);
      const delay = program.received - sourceTime;
      if (
        delay >= 0 &&
        delay <= 600000 &&
        !candidates.some((c) => c.segment === a.segment && Math.abs(c.delay - delay) < 1)
      )
        candidates.push({ delay, segment: a.segment });
    }
    if (candidates.length !== 1) return;
    const lastEvidence = this.clockEvidence.at(-1);
    // Limit correlated samples; paced backlog cannot be identified from this contract.
    if (
      lastEvidence &&
      (lastEvidence.round !== program.round || lastEvidence.segment !== candidates[0]!.segment)
    )
      this.clockEvidence = [];
    else if (lastEvidence && program.received - lastEvidence.time < 2000) return;
    this.clockEvidence.push({
      delay: candidates[0]!.delay,
      segment: candidates[0]!.segment,
      time: program.received,
      remaining: program.remaining,
      round: program.round,
    });
    this.clockEvidence = this.clockEvidence.filter((p) => p.time >= now - 30000).slice(-12);
    if (
      this.clockEvidence.length < 3 ||
      this.clockEvidence.at(-1)!.time - this.clockEvidence[0]!.time < 5000
    )
      return;
    const delays = this.clockEvidence.map((p) => p.delay).sort((a, b) => a - b);
    const spread = delays.at(-1)! - delays[0]!;
    if (spread > 1500) {
      this.estimateReason = 'unstable-clock';
      return;
    }
    const median = delays[Math.floor(delays.length / 2)]!;
    if (
      this.freezeOffset &&
      this.freezeOffset.round === program.round &&
      this.freezeOffset.generation ===
        this.sourceClocks.find((p) => p.segment === candidates[0]!.segment)?.generation &&
      Math.abs(this.freezeOffset.delay - median) > 2500
    ) {
      this.estimateReason = 'freeze-boundary-conflict';
      return;
    }
    this.effectiveDelayMs = median;
    this.evidenceCount = delays.length;
    this.evidenceSpreadMs = spread;
    this.lastEvidenceAt = now;
    this.continuityLost = false;
    this.estimateReason = 'consistent-round-clock';
  }
  project(
    program: ObserverProgramView,
    settings: ObserverHintSettings,
    now: number,
    source: typeof this.sourceHealth,
    programReceiveMs = now,
    clock?: {
      source?: ClockInput;
      program?: ClockInput;
      freezeEnd?: ClockBoundary;
      sourceExecution?: number;
      phase?: { phase: string; round: number; received: number; generation: number };
    },
  ): ObserverAssistProjection {
    this.lastNow = now;
    this.configuration = { ...settings };
    if (this.programSource.generation !== program.cursor.programSourceGeneration) {
      this.lastProgramSequence = null;
      this.seenReceive = null;
      this.previous.clear();
    }
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
        calibrationState: this.calibrationState(now),
        effectiveDelaySeconds:
          (this.effectiveDelayMs ?? settings.expectedDelaySeconds * 1000) / 1000,
        waitingReason: this.blocked,
        nextWindowSeconds: null,
        measuredDelaySeconds: null,
        hints: [],
      },
    });
    if (!settings.enabled) {
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
          (this.pendingMap.execution !== undefined &&
            clock?.sourceExecution !== undefined &&
            this.pendingMap.execution !== clock.sourceExecution));
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
                k.event.cursor.mapName === program.map.name && k.sourceMs >= this.pendingMap!.since,
            )
          : [];
      this.reset('program-context', now);
      if (pendingConflict) {
        this.sourceExecution = clock?.sourceExecution;
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
      this.generation = source.generation;
      this.lastSourceReceiveMs = null;
    }
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
            execution: clock?.sourceExecution,
            conflicted: false,
          };
        } else if (
          this.pendingMap.execution !== undefined &&
          clock?.sourceExecution !== undefined &&
          this.pendingMap.execution !== clock.sourceExecution
        ) {
          this.pendingMap.conflicted = true;
        }
      }
      this.previous.clear();
      this.seenReceive = null;
      this.lastProgramClock = null;
      this.clockSegment++;
      return empty('unavailable');
    }
    const players = program.players.filter((p) => p.lineupEvidence === 'current');
    if (players.length !== 10 || new Set(players.map((p) => p.sourcePlayerId)).size !== 10) {
      this.blocked = 'identity-unavailable';
      return empty('unavailable');
    }
    this.observeContinuity(
      now,
      program.cursor.programReceiveSequence,
      source.lastReceiveMonotonicMs ?? null,
    );
    this.blocked = null;
    this.observeClock(
      clock?.source,
      clock?.program,
      now,
      clock?.freezeEnd,
      clock?.sourceExecution,
      clock?.phase,
    );
    if (this.sourceExecutionChanged) {
      this.blocked = 'source-execution-ahead';
      this.nextDueMs = null;
      this.nextWindowMs = null;
      return empty('unavailable');
    }
    const alive = new Map(
      players
        .filter((p) => p.lifeState !== 'unknown')
        .map((p) => [p.sourcePlayerId, p.lifeState === 'alive']),
    );
    const reacquiring = this.calibrationState(now) === 'reacquiring';
    if (reacquiring) this.continuityLost = true;
    if (program.cursor.programReceiveSequence !== this.seenReceive) {
      const fallen = [...alive]
        .filter(([id, live]) => !live && this.previous.get(id) === true)
        .map(([id]) => id);
      this.programDeaths += fallen.length;
      for (const victim of fallen) {
        const candidates = this.kills.filter(
          (kill) =>
            !kill.matched &&
            kill.event.victim.sourcePlayerId === victim &&
            kill.event.cursor.mapName === program.map.name &&
            kill.shownDueMs !== null &&
            programReceiveMs >= kill.shownDueMs - settings.leadSeconds * 1000 &&
            programReceiveMs <= kill.shownDueMs + 1000,
        );
        if (candidates.length === 1) candidates[0]!.matched = true;
      }
      this.previous = alive;
      this.seenReceive = program.cursor.programReceiveSequence;
    }
    const keepSince =
      now -
      (Math.max(600000, settings.expectedDelaySeconds * 1000, this.effectiveDelayMs ?? 0) + 180000);
    this.kills = this.kills.filter((kill) => kill.sourceMs >= keepSince);
    if (this.calibrationState(now) === 'reacquiring') {
      this.blocked = 'calibration-reacquiring';
      this.nextDueMs = null;
      this.nextWindowMs = null;
      return empty('unavailable');
    }
    const stableDelay = this.effectiveDelayMs;
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
      // A Program-confirmed death is never a future hint.
      const due =
        kill.shownDueMs ?? kill.sourceMs + (stableDelay ?? settings.expectedDelaySeconds * 1000);
      if (now >= due && kill.shownDueMs !== null && !kill.retired) {
        kill.retired = true;
        this.discard('expired');
      }
      if (kill.matched || kill.retired || now >= due) continue;
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
      if (hints.length >= 6) continue;
      kill.shownDueMs = due;
      hints.push({
        id: `${kill.event.cursor.generation}:${kill.event.cursor.sequence}`,
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
        calibrationState: this.calibrationState(now),
        effectiveDelaySeconds: (stableDelay ?? settings.expectedDelaySeconds * 1000) / 1000,
        waitingReason:
          this.nextDueMs === null ? 'waiting-event' : hints.length ? null : 'buffering',
        nextWindowSeconds:
          this.nextWindowMs === null ? null : Math.max(0, (this.nextWindowMs - now) / 1000),
        measuredDelaySeconds: stableDelay === null ? null : stableDelay / 1000,
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
