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
  pairedProgramKey: string | null;
}

/** Private event projection. Program deaths provide independent same-player time anchors. */
export class ObserverHintTimeline {
  private kills: BufferedKill[] = [];
  private context = '';
  private generation: number | undefined;
  private previous = new Map<string, boolean>();
  private seenReceive: number | null = null;
  private programEvents: { victim: string; time: number; frame: number }[] = [];
  private effectiveDelayMs: number | null = null;
  private lastEvidenceAt: number | null = null;
  private lastEvidenceKey = '';
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
    this.programEvents = [];
    this.effectiveDelayMs = null;
    this.lastEvidenceAt = null;
    this.lastEvidenceKey = '';
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
  settingsChanged() {
    // Settings affect future projections without discarding the current map timeline.
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
      pairedProgramKey: null,
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

  private calibrate(
    now: number,
    settings: ObserverHintSettings,
    map: string,
    identities: Set<string>,
  ) {
    const observations = this.programEvents.filter((event) => event.time >= now - 60000);
    const center = this.effectiveDelayMs ?? settings.expectedDelaySeconds * 1000;
    const reacquiring = this.calibrationState(now) === 'reacquiring';
    const lower = reacquiring ? 0 : Math.max(0, center - 60000);
    const upper = reacquiring ? Math.max(600000, center + 180000) : center + 60000;
    const assignments = new Map(
      this.kills
        .filter((kill) => kill.pairedProgramKey !== null)
        .map((kill) => [kill.pairedProgramKey!, kill]),
    );
    const pairs = observations.flatMap((event) =>
      this.kills
        .filter(
          (kill) =>
            kill.event.cursor.mapName === map &&
            (kill.pairedProgramKey === null ||
              kill.pairedProgramKey === `${event.frame}:${event.victim}`) &&
            (!assignments.has(`${event.frame}:${event.victim}`) ||
              assignments.get(`${event.frame}:${event.victim}`) === kill) &&
            identities.has(kill.event.attacker!.sourcePlayerId!) &&
            kill.event.victim.sourcePlayerId === event.victim &&
            event.time - kill.sourceMs >= lower &&
            event.time - kill.sourceMs <= upper,
        )
        .map((kill) => ({ event, kill, delay: event.time - kill.sourceMs })),
    );
    this.candidateCount += pairs.length;
    if (pairs.length > 96) {
      this.estimateReason = 'candidate-capacity';
      return;
    }
    // Evaluate clusters of candidate offsets. Reject ambiguous identities and inconsistent order.
    const clusters = pairs
      .map((seed) => {
        const nearby = pairs.filter((pair) => Math.abs(pair.delay - seed.delay) <= 1500);
        const unique = nearby.filter(
          (pair) =>
            nearby.filter((other) => other.event === pair.event).length === 1 &&
            nearby.filter((other) => other.kill === pair.kill).length === 1,
        );
        unique.sort((a, b) => a.event.time - b.event.time || a.event.frame - b.event.frame);
        const ordered = unique.every((pair) =>
          unique.every(
            (other) =>
              other.event.frame === pair.event.frame ||
              other.event.time >= pair.event.time ||
              other.kill.sourceMs < pair.kill.sourceMs,
          ),
        );
        return ordered ? unique : [];
      })
      .filter((cluster) => cluster.length >= 3);
    clusters.sort((a, b) => b.length - a.length);
    const best = clusters[0];
    if (!best) {
      this.estimateReason = 'insufficient-or-ambiguous';
      return;
    }
    const sorted = best.map((pair) => pair.delay).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)]!;
    if (
      clusters.some(
        (cluster) =>
          Math.abs(
            cluster.map((pair) => pair.delay).sort((a, b) => a - b)[
              Math.floor(cluster.length / 2)
            ]! - median,
          ) > 3000,
      )
    ) {
      this.estimateReason = 'competing-offsets';
      return;
    }
    if (
      reacquiring &&
      (best.length < 4 || new Set(best.map((pair) => pair.event.frame)).size < 3)
    ) {
      this.estimateReason = 'insufficient-reacquisition-evidence';
      return;
    }
    const key = best
      .map(
        (pair) =>
          `${pair.event.frame}:${pair.kill.event.cursor.generation}:${pair.kill.event.cursor.sequence}`,
      )
      .sort()
      .join(',');
    if (key === this.lastEvidenceKey) return;
    const jump = this.effectiveDelayMs !== null && Math.abs(median - this.effectiveDelayMs) > 8000;
    if (
      jump &&
      best.filter((pair) => pair.event.time > (this.lastEvidenceAt ?? -Infinity)).length < 3
    ) {
      this.estimateReason = 'awaiting-jump-evidence';
      return;
    }
    for (const pair of best) {
      pair.kill.matched = true;
      pair.kill.pairedProgramKey = `${pair.event.frame}:${pair.event.victim}`;
    }
    this.lastEvidenceKey = key;
    this.evidenceCount = best.length;
    this.evidenceSpreadMs = sorted[sorted.length - 1]! - sorted[0]!;
    this.lastEvidenceAt = now;
    if (reacquiring) this.continuityLost = false;
    this.estimateReason = reacquiring
      ? 'reacquired'
      : jump
        ? 'confirmed-timeline-shift'
        : 'consistent-sequence';
    this.effectiveDelayMs =
      this.effectiveDelayMs === null || jump || reacquiring
        ? median
        : this.effectiveDelayMs + (median - this.effectiveDelayMs) * 0.25;
  }
  project(
    program: ObserverProgramView,
    settings: ObserverHintSettings,
    now: number,
    source: typeof this.sourceHealth,
    programReceiveMs = now,
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
      this.reset('program-context', now);
      this.context = context;
    }
    if (this.generation === undefined || source.generation > this.generation) {
      this.generation = source.generation;
      this.lastSourceReceiveMs = null;
    }
    if (!source.connected) {
      this.blocked = 'source-disconnected';
      this.lastHealthCheckAt = now;
      this.lastProgramProgressAt = now;
      this.lastSourceProgressAt = now;
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
      if (source.sameMap === false && program.map.name) this.reset(this.blocked, now);
      else {
        this.lastHealthCheckAt = now;
        this.lastProgramProgressAt = now;
        this.lastSourceProgressAt = now;
        this.previous.clear();
        this.seenReceive = null;
        this.programEvents = [];
      }
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
    const alive = new Map(
      players
        .filter((p) => p.lifeState !== 'unknown')
        .map((p) => [p.sourcePlayerId, p.lifeState === 'alive']),
    );
    const reacquiring = this.calibrationState(now) === 'reacquiring';
    if (reacquiring) this.continuityLost = true;
    const priorDelay = this.effectiveDelayMs ?? settings.expectedDelaySeconds * 1000;
    if (program.cursor.programReceiveSequence !== this.seenReceive) {
      const fallen = [...alive]
        .filter(([id, live]) => !live && this.previous.get(id) === true)
        .map(([id]) => id);
      this.programDeaths += fallen.length;
      const frame = program.cursor.programReceiveSequence ?? 0;
      for (const victim of fallen) {
        this.programEvents.push({ victim, time: programReceiveMs, frame });
        const candidates = this.kills.filter(
          (kill) =>
            !kill.matched &&
            kill.event.victim.sourcePlayerId === victim &&
            kill.event.cursor.mapName === program.map.name &&
            Math.abs(programReceiveMs - kill.sourceMs - priorDelay) <= 60000,
        );
        if (candidates.length === 1) candidates[0]!.matched = true;
      }
      this.previous = alive;
      this.seenReceive = program.cursor.programReceiveSequence;
      if (fallen.length)
        this.calibrate(
          programReceiveMs,
          settings,
          program.map.name,
          new Set(players.map((player) => player.sourcePlayerId)),
        );
    }
    this.programEvents = this.programEvents
      .filter((event) => event.time >= now - 60000)
      .slice(-256);
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
      // A Program-confirmed death remains a calibration anchor, never a future hint.
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
