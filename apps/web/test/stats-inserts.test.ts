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

it('renders the selected map summary without inventing player statistics', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { StatsInsertView } = await import('@mizar/hud-view');
  const { broadcastStatsProgramSchema } =
    await import('@mizar/protocol/broadcast-stats-presentation');
  const { statsProgramInserts } = await import('../src/program/stats-program');
  const fixture = (await import('./fixtures/stats-program.json')).default;
  const first = fixture.pages[0]!;
  const program = broadcastStatsProgramSchema.parse({
    ...fixture,
    phase: 'intermap',
    summaryHasKAD: false,
    selectedMap: {
      matchId: fixture.matchId,
      mapOrder: 1,
      mapName: 'de_nuke',
      cursor: {
        producerInstanceId: 'test',
        liveSessionId: null,
        runtimeSeq: 1,
        programSourceGeneration: 0,
        programReceiveSequence: null,
        mapEpoch: 1,
      },
      score: { a: 13, b: 5 },
      players: { a: [], b: [] },
    },
    pages: [{ ...first, id: 'current-map', kind: 'current-map' }],
  });
  const card = statsProgramInserts(program)[0]!;
  expect(card.content?.kind).toBe('current-map');
  const html = renderToStaticMarkup(createElement(StatsInsertView, { insert: card }));
  expect(html).toContain('13 : 5');
  expect(html).not.toContain('>K</');
});
