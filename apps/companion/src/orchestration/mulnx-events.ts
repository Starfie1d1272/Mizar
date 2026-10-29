import { z } from 'zod';
import type { PlayerDeathGameEvent, PlayerHurtGameEvent } from '@mizar/core/game-events';

const integer = z.number().int().safe();
const flag = z.union([z.literal(0), z.literal(1)]);
const playerId = z.string().regex(/^(?:0|\d{17})$/);
const common = {
  attackerSteamId: playerId,
  victimSteamId: playerId,
  weapon: z.string(),
};
const message = z.union([
  z.object({
    ...common,
    eventType: z.literal('player_hurt'),
    dmgHealth: integer,
    health: integer,
    hitgroup: integer,
  }),
  z.object({
    ...common,
    eventType: z.never().optional(),
    capturedAtUnixMs: integer.nonnegative().optional(),
    networkGameClientTick: integer.optional(),
    assistSteamId: playerId,
    assistedflash: flag,
    headshot: flag,
    penetrated: integer.nonnegative(),
    noscope: flag,
    thrusmoke: flag,
    attackerblind: flag,
    attackerinair: flag,
  }),
]);

type EventFacts = Omit<PlayerDeathGameEvent, 'cursor'> | Omit<PlayerHurtGameEvent, 'cursor'>;
export interface MulnxEventCandidate {
  readonly capturedAtUnixMs?: number;
  readonly networkGameClientTick?: number;
  readonly facts: EventFacts;
}

function player(id: string) {
  return id === '0' ? {} : { sourcePlayerId: id };
}

/** Parse only HSI events. A candidate has no verified session, map or source cursor. */
export function parseMulnxEvent(input: unknown): MulnxEventCandidate | null {
  const result = message.safeParse(input);
  if (!result.success) return null;
  const event = result.data;
  const shared = {
    victim: player(event.victimSteamId),
    ...(event.attackerSteamId === '0' ? {} : { attacker: player(event.attackerSteamId) }),
    weapon: event.weapon,
  };
  const facts: EventFacts =
    event.eventType === 'player_hurt'
      ? {
          ...shared,
          kind: 'player-hurt',
          damageHealth: event.dmgHealth,
          healthRemaining: event.health,
          hitgroup: event.hitgroup,
        }
      : {
          ...shared,
          kind: 'player-death',
          ...(event.assistSteamId === '0' ? {} : { assister: player(event.assistSteamId) }),
          assistedFlash: event.assistedflash === 1,
          headshot: event.headshot === 1,
          penetratedObjects: event.penetrated,
          noScope: event.noscope === 1,
          throughSmoke: event.thrusmoke === 1,
          attackerBlind: event.attackerblind === 1,
          attackerInAir: event.attackerinair === 1,
        };
  return {
    ...('capturedAtUnixMs' in event && event.capturedAtUnixMs !== undefined
      ? { capturedAtUnixMs: event.capturedAtUnixMs }
      : {}),
    ...('networkGameClientTick' in event && event.networkGameClientTick !== undefined
      ? { networkGameClientTick: event.networkGameClientTick }
      : {}),
    facts,
  };
}
