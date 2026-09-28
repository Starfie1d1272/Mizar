import { z } from 'zod';

export const nullableStringSchema = z.string().nullable();
export const nullableNumberSchema = z.number().nullable();

export const broadcastMatchStatusSchema = z.enum([
  'scheduled',
  'in_progress',
  'finished',
  'cancelled',
]);

export const broadcastMatchFormatSchema = z.enum(['bo1', 'bo3', 'bo5']);
export const broadcastSideSchema = z.enum(['t', 'ct']);

/** Shared read-side competition shape used by Manifest and ScheduleWindow. */
export const broadcastCompetitionSchema = z.object({
  competitionId: z.string(),
  slug: z.string(),
  name: z.string(),
  logoUrl: nullableStringSchema.optional(),
  themeColor: nullableStringSchema,
});
