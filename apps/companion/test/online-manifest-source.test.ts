import type { BroadcastManifest } from '@mizar/rivalhub';
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

it.each([
  ['network', () => Promise.reject(new TypeError('secret-token /private/path')), 'network'],
  ['timeout', () => Promise.reject(new DOMException('private', 'TimeoutError')), 'timeout'],
  [
    'authorization',
    () => Promise.resolve(new Response('private-token', { status: 401 })),
    'authorization',
  ],
  ['not-found', () => Promise.resolve(new Response('private-path', { status: 404 })), 'not_found'],
  ['server', () => Promise.resolve(new Response('private-body', { status: 503 })), 'unavailable'],
  [
    'json',
    () => Promise.resolve(new Response('private invalid json', { status: 200 })),
    'invalid_response',
  ],
  ['schema', () => Promise.resolve(new Response('{}', { status: 200 })), 'invalid_manifest'],
] as const)(
  'retains safe %s recovery classification through real acquisition, overlay fallback and refresh',
  async (_name, fail, expected) => {
    const root = await mkdtemp(join(tmpdir(), 'rh-recovery-'));
    roots.push(root);
    const manifest = JSON.parse(
      await readFile(
        resolve('packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
        'utf8',
      ),
    ) as BroadcastManifest;
    const controller = new MatchContextController({
      lkgStore: new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') }),
    });
    const selected = await controller.selectMatch(manifest.match.matchId, {
      kind: 'online',
      load: () => Promise.resolve(manifest),
    });
    expect(selected.ok).toBe(true);
    const local = await controller.selectLocalMatch(manifest, controller.getActiveRevision());
    expect(local.ok).toBe(true);
    expect(controller.getActiveBinding()?.localAuthoringMode).toBe('bound-overlay');
    const before = controller.getActiveBinding()!.context;
    const source = createOnlineManifestSource(manifest.match.matchId, {
      urlTemplate: 'https://example.test/{matchId}',
      readToken: 'secret-token',
      retries: 0,
      fetchImpl: fail,
    });
    const failure = await controller.refreshOnlineMatch(source);
    expect(failure.ok).toBe(false);
    expect(JSON.stringify(failure.diagnostics)).not.toMatch(
      /secret-token|private-body|private-path|invalid json/,
    );
    if (expected === 'network')
      expect(failure.diagnostics[0]?.sourceEvidence?.cause?.name).toBe('TypeError');
    if (expected === 'authorization')
      expect(failure.diagnostics[0]?.sourceEvidence?.status).toBe(401);
    if (expected === 'unavailable')
      expect(failure.diagnostics[0]?.sourceEvidence?.status).toBe(503);
    expect(controller.getActiveBinding()).toMatchObject({
      freshness: 'stale',
      sourceFailure: expected,
    });
    expect(controller.getActiveBinding()!.context).toEqual(before);
    const failedRevision = controller.getActiveRevision();
    await controller.refreshOnlineMatch(source);
    expect(controller.getActiveRevision()).toBe(failedRevision);
    expect(JSON.stringify(controller.getActiveBinding())).not.toMatch(
      /secret-token|private-body|private-path|invalid json/,
    );
    const recovered = await controller.refreshOnlineMatch({
      kind: 'online',
      load: () => Promise.resolve(manifest),
    });
    expect(recovered.ok).toBe(true);
    expect(controller.getActiveBinding()?.freshness).toBe('fresh');
    expect(controller.getActiveBinding()?.sourceFailure).toBeUndefined();
    expect(controller.getActiveBinding()!.context).toEqual(before);
  },
);
