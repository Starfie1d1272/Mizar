import { z } from 'zod';

// Local, selected presentation facts. The source broadcast-stats.v1 document stays canonical.
const id = z.string().min(1).max(128);
const name = z.string().min(1).max(256);
const media = z.string().max(2048).nullable();
const count = z.number().int().nonnegative().max(1_000_000);
const value = z.number().finite().nonnegative();
const eligibility = z.object({
  eligible: z.boolean(),
  reason: z
    .enum([
      'missing-data',
      'insufficient-sample',
      'incompatible-scope',
      'invalid-data',
      'identity-mismatch',
    ])
    .nullable(),
});
const team = z.object({ entryId: id, name, logoUrl: media });
const player = z.object({ entryId: id, userId: id, nickname: name, avatarUrl: media });
const mapValue = z.object({ played: count, wins: count, winRate: z.number().min(0).max(1) });
const mapRow = z.object({ mapName: name, values: z.tuple([mapValue, mapValue]) });
const recentMap = z.object({
  matchId: id,
  mapName: name,
  completedAt: z.iso.datetime(),
  opponent: team,
  score: count,
  opponentScore: count,
});
const win = z.object({ wins: count, opportunities: count, rate: z.number().min(0).max(1) });
const winPair = z.tuple([win, win]).nullable();
const quantity = z.object({ successes: value, attempts: count, rate: value });
const quantityPair = z.tuple([quantity, quantity]).nullable();
const rating = z.object({ value, sampleMaps: count });
const adr = z.object({ value, sampleRounds: count });
const attributePair = z.tuple([z.number().min(0).max(100), z.number().min(0).max(100)]);

/** A separate local contract for validated selections; values remain unformatted. */
export const broadcastStatsPresentationSchema = z.object({
  schemaVersion: z.literal('mizar.broadcast-stats-presentation.v1'),
  matchId: id,
  competitionId: id,
  sourceRevision: id,
  sourceGeneratedAt: z.iso.datetime(),
  teams: z.tuple([team, team]),
  // The same chosen pair is used by playerComparison and playerAttributes.
  selectedPlayers: z.tuple([player, player]).nullable(),
  maps: z.object({
    id: z.literal('maps'),
    ...eligibility.shape,
    pages: z
      .array(z.object({ page: z.number().int().positive(), rows: z.array(mapRow).max(7) }))
      .max(5),
  }),
  recent: z.object({
    id: z.literal('recent'),
    ...eligibility.shape,
    results: z.tuple([z.array(recentMap).max(5), z.array(recentMap).max(5)]),
  }),
  lineups: z.object({
    id: z.literal('lineups'),
    ...eligibility.shape,
    rows: z.array(z.tuple([player, player])).max(5),
  }),
  pistol: z.object({
    id: z.literal('pistol'),
    ...eligibility.shape,
    pistol: winPair,
    conversion: winPair,
    break: winPair,
  }),
  economy: z.object({ id: z.literal('economy'), ...eligibility.shape, ecoSemiUpset: winPair }),
  utility: z.object({
    id: z.literal('utility'),
    ...eligibility.shape,
    utilityDamagePerRound: quantityPair,
    flashAssistsPerRound: quantityPair,
    enemyBlindSecondsPerFlash: quantityPair,
    enemyBlindSecondsPerRound: quantityPair,
  }),
  playerComparison: z.object({
    id: z.literal('player-comparison'),
    ...eligibility.shape,
    rating: z.tuple([rating, rating]).nullable(),
    adr: z.tuple([adr, adr]).nullable(),
  }),
  playerAttributes: z.object({
    id: z.literal('player-attributes'),
    ...eligibility.shape,
    benchmark: z.literal('rivalhub-all-time-qualified').nullable(),
    scope: z.literal('competition').nullable(),
    sampleRounds: z.tuple([count, count]).nullable(),
    values: z
      .object({
        firepower: attributePair,
        entrying: attributePair,
        trading: attributePair,
        opening: attributePair,
        clutching: attributePair,
        sniping: attributePair,
        utility: attributePair,
      })
      .nullable(),
  }),
});
export type BroadcastStatsPresentation = z.infer<typeof broadcastStatsPresentationSchema>;
