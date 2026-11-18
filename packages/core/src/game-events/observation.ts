import type { PlayerDeathGameEvent, PlayerHurtGameEvent } from './combat.js';
import type { GrenadeThrownGameEvent, WeaponFireGameEvent } from './combat.js';
import type { BombGameEventObservation } from './objective.js';

export type GameEventSourceRole = 'program' | 'lookahead';

/** Continuity cursor owned by one CSTV source role. */
export interface GameEventSourceCursor {
  readonly kind: 'cs2-cstv';
  readonly role: GameEventSourceRole;
  readonly generation: number;
  readonly sequence: number;
  readonly tick: number;
  readonly observedAt: string;
  readonly observedMonotonicMs: number;
  readonly mapName?: string;
  readonly ticksPerSecond?: number;
  /** Raw completed-round count from the same source record, when supplied. */
  readonly roundsCompleted?: number;
}

export interface GameEventObservationBase {
  readonly cursor: GameEventSourceCursor;
}

export type GameEventObservation =
  | PlayerDeathGameEvent
  | PlayerHurtGameEvent
  | WeaponFireGameEvent
  | GrenadeThrownGameEvent
  | BombGameEventObservation;

/** A game-event observation whose source role is fixed at the type boundary. */
export type RoleScopedGameEventObservation<R extends GameEventSourceRole> = GameEventObservation & {
  readonly cursor: GameEventSourceCursor & { readonly role: R };
};

export type GameEventKind = GameEventObservation['kind'];
