import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { validateBroadcastManifest, validateBroadcastScheduleWindow } from '@mizar/rivalhub';
import { RivalHubLibrary } from '../src/match-context/rivalhub-library.js';

it('caches a four-week library, checks individual changes with ETag, persists and keeps stale data on outage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-library-'));
  try {
    const manifestInput: unknown = JSON.parse(
      await readFile(
        new URL(
          '../../../packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const raw: unknown = JSON.parse(
      await readFile(
        new URL(
          '../../../packages/rivalhub/test/fixtures/broadcast-schedule-window-v1.valid.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const validatedManifest = validateBroadcastManifest(manifestInput);
    if (!validatedManifest.ok) throw new Error('fixture invalid');
    let manifest = validatedManifest.value;
    const valid = validateBroadcastScheduleWindow(raw);
    if (!valid.ok) throw new Error('fixture invalid');
    let currentSchedule = {
      ...valid.value,
      matches: valid.value.matches.filter((row) => row.matchId === manifest.match.matchId),
    };
    let clock = Date.parse('2026-09-16T12:00:00Z');
    let offline = false;
    let changed = false;
    const schedule = vi.fn<(from: string, to: string) => Promise<typeof currentSchedule>>(() => {
      if (offline) return Promise.reject(new Error('offline'));
      return Promise.resolve(currentSchedule);
    });
    const request = vi.fn((_operation: string, init?: RequestInit) => {
      if (new Headers(init?.headers).get('if-none-match') === '"original"' && !changed)
        return Promise.resolve(new Response(null, { status: 304 }));
      return Promise.resolve(
        Response.json(manifest, { headers: { etag: changed ? '"changed"' : '"original"' } }),
      );
    });
    const file = join(directory, 'library.json');
    const library = new RivalHubLibrary(file, 'competition-m2', schedule, request, () => clock);
    const settle = async (target = library) => {
      let result = await target.view();
      await vi.waitFor(async () => {
        result = await target.view();
        expect(result.library.refreshing).toBe(false);
      });
      return result;
    };
    const initial = await settle();
    expect(schedule.mock.calls[0]).toEqual([
      '2026-09-02T12:00:00.000Z',
      '2026-09-30T12:00:00.000Z',
    ]);
    const id = manifest.match.matchId;
    expect(initial.library.entries[id]?.document.entrants.a.name).toBe(manifest.entrants.a.name);
    clock += 60_001;
    const unchanged = await settle();
    expect(unchanged.library.entries[id]?.updatedAt).toBe(initial.library.entries[id]?.updatedAt);
    expect(request.mock.calls[1]?.[1]?.headers).toEqual({ 'if-none-match': '"original"' });
    changed = true;
    manifest = {
      ...manifest,
      entrants: { ...manifest.entrants, a: { ...manifest.entrants.a, name: '更新后的队名' } },
    };
    clock += 60_001;
    const updated = await settle();
    expect(updated.library.entries[id]?.document.entrants.a.name).toBe('更新后的队名');
    expect(updated.library.entries[id]?.updatedAt).not.toBe(initial.library.entries[id]?.updatedAt);
    offline = true;
    clock += 60_001;
    const restored = await settle(
      new RivalHubLibrary(file, 'competition-m2', schedule, request, () => clock),
    );
    expect(restored.library.entries[id]?.document.entrants.a.name).toBe('更新后的队名');
    expect(restored.library.error).toContain('保留');
    const wrong = new RivalHubLibrary(file, 'other-competition', schedule, request, () => clock);
    await expect(wrong.view()).rejects.toThrow();
    offline = false;
    currentSchedule = { ...currentSchedule, matches: [] };
    clock += 60_001;
    expect((await settle()).library.entries).toEqual({});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
