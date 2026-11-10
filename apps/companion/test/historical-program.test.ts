import { expect, it } from 'vitest';
import { broadcastStatsSchema, type BroadcastStats } from '@mizar/protocol/broadcast-stats';
import type { MatchContextBinding } from '../src/match-context/lkg-store.js';
import { projectHistoricalProgram } from '../src/projections/historical-program.js';
import extended from '../../../tests/fixtures/rivalhub-provider-stats-v1-extended.json' with { type: 'json' };
import scoreboardOnly from '../../../tests/fixtures/rivalhub-provider-stats-v1-scoreboard-only.json' with { type: 'json' };

function binding(raw: BroadcastStats, excluded?: string): MatchContextBinding {
  const team = (entry: BroadcastStats['entrants'][number]) => ({
    entryId: entry.entryId,
    name: entry.name,
    logoUrl: entry.logoUrl,
    players: entry.starters.map((player) => ({
      playerId: player.userId,
      displayName: player.nickname,
      avatarUrl: player.avatarUrl,
      isStarter: player.userId !== excluded,
    })),
  });
  const manifestTeam = (entry: BroadcastStats['entrants'][number]) => ({
    entryId: entry.entryId,
    roster: {
      players: entry.starters.map((player) => ({
        playerId: player.userId,
        isStarter: player.userId !== excluded,
      })),
    },
  });
  return {
    origin: 'online',
    context: {
      matchId: raw.matchId,
      competition: { competitionId: raw.competitionId },
      mapPool: raw.mapPool ?? [],
      entrants: { a: team(raw.entrants[0]!), b: team(raw.entrants[1]!) },
    },
    manifest: {
      match: { matchId: raw.matchId },
      entrants: { a: manifestTeam(raw.entrants[0]!), b: manifestTeam(raw.entrants[1]!) },
    },
  } as unknown as MatchContextBinding;
}

it('does not attach a snapshot from another competition even when match and entrant IDs match', () => {
  const input = broadcastStatsSchema.parse(extended);
  const other = { ...input, competitionId: 'different-competition' };
  const output = projectHistoricalProgram(binding(input), other, null, 'waiting');
  expect(output.history).toEqual([null, null]);
  expect(output.sourceRevision).toBeNull();
  expect(output.pages.some((page) => page.kind === 'overview')).toBe(false);
});

it('requires independent Rating and ADR samples in the program presentation', () => {
  const input = broadcastStatsSchema.parse(extended);
  const invalid = input.entrants[0]!.playerPerformance.players[0]!;
  const valid = input.entrants[0]!.playerPerformance.players[1]!;
  invalid.rating = 10;
  invalid.sample.ratingMaps = 0;
  invalid.adr = 80;
  invalid.sample.adrRounds = null;
  valid.rating = 3;
  valid.sample.ratingMaps = 1;
  valid.adr = 90;
  valid.sample.adrRounds = 0;
  const output = projectHistoricalProgram(binding(input), input, null, 'waiting');
  expect(output.selectedPlayerIds?.[0]).toBe(valid.userId);
  expect(output.displayPlayers.find((p) => p.userId === invalid.userId)?.metrics).toMatchObject({
    rating: { value: null, denominator: 0 },
    adr: { value: null, denominator: null },
  });
  expect(output.displayPlayers.find((p) => p.userId === valid.userId)?.metrics.adr).toMatchObject({
    value: null,
    denominator: 0,
  });
  expect(output.pages.find((page) => page.kind === 'ranking')?.playerIds).not.toContain(
    invalid.userId,
  );
  invalid.sample.ratingMaps = invalid.sample.maps + 1;
  expect(
    projectHistoricalProgram(binding(input), input, null, 'waiting').displayPlayers.find(
      (p) => p.userId === invalid.userId,
    )?.metrics.rating.value,
  ).toBeNull();
});

it('orders only current starters by the confirmed scoreboard multi-kill rate', () => {
  const input = broadcastStatsSchema.parse(scoreboardOnly);
  const first = input.entrants[0]!.facts!.players[0]!;
  const second = input.entrants[0]!.facts!.players[1]!;
  const active = binding(input, first.userId);
  first.scoreboard!.mkpr.value = 0.4;
  second.scoreboard!.mkpr.value = 0.3;
  const output = projectHistoricalProgram(active, input, null, 'waiting');
  const ranking = output.pages.find((page) => page.kind === 'multikill');
  expect(ranking?.playerIds[0]).toBe(second.userId);
  expect(ranking?.playerIds).not.toContain(first.userId);
  expect(ranking?.teamIndices).toEqual([0, 1]);
  expect(output.history[0]?.facts?.players.some((player) => player.userId === first.userId)).toBe(
    false,
  );
});

it('projects scoreboard values and their own samples without requiring detailed data', () => {
  const input = broadcastStatsSchema.parse(scoreboardOnly);
  const output = projectHistoricalProgram(binding(input), input, null, 'waiting');
  const player = output.displayPlayers[0]!;
  expect(player.metrics).toMatchObject({
    kpr: { value: 0.5, denominator: 40, unit: 'per-round' },
    kast: { value: 50, denominator: 20, unit: 'percent' },
    trade: { value: 15, denominator: 20, unit: 'per100' },
    multikill: { value: 10, denominator: 20, unit: 'per100' },
    headshot: { value: 50, denominator: 10, unit: 'percent' },
    kd: { value: 1.25, denominator: 16, unit: 'number' },
    adr: { value: null },
    opening: { value: null },
  });
  const comparison = output.pages.find((page) => page.kind === 'players')!;
  expect(comparison.metricRows.map((item) => item.key)).toEqual(['rating', 'kpr', 'kast', 'trade']);
  expect(comparison.metricRows.find((item) => item.key === 'kast')?.values[0].value).toBe(50);
});

it('selects team and map display fields with their actual samples', () => {
  const input = broadcastStatsSchema.parse(extended);
  const output = projectHistoricalProgram(binding(input), input, null, 'waiting');
  const lookup = (kind: string, key: string) =>
    output.pages.find((page) => page.kind === kind)?.metricRows.find((row) => row.key === key)
      ?.values[0];
  expect(lookup('overview', 'round-win')).toMatchObject({
    numerator: 13,
    denominator: 21,
    unit: 'percent',
  });
  expect(lookup('overview', 'round-win')?.value).toBeCloseTo((13 / 21) * 100);
  expect(lookup('opening', 'trade')).toMatchObject({
    numerator: 3,
    denominator: 21,
    unit: 'per100',
  });
  expect(lookup('utility', 'flashes-thrown')).toMatchObject({
    numerator: 10,
    denominator: 21,
    unit: 'per-round',
  });
  expect(lookup('flash', 'enemy-blind-per-flash')).toMatchObject({
    value: 2,
    numerator: 20,
    denominator: 10,
  });
  expect(lookup('conversion', 'plant-conversion')).toMatchObject({
    value: 60,
    numerator: 3,
    denominator: 5,
  });
  expect(output.pages.find((page) => page.kind === 'map-profile')?.maps[0]?.sides[0]).toMatchObject(
    {
      played: 1,
      wins: 1,
      losses: 0,
      ct: { numerator: 7, denominator: 12 },
      picks: 1,
    },
  );
  expect(output.pages.find((page) => page.kind === 'ranking')?.ranks[0]?.place).toBe(1);
  expect(output.communityDisplay?.percentages[0]).toBeCloseTo(66.6666666);
  expect(output.communityDisplay?.percentages[1]).toBeCloseTo(33.3333333);
});

it('shows observed weapon rows but infers a missing AWP as zero only with explicit completeness', () => {
  const input = broadcastStatsSchema.parse(extended);
  input.entrants[1]!.facts!.weapons![0]!.weapon = 'ak47';
  let output = projectHistoricalProgram(binding(input), input, null, 'waiting');
  const weapons = output.pages.find((page) => page.kind === 'weapons')!;
  expect(weapons.teamIndices).toEqual([0, 1]);
  expect(weapons.weaponCoverage[1]).toMatchObject({
    completeness: 'unknown',
    totalKills: 15,
    rounds: 21,
  });
  expect(weapons.weapons[1][0]).toMatchObject({
    weapon: 'ak47',
    kills: 3,
    share: { value: 20, denominator: 15 },
  });
  let awp = output.pages.find((page) => page.kind === 'awp')!;
  expect(awp.teamIndices).toEqual([0]);
  expect(awp.metricRows.find((row) => row.key === 'awp-kills')?.values[1].value).toBeNull();
  input.entrants[1]!.facts!.weaponsCoverage!.completeness = 'complete';
  output = projectHistoricalProgram(binding(input), input, null, 'waiting');
  awp = output.pages.find((page) => page.kind === 'awp')!;
  expect(awp.teamIndices).toEqual([0, 1]);
  expect(awp.metricRows.find((row) => row.key === 'awp-kills')?.values[1].value).toBe(0);
  expect(awp.metricRows.find((row) => row.key === 'awp-per100')?.values[1]).toMatchObject({
    value: 0,
    denominator: 21,
  });
});
