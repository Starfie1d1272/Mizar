import { expect, it } from 'vitest';
import { broadcastStatsSchema } from '@mizar/protocol/broadcast-stats';
import { projectHistoricalStats } from '../src/projections/historical-stats.js';
import fixture from '../../../tests/fixtures/rivalhub-provider-stats-v1.json' with { type: 'json' };
import sparse from '../../../tests/fixtures/rivalhub-provider-stats-v1-sparse.json' with { type: 'json' };

it('selects comparable website facts without altering the original snapshot', () => {
  const input = broadcastStatsSchema.parse(fixture);
  const original = structuredClone(input);
  const projection = projectHistoricalStats(input)!;
  expect(projection.matchId).toBe(input.matchId);
  expect(projection.revision).toBe(input.revision);
  expect(projection.topics.maps[0]).toMatchObject({
    mapName: input.entrants[0]!.mapPerformance.maps[0]!.mapName,
    values: [{ value: 0.5 }, { value: input.entrants[1]!.mapPerformance.maps[0]!.winRate }],
  });
  expect(projection.topics.lineups?.map((entry) => entry.length)).toEqual([5, 5]);
  expect(projection.topics.playerComparison?.players).toEqual(
    projection.topics.playerAttributes?.players,
  );
  expect(projection.topics.playerAttributes?.values).toHaveLength(7);
  expect(input).toEqual(original);
  expect(projectHistoricalStats(broadcastStatsSchema.parse(sparse))?.topics.maps).toEqual([]);
});

it('selects the highest sampled starter independently of ADR and qualifies each row independently', () => {
  const input = broadcastStatsSchema.parse(fixture);
  const team = input.entrants[1]!;
  const top = team.playerPerformance.players[1]!;
  top.rating = 3;
  top.sample.ratingMaps = 1;
  top.adr = null;
  top.available = false;
  team.playerPerformance.available = false;
  team.pistol.pistol = { wins: 0, opportunities: 2, rate: 0 };
  team.pistol.conversion = { wins: 0, opportunities: 0, rate: null };
  team.utility.utilityDamagePerRound = { successes: 0, attempts: 5, rate: 0 };
  team.utility.flashAssistsPerRound = null;
  const projection = projectHistoricalStats(input)!;
  expect(projection.topics.playerComparison?.players[1].userId).toBe(top.userId);
  expect(projection.topics.playerComparison?.adr).toBeNull();
  expect(projection.topics.playerAttributes?.players[1].userId).toBe(top.userId);
  expect(projection.topics.pistol?.pistol?.[1].value).toBe(0);
  expect(projection.topics.pistol?.conversion).toBeNull();
  expect(projection.topics.utility?.utilityDamagePerRound?.[1].value).toBe(0);
  expect(projection.topics.utility?.flashAssistsPerRound).toBeNull();
  top.attributes.values[0]!.status = 'limited';
  expect(projectHistoricalStats(input)?.topics.playerAttributes).toBeNull();
  team.starters = team.starters.slice(0, 4);
  const incomplete = projectHistoricalStats(input)!;
  expect(incomplete.topics.lineups).toBeNull();
  expect(incomplete.topics.playerComparison?.players[1].userId).toBe(top.userId);
});
