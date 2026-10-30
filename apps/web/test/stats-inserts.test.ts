import { expect, it } from 'vitest';
import { broadcastStatsPresentationSchema } from '@mizar/protocol/broadcast-stats-presentation';
import { statsInserts } from '../src/program/stats-inserts';
import fixture from '../../../tests/fixtures/mizar-broadcast-stats-presentation-v1.json';

it('formats only eligible projection topics and preserves raw radar values', () => {
  const input = broadcastStatsPresentationSchema.parse(fixture);
  const cards = statsInserts(input);
  expect(cards.find((card) => card.id === 'maps')?.rows[0]?.values).toEqual(['50.0%', '50.0%']);
  const portrait = cards.find((card) => card.id === 'player-attributes')!;
  expect(portrait.scope).toContain('本届');
  expect(portrait.rows[0]?.numericValues).toEqual(input.playerAttributes.values!.firepower);
  expect(cards.find((card) => card.id === 'player-comparison')?.teams).toEqual(
    input.selectedPlayers!.map((player) => player.nickname),
  );
  input.pistol.conversion = null;
  input.utility.flashAssistsPerRound = null;
  input.playerAttributes.eligible = false;
  const filtered = statsInserts(input);
  expect(filtered.find((card) => card.id === 'pistol')?.rows.map((row) => row.label)).toEqual([
    '手枪局',
    '输手枪后的第二回合',
  ]);
  expect(
    filtered
      .find((card) => card.id === 'utility')
      ?.rows.some((row) => row.label === '闪光助攻 / 回合'),
  ).toBe(false);
  expect(filtered.some((card) => card.id === 'player-attributes')).toBe(false);
});

it('renders each supplied map page and its samples without changing their order', () => {
  const input = broadcastStatsPresentationSchema.parse(fixture);
  const first = input.maps.pages[0]!.rows[0]!;
  input.maps.pages = [
    { page: 1, rows: [first] },
    { page: 2, rows: [first] },
  ];
  const cards = statsInserts(input).filter((card) => card.id === 'maps');
  expect(cards).toHaveLength(2);
  expect(cards[1]!.scope).toContain('2 / 2 页');
  expect(cards[0]!.rows[0]!.samples).toEqual([
    `${first.values[0].played} 图`,
    `${first.values[1].played} 图`,
  ]);
});

it('renders the Companion program pages in their supplied order and preserves missing and zero metrics', async () => {
  const { broadcastStatsProgramSchema } =
    await import('@mizar/protocol/broadcast-stats-presentation');
  const { statsProgramInserts } = await import('../src/program/stats-program');
  const fixture = (await import('./fixtures/stats-program.json')).default;
  const projection = broadcastStatsProgramSchema.parse(fixture);
  const maps = projection.pages.find((page) => page.kind === 'maps')!;
  maps.maps[0]!.sides[0].winRate.value = 0;
  maps.maps[0]!.sides[1].winRate.value = null;
  const cards = statsProgramInserts(projection);
  expect(cards.map((card) => card.id)).toEqual(projection.pages.map((page) => page.id));
  expect(cards.find((card) => card.id === maps.id)!.rows[0]!.values).toEqual(['0%', '—']);
  expect(cards.find((card) => card.id === 'economy')?.layout).toBe('columns');
  expect(cards.find((card) => card.id === 'conversion')?.layout).toBe('comparison');
  expect(cards.find((card) => card.id === 'lineup')?.content?.kind).toBe('lineup');
  expect(cards.find((card) => card.id === 'weapons')?.content?.kind).toBe('weapons');
});
