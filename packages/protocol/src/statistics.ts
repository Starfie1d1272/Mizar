import { z } from 'zod';

export const metricNumberSchema = z.object({
  value: z.number().finite().nullable(),
  basis: z.object({
    source: z.enum(['gsi', 'program-events', 'gsi-and-program-events']),
    window: z.enum([
      'map-scoreboard',
      'current-round',
      'completed-observed-rounds',
      'completed-plus-current',
    ]),
    definition: z.enum([
      'scoreboard-count.v1',
      'kd-ratio.v1',
      'adr.v1',
      'kast-percent.v1',
      'impact-approx.v1',
      'rating2-approx.v1',
      'round-damage.v1',
      'round-money-spent.v1',
    ]),
    rounds: z.number().int().nonnegative().nullable(),
    coverage: z.enum(['complete', 'partial', 'unavailable']),
  }),
  reason: z
    .enum([
      'missing-input',
      'no-rounds',
      'incomplete-coverage',
      'untrusted-events',
      'invalid-input',
      'zero-denominator',
    ])
    .nullable(),
});
export const playerStatisticsSchema = z.object({
  scoreboard: z.object({
    kills: metricNumberSchema,
    assists: metricNumberSchema,
    deaths: metricNumberSchema,
    kdRatio: metricNumberSchema,
  }),
  completed: z.object({
    adr: metricNumberSchema,
    kastPercent: metricNumberSchema,
    impactApprox: metricNumberSchema,
    rating2Approx: metricNumberSchema,
  }),
  includingCurrentRound: z.object({ adr: metricNumberSchema }),
  currentRound: z.object({ damage: metricNumberSchema, moneySpent: metricNumberSchema }),
});
export type MetricNumber = z.infer<typeof metricNumberSchema>;
export type PlayerStatistics = z.infer<typeof playerStatisticsSchema>;
