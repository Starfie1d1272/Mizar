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
const block = {
  available: z.boolean(),
  scope: z.literal('competition'),
  coverage: z.object({ completedMaps: count, detailedMaps: count }),
};
const win = z.object({
  wins: count,
  opportunities: count,
  rate: z.number().min(0).max(1).nullable(),
});
const quantity = z.object({
  successes: z.number().finite().nonnegative(),
  attempts: count,
  rate: z.number().finite().nonnegative().nullable(),
});
const winRate = win.nullable();
const quantityRate = quantity.nullable();
const coverage = z.object({ completedMaps: count, detailedMaps: count });
const rounds = z.object({
  wins: count,
  rounds: count,
  rate: z.number().min(0).max(1).nullable(),
  ct: win,
  t: win,
});
const team = z.object({ entryId: id, name, logoUrl: media });
const scoreboardRound = z.object({
  value: z.number().finite().nonnegative().nullable(),
  rounds: count.nullable(),
});
const scoreboard = z.object({
  source: z.literal('confirmed-scoreboard'),
  kpr: scoreboardRound,
  fkpr: scoreboardRound,
  mkpr: scoreboardRound,
  cpr: scoreboardRound,
  fdpr: scoreboardRound,
  tradeKpr: scoreboardRound,
  kast: scoreboardRound,
  avgHs: z.object({ value: z.number().finite().nonnegative().nullable(), kills: count.nullable() }),
  kd: z.object({ value: z.number().finite().nonnegative().nullable(), deaths: count.nullable() }),
});
const details = z.object({
  sample: z.object({ rounds: count }),
  kast: quantity,
  killsPerRound: quantity,
  headshotRate: quantity,
  twoKillRounds: count,
  threeKillRounds: count,
  fourKillRounds: count,
  fiveKillRounds: count,
  openingSuccess: quantity,
  tradeKillsPerRound: quantity,
  clutch: z.object({
    attempts: count,
    wins: count,
    winRate: quantity,
    byOpponentCount: z.object({
      '1': quantity,
      '2': quantity,
      '3': quantity,
      '4': quantity,
      '5': quantity,
    }),
  }),
});
export const broadcastStatsFactsSchema = z.object({
  source: z.literal('competition-canonical'),
  coverage,
  results: z
    .object({
      matches: count,
      matchWins: count,
      matchLosses: count,
      maps: count,
      mapWins: count,
      mapLosses: count,
    })
    .nullable(),
  maps: z
    .array(
      z.object({
        mapName: name,
        results: z.object({ played: count, wins: count, losses: count }).nullable(),
        rounds: rounds.nullable(),
        selection: z.object({ picks: count, bans: count, deciders: count }).nullable(),
        coverage,
      }),
    )
    .max(32),
  series: z.object({
    total: count,
    truncated: z.boolean(),
    matches: z
      .array(
        z.object({
          matchId: id,
          stage: z.string().max(256),
          round: count.nullable(),
          completedAt: z.iso.datetime().nullable(),
          opponent: team,
          score: count,
          opponentScore: count,
          maps: z
            .array(
              z.object({
                mapName: name,
                completedAt: z.iso.datetime().nullable(),
                score: count.nullable(),
                opponentScore: count.nullable(),
              }),
            )
            .max(5),
        }),
      )
      .max(50),
  }),
  teamRating: z
    .object({ rating: z.number().finite().nonnegative(), ratingSamples: count })
    .nullable(),
  rounds: rounds.nullable(),
  manAdvantage: z.object({ '5v4': win, '4v5': win, '5v3': win, '3v5': win }).nullable(),
  opening: z
    .object({
      successRate: quantity,
      winAfterOpening: quantity,
      tradeKillsPerRound: quantity,
      tradedOpeningDeaths: count,
      firstDeaths: count,
      openingDeathTraded: quantity,
      comebackRate: quantity,
    })
    .nullable(),
  utility: z
    .object({
      sample: z.object({ rounds: count }),
      flashesThrown: count,
      utilityDamagePerRound: quantity,
      flashAssistsPerRound: quantity,
      utilityKillsPerRound: quantity,
      enemyBlindSecondsPerFlash: quantity,
      enemyBlindSecondsPerRound: quantity,
      teamBlindSecondsPerRound: quantity,
    })
    .nullable(),
  plantConversions: quantity.nullable(),
  weapons: z
    .array(z.object({ weapon: name, kills: count, killShare: quantity, killsPerRound: quantity }))
    .max(128)
    .nullable(),
  weaponsCoverage: z
    .object({
      completeness: z.enum(['unknown', 'complete']),
      completedMaps: count,
      detailedMaps: count,
      totalKills: count.nullable(),
      rounds: count,
    })
    .nullable()
    .optional(),
  players: z
    .array(
      z.object({
        userId: id,
        maps: count,
        ratingMaps: count,
        rounds: count.nullable(),
        adrRounds: count.nullable(),
        rating: z.number().finite().nonnegative().nullable(),
        adr: z.number().finite().nonnegative().nullable(),
        kd: z.number().finite().nonnegative().nullable(),
        scoreboard: scoreboard.nullable().optional(),
        detailed: details.nullable(),
      }),
    )
    .max(10),
});
export const broadcastStatsEntrantSchema = z.object({
  facts: broadcastStatsFactsSchema.nullable().optional(),
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
  pistol: z.object({ ...block, pistol: winRate, conversion: winRate, break: winRate }),
  economy: z.object({ ...block, ecoSemiUpset: winRate }),
  utility: z.object({
    ...block,
    utilityDamagePerRound: quantityRate,
    flashAssistsPerRound: quantityRate,
    enemyBlindSecondsPerFlash: quantityRate,
    enemyBlindSecondsPerRound: quantityRate,
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
          available: z.boolean(),
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
            scope: z.literal('competition'),
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
    scope: z.object({ kind: z.literal('competition') }),
    entrants: z.array(broadcastStatsEntrantSchema).max(2),
    mapPool: z.array(name).max(32).nullable().optional(),
    support: z
      .object({
        total: z.string().regex(/^\d+(?:\.\d+)?$/),
        sides: z
          .array(
            z.object({
              entryId: id,
              amount: z.string().regex(/^\d+(?:\.\d+)?$/),
              ratio: z.number().min(0).max(1).nullable(),
            }),
          )
          .max(2),
      })
      .nullable()
      .optional(),
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
      if (entry.facts) {
        unique(
          entry.facts.players.map((player) => player.userId),
          ['entrants', i, 'facts', 'players'],
        );
        unique(
          entry.facts.maps.map((map) => map.mapName),
          ['entrants', i, 'facts', 'maps'],
        );
      }
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
