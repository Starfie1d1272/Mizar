import type { GameEventObservation } from '@mizar/core/game-events';
import { SUPPORTED_CSTV_GAME_EVENT_NAMES, type CstvGameEventName } from '../types.js';
import { normalizeGameEvent, type GameEventNormalizationContext } from './events.js';
import { asRecord } from './player.js';

/** Identity supplied by the local source owner, never inferred from event payload fields. */
export interface ObserverSourceIdentity {
  readonly source: string;
  readonly role: 'ahead' | 'delayed';
  readonly channel: number;
  readonly world: number;
}

function record(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  if (result === undefined || Array.isArray(value)) throw new Error('Invalid observer record');
  return result;
}

/**
 * Adapt a committed ordinary-observer event without treating controller slots as userids.
 * Transport ownership and discontinuity handling remain with the caller.
 */
export function normalizeObserverGameEvent(
  input: unknown,
  owner: ObserverSourceIdentity,
  context: GameEventNormalizationContext,
): GameEventObservation {
  const row = record(input);
  const role = owner.role === 'ahead' ? 'lookahead' : 'program';
  if (
    row.type !== 'raw-event' ||
    row.source !== owner.source ||
    !owner.source.startsWith(`${owner.role}:`) ||
    row.channel !== owner.channel ||
    row.world !== owner.world ||
    context.cursor.role !== role ||
    row.tick !== context.cursor.tick ||
    typeof row.sequence !== 'number' ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    typeof row.tick !== 'number' ||
    !Number.isSafeInteger(row.tick) ||
    row.tick < 1 ||
    typeof row.committedTick !== 'number' ||
    !Number.isSafeInteger(row.committedTick) ||
    row.committedTick < 1 ||
    typeof row.name !== 'string' ||
    !SUPPORTED_CSTV_GAME_EVENT_NAMES.includes(row.name as CstvGameEventName)
  )
    throw new Error('Observer source or event mismatch');

  const sourceFields = record(row.fields);
  const identities = record(row.players);
  const fields: Record<string, unknown> = { ...sourceFields };
  for (const [key, playerKey] of [
    ['userid', 'player'],
    ['attacker', 'attackerPlayer'],
    ['assister', 'assisterPlayer'],
  ] as const) {
    // The raw type9 scalar is a controller slot. Only the separately resolved
    // userinfo userid may enter the existing sourceUserId contract.
    fields[key] = undefined;
    fields[playerKey] = undefined;
    const identityValue = identities[key];
    if (identityValue === null || identityValue === undefined) continue;
    const identity = record(identityValue);
    const rawSlot = sourceFields[key];
    if (
      identity.domain !== 'player-controller-slot' ||
      typeof rawSlot !== 'number' ||
      !Number.isInteger(rawSlot) ||
      (rawSlot & 0xffff) === 0xffff ||
      identity.slot !== (rawSlot & 0xff) ||
      typeof identity.userId !== 'number' ||
      !Number.isSafeInteger(identity.userId) ||
      identity.userId <= 0 ||
      identity.userId > 0x7fffffff ||
      typeof identity.steamId !== 'string' ||
      !/^7656119\d{10}$/.test(identity.steamId)
    )
      continue;
    const controller = record(identity.controller);
    if (
      controller.index !== (rawSlot & 0xff) + 1 ||
      typeof controller.serial !== 'number' ||
      !Number.isInteger(controller.serial) ||
      controller.serial < 0 ||
      controller.serial > 0x1ffff
    )
      continue;
    fields[key] = identity.userId;
    fields[playerKey] = { steamId: identity.steamId };
  }
  return normalizeGameEvent(row.name as CstvGameEventName, fields, context);
}
