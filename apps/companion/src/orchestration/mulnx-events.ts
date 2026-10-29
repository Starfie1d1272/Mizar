import { z } from 'zod';
import type { PlayerDeathGameEvent, PlayerHurtGameEvent } from '@mizar/core/game-events';

const integer = z.number().int().safe();
const flag = z.union([z.literal(0), z.literal(1)]);
const playerId = z.string().regex(/^(?:0|\d{17})$/);
const common = {
  sequence: integer.positive(),
  capturedAtUnixMs: integer.nonnegative(),
  attackerSteamId: playerId,
  victimSteamId: playerId,
  weapon: z.string(),
  clientTime: z
    .object({ timeDomain: z.literal('network_game_client_tick'), tick: integer })
    .optional(),
  eventTime: z.object({ timeDomain: z.literal('demo_playback_tick'), tick: integer }).optional(),
};
const message = z.discriminatedUnion('eventType', [
  z.object({
    ...common,
    eventType: z.literal('player_hurt'),
    dmgHealth: integer,
    health: integer,
    hitgroup: integer,
  }),
  z.object({
    ...common,
    eventType: z.literal('player_death'),
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

const clockMessage = z
  .object({
    eventType: z.literal('game_clock'),
    sampledAtUnixMs: integer.nonnegative(),
    timeDomain: z.literal('network_game_client_tick'),
    valid: z.boolean(),
    tick: integer.optional(),
    demoTime: z
      .object({
        timeDomain: z.literal('demo_playback_tick'),
        tick: integer,
        paused: z.boolean().optional(),
      })
      .optional(),
  })
  .refine((value) => !value.valid || value.tick !== undefined);

export interface MulnxClockSample {
  readonly sampledAtUnixMs: number;
  readonly receivedMonotonicMs: number;
  readonly timeDomain: 'network_game_client_tick';
  readonly valid: boolean;
  readonly tick?: number;
  readonly demoTime?: {
    readonly timeDomain: 'demo_playback_tick';
    readonly tick: number;
    readonly paused?: boolean;
  };
}

export function parseMulnxClock(
  input: unknown,
  receivedMonotonicMs: number,
): MulnxClockSample | null {
  const result = clockMessage.safeParse(input);
  if (!result.success || !Number.isFinite(receivedMonotonicMs)) return null;
  const sample = result.data;
  return {
    sampledAtUnixMs: sample.sampledAtUnixMs,
    receivedMonotonicMs,
    timeDomain: sample.timeDomain,
    valid: sample.valid,
    ...(sample.tick === undefined ? {} : { tick: sample.tick }),
    ...(sample.demoTime === undefined
      ? {}
      : {
          demoTime: {
            timeDomain: sample.demoTime.timeDomain,
            tick: sample.demoTime.tick,
            ...(sample.demoTime.paused === undefined ? {} : { paused: sample.demoTime.paused }),
          },
        }),
  };
}

type EventFacts = Omit<PlayerDeathGameEvent, 'cursor'> | Omit<PlayerHurtGameEvent, 'cursor'>;
export interface MulnxEventCandidate {
  readonly sequence: number;
  readonly capturedAtUnixMs: number;
  readonly clientTime?: { readonly timeDomain: 'network_game_client_tick'; readonly tick: number };
  readonly eventTime?: { readonly timeDomain: 'demo_playback_tick'; readonly tick: number };
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
    sequence: event.sequence,
    capturedAtUnixMs: event.capturedAtUnixMs,
    ...(event.clientTime === undefined ? {} : { clientTime: event.clientTime }),
    ...(event.eventTime === undefined ? {} : { eventTime: event.eventTime }),
    facts,
  };
}

/** One instance belongs to one socket; discard it when that socket closes. */
export class MulnxEventSequence {
  private last = 0;

  accept(input: unknown): MulnxEventCandidate | null {
    const event = parseMulnxEvent(input);
    if (event === null || event.sequence <= this.last) return null;
    this.last = event.sequence;
    return event;
  }
}
