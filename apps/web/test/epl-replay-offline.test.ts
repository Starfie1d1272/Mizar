import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { loadReplayFixture } from '../src/operator/replay-fixture.js';

afterEach(() => vi.unstubAllGlobals());

it.each(['epl-inferno-opening', 'epl-inferno-final-round'] as const)(
  'seeks bundled %s without a development prefix endpoint',
  async (id) => {
    const requests: string[] = [];
    vi.stubGlobal('window', {
      performance,
      setTimeout,
      clearTimeout,
    });
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(url);
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
      expect(requests).toHaveLength(5);
    } finally {
      fixture.dispose();
    }
  },
);
