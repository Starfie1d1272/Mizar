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
  expect(cards.find((card) => card.subtitle === 'PLAYER ATTRIBUTES')?.scope).toContain('本届');
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
  expect(statsInserts(input).some((card) => card.subtitle === 'PLAYER COMPARISON')).toBe(false);
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
  expect(cards.some((card) => card.subtitle === 'PISTOL & CONVERSION')).toBe(false);
  expect(cards.some((card) => card.subtitle === 'ECONOMY')).toBe(true);
  expect(cards.some((card) => card.subtitle === 'UTILITY')).toBe(true);
});

it('skips incomplete statistics from the provider sparse fixture', () => {
  const cards = statsInserts(broadcastStatsSchema.parse(sparse));
  expect(cards.some((card) => card.subtitle === 'MAP PERFORMANCE')).toBe(false);
});
