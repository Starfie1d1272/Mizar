import { describe, expect, it } from 'vitest';
import { broadcastStatsPresentationSchema } from '../src/broadcast-stats-presentation.js';

const unavailable = { eligible: false, reason: 'missing-data' } as const;
const team = { entryId: 'a', name: 'A', logoUrl: null };
const snapshot = {
  schemaVersion: 'mizar.broadcast-stats-presentation.v1',
  matchId: 'match',
  competitionId: 'cup',
  sourceRevision: 'revision',
  sourceGeneratedAt: '2026-10-30T00:00:00Z',
  teams: [team, { ...team, entryId: 'b', name: 'B' }],
  selectedPlayers: null,
  maps: { id: 'maps', ...unavailable, pages: [] },
  recent: { id: 'recent', ...unavailable, results: [[], []] },
  lineups: { id: 'lineups', ...unavailable, rows: [] },
  pistol: { id: 'pistol', ...unavailable, pistol: null, conversion: null, break: null },
  economy: { id: 'economy', ...unavailable, ecoSemiUpset: null },
  utility: {
    id: 'utility',
    ...unavailable,
    utilityDamagePerRound: null,
    flashAssistsPerRound: null,
    enemyBlindSecondsPerFlash: null,
    enemyBlindSecondsPerRound: null,
  },
  playerComparison: { id: 'player-comparison', ...unavailable, rating: null, adr: null },
  playerAttributes: {
    id: 'player-attributes',
    ...unavailable,
    benchmark: null,
    scope: null,
    sampleRounds: null,
    values: null,
  },
};

describe('local historical stats presentation contract', () => {
  it('keeps source identity and fixed topic IDs separate from canonical data', () => {
    expect(broadcastStatsPresentationSchema.parse(snapshot).sourceRevision).toBe('revision');
    expect(
      broadcastStatsPresentationSchema.safeParse({
        ...snapshot,
        maps: { ...snapshot.maps, id: 'translated title' },
      }).success,
    ).toBe(false);
  });
  it('accepts raw numeric values and rejects formatted metric strings', () => {
    const row = {
      mapName: 'de_mirage',
      values: [
        { played: 5, wins: 3, winRate: 0.6 },
        { played: 4, wins: 2, winRate: 0.5 },
      ],
    };
    const maps = { id: 'maps', eligible: true, reason: null, pages: [{ page: 1, rows: [row] }] };
    expect(broadcastStatsPresentationSchema.safeParse({ ...snapshot, maps }).success).toBe(true);
    expect(
      broadcastStatsPresentationSchema.safeParse({
        ...snapshot,
        maps: {
          ...maps,
          pages: [
            {
              page: 1,
              rows: [{ ...row, values: [{ ...row.values[0], winRate: '60%' }, row.values[1]] }],
            },
          ],
        },
      }).success,
    ).toBe(false);
  });
});
