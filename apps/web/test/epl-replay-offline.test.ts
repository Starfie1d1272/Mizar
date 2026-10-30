import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadReplayFixture } from '../src/operator/replay-fixture.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each(['epl-inferno-opening', 'epl-inferno-final-round'] as const)(
  'seeks bundled %s without a development prefix endpoint',
  async (id) => {
    vi.stubGlobal('window', {
      performance,
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal('fetch', async (url: string) => {
      if (!url.startsWith(`/fixtures/${id}/replay/`)) throw new Error('Unexpected endpoint');
      const bytes = await readFile(resolve('apps/web/public', url.slice(1)));
      return new Response(bytes);
    });
    const fixture = await loadReplayFixture(id);
    try {
      const event = fixture.events.at(-1)!;
      await fixture.session.seekEvent(event.id);
      expect(fixture.session.getSnapshot().error).toBeNull();
      expect(fixture.session.getSnapshot().currentIndex).toBe(event.captureIndex);
    } finally {
      fixture.dispose();
    }
  },
);

it('loads the original v8 recorded video without inventing v9 facts', async () => {
  const id = 'epl-inferno-video';
  vi.stubGlobal('window', { performance, setTimeout, clearTimeout });
  vi.stubGlobal('fetch', async (url: string) => {
    if (!url.startsWith(`/fixtures/${id}/replay/`)) throw new Error('Unexpected endpoint');
    return new Response(await readFile(resolve('apps/web/public', url.slice(1))));
  });
  const firstLine = (
    await readFile(resolve('apps/web/public/fixtures', id, 'replay/frames.jsonl'), 'utf8')
  ).split('\n')[0]!;
  const recorded = JSON.parse(firstLine);
  const fixture = await loadReplayFixture(id);
  try {
    const current = fixture.session.getSnapshot().current!;
    expect(recorded.program.schemaVersion).toBe(8);
    expect(current.program.schemaVersion).toBe(9);
    expect(current.program.cursor).toEqual(recorded.program.cursor);
    expect(current.program.payload.players[0]!.matchStats).toEqual(
      recorded.program.payload.players[0].matchStats,
    );
    expect(current.program.payload.players[0]!.statistics.completed.rating2Approx).toMatchObject({
      value: null,
      reason: 'missing-input',
      basis: { coverage: 'unavailable' },
    });
    expect(current.program.payload.players[0]!.equipment).toMatchObject({
      available: false,
      hasC4: null,
    });
    expect(current.program.payload.teamEconomy.ct.money).toBeNull();
    await fixture.session.seekEvent(fixture.events.at(-1)!.id);
    expect(fixture.session.getSnapshot().error).toBeNull();
  } finally {
    fixture.dispose();
  }
});

it('loads the preserved demo reference with unavailable v9 facts', async () => {
  const id = 'nuke-demo-round-01';
  vi.stubEnv('VITE_VISUAL_FIXTURES', '1');
  vi.stubGlobal('window', { performance, setTimeout, clearTimeout });
  vi.stubGlobal('fetch', async (url: string) => {
    if (!url.startsWith(`/fixtures/${id}/replay/`)) throw new Error('Unexpected endpoint');
    return new Response(await readFile(resolve('apps/web/public', url.slice(1))));
  });
  const fixture = await loadReplayFixture(id);
  try {
    const player = fixture.session.getSnapshot().current!.program.payload.players[0]!;
    expect(player.statistics.completed.rating2Approx.value).toBeNull();
    expect(player.equipment.available).toBe(false);
  } finally {
    fixture.dispose();
  }
});
