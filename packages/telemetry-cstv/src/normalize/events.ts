import type {
  BombAbortDefuseGameEvent,
  BombAbortPlantGameEvent,
  BombBeginDefuseGameEvent,
  BombBeginPlantGameEvent,
  BombDefusedGameEvent,
  BombDroppedGameEvent,
  BombExplodedGameEvent,
  BombPickupGameEvent,
  BombPlantedGameEvent,
  GameEventObservation,
  GameEventSourceCursor,
  GameEventPlayerRef,
  GrenadeThrownGameEvent,
  PlayerDeathGameEvent,
  PlayerHurtGameEvent,
  WeaponFireGameEvent,
} from '@mizar/core/game-events';

import { asRecord, isSourceUserId, normalizeSourcePlayerRef, readPropertyValue } from './player.js';
import type { CstvGameEventName } from '../types.js';

export interface GameEventNormalizationContext {
  readonly cursor: GameEventSourceCursor;
}

function requiredRecord(value: unknown): Record<string, unknown> {
  const record = asRecord(value);
  if (record === undefined) throw new Error('event is not an object');
  return record;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = readPropertyValue(record, key);
  if (typeof value !== 'string') throw new Error(`event field ${key} is not a string`);
  return value;
}

function requiredFiniteNumber(record: Record<string, unknown>, key: string): number {
  const value = readPropertyValue(record, key);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`event field ${key} is not a finite number`);
  }
  return value;
}

function requiredInteger(record: Record<string, unknown>, key: string): number {
  const value = requiredFiniteNumber(record, key);
  if (!Number.isSafeInteger(value)) throw new Error(`event field ${key} is not a safe integer`);
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = readPropertyValue(record, key);
  if (typeof value !== 'boolean') throw new Error(`event field ${key} is not a boolean`);
  return value;
}

function requiredPlayer(
  record: Record<string, unknown>,
  userIdKey: string,
  playerKey = 'player',
): GameEventPlayerRef {
  const sourceUserId = readPropertyValue(record, userIdKey);
  if (!isSourceUserId(sourceUserId))
    throw new Error(`event field ${userIdKey} is not a source userid`);
  const player = normalizeSourcePlayerRef(readPropertyValue(record, playerKey), sourceUserId);
  if (player === undefined) throw new Error(`event player ${playerKey} is unavailable`);
  return player;
}

function optionalPlayer(
  record: Record<string, unknown>,
  userIdKey: string,
  playerKey: string,
): GameEventPlayerRef | undefined {
  const sourceUserId = readPropertyValue(record, userIdKey);
  if (!isSourceUserId(sourceUserId)) return undefined;
  return normalizeSourcePlayerRef(readPropertyValue(record, playerKey), sourceUserId);
}

function normalizePlayerDeath(
  record: Record<string, unknown>,
  context: GameEventNormalizationContext,
): PlayerDeathGameEvent {
  const attacker = optionalPlayer(record, 'attacker', 'attackerPlayer');
  const assister = optionalPlayer(record, 'assister', 'assisterPlayer');
  return {
    kind: 'player-death',
    cursor: context.cursor,
    victim: requiredPlayer(record, 'userid'),
    ...(attacker === undefined ? {} : { attacker }),
    ...(assister === undefined ? {} : { assister }),
    weapon: requiredString(record, 'weapon'),
    assistedFlash: requiredBoolean(record, 'assistedflash'),
    headshot: requiredBoolean(record, 'headshot'),
    penetratedObjects: requiredInteger(record, 'penetrated'),
    noScope: requiredBoolean(record, 'noscope'),
    throughSmoke: requiredBoolean(record, 'thrusmoke'),
    attackerBlind: requiredBoolean(record, 'attackerblind'),
    attackerInAir: requiredBoolean(record, 'attackerinair'),
    distance: requiredFiniteNumber(record, 'distance'),
    damageHealth: requiredFiniteNumber(record, 'dmg_health'),
    damageArmor: requiredFiniteNumber(record, 'dmg_armor'),
    hitgroup: requiredInteger(record, 'hitgroup'),
  };
}

function normalizePlayerHurt(
  record: Record<string, unknown>,
  context: GameEventNormalizationContext,
): PlayerHurtGameEvent {
  const attacker = optionalPlayer(record, 'attacker', 'attackerPlayer');
  return {
    kind: 'player-hurt',
    cursor: context.cursor,
    victim: requiredPlayer(record, 'userid'),
    ...(attacker === undefined ? {} : { attacker }),
    weapon: requiredString(record, 'weapon'),
    healthRemaining: requiredFiniteNumber(record, 'health'),
    armorRemaining: requiredFiniteNumber(record, 'armor'),
    damageHealth: requiredFiniteNumber(record, 'dmg_health'),
    damageArmor: requiredFiniteNumber(record, 'dmg_armor'),
    hitgroup: requiredInteger(record, 'hitgroup'),
  };
}

function normalizeWeaponFire(
  record: Record<string, unknown>,
  context: GameEventNormalizationContext,
): WeaponFireGameEvent {
  return {
    kind: 'weapon-fire',
    cursor: context.cursor,
    player: requiredPlayer(record, 'userid'),
    weapon: requiredString(record, 'weapon'),
    silenced: requiredBoolean(record, 'silenced'),
  };
}

function normalizeGrenadeThrown(
  record: Record<string, unknown>,
  context: GameEventNormalizationContext,
): GrenadeThrownGameEvent {
  return {
    kind: 'grenade-thrown',
    cursor: context.cursor,
    player: requiredPlayer(record, 'userid'),
    weapon: requiredString(record, 'weapon'),
  };
}

function normalizeBombBeginPlant(
  record: Record<string, unknown>,
  context: GameEventNormalizationContext,
): BombBeginPlantGameEvent {
  return {
    kind: 'bomb-begin-plant',
    cursor: context.cursor,
    player: requiredPlayer(record, 'userid'),
    site: requiredInteger(record, 'site'),
  };
}

function normalizeBombAbortPlant(
  record: Record<string, unknown>,
  context: GameEventNormalizationContext,
): BombAbortPlantGameEvent {
  return {
    kind: 'bomb-abort-plant',
    cursor: context.cursor,
    player: requiredPlayer(record, 'userid'),
    site: requiredInteger(record, 'site'),
  };
}

function normalizeBombPlanted(
  record: Record<string, unknown>,
  context: GameEventNormalizationContext,
): BombPlantedGameEvent {
  return {
    kind: 'bomb-planted',
    cursor: context.cursor,
    player: requiredPlayer(record, 'userid'),
    site: requiredInteger(record, 'site'),
    c4EntityId: requiredInteger(record, 'c4'),
  };
}

function normalizeBombBeginDefuse(
  record: Record<string, unknown>,
  context: GameEventNormalizationContext,
): BombBeginDefuseGameEvent {
  return {
    kind: 'bomb-begin-defuse',
    cursor: context.cursor,
    player: requiredPlayer(record, 'userid'),
    hasKit: requiredBoolean(record, 'haskit'),
  };
}

function normalizeBombAbortDefuse(
  record: Record<string, unknown>,
  context: GameEventNormalizationContext,
): BombAbortDefuseGameEvent {
  return {
    kind: 'bomb-abort-defuse',
    cursor: context.cursor,
    player: requiredPlayer(record, 'userid'),
  };
}

function normalizeBombDefused(
  record: Record<string, unknown>,
  context: GameEventNormalizationContext,
): BombDefusedGameEvent {
  return {
    kind: 'bomb-defused',
    cursor: context.cursor,
    player: requiredPlayer(record, 'userid'),
    site: requiredInteger(record, 'site'),
    c4EntityId: requiredInteger(record, 'c4'),
  };
}

function normalizeBombExploded(
  record: Record<string, unknown>,
  context: GameEventNormalizationContext,
): BombExplodedGameEvent {
  return {
    kind: 'bomb-exploded',
    cursor: context.cursor,
    player: requiredPlayer(record, 'userid'),
    site: requiredInteger(record, 'site'),
    c4EntityId: requiredInteger(record, 'c4'),
  };
}

function normalizeBombDropped(
  record: Record<string, unknown>,
  context: GameEventNormalizationContext,
): BombDroppedGameEvent {
  return {
    kind: 'bomb-dropped',
    cursor: context.cursor,
    player: requiredPlayer(record, 'userid'),
    entityId: requiredInteger(record, 'entindex'),
  };
}

function normalizeBombPickup(
  record: Record<string, unknown>,
  context: GameEventNormalizationContext,
): BombPickupGameEvent {
  return {
    kind: 'bomb-pickup',
    cursor: context.cursor,
    sourcePawnId: requiredInteger(record, 'userid_pawn'),
  };
}

/** Normalize one supported cs2parser event without retaining its object graph. */
export function normalizeGameEvent(
  eventName: CstvGameEventName,
  event: unknown,
  context: GameEventNormalizationContext,
): GameEventObservation {
  const record = requiredRecord(event);
  switch (eventName) {
    case 'player_death':
      return normalizePlayerDeath(record, context);
    case 'player_hurt':
      return normalizePlayerHurt(record, context);
    case 'weapon_fire':
      return normalizeWeaponFire(record, context);
    case 'grenade_thrown':
      return normalizeGrenadeThrown(record, context);
    case 'bomb_beginplant':
      return normalizeBombBeginPlant(record, context);
    case 'bomb_abortplant':
      return normalizeBombAbortPlant(record, context);
    case 'bomb_planted':
      return normalizeBombPlanted(record, context);
    case 'bomb_begindefuse':
      return normalizeBombBeginDefuse(record, context);
    case 'bomb_abortdefuse':
      return normalizeBombAbortDefuse(record, context);
    case 'bomb_defused':
      return normalizeBombDefused(record, context);
    case 'bomb_exploded':
      return normalizeBombExploded(record, context);
    case 'bomb_dropped':
      return normalizeBombDropped(record, context);
    case 'bomb_pickup':
      return normalizeBombPickup(record, context);
  }
}
