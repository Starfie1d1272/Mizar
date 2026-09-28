import { z } from 'zod';

export const LIVE_SNAPSHOT_SCHEMA_VERSION = 'mizar.live-snapshot.v1' as const;
export const RELIABLE_EVENT_SCHEMA_VERSION = 'mizar.reliable-event.v1' as const;

const id = z.string().min(1).max(128);
const nullableId = id.nullable();
const utc = z.iso.datetime({ offset: true });
const number = z.number().finite().nullable();
const nonNegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const count = nonNegativeInteger.nullable();
const health = z.number().int().min(0).max(100).nullable();
const economy = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable();
const vector = z
  .strictObject({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
  .nullable();
const cursor = z.strictObject({
  producerInstanceId: id,
  liveSessionId: nullableId,
  runtimeSeq: z.number().int().min(0),
  programSourceGeneration: z.number().int().min(0),
  programReceiveSequence: z.number().int().min(0).nullable(),
  mapEpoch: z.number().int().min(0),
});
const identity = z.enum(['unbound', 'resolving', 'matched', 'degraded', 'mismatch']);
const capability = z.strictObject({
  telemetryFresh: z.boolean(),
  contextFresh: z.boolean(),
  identity,
  lineupComplete: z.boolean(),
  radarCurrent: z.boolean(),
  canonicalTeams: z.boolean(),
});
const player = z.strictObject({
  sourcePlayerId: id,
  canonicalPlayerId: nullableId,
  identityEvidence: z.enum(['canonical', 'observed', 'unresolved']),
  lineupEvidence: z.enum(['current', 'retained']),
  displayName: z.string().max(256).nullable(),
  side: z.enum(['CT', 'T', 'unknown']),
  lifeState: z.enum(['alive', 'dead', 'unknown']),
  health: health,
  armor: health,
  hasHelmet: z.boolean().nullable(),
  hasDefuser: z.boolean().nullable(),
  money: economy,
  equipmentValue: economy,
  activeWeapon: z
    .strictObject({ name: z.string().max(128).nullable(), ammoClip: count, ammoReserve: count })
    .nullable(),
  stats: z.strictObject({
    kills: count,
    assists: count,
    deaths: count,
    liveAdr: number,
    completedAdr: number,
  }),
});
const radar = z.strictObject({
  players: z
    .array(
      z.strictObject({
        sourcePlayerId: id,
        position: vector,
        forward: vector,
      }),
    )
    .max(64),
  bombPosition: vector,
  utility: z
    .array(
      z.strictObject({
        sourceEntityId: id,
        kind: z.string().max(128).nullable(),
        ownerSourceId: nullableId,
        position: vector,
        flames: z.array(z.strictObject({ sourceFlameId: id, position: vector })).max(64),
      }),
    )
    .max(128),
});

export const liveSnapshotV1Schema = z.strictObject({
  schemaVersion: z.literal(LIVE_SNAPSHOT_SCHEMA_VERSION),
  cursor,
  producedAt: utc,
  matchId: id,
  competitionId: id,
  format: z.enum(['bo1', 'bo3', 'bo5']),
  series: z.strictObject({ scoreA: count, scoreB: count, currentMapOrder: count }),
  map: z.strictObject({
    mapId: nullableId,
    name: z.string().max(128).nullable(),
    phase: z.string().max(128).nullable(),
    roundNumber: count,
    scoreCT: count,
    scoreT: count,
  }),
  roundPhase: z.string().max(128).nullable(),
  clock: z
    .strictObject({ phase: z.string().max(128).nullable(), remainingSeconds: number })
    .nullable(),
  teams: z.strictObject({
    ct: z.strictObject({ entryId: nullableId, name: z.string().max(256) }),
    t: z.strictObject({ entryId: nullableId, name: z.string().max(256) }),
  }),
  players: z.array(player).max(64),
  observedPlayerSourceId: nullableId,
  bomb: z
    .strictObject({
      state: z.string().max(128).nullable(),
      carrierSourceId: nullableId,
      action: z
        .strictObject({
          kind: z.enum(['plant', 'defuse']),
          sourcePlayerId: nullableId,
          remainingSeconds: number,
          durationSeconds: number,
        })
        .nullable(),
    })
    .nullable(),
  radar: radar.nullable(),
  capability,
});

export const reliableEventKindV1Schema = z.enum([
  'match_started',
  'map_started',
  'map_ended',
  'series_ended',
  'source_generation_changed',
  'map_epoch_changed',
  'identity_mismatch',
  'lineup_mismatch',
]);
const reliableEventBase = z.strictObject({
  schemaVersion: z.literal(RELIABLE_EVENT_SCHEMA_VERSION),
  idempotencyKey: id,
  cursor,
  observedAt: utc,
  matchId: id,
  competitionId: id,
  contextRevision: id,
  mapId: nullableId,
  mapName: z.string().max(128).nullable(),
  entryAId: id,
  entryBId: id,
  evidence: z.strictObject({
    identity,
    telemetryFresh: z.boolean(),
    contextFresh: z.boolean(),
    source: z.enum(['runtime-transition', 'runtime-continuity', 'series-progress', 'identity']),
  }),
});
const emptyPayload = z.strictObject({});
const reason = z.string().max(128).nullable();
export const reliableEventV1Schema = z.discriminatedUnion('kind', [
  reliableEventBase.extend({ kind: z.literal('match_started'), payload: emptyPayload }),
  reliableEventBase.extend({ kind: z.literal('map_started'), payload: emptyPayload }),
  reliableEventBase.extend({
    kind: z.literal('map_ended'),
    payload: z.strictObject({
      scoreA: nonNegativeInteger,
      scoreB: nonNegativeInteger,
      scoreCT: nonNegativeInteger,
      scoreT: nonNegativeInteger,
    }),
  }),
  reliableEventBase.extend({
    kind: z.literal('series_ended'),
    payload: z.strictObject({ scoreA: count, scoreB: count }),
  }),
  reliableEventBase.extend({
    kind: z.literal('source_generation_changed'),
    payload: z.strictObject({ previousSourceGeneration: count }),
  }),
  reliableEventBase.extend({
    kind: z.literal('map_epoch_changed'),
    payload: z.strictObject({ previousMapEpoch: count, reason }),
  }),
  reliableEventBase.extend({
    kind: z.literal('identity_mismatch'),
    payload: z.strictObject({ reason }),
  }),
  reliableEventBase.extend({
    kind: z.literal('lineup_mismatch'),
    payload: z.strictObject({ reason }),
  }),
]);

export type LiveSnapshotV1 = z.infer<typeof liveSnapshotV1Schema>;
export type ReliableEventV1 = z.infer<typeof reliableEventV1Schema>;
export type ReliableEventKindV1 = z.infer<typeof reliableEventKindV1Schema>;

function boundedParse<T>(schema: z.ZodType<T>, input: unknown, maxBytes: number): T {
  const text = JSON.stringify(input);
  if (text === undefined || new TextEncoder().encode(text).length > maxBytes)
    throw new Error('output_payload_too_large');
  return schema.parse(input);
}
export const parseLiveSnapshotV1 = (input: unknown): LiveSnapshotV1 =>
  boundedParse(liveSnapshotV1Schema, input, 262_144);
export const parseReliableEventV1 = (input: unknown): ReliableEventV1 =>
  boundedParse(reliableEventV1Schema, input, 16_384);
