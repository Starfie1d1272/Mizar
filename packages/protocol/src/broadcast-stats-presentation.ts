import { z } from 'zod';
import {
  broadcastStatsEntrantSchema,
  broadcastStatsFactsSchema,
  broadcastStatsSchema,
} from './broadcast-stats.js';
import { mapSummarySchema, programPresentationSchema } from './program-scenes.js';

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

// Fixed v2 topics and already-selected records for the historical program insert.
// Website statistics are kept in their canonical form; this plan contains no
// user-defined fields or formulas.
const historyPageKind = z.enum([
  'match',
  'current-map',
  'series',
  'bp',
  'lineup',
  'maps',
  'maps-info',
  'map-profile',
  'veto',
  'recent',
  'players',
  'radar',
  'profile',
  'ranking',
  'multikill',
  'overview',
  'economy',
  'opening',
  'advantage',
  'utility',
  'flash',
  'weapons',
  'awp',
  'conversion',
  'clutch',
  'community',
]);
const historyIdentity = z.object({
  entryId: id,
  name,
  logoUrl: media,
  starters: z
    .array(z.object({ userId: id, nickname: z.string().nullable(), avatarUrl: media }))
    .max(10),
});
// Display values are already selected and scaled by Companion. A null value is
// unknown; numerator/denominator preserve the actual source sample.
const displayMetric = z.object({
  value: z.number().finite().nullable(),
  numerator: z.number().finite().nullable(),
  denominator: z.number().finite().nullable(),
  unit: z.enum(['number', 'percent', 'per100', 'per-round', 'seconds', 'count']),
});
const displayPlayer = z.object({
  userId: id,
  teamIndex: z.union([z.literal(0), z.literal(1)]),
  nickname: z.string().nullable(),
  avatarUrl: media,
  maps: count.nullable(),
  rounds: count.nullable(),
  metrics: z.object({
    rating: displayMetric,
    adr: displayMetric,
    kpr: displayMetric,
    kast: displayMetric,
    opening: displayMetric,
    trade: displayMetric,
    multikill: displayMetric,
    headshot: displayMetric,
    kd: displayMetric,
  }),
  attributes: z
    .array(
      z.object({
        key: z.enum([
          'firepower',
          'entrying',
          'trading',
          'opening',
          'clutching',
          'sniping',
          'utility',
        ]),
        score: z.number().min(0).max(100).nullable(),
        status: z.enum(['qualified', 'limited', 'no-data']),
      }),
    )
    .max(7),
  profileMode: z.enum(['identity', 'stats', 'attributes']),
  limited: z.boolean(),
  clutch: z
    .array(z.object({ opponents: z.number().int().min(0).max(5), metric: displayMetric }))
    .max(6),
});
const displayMapSide = z.object({
  played: count.nullable(),
  wins: count.nullable(),
  losses: count.nullable(),
  winRate: displayMetric,
  rounds: displayMetric,
  ct: displayMetric,
  t: displayMetric,
  picks: count.nullable(),
  bans: count.nullable(),
  deciders: count.nullable(),
});
const displayMap = z.object({ name, sides: z.tuple([displayMapSide, displayMapSide]) });
const metricRow = z.object({
  key: z.string().min(1),
  values: z.tuple([displayMetric, displayMetric]),
  // Precomputed comparison scale, in the same unit as value.
  max: z.number().finite().positive(),
});
const historyPage = z.object({
  id: z.string().min(1),
  kind: historyPageKind,
  teamIndices: z.array(z.union([z.literal(0), z.literal(1)])).max(2),
  playerIds: z.array(id).max(20),
  mapNames: z.array(name).max(32),
  recentIds: z.tuple([z.array(id).max(2), z.array(id).max(2)]),
  recentItems: z.tuple([
    z
      .array(
        z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('series'),
            value: broadcastStatsFactsSchema.shape.series.shape.matches.element,
          }),
          z.object({
            kind: z.literal('map'),
            value: broadcastStatsEntrantSchema.shape.recentResults.shape.results.element,
          }),
        ]),
      )
      .max(2),
    z
      .array(
        z.discriminatedUnion('kind', [
          z.object({
            kind: z.literal('series'),
            value: broadcastStatsFactsSchema.shape.series.shape.matches.element,
          }),
          z.object({
            kind: z.literal('map'),
            value: broadcastStatsEntrantSchema.shape.recentResults.shape.results.element,
          }),
        ]),
      )
      .max(2),
  ]),
  vetoSteps: programPresentationSchema.shape.series.unwrap().shape.veto.max(10),
  metricRows: z.array(metricRow),
  maps: z.array(displayMap).max(7),
  lineupHasStats: z.tuple([z.boolean(), z.boolean()]),
  profileDefaultId: id.nullable(),
  pageNumber: z.number().int().positive(),
  pageCount: z.number().int().positive(),
});

export const broadcastStatsProgramSchema = z.object({
  schemaVersion: z.literal('mizar.broadcast-stats-program.v1'),
  matchId: id,
  competitionId: id.nullable(),
  sourceRevision: id.nullable(),
  sourceGeneratedAt: z.iso.datetime().nullable(),
  teams: z.tuple([historyIdentity, historyIdentity]),
  displayPlayers: z.array(displayPlayer).max(20),
  history: z.tuple([
    broadcastStatsEntrantSchema.nullable(),
    broadcastStatsEntrantSchema.nullable(),
  ]),
  mapPool: z.array(name).max(32),
  support: broadcastStatsSchema.shape.support,
  program: programPresentationSchema.nullable(),
  selectedMap: mapSummarySchema.nullable(),
  selectedPlayerIds: z.tuple([id, id]).nullable(),
  radar: z
    .object({
      mode: z.enum(['radar', 'bars']),
      values: z
        .array(
          z.object({
            key: z.enum([
              'firepower',
              'entrying',
              'trading',
              'opening',
              'clutching',
              'sniping',
              'utility',
            ]),
            values: z.tuple([
              z.number().min(0).max(100).nullable(),
              z.number().min(0).max(100).nullable(),
            ]),
          }),
        )
        .length(7),
    })
    .nullable(),
  pages: z.array(historyPage),
});
export type BroadcastStatsProgram = z.infer<typeof broadcastStatsProgramSchema>;
