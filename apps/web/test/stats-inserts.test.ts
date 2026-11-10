import { expect, it } from 'vitest';

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
});
