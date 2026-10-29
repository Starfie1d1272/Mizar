import { z } from 'zod';

const id = z.string().min(1).max(128);
const name = z.string().min(1).max(256);
const count = z.number().int().nonnegative().max(1000000);
const media = z.string().max(2048).nullable();
const attribute = z.object({
  key: z.enum(['firepower', 'entrying', 'trading', 'opening', 'clutching', 'sniping', 'utility']),
  score: z.number().min(0).max(100).nullable(),
  status: z.enum(['qualified', 'limited', 'no-data']),
});
const entrant = z.object({
  entryId: id,
  name,
  logoUrl: media,
  starters: z.array(z.object({ userId: id, nickname: name, avatarUrl: media })).max(10),
  mapPerformance: z.object({
    available: z.boolean(),
    maps: z
      .array(
        z.object({
          mapName: name,
          played: count,
          wins: count,
          winRate: z.number().min(0).max(1).nullable(),
        }),
      )
      .max(32),
  }),
  recentResults: z.object({
    available: z.boolean(),
    granularity: z.literal('map'),
    results: z
      .array(
        z.object({
          matchId: id,
          mapName: name,
          completedAt: z.iso.datetime(),
          opponent: z.object({ entryId: id, name, logoUrl: media }),
          score: count,
          opponentScore: count,
        }),
      )
      .max(5),
  }),
  playerPerformance: z.object({
    available: z.boolean(),
    players: z
      .array(
        z.object({
          userId: id,
          sample: z.object({
            maps: count,
            rounds: count.nullable(),
            ratingMaps: count,
            adrRounds: count.nullable(),
          }),
          rating: z.number().finite().nonnegative().nullable(),
          adr: z.number().finite().nonnegative().nullable(),
          attributes: z.object({
            available: z.boolean(),
            benchmark: z.literal('rivalhub-all-time-qualified'),
            scope: z.literal('competition-before-match'),
            sample: z.object({ rounds: count }),
            values: z.array(attribute).max(7),
          }),
        }),
      )
      .max(10),
  }),
});
export const broadcastStatsSchema = z
  .object({
    schemaVersion: z.literal('rivalhub.broadcast-stats.v1'),
    revision: id,
    generatedAt: z.iso.datetime(),
    matchId: id,
    competitionId: id,
    scope: z.object({
      kind: z.literal('competition-before-match'),
      cutoffAt: z.iso.datetime(),
      cutoffSource: z.enum(['startedAt', 'scheduledAt', 'generatedAt']),
    }),
    entrants: z.array(entrant).max(2),
  })
  .superRefine((bundle, ctx) => {
    const unique = (values: string[], path: (string | number)[]) => {
      if (new Set(values).size !== values.length)
        ctx.addIssue({ code: 'custom', path, message: 'Duplicate identity' });
    };
    unique(
      bundle.entrants.map((entry) => entry.entryId),
      ['entrants'],
    );
    unique(
      bundle.entrants.flatMap((entry) => entry.starters.map((player) => player.userId)),
      ['entrants'],
    );
    bundle.entrants.forEach((entry, i) => {
      unique(
        entry.playerPerformance.players.map((player) => player.userId),
        ['entrants', i, 'playerPerformance', 'players'],
      );
      unique(
        entry.mapPerformance.maps.map((map) => map.mapName),
        ['entrants', i, 'mapPerformance', 'maps'],
      );
      entry.playerPerformance.players.forEach((player, j) =>
        unique(
          player.attributes.values.map((item) => item.key),
          ['entrants', i, 'playerPerformance', 'players', j, 'attributes', 'values'],
        ),
      );
    });
  });
export type BroadcastStats = z.infer<typeof broadcastStatsSchema>;
