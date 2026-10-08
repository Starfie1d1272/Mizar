import { z } from 'zod';

import {
  broadcastCompetitionSchema,
  broadcastMatchFormatSchema,
  broadcastMatchStatusSchema,
  nullableNumberSchema,
  nullableStringSchema,
} from '../common-schemas.js';
import { BROADCAST_SCHEDULE_WINDOW_SCHEMA_VERSION } from './types.js';

export const broadcastScheduleCompetitionSchema = broadcastCompetitionSchema;

export const broadcastScheduleEntrantSchema = z.object({
  entryId: z.string(),
  name: z.string(),
  logoUrl: nullableStringSchema,
});

export const broadcastScheduleMatchSchema = z.object({
  matchId: z.string(),
  scheduledAt: nullableStringSchema,
  startedAt: nullableStringSchema,
  completedAt: nullableStringSchema,
  status: broadcastMatchStatusSchema,
  format: broadcastMatchFormatSchema,
  stage: z.string(),
  stageLabel: nullableStringSchema.optional(),
  round: nullableNumberSchema,
  roundLabel: nullableStringSchema.optional(),
  matchLabel: nullableStringSchema.optional(),
  isForfeit: z.boolean(),
  isTest: z.boolean().optional(),
  scoreA: nullableNumberSchema,
  scoreB: nullableNumberSchema,
  entrantA: broadcastScheduleEntrantSchema,
  entrantB: broadcastScheduleEntrantSchema,
});

export const broadcastScheduleWindowSchema = z.object({
  schemaVersion: z.literal(BROADCAST_SCHEDULE_WINDOW_SCHEMA_VERSION),
  revision: z.string(),
  competition: broadcastScheduleCompetitionSchema,
  from: z.string(),
  to: z.string(),
  matches: z.array(broadcastScheduleMatchSchema),
});

export type BroadcastScheduleCompetitionSchemaOutput = z.infer<
  typeof broadcastScheduleCompetitionSchema
>;
export type BroadcastScheduleEntrantSchemaOutput = z.infer<typeof broadcastScheduleEntrantSchema>;
export type BroadcastScheduleMatchSchemaOutput = z.infer<typeof broadcastScheduleMatchSchema>;
export type BroadcastScheduleWindowSchemaOutput = z.infer<typeof broadcastScheduleWindowSchema>;
