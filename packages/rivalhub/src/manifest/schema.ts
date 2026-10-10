import { z } from 'zod';
import { liveStreamUrlSchema } from '@mizar/protocol/context';

import {
  broadcastCompetitionSchema,
  broadcastMatchFormatSchema,
  broadcastMatchStatusSchema,
  broadcastSideSchema,
  nullableNumberSchema,
  nullableStringSchema,
} from '../common-schemas.js';
import { BROADCAST_MANIFEST_SCHEMA_VERSION } from './types.js';

export { broadcastCompetitionSchema } from '../common-schemas.js';

export const broadcastMatchSchema = z.object({
  matchId: z.string(),
  competition: broadcastCompetitionSchema,
  status: broadcastMatchStatusSchema,
  format: broadcastMatchFormatSchema,
  stage: z.string(),
  stageKey: nullableStringSchema.optional(),
  stageLabel: nullableStringSchema.optional(),
  round: nullableNumberSchema,
  roundLabel: nullableStringSchema.optional(),
  entryRound: nullableStringSchema,
  matchLabel: nullableStringSchema.optional(),
  stakesLabel: nullableStringSchema.optional(),
  mapPool: z.array(z.string()).optional(),
  scheduledAt: nullableStringSchema,
  startedAt: nullableStringSchema,
  completedAt: nullableStringSchema,
  scoreA: nullableNumberSchema,
  scoreB: nullableNumberSchema,
  resultDisposition: z.enum(['recorded', 'pending', 'omitted']).nullable().optional(),
  isForfeit: z.boolean(),
  isTest: z.boolean().optional(),
});

export const broadcastPlayerSchema = z.object({
  playerId: z.string(),
  steam64: nullableStringSchema,
  displayName: nullableStringSchema,
  avatarUrl: nullableStringSchema,
  isStarter: z.boolean(),
});

export const broadcastRosterSchema = z.object({
  rosterId: nullableStringSchema,
  players: z.array(broadcastPlayerSchema),
});

export const broadcastEntrantSchema = z.object({
  entryId: z.string(),
  name: z.string(),
  logoUrl: nullableStringSchema,
  roster: broadcastRosterSchema,
});

export const broadcastVetoStepSchema = z.object({
  stepOrder: z.number(),
  actionType: z.enum(['ban', 'pick', 'side_pick', 'decider']),
  mapName: z.string(),
  entryId: nullableStringSchema,
  side: broadcastSideSchema.nullable(),
});

export const broadcastMapSchema = z.object({
  mapId: z.string(),
  mapOrder: z.number(),
  mapName: z.string(),
  pickedByEntryId: nullableStringSchema,
  teamAStartSide: broadcastSideSchema.nullable(),
  scoreA: nullableNumberSchema,
  scoreB: nullableNumberSchema,
  completedAt: nullableStringSchema,
});

export const broadcastCommentatorSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  avatarUrl: nullableStringSchema,
  liveStreamUrl: liveStreamUrlSchema,
});

export const broadcastManifestV1Schema = z.object({
  schemaVersion: z.literal(BROADCAST_MANIFEST_SCHEMA_VERSION),
  revision: z.string(),
  match: broadcastMatchSchema,
  entrants: z.object({
    a: broadcastEntrantSchema,
    b: broadcastEntrantSchema,
  }),
  maps: z.array(broadcastMapSchema),
  veto: z.array(broadcastVetoStepSchema),
  commentators: z.array(broadcastCommentatorSchema),
});

export type BroadcastCompetitionSchemaOutput = z.infer<typeof broadcastCompetitionSchema>;
export type BroadcastMatchSchemaOutput = z.infer<typeof broadcastMatchSchema>;
export type BroadcastPlayerSchemaOutput = z.infer<typeof broadcastPlayerSchema>;
export type BroadcastRosterSchemaOutput = z.infer<typeof broadcastRosterSchema>;
export type BroadcastEntrantSchemaOutput = z.infer<typeof broadcastEntrantSchema>;
export type BroadcastVetoStepSchemaOutput = z.infer<typeof broadcastVetoStepSchema>;
export type BroadcastMapSchemaOutput = z.infer<typeof broadcastMapSchema>;
export type BroadcastCommentatorSchemaOutput = z.infer<typeof broadcastCommentatorSchema>;
export type BroadcastManifestSchemaOutput = z.infer<typeof broadcastManifestSchema>;

/** v2 removes event affiliation as a prerequisite; entrant IDs remain opaque runtime identities. */
export const broadcastManifestV2Schema = broadcastManifestV1Schema.extend({
  schemaVersion: z.literal('rivalhub.broadcast-manifest.v2'),
  match: broadcastMatchSchema.extend({
    resultDisposition: z.enum(['recorded', 'pending', 'omitted']).nullable(),
    competition: broadcastCompetitionSchema.nullable(),
    stage: nullableStringSchema,
  }),
});
export const broadcastManifestSchema = z.discriminatedUnion('schemaVersion', [
  broadcastManifestV1Schema,
  broadcastManifestV2Schema,
]);
export type BroadcastManifestV1SchemaOutput = z.infer<typeof broadcastManifestV1Schema>;
