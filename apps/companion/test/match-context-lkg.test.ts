import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { BroadcastManifest } from '@mizar/rivalhub';
import { afterEach, describe, expect, it } from 'vitest';

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
});
