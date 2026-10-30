import { expect, it } from 'vitest';
import { broadcastStatsSchema } from '@mizar/protocol/broadcast-stats';
import {
  bindHistoricalStats,
  projectHistoricalStats,
} from '../src/projections/historical-stats.js';
import expected from '../../../tests/fixtures/mizar-broadcast-stats-presentation-v1.json' with { type: 'json' };
import fixture from '../../../tests/fixtures/rivalhub-provider-stats-v1.json' with { type: 'json' };
import type { BroadcastManifest } from '@mizar/rivalhub';
import sparse from '../../../tests/fixtures/rivalhub-provider-stats-v1-sparse.json' with { type: 'json' };

it('selects comparable website facts without altering the original snapshot', () => {
  const input = broadcastStatsSchema.parse(fixture);
  const original = structuredClone(input);
  const projection = projectHistoricalStats(input)!;
  expect(projection).toEqual(expected);
  expect(projection.matchId).toBe(input.matchId);
  expect(projection.sourceRevision).toBe(input.revision);
  expect(projection.maps.pages[0]!.rows[0]).toMatchObject({
    mapName: input.entrants[0]!.mapPerformance.maps[0]!.mapName,
    values: [{ winRate: 0.5 }, { winRate: input.entrants[1]!.mapPerformance.maps[0]!.winRate }],
  });
  expect(projection.lineups.rows.map((entry) => entry.length)).toEqual([2, 2, 2, 2, 2]);
  expect(projection.selectedPlayers).not.toBeNull();
  expect(Object.keys(projection.playerAttributes.values!)).toHaveLength(7);
  expect(input).toEqual(original);
  expect(projectHistoricalStats(broadcastStatsSchema.parse(sparse))?.maps.pages).toEqual([]);
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
  expect(projection.selectedPlayers?.[1].userId).toBe(top.userId);
  expect(projection.playerComparison.adr).toBeNull();
  expect(projection.selectedPlayers?.[1].userId).toBe(top.userId);
  expect(projection.pistol.pistol?.[1].rate).toBe(0);
  expect(projection.pistol.conversion).toBeNull();
  expect(projection.utility.utilityDamagePerRound?.[1].rate).toBe(0);
  expect(projection.utility.flashAssistsPerRound).toBeNull();
  top.attributes.values[0]!.status = 'limited';
  expect(projectHistoricalStats(input)?.playerAttributes.eligible).toBe(false);
  team.starters = team.starters.slice(0, 4);
  const incomplete = projectHistoricalStats(input)!;
  expect(incomplete.lineups.eligible).toBe(false);
  expect(incomplete.selectedPlayers?.[1].userId).toBe(top.userId);
});

it('binds ordered entrants and starters to the active match before projection', () => {
  const input = broadcastStatsSchema.parse(fixture);
  const manifest = {
    match: { matchId: input.matchId },
    entrants: {
      a: {
        entryId: 'a',
        roster: { players: Array.from({ length: 5 }, () => ({ playerId: '', isStarter: false })) },
      },
      b: {
        entryId: 'b',
        roster: { players: Array.from({ length: 5 }, () => ({ playerId: '', isStarter: false })) },
      },
    },
  } as unknown as BroadcastManifest;
  const mutable = manifest as unknown as {
    match: { matchId: string };
    entrants: {
      a: { entryId: string; roster: { players: Array<{ playerId: string; isStarter: boolean }> } };
      b: { entryId: string; roster: { players: Array<{ playerId: string; isStarter: boolean }> } };
    };
  };
  mutable.match.matchId = input.matchId;
  for (const [index, team] of [mutable.entrants.a, mutable.entrants.b].entries()) {
    team.entryId = input.entrants[1 - index]!.entryId;
    team.roster.players.forEach((player, i) => {
      player.isStarter = i === 0;
      player.playerId = input.entrants[1 - index]!.starters[0]!.userId;
    });
  }
  const bound = bindHistoricalStats(input, manifest)!;
  expect(bound.entrants.map((team) => team.entryId)).toEqual([
    input.entrants[1]!.entryId,
    input.entrants[0]!.entryId,
  ]);
  expect(bound.entrants.map((team) => team.starters.length)).toEqual([1, 1]);
  mutable.match.matchId = 'different';
  expect(bindHistoricalStats(input, manifest)).toBeNull();
});

it('pages comparable maps and rejects rows with missing or inconsistent samples', () => {
  const input = broadcastStatsSchema.parse(fixture);
  for (let i = 0; i < 8; i++) {
    for (const team of input.entrants)
      team.mapPerformance.maps.push({ mapName: `de_extra_${i}`, played: 1, wins: 0, winRate: 0 });
  }
  const pages = projectHistoricalStats(input)!.maps.pages;
  expect(pages.map((page) => page.rows.length)).toEqual([7, 2]);
  input.entrants[1]!.mapPerformance.maps[0]!.winRate = null;
  input.entrants[1]!.mapPerformance.maps[1]!.wins = 2;
  const filtered = projectHistoricalStats(input)!.maps.pages.flatMap((page) => page.rows);
  expect(filtered).toHaveLength(7);
  expect(filtered.every((row) => row.mapName.startsWith('de_extra_'))).toBe(true);
});
