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
  const tick = observerEventTick(row);
  const role = owner.role === 'ahead' ? 'lookahead' : 'program';
  if (
    row.type !== 'raw-event' ||
    row.source !== owner.source ||
    !owner.source.startsWith(`${owner.role}:`) ||
    row.channel !== owner.channel ||
    row.world !== owner.world ||
    context.cursor.role !== role ||
    tick !== context.cursor.tick ||
    typeof row.sequence !== 'number' ||
    !Number.isSafeInteger(row.sequence) ||
    row.sequence < 1 ||
    !Number.isSafeInteger(tick) ||
    tick < 1 ||
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
      !isIndividualSteamId(identity.steamId)
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

/** Validate the public individual account bit fields without losing uint64 precision. */
function isIndividualSteamId(value: string): boolean {
  if (!/^[1-9]\d{0,19}$/.test(value)) return false;
  const id = BigInt(value);
  return (
    id <= 0xffffffffffffffffn &&
    id >> 56n === 1n &&
    ((id >> 52n) & 15n) === 1n &&
    ((id >> 32n) & 0xfffffn) <= 4n &&
    (id & 0xffffffffn) !== 0n
  );
}

/** Event time comes from the source event, with explicit transport context as fallback. */
export function observerEventTick(input: unknown): number {
  const row = record(input);
  const tick = row.eventServerTick ?? row.tick;
  if (typeof tick !== 'number' || !Number.isSafeInteger(tick) || tick < 1)
    throw new Error('Invalid observer event tick');
  return tick;
}
