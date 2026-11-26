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
  published: boolean;
  shownDueMs: number | null;
}

export class ObserverHintTimeline {
  private kills: BufferedKill[] = [];
  private sessionEpoch = 0;
  private currentContext: {
    key: string;
    match: string;
    session: string | null;
    map: string;
  } | null = null;
  private lastNow = 0;
  private programSource = { generation: 0, mapEpoch: 0, receiveSequence: null as number | null };
  private configuration: ObserverHintSettings | null = null;
  private blocked: string | null = 'disabled';
  private lastReset = { reason: 'initial', atMonotonicMs: 0 };
  private receivedEvents = 0;
  private acceptedDeaths = 0;
  private publishedHints = 0;
  private compensatedDeaths = 0;
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
      receivedEvents: this.receivedEvents,
      acceptedDeaths: this.acceptedDeaths,
      publishedHints: this.publishedHints,
      timingBasis: {
        localResidence: this.compensatedDeaths,
        receipt: this.acceptedDeaths - this.compensatedDeaths,
      },
      pending: this.kills.length,
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

  private reset(reason: string, now: number) {
    if (this.lastReset.reason !== reason || this.kills.length)
      this.lastReset = { reason, atMonotonicMs: now };
    this.kills = [];
    this.sessionEpoch++;
    this.nextDueMs = null;
    this.nextWindowMs = null;
  }

  resetForMap(now: number) {
    this.currentContext = null;
    this.reset('map-connection', now);
  }

  consume(event: GameEventObservation) {
    if (event.cursor.role !== 'lookahead') return;
    this.receivedEvents++;
    this.lastReceivedMs = event.cursor.observedMonotonicMs;
    if (event.kind !== 'player-death') return;
    if (!event.attacker?.sourcePlayerId || !event.victim.sourcePlayerId) return;
    if (!event.cursor.ticksPerSecond) return;
    this.acceptedDeaths++;
    if (event.cursor.sourceArrivalMonotonicMs !== undefined) this.compensatedDeaths++;
    this.kills.push({
      id: `${this.sessionEpoch}:${event.cursor.generation}:${event.cursor.sequence}`,
      event,
      sourceMs: event.cursor.sourceArrivalMonotonicMs ?? event.cursor.observedMonotonicMs,
      published: false,
      shownDueMs: null,
    });
    if (this.kills.length > 4096) this.kills.shift();
  }

  project(
    program: ObserverProgramView,
    settings: ObserverHintSettings,
    now: number,
    source: typeof this.sourceHealth,
  ): ObserverAssistProjection {
    this.lastNow = now;
    const delayMs = settings.delaySeconds * 1000;
    const previousDelayMs = (this.configuration?.delaySeconds ?? settings.delaySeconds) * 1000;
    this.kills = this.kills.filter(
      (kill) => now < (kill.shownDueMs ?? kill.sourceMs + Math.min(previousDelayMs, delayMs)),
    );
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
    const contextKey = [
      program.match?.matchId,
      program.cursor.liveSessionId,
      program.cursor.mapEpoch,
      program.map.name,
    ].join(':');
    if (program.match && program.map.name && contextKey !== this.currentContext?.key) {
      if (this.currentContext !== null) this.reset('program-context', now);
      this.currentContext = {
        key: contextKey,
        match: program.match.matchId,
        session: program.cursor.liveSessionId,
        map: program.map.name,
      };
    }
    if (
      program.status.telemetry !== 'fresh' ||
      !program.map.name ||
      !program.match ||
      program.status.identity === 'mismatch'
    ) {
      this.blocked =
        program.status.telemetry !== 'fresh'
          ? 'program-stale'
          : !program.map.name
            ? 'map-missing'
            : 'identity-unavailable';
      return empty('unavailable');
    }

    const paused = ['paused', 'timeout_ct', 'timeout_t'].includes(program.clock?.phase ?? '');
    const leadMs = settings.leadSeconds * 1000;
    const players = program.players;
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

    const kept: BufferedKill[] = [];
    const hints: ObserverHint[] = [];
    for (const kill of this.kills) {
      if (kill.event.cursor.mapName !== program.map.name) continue;
      const attacker = players.find(
        (p) => p.sourcePlayerId === kill.event.attacker!.sourcePlayerId,
      );
      const victim = players.find((p) => p.sourcePlayerId === kill.event.victim.sourcePlayerId);
      if (!attacker || !victim) {
        kept.push(kill);
        continue;
      }
      const eventRound = kill.event.cursor.roundsCompleted;
      const programRound = program.map.roundNumber;
      if (eventRound === undefined || programRound === null) {
        kept.push(kill);
        continue;
      }
      if (
        eventRound < programRound ||
        (eventRound === programRound && victim.lifeState === 'dead')
      ) {
        continue;
      }
      kept.push(kill);
      if (paused || eventRound !== programRound || victim.lifeState !== 'alive') continue;
      const due = kill.shownDueMs ?? kill.sourceMs + delayMs;
      const window = Math.max(kill.event.cursor.observedMonotonicMs, due - leadMs);
      if (this.nextDueMs === null || due < this.nextDueMs) {
        this.nextDueMs = due;
        this.nextWindowMs = window;
      }
      if (now < window || hints.length >= 6) continue;
      if (kill.shownDueMs === null) kill.shownDueMs = due;
      hints.push({
        id: kill.id,
        remainingSeconds: Math.max(0, (due - now) / 1000),
        attacker: ref(attacker),
        victim: ref(victim),
      });
    }
    this.kills = kept;

    if (paused) {
      this.blocked = 'program-paused';
      return empty('paused');
    }

    if (this.kills.length === 0) {
      if (!source.connected) {
        this.blocked = 'source-disconnected';
        return empty('connecting');
      }
      if (!source.fresh || source.sameMap === false) {
        this.blocked = !source.fresh ? 'source-stale' : 'source-map-mismatch';
        return empty('unavailable');
      }
    }

    this.blocked = null;
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
