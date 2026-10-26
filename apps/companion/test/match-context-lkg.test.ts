import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { BroadcastManifest } from '@mizar/rivalhub';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MatchContextController,
  MatchManifestLkgStore,
  SourceLoadError,
} from '../src/match-context/index.js';

const fixtureRoot = resolve(process.cwd(), 'packages/rivalhub/test/fixtures');
const temporaryRoots: string[] = [];

async function readFixture<T>(fileName: string): Promise<T> {
  return JSON.parse(await readFile(join(fixtureRoot, fileName), 'utf8')) as T;
}

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mizar-m2-'));
  temporaryRoots.push(root);
  return root;
}

function source(kind: 'online' | 'fixture', value: unknown) {
  return { kind, load: () => Promise.resolve(value) } as const;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('Match Manifest last-known-good seam', () => {
  it('clears A before selecting B, so B failure cannot leak A branding', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const store = new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') });
    const controller = new MatchContextController({ lkgStore: store });
    const first = await controller.selectMatch(manifest.match.matchId, source('fixture', manifest));
    expect(first.ok).toBe(true);
    expect(controller.getActiveBinding()?.context.matchId).toBe(manifest.match.matchId);

    const failed = await controller.selectMatch('match-m2-next', {
      kind: 'online',
      load: () => Promise.reject(new SourceLoadError('offline')),
    });

    expect(failed.ok).toBe(false);
    expect(controller.getActiveBinding()).toBeUndefined();
    expect(failed.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['source_load_failed', 'lkg_unavailable']),
    );
  });

  it('uses same-match LKG on source failure and restores deterministically after process restart', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const filePath = join(root, 'manifest.json');
    const store = new MatchManifestLkgStore({ filePath });
    const controller = new MatchContextController({ lkgStore: store });
    expect(
      (await controller.selectMatch(manifest.match.matchId, source('online', manifest))).ok,
    ).toBe(true);

    const restarted = new MatchContextController({
      lkgStore: new MatchManifestLkgStore({ filePath }),
    });
    const result = await restarted.selectMatch(manifest.match.matchId, {
      kind: 'online',
      load: () => Promise.reject(new SourceLoadError('offline')),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('same-match LKG should be used');
    expect(result.binding.origin).toBe('cache');
    expect(result.binding.freshness).toBe('stale');
    expect(result.binding.context).toEqual(controller.getActiveBinding()?.context);
  });
  it('refreshes confirmed results during execution without accepting a changed plan', async () => {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const initial = {
      ...manifest,
      maps: manifest.maps.map((map) => ({
        ...map,
        scoreA: null,
        scoreB: null,
        completedAt: null,
      })),
    };
    const controller = new MatchContextController({
      lkgStore: new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') }),
    });
    await controller.selectMatch(manifest.match.matchId, source('online', initial));
    await controller.refreshOnlineMatch(source('online', manifest), () => false);
    expect(controller.getActiveBinding()?.context.maps[0]).toMatchObject({
      scoreA: 16,
      scoreB: 12,
      completedAt: '2026-09-16T11:15:00.000Z',
    });
    expect(controller.getPendingOnlineCandidate()).toBeUndefined();
    const changed = {
      ...manifest,
      maps: manifest.maps.map((map, index) =>
        index === 1 ? { ...map, teamAStartSide: 't' as const } : map,
      ),
    };
    await controller.refreshOnlineMatch(source('online', changed), () => false);
    expect(controller.getActiveBinding()?.manifest.maps[1]?.teamAStartSide).toBe('ct');
    expect(controller.getPendingOnlineCandidate()).toBeDefined();
  });
});

describe('explicit online library load', () => {
  async function setup() {
    const root = await temporaryDirectory();
    const manifest = await readFixture<BroadcastManifest>('broadcast-manifest-v1.valid.json');
    const store = new MatchManifestLkgStore({ filePath: join(root, 'library-load.json') });
    const controller = new MatchContextController({ lkgStore: store });
    controller.activateFixture(manifest);
    const next = {
      ...manifest,
      revision: 'next-revision',
      match: { ...manifest.match, matchId: 'next-match' },
    };
    return { controller, manifest, next, store };
  }

  it('loads and persists in one action, clears the candidate, and is idempotent', async () => {
    const { controller, next, store } = await setup();
    expect((await controller.loadOnlineMatch(next.match.matchId, source('online', next))).ok).toBe(
      true,
    );
    expect(controller.getActiveBinding()?.context.matchId).toBe(next.match.matchId);
    expect(controller.getPendingOnlineCandidate()).toBeUndefined();
    const saved = await store.readLatest();
    expect(saved.ok && saved.value.context.matchId).toBe(next.match.matchId);
    const revision = controller.getActiveRevision();
    expect((await controller.loadOnlineMatch(next.match.matchId, source('online', next))).ok).toBe(
      true,
    );
    expect(controller.getActiveRevision()).toBe(revision);
  });

  it('keeps the current match on acquisition failure and preserves stage-only compatibility', async () => {
    const { controller, next } = await setup();
    const old = controller.getActiveBinding();
    expect(
      (
        await controller.loadOnlineMatch(next.match.matchId, {
          kind: 'online',
          load: () => Promise.reject(new SourceLoadError('offline')),
        })
      ).ok,
    ).toBe(false);
    expect(controller.getActiveBinding()).toBe(old);
    expect((await controller.stageOnlineMatch(next.match.matchId, source('online', next))).ok).toBe(
      true,
    );
    expect(controller.getActiveBinding()).toBe(old);
    expect(controller.getPendingOnlineCandidate()?.binding.context.matchId).toBe(
      next.match.matchId,
    );
  });

  it('does not overwrite a newer selection when a slow acquisition completes', async () => {
    const { controller, manifest, next } = await setup();
    let release!: (value: unknown) => void;
    const slow = controller.loadOnlineMatch(next.match.matchId, {
      kind: 'online',
      load: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    expect(
      (await controller.loadOnlineMatch(manifest.match.matchId, source('online', manifest))).ok,
    ).toBe(true);
    release(next);
    expect((await slow).ok).toBe(false);
    expect(controller.getActiveBinding()?.context.matchId).toBe(manifest.match.matchId);
  });

  it('refuses activation if the current context changes during acquisition', async () => {
    const { controller, manifest, next } = await setup();
    let release!: (value: unknown) => void;
    const slow = controller.loadOnlineMatch(next.match.matchId, {
      kind: 'online',
      load: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    controller.activateFixture(manifest);
    const changed = controller.getActiveBinding();
    release(next);
    expect((await slow).ok).toBe(false);
    expect(controller.getActiveBinding()).toBe(changed);
  });

  it('keeps the active match when durable publication fails', async () => {
    const { controller, next, store } = await setup();
    const old = controller.getActiveBinding();
    const save = vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('synthetic disk failure'));
    await expect(
      controller.loadOnlineMatch(next.match.matchId, source('online', next)),
    ).rejects.toThrow('synthetic disk failure');
    expect(controller.getActiveBinding()).toBe(old);
    expect(controller.getPendingOnlineCandidate()?.binding.context.matchId).toBe(
      next.match.matchId,
    );
    save.mockRestore();
  });
});
