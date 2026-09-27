import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  MatchContextController,
  MatchManifestLkgStore,
  SourceLoadError,
  createOnlineManifestSource,
} from '../src/match-context/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

it('stages a scoped HTTP Manifest and changes active truth only after explicit confirmation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rh-online-'));
  roots.push(root);
  const manifest = JSON.parse(
    await readFile(
      resolve('packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  ) as { match: { matchId: string } };
  const calls: string[] = [];
  const fetchImpl = vi.fn((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    expect(init?.headers).toEqual({
      Accept: 'application/json',
      Authorization: 'Bearer scoped-read-token',
    });
    expect(init?.redirect).toBe('manual');
    return Promise.resolve(new Response(JSON.stringify(manifest), { status: 200 }));
  }) as typeof fetch;
  const controller = new MatchContextController({
    lkgStore: new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') }),
  });
  const source = createOnlineManifestSource(manifest.match.matchId, {
    urlTemplate: 'https://example.test/matches/{matchId}/broadcast-manifest',
    readToken: 'scoped-read-token',
    fetchImpl,
  });
  const staged = await controller.stageOnlineMatch(manifest.match.matchId, source);
  expect(staged.ok).toBe(true);
  expect(controller.getActiveBinding()).toBeUndefined();
  expect(calls).toEqual([
    `https://example.test/matches/${manifest.match.matchId}/broadcast-manifest`,
  ]);
  const pending = controller.getPendingOnlineCandidate()!;
  const activated = await controller.activatePendingOnlineMatch(
    controller.getActiveRevision(),
    pending.revision,
  );
  expect(activated.ok).toBe(true);
  expect(controller.getActiveBinding()?.context.matchId).toBe(manifest.match.matchId);
  expect(controller.getPendingOnlineCandidate()).toBeUndefined();
  const failedRefresh = await controller.stageOnlineMatch(manifest.match.matchId, {
    kind: 'online',
    load: () => Promise.reject(new SourceLoadError('network unavailable')),
  });
  expect(failedRefresh.ok).toBe(false);
  expect(controller.getActiveBinding()?.freshness).toBe('stale');
  expect(controller.getActiveBinding()?.context.matchId).toBe(manifest.match.matchId);
  expect(controller.getPendingOnlineCandidate()).toBeUndefined();
});

it('never sends a credential to an insecure remote origin or a redirect', async () => {
  expect(() =>
    createOnlineManifestSource('m1', {
      urlTemplate: 'http://example.test/{matchId}',
      readToken: 'secret',
    }),
  ).toThrow();
  const source = createOnlineManifestSource('m1', {
    urlTemplate: 'https://example.test/{matchId}',
    readToken: 'secret',
    fetchImpl: vi.fn(() =>
      Promise.resolve(
        new Response(null, { status: 302, headers: { Location: 'https://other.test/' } }),
      ),
    ),
  });
  await expect(source.load()).rejects.toBeInstanceOf(SourceLoadError);
});
