import { z } from 'zod';

import {
  localSnapshotEnvelopeSchema,
  projectionCursorSchema,
  type LocalSnapshot,
} from './shared.js';
import { PROGRAM_SCHEMA_VERSION } from './version.js';

const nullableNumber = z.number().nullable();
const nullableString = z.string().nullable();
const nullableBoolean = z.boolean().nullable();
const sourceSideSchema = z.enum(['CT', 'T', 'unknown']);
const coverageSchema = z.enum(['present', 'absent', 'degraded']);
const seriesSelectionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pick'), entryId: z.string().min(1) }),
  z.object({ kind: z.literal('decider') }),
  z.object({ kind: z.literal('unknown') }),
]);
const seriesRoundSchema = z.object({
  roundNumber: z.number().int().positive(),
  winnerSide: sourceSideSchema,
  winnerEntryId: nullableString,
  winCondition: z.enum(['elimination', 'bomb', 'defuse', 'time', 'unknown']),
});
const seriesMapSchema = z.object({
  mapId: nullableString,
  mapOrder: z.number().int().positive(),
  mapName: z.string(),
  selection: seriesSelectionSchema,
  teamAStartSide: z.enum(['CT', 'T']).nullable(),
  status: z.enum(['pending', 'current', 'completed', 'not_played']),
  finalScore: z
    .object({ a: z.number().int().nonnegative(), b: z.number().int().nonnegative() })
    .nullable(),
  winnerEntryId: nullableString,
});
const seriesVetoStepSchema = z.object({
  stepOrder: z.number().int().positive(),
  actionType: z.enum(['ban', 'pick', 'side_pick', 'decider']),
  mapName: z.string(),
  entryId: nullableString,
  side: z.enum(['CT', 'T']).nullable(),
});
const seriesProjectionSchema = z.object({
  format: z.enum(['bo1', 'bo3', 'bo5']),
  requiredWins: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  entrants: z.object({
    a: z.object({ entryId: z.string().min(1), name: z.string(), logoUrl: nullableString }),
    b: z.object({ entryId: z.string().min(1), name: z.string(), logoUrl: nullableString }),
  }),
  score: z.object({
    a: z.number().int().nonnegative().nullable(),
    b: z.number().int().nonnegative().nullable(),
  }),
  resultDisposition: z.enum(['recorded', 'pending', 'omitted']).nullable().optional(),
  status: z.enum(['planned', 'live', 'completed']),
  bindingState: z.enum(['bound', 'unbound', 'needs_operator']),
  currentMapOrder: z.number().int().positive().nullable(),
  maps: z.array(seriesMapSchema),
  veto: z.array(seriesVetoStepSchema),
  roundHistory: z
    .object({
      mapOrder: z.number().int().positive(),
      completeness: z.enum(['complete', 'partial', 'unavailable']),
      rounds: z.array(seriesRoundSchema),
    })
    .nullable(),
});

const teamSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('canonical'),
    entryId: z.string().min(1),
    name: z.string(),
    logoUrl: nullableString,
    seriesScore: nullableNumber,
  }),
  z.object({
    mode: z.literal('neutral'),
    entryId: z.null(),
    name: z.enum(['CT', 'T']),
    logoUrl: z.null(),
    seriesScore: z.null(),
  }),
]);

const playerStateSchema = z.object({
  health: nullableNumber,
  armor: nullableNumber,
  hasHelmet: nullableBoolean,
  hasDefuser: nullableBoolean,
  flashed: nullableNumber,
  smoked: nullableNumber,
  burning: nullableNumber,
  money: nullableNumber,
  roundTotalDamage: nullableNumber,
  roundKills: nullableNumber,
  roundKillHeadshots: nullableNumber,
  equipValue: nullableNumber,
});

const matchStatsSchema = z.object({
  kills: nullableNumber,
  assists: nullableNumber,
  deaths: nullableNumber,
  mvps: nullableNumber,
  score: nullableNumber,
});

const weaponSchema = z.object({
  sourceWeaponId: z.string(),
  name: nullableString,
  paintKit: nullableString,
  type: nullableString,
  ammoClip: nullableNumber,
  ammoClipMax: nullableNumber,
  ammoReserve: nullableNumber,
  state: z.enum(['active', 'holstered', 'reloading', 'unknown']).nullable(),
});

const playerSchema = z.object({
  sourcePlayerId: z.string(),
  canonicalPlayerId: nullableString,
  identityEvidence: z.enum(['canonical', 'observed', 'unresolved']),
  lineupEvidence: z.enum(['current', 'retained']),
  displayName: nullableString,
  displayNameSource: z.enum(['canonical', 'observed', 'unavailable']),
  avatarUrl: nullableString,
  side: sourceSideSchema,
  observerSlot: nullableNumber,
  activity: nullableString,
  lifeState: z.enum(['alive', 'dead', 'unknown']),
  liveAdr: nullableNumber,
  completedAdr: nullableNumber,
  weaponsAvailable: z.boolean(),
  currentRoundDamage: nullableNumber,
  roundMoneySpent: nullableNumber,
  state: playerStateSchema.nullable(),
  matchStats: matchStatsSchema.nullable(),
  weapons: z.array(weaponSchema),
});

const objectiveClockSchema = z.object({
  remainingSeconds: nullableNumber,
  durationSeconds: nullableNumber,
});

const bombActionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('plant'),
    sourcePlayerId: nullableString,
    remainingSeconds: nullableNumber,
    durationSeconds: nullableNumber,
  }),
  z.object({
    kind: z.literal('defuse'),
    sourcePlayerId: nullableString,
    remainingSeconds: nullableNumber,
    durationSeconds: nullableNumber,
    hasDefuseKit: nullableBoolean,
  }),
]);

const bombSchema = z.object({
  state: z
    .enum([
      'carried',
      'dropped',
      'planting',
      'planted',
      'defusing',
      'exploded',
      'defused',
      'unknown',
    ])
    .nullable(),
  sourcePlayerId: nullableString,
  explosion: objectiveClockSchema.nullable(),
  action: bombActionSchema.nullable(),
});

export const bombDamageSchema = z.object({
  status: z.enum(['available', 'unavailable']),
  reason: z.string().max(160).nullable(),
  model: z
    .object({
      packageVersion: z.enum(['0.1.0', '0.1.1']),
      mapName: z.string().max(64),
      modelRevision: z.string().max(128),
      resourceSha256: z.string().length(64),
    })
    .nullable(),
  players: z
    .array(
      z.discriminatedUnion('status', [
        z.object({
          sourcePlayerId: z.string(),
          status: z.literal('unavailable'),
          reason: z.string().max(160),
        }),
        z.object({
          sourcePlayerId: z.string(),
          status: z.literal('predicted'),
          stance: z.literal('standing'),
          damage: z.number().int().min(0).max(255),
          hpAfter: z.number().finite().min(0),
          lethal: z.boolean(),
          modelRevision: z.string().max(128),
          assumptions: z.array(z.string().max(256)).max(32),
          unknownInputs: z.array(z.string().max(256)).max(32),
        }),
      ]),
    )
    .max(10),
});
export const programPayloadSchema = z.object({
  bombDamage: bombDamageSchema,
  status: z.object({
    telemetry: z.enum(['awaiting', 'fresh', 'stale']),
    context: z.enum(['unbound', 'fresh', 'stale']),
    identity: z.enum(['unbound', 'resolving', 'matched', 'degraded', 'mismatch']),
  }),
  match: z
    .object({
      matchId: z.string(),
      competition: z
        .object({
          competitionId: z.string(),
          slug: z.string(),
          name: z.string(),
          themeColor: nullableString,
        })
        .nullable(),
      format: z.enum(['bo1', 'bo3', 'bo5']),
      stage: z.string().nullable(),
    })
    .nullable(),
  teams: z.object({ ct: teamSchema, t: teamSchema }),
  series: seriesProjectionSchema.nullable(),
  map: z.object({
    roundHistory: z
      .object({
        completeness: z.enum(['complete', 'partial', 'unavailable']),
        rounds: z.array(seriesRoundSchema).max(256),
      })
      .nullable()
      .optional(),
    name: nullableString,
    mode: nullableString,
    phase: z.enum(['warmup', 'live', 'intermission', 'gameover', 'unknown']).nullable(),
    roundNumber: nullableNumber,
    score: z.object({ ct: nullableNumber, t: nullableNumber }),
    timeoutsRemaining: z.object({ ct: nullableNumber, t: nullableNumber }),
    consecutiveRoundLosses: z.object({ ct: nullableNumber, t: nullableNumber }),
  }),
  round: z
    .object({
      phase: z.enum(['freezetime', 'live', 'over', 'unknown']).nullable(),
      winnerSide: sourceSideSchema,
    })
    .nullable(),
  clock: z
    .object({
      phase: z
        .enum([
          'paused',
          'timeout_ct',
          'timeout_t',
          'warmup',
          'freezetime',
          'live',
          'bomb',
          'defuse',
          'over',
          'unknown',
        ])
        .nullable(),
      endsInSeconds: nullableNumber,
    })
    .nullable(),
  observedPlayerSourceId: nullableString,
  players: z.array(playerSchema),
  bomb: bombSchema.nullable(),
  coverage: z.object({
    map: coverageSchema,
    round: coverageSchema,
    phaseCountdowns: coverageSchema,
    player: coverageSchema,
    allPlayers: coverageSchema,
    bomb: coverageSchema,
  }),
});

export const programSnapshotSchema = localSnapshotEnvelopeSchema.extend({
  channel: z.literal('program'),
  schemaVersion: z.literal(PROGRAM_SCHEMA_VERSION),
  cursor: projectionCursorSchema,
  payload: programPayloadSchema,
});

export type ProgramPayload = z.infer<typeof programPayloadSchema>;
export type ProgramSnapshot = z.infer<typeof programSnapshotSchema>;
export type ProgramSnapshotInput = Omit<
  LocalSnapshot<ProgramPayload, typeof PROGRAM_SCHEMA_VERSION>,
  'channelSeq'
> & {
  readonly channel: 'program';
  readonly schemaVersion: typeof PROGRAM_SCHEMA_VERSION;
};

export const ProgramPayloadSchema = programPayloadSchema;
export const ProgramSnapshotSchema = programSnapshotSchema;
