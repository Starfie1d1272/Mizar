import { describe, expect, it, vi } from 'vitest';
import { playerStatisticsSchema } from '@mizar/protocol';

const { getProgramFixture, statistics } = vi.hoisted(() => {
  const metric = (value: number | null, coverage: string, definition = 'scoreboard-count.v1') => ({
    value,
    basis: {
      source: 'gsi',
      window: 'map-scoreboard',
      definition,
      rounds: null,
      coverage,
    },
    reason: value === null ? 'missing-input' : null,
  });
  const statistics = {
    scoreboard: {
      kills: metric(12, 'complete'),
      assists: metric(null, 'unavailable'),
      deaths: metric(8, 'complete'),
      kdRatio: metric(null, 'unavailable', 'kd-ratio.v1'),
    },
    completed: {
      adr: metric(null, 'unavailable', 'adr.v1'),
      kastPercent: metric(null, 'unavailable', 'kast-percent.v1'),
      impactApprox: metric(null, 'unavailable', 'impact-approx.v1'),
      rating2Approx: metric(null, 'unavailable', 'rating2-approx.v1'),
    },
    includingCurrentRound: { adr: metric(null, 'unavailable', 'adr.v1') },
    currentRound: {
      damage: metric(null, 'unavailable', 'round-damage.v1'),
      moneySpent: metric(null, 'unavailable', 'round-money-spent.v1'),
    },
  };
  return {
    statistics,
    getProgramFixture: vi.fn((id: string) => ({
      cursor: { sequence: 1 },
      payload: {
        match: { matchId: 'match' },
        series: { entrants: { a: { entryId: 'a' }, b: { entryId: 'b' } }, maps: [] },
        teams: { ct: { entryId: 'a' }, t: { entryId: 'b' } },
        map: { name: id, score: { ct: 13, t: 9 } },
        players: [
          { sourcePlayerId: 'one', displayName: 'One', avatarUrl: null, side: 'CT', statistics },
        ],
      },
    })),
  };
});

vi.mock('../src/program/fixtures', () => ({ getProgramFixture }));

import { presentationPreview } from '../src/program/presentation-preview';

describe('presentation preview', () => {
  it('uses the final-map fixture and preserves projected metric values and provenance', () => {
    expect(playerStatisticsSchema.safeParse(statistics).success).toBe(true);
    const presentation = presentationPreview('match_result', null);
    expect(getProgramFixture).toHaveBeenCalledWith('epl-match-result');
    expect(presentation.schemaVersion).toBe('mizar.program-presentation.v2');
    expect(presentation.completed[0]?.mapName).toBe('epl-match-result');
    expect(presentation.completed[0]?.players.a[0]).toMatchObject({
      kills: 12,
      assists: null,
      deaths: 8,
      statistics,
    });
  });
});
