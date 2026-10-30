import { expect, it } from 'vitest';
import { broadcastStatsSchema } from '@mizar/protocol/broadcast-stats';
import { statsInserts } from '../src/program/stats-inserts';
import fixture from '../../../tests/fixtures/rivalhub-provider-stats-v1.json';
import sparse from '../../../tests/fixtures/rivalhub-provider-stats-v1-sparse.json';

it('renders complete comparisons without borrowing missing statistics or treating zero as missing', () => {
  const first = structuredClone(fixture.entrants[0]!);
  const second = structuredClone(fixture.entrants[1]!);
  second.mapPerformance.maps[0]!.winRate = 0;
  second.mapPerformance.maps[0]!.wins = 0;
  const input = broadcastStatsSchema.parse({ ...fixture, entrants: [first, second] });
  const cards = statsInserts(input);
  expect(cards[0]?.rows[0]?.values).toEqual(['50.0%', '0.0%']);
  expect(cards.some((card) => card.subtitle === 'PLAYER COMPARISON')).toBe(true);
  const portrait = cards.find((card) => card.id === 'player-attributes');
  expect(portrait?.scope).toContain('本届');
  expect(portrait?.rows[0]?.numericValues).toEqual([
    input.entrants[0]!.playerPerformance.players[0]!.attributes.values[0]!.score,
    input.entrants[1]!.playerPerformance.players[0]!.attributes.values[0]!.score,
  ]);
  input.entrants[1]!.playerPerformance.players[1]!.rating = 2;
  const next = statsInserts(input);
  expect(next.find((card) => card.subtitle === 'PLAYER COMPARISON')?.teams[1]).toBe(
    input.entrants[1]!.starters[1]!.nickname,
  );
  expect(next.find((card) => card.subtitle === 'PLAYER ATTRIBUTES')?.teams[1]).toBe(
    input.entrants[1]!.starters[1]!.nickname,
  );
  input.entrants[1]!.playerPerformance.players[1]!.attributes.values[0]!.status = 'limited';
  expect(statsInserts(input).some((card) => card.subtitle === 'PLAYER ATTRIBUTES')).toBe(false);
  input.entrants[1]!.playerPerformance.available = false;
  expect(statsInserts(input).some((card) => card.subtitle === 'PLAYER COMPARISON')).toBe(true);
  input.entrants[1]!.playerPerformance.players[1]!.adr = null;
  const comparison = statsInserts(input).find((card) => card.subtitle === 'PLAYER COMPARISON');
  expect(comparison?.teams[1]).toBe(input.entrants[1]!.starters[1]!.nickname);
  expect(comparison?.rows.map((row) => row.label)).toEqual(['Rating']);
  input.entrants[1]!.mapPerformance.maps[0]!.winRate = null;
  expect(statsInserts(input).some((card) => card.subtitle === 'MAP PERFORMANCE')).toBe(false);
  input.entrants[1]!.playerPerformance.players.push(
    input.entrants[1]!.playerPerformance.players[0]!,
  );
  expect(broadcastStatsSchema.safeParse(input).success).toBe(false);
});

it('requires each team topic’s own fields without depending on maps or player coverage', () => {
  const input = broadcastStatsSchema.parse(fixture);
  for (const title of ['PISTOL & CONVERSION', 'ECONOMY', 'UTILITY'])
    expect(statsInserts(input).some((card) => card.subtitle === title)).toBe(true);
  input.entrants[0]!.mapPerformance.available = false;
  input.entrants[0]!.playerPerformance.available = false;
  input.entrants[0]!.pistol.conversion = null;
  const cards = statsInserts(input);
  expect(
    cards.find((card) => card.subtitle === 'PISTOL & CONVERSION')?.rows.map((r) => r.label),
  ).toEqual(['手枪局', '输手枪后的第二回合']);
  expect(cards.some((card) => card.subtitle === 'ECONOMY')).toBe(true);
  expect(cards.some((card) => card.subtitle === 'UTILITY')).toBe(true);
});

it('keeps valid zero rows and selects the highest sampled Rating independently of ADR', () => {
  const input = broadcastStatsSchema.parse(fixture);
  const team = input.entrants[1]!;
  const top = team.playerPerformance.players[1]!;
  top.rating = 3;
  top.sample.ratingMaps = 1;
  top.adr = null;
  top.available = false;
  team.pistol.conversion = { wins: 0, opportunities: 0, rate: null };
  team.pistol.pistol = { wins: 0, opportunities: 2, rate: 0 };
  team.utility.flashAssistsPerRound = null;
  team.utility.utilityDamagePerRound = { successes: 0, attempts: 5, rate: 0 };
  const cards = statsInserts(input);
  const comparison = cards.find((card) => card.subtitle === 'PLAYER COMPARISON');
  expect(comparison?.teams[1]).toBe(team.starters[1]!.nickname);
  expect(comparison?.rows.map((row) => row.label)).toEqual(['Rating']);
  expect(cards.find((card) => card.subtitle === 'PLAYER ATTRIBUTES')?.teams[1]).toBe(
    team.starters[1]!.nickname,
  );
  const pistol = cards.find((card) => card.subtitle === 'PISTOL & CONVERSION');
  expect(pistol?.rows.find((row) => row.label === '手枪局')?.values[1]).toBe('0.0%');
  expect(pistol?.rows.some((row) => row.label === '赢手枪后的第二回合')).toBe(false);
  const utility = cards.find((card) => card.subtitle === 'UTILITY');
  expect(utility?.rows.find((row) => row.label === '道具伤害 / 回合')?.values[1]).toBe('0.00');
  expect(utility?.rows.some((row) => row.label === '闪光助攻 / 回合')).toBe(false);
});

it('skips incomplete statistics from the provider sparse fixture', () => {
  const cards = statsInserts(broadcastStatsSchema.parse(sparse));
  expect(cards.some((card) => card.subtitle === 'MAP PERFORMANCE')).toBe(false);
});

it('splits a large shared map history into readable pages', () => {
  const input = broadcastStatsSchema.parse(fixture);
  for (let i = 0; i < 8; i++) {
    for (const team of input.entrants) {
      team.mapPerformance.maps.push({ mapName: `de_extra_${i}`, played: 1, wins: 0, winRate: 0 });
    }
  }
  const pages = statsInserts(input).filter((card) => card.subtitle === 'MAP PERFORMANCE');
  expect(pages).toHaveLength(2);
  expect(pages.map((card) => card.rows.length)).toEqual([7, 2]);
  expect(pages[1]!.scope).toContain('2 / 2 页');
});
