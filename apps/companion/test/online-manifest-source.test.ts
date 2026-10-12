import { rm } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceLoadError, createOnlineManifestSource } from '../src/match-context/index.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
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
