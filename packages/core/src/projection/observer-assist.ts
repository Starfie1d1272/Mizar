import type { ProjectionCursor } from './cursor.js';
import type { ProgramSafeRuntimeView } from './program-safe-runtime.js';
import type { ProgramProjection, ProgramPlayerProjection } from './program.js';
import type { PlayerDeathGameEvent, GameEventObservation } from '../game-events/index.js';

export interface ObserverHint {
  readonly id: string;
  readonly remainingSeconds: number;
  readonly occurred: boolean;
  readonly attacker: { readonly name: string; readonly observerSlot: number | null };
  readonly victim: { readonly name: string; readonly observerSlot: number | null };
}
export interface ObserverHintSettings {
  readonly enabled: boolean;
  readonly expectedDelaySeconds: number;
  readonly leadSeconds: number;
  readonly displaySeconds: number;
}

/** Operator-only hints share the Program cursor while retaining their own payload. */
export interface ObserverAssistProjection {
  readonly cursor: ProjectionCursor;
  readonly availability: 'unavailable' | 'available';
  readonly observer?: ObserverHintSettings & {
    readonly state: 'connecting' | 'aligning' | 'ready' | 'paused' | 'unavailable';
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
}

/** Private event projection. Program deaths provide independent same-player time anchors. */
export class ObserverHintTimeline {
  private kills: BufferedKill[] = [];
  private context = '';
  private generation: number | undefined;
  private previous = new Map<string, boolean>();
  private seenReceive: number | null = null;
  private anchors: { offset: number; delay: number; victim: string }[] = [];
  private offset: number | undefined;
  private lastAnchorAt = 0;
  private boundary = '';
  private earliest = -Infinity;

  clear() {
    this.kills = [];
    this.anchors = [];
    this.offset = undefined;
    this.previous.clear();
    this.seenReceive = null;
    this.lastAnchorAt = 0;
  }
  settingsChanged(now: number) {
    this.clear();
    this.earliest = now;
  }
  consume(event: GameEventObservation) {
    if (event.cursor.role !== 'lookahead') return;
    if (this.generation !== event.cursor.generation) {
      this.clear();
      this.generation = event.cursor.generation;
    }
    if (
      event.kind !== 'player-death' ||
      !event.attacker?.sourcePlayerId ||
      !event.victim.sourcePlayerId ||
      !event.cursor.ticksPerSecond ||
      event.cursor.observedMonotonicMs < this.earliest
    )
      return;
    if (this.kills.some((k) => k.event.cursor.sequence === event.cursor.sequence)) return;
    this.kills.push({
      event,
      sourceMs: event.cursor.observedMonotonicMs,
      matched: false,
    });
    if (this.kills.length > 4096) this.kills.shift();
  }
  project(
    program: ObserverProgramView,
    settings: ObserverHintSettings,
    now: number,
    source: { connected: boolean; generation: number; fresh: boolean },
  ): ObserverAssistProjection {
    const empty = (
      state: NonNullable<ObserverAssistProjection['observer']>['state'],
    ): ObserverAssistProjection => ({
      cursor: program.cursor,
      availability: 'unavailable',
      observer: { ...settings, state, measuredDelaySeconds: null, hints: [] },
    });
    if (!settings.enabled) {
      this.clear();
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
      this.clear();
      this.context = context;
      this.boundary = boundary;
      this.generation = source.generation;
    }
    if (!source.connected) {
      this.clear();
      return empty('connecting');
    }
    if (paused) {
      this.clear();
      return empty('paused');
    }
    if (
      !source.fresh ||
      program.status.telemetry !== 'fresh' ||
      program.coverage.allPlayers !== 'present' ||
      !program.map.name ||
      program.status.identity === 'mismatch'
    ) {
      this.clear();
      return empty('unavailable');
    }
    const players = program.players.filter((p) => p.lineupEvidence === 'current');
    if (players.length !== 10 || new Set(players.map((p) => p.sourcePlayerId)).size !== 10) {
      this.clear();
      return empty('unavailable');
    }
    const alive = new Map(
      players
        .filter((p) => p.lifeState !== 'unknown')
        .map((p) => [p.sourcePlayerId, p.lifeState === 'alive']),
    );
    if (program.cursor.programReceiveSequence !== this.seenReceive) {
      const fallen = [...alive]
        .filter(([id, live]) => !live && this.previous.get(id) === true)
        .map(([id]) => id);
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
        if (candidates.length !== 1) continue;
        const kill = candidates[0]!;
        kill.matched = true;
        if (!players.some((p) => p.sourcePlayerId === kill.event.attacker!.sourcePlayerId))
          continue;
        const offset = now - kill.sourceMs;
        if (this.offset !== undefined && Math.abs(offset - this.offset) > 1500) {
          this.anchors = [];
          this.offset = undefined;
        }
        this.anchors.push({ offset, delay: now - kill.event.cursor.observedMonotonicMs, victim });
        this.anchors = this.anchors.slice(-5);
        if (
          this.anchors.length >= 2 &&
          new Set(this.anchors.map((a) => a.victim)).size >= 2 &&
          Math.max(...this.anchors.map((a) => a.offset)) -
            Math.min(...this.anchors.map((a) => a.offset)) <=
            1500
        )
          this.offset = this.anchors.map((a) => a.offset).sort((a, b) => a - b)[
            Math.floor(this.anchors.length / 2)
          ];
        this.lastAnchorAt = now;
      }
      this.previous = alive;
      this.seenReceive = program.cursor.programReceiveSequence;
    }
    if (this.offset === undefined || now - this.lastAnchorAt > 180000) {
      this.offset = undefined;
      return empty('aligning');
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
    for (const kill of [...this.kills].sort((a, b) => a.sourceMs - b.sourceMs)) {
      const due = kill.sourceMs + this.offset;
      if (
        now < due - settings.leadSeconds * 1000 ||
        now >= due + (settings.displaySeconds - settings.leadSeconds) * 1000 ||
        kill.event.cursor.mapName !== program.map.name
      )
        continue;
      const attacker = players.find(
        (p) => p.sourcePlayerId === kill.event.attacker!.sourcePlayerId,
      );
      const victim = players.find((p) => p.sourcePlayerId === kill.event.victim.sourcePlayerId);
      if (!attacker || !victim) continue;
      hints.push({
        id: `${this.generation}:${kill.event.cursor.sequence}`,
        remainingSeconds: Math.max(0, (due - now) / 1000),
        occurred: now >= due,
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
