import { expect, it } from 'vitest';
import { createSeriesProgress, syncSeriesProgress } from '../src/series-progress/reducer.js';
import type { MatchContext } from '../src/match-context/types.js';

const context: MatchContext = {
  matchId: 'match-1',
  competition: null,
  status: 'in_progress',
  format: 'bo1',
  stage: null,
  round: null,
  entryRound: null,
  scheduledAt: null,
  startedAt: null,
  completedAt: null,
  scoreA: null,
  scoreB: null,
  isForfeit: false,
  entrants: {
    a: { entryId: 'entry-a', name: 'Team A', logoUrl: null, rosterId: null, players: [] },
    b: { entryId: 'entry-b', name: 'Team B', logoUrl: null, rosterId: null, players: [] },
  },
  mapPool: ['de_dust2'],
  maps: [
    {
      mapId: 'map-1',
      mapOrder: 1,
      mapName: 'de_dust2',
      pickedByEntryId: null,
      teamAStartSide: null,
      scoreA: null,
      scoreB: null,
      completedAt: null,
    },
  ],
  veto: [],
  commentators: [],
};

it('backfills winnerEntryId on an existing round when sideProof becomes valid without duplicating rounds', () => {
  const initial = createSeriesProgress(context);
  const observation = {
    sourceGeneration: 1,
    mapEpoch: 1,
    mapName: 'de_dust2',
    phase: 'live' as const,
    roundNumber: 1,
    score: { ct: 1, t: 0 },
    roundWins: [
      { roundNumber: 1, winnerSide: 'CT' as const, winCondition: 'elimination' as const },
    ],
  };

  const first = syncSeriesProgress(initial, {
    observation,
    events: [
      {
        kind: 'round-ended',
        roundNumber: 1,
        winnerSide: 'CT',
        winCondition: 'elimination',
        sourceGeneration: 1,
        mapEpoch: 1,
      },
    ],
    sideProof: null,
    allowMapCreation: false,
    restore: false,
  });
  expect(first.progress.maps[0]?.roundHistory.rounds).toHaveLength(1);
  expect(first.progress.maps[0]?.roundHistory.rounds[0]?.winnerEntryId).toBeNull();

  const second = syncSeriesProgress(first.progress, {
    observation,
    events: [
      {
        kind: 'round-ended',
        roundNumber: 1,
        winnerSide: 'CT',
        winCondition: 'elimination',
        sourceGeneration: 1,
        mapEpoch: 1,
      },
    ],
    sideProof: {
      sourceGeneration: 1,
      mapEpoch: 1,
      a: 'CT',
      b: 'T',
      displayOnly: false,
    },
    allowMapCreation: false,
    restore: false,
  });

  const rounds = second.progress.maps[0]?.roundHistory.rounds ?? [];
  expect(rounds).toHaveLength(1);
  expect(rounds[0]?.winnerEntryId).toBe('entry-a');
});
