import type { GameEventObservationBase } from './observation.js';
import type { GameEventPlayerRef } from './player.js';

export interface PlayerDeathGameEvent extends GameEventObservationBase {
  readonly kind: 'player-death';
  readonly victim: GameEventPlayerRef;
  readonly attacker?: GameEventPlayerRef;
  readonly assister?: GameEventPlayerRef;
  readonly weapon: string;
  readonly assistedFlash: boolean;
  readonly headshot: boolean;
  readonly penetratedObjects: number;
  readonly noScope: boolean;
  readonly throughSmoke: boolean;
  readonly attackerBlind: boolean;
  readonly attackerInAir: boolean;
  readonly distance?: number;
  readonly damageHealth?: number;
  readonly damageArmor?: number;
  readonly hitgroup?: number;
}

export interface PlayerHurtGameEvent extends GameEventObservationBase {
  readonly kind: 'player-hurt';
  readonly victim: GameEventPlayerRef;
  readonly attacker?: GameEventPlayerRef;
  readonly weapon: string;
  readonly healthRemaining: number;
  readonly armorRemaining?: number;
  readonly damageHealth: number;
  readonly damageArmor?: number;
  readonly hitgroup: number;
}

export interface WeaponFireGameEvent extends GameEventObservationBase {
  readonly kind: 'weapon-fire';
  readonly player: GameEventPlayerRef;
  readonly weapon: string;
  readonly silenced: boolean;
}

export interface GrenadeThrownGameEvent extends GameEventObservationBase {
  readonly kind: 'grenade-thrown';
  readonly player: GameEventPlayerRef;
  readonly weapon: string;
}

export type CombatGameEventObservation =
  PlayerDeathGameEvent | PlayerHurtGameEvent | WeaponFireGameEvent | GrenadeThrownGameEvent;
