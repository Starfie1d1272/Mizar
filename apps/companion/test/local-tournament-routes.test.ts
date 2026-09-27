import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MatchDocumentV1 } from '@mizar/protocol/context';
import { DEFAULT_LOCAL_BP_MAP_POOL } from '@mizar/core/projection';
import { toMatchContext, validateBroadcastManifest } from '@mizar/rivalhub';
import { expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { MatchManifestLkgStore } from '../src/match-context/lkg-store.js';
import { LocalTournamentStore } from '../src/match-context/local-tournament-store.js';

interface TournamentView {
  readonly selectedMatchId: string | null;
  readonly contextRevision: string;
  readonly matches: readonly MatchDocumentV1[];
}

it('creates and restores a standalone local match before BP, with a persistent local image', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-local-routes-'));
  const manifestPath = join(directory, 'match-context.json');
  const localPath = join(directory, 'local-tournament.json');
  const headers = { origin: 'http://127.0.0.1:3000' };
  const app = buildApp({ matchManifestPath: manifestPath, localTournamentPath: localPath });
  try {
    await app.ready();
    const created = await app.inject({
      method: 'POST',
      url: '/operator/local-match/create',
      headers,
      payload: { teamA: 'NJU A', teamB: 'NJU B', format: 'bo3' },
    });
    expect(created.statusCode).toBe(200);
    const matchId = created.json<{ matchId: string }>().matchId;
    const first = await app.inject({ method: 'GET', url: '/local/v1/tournament' });
    const firstView = first.json<TournamentView>();
    expect(first.statusCode).toBe(200);
    expect(firstView.selectedMatchId).toBe(matchId);
    expect(firstView.matches[0]?.veto).toEqual([]);
    const envelope = await app.inject({ method: 'GET', url: '/local/v1/match-document' });
    expect(envelope.json<{ source: string; document: { matchId: string } }>()).toMatchObject({
      source: 'local',
      document: { matchId },
    });
    const bp = await app.inject({ method: 'GET', url: '/local/v1/bp-workspace' });
    expect(bp.json<{ readiness: string }>().readiness).toBe('missing');
    const image =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=';
    const uploaded = await app.inject({
      method: 'POST',
      url: '/operator/local-asset',
      headers,
      payload: { mimeType: 'image/png', base64: image },
    });
    expect(uploaded.statusCode).toBe(200);
    const url = uploaded.json<{ url: string }>().url;
    const asset = await app.inject({ method: 'GET', url });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('image/png');
    const document = firstView.matches[0]!;
    const entrants = document.entrants;
    const saved = await app.inject({
      method: 'POST',
      url: '/operator/local-match/save',
      headers,
      payload: {
        expectedContextRevision: firstView.contextRevision,
        document: {
          ...document,
          entrants: { ...entrants, a: { ...entrants.a, logoUrl: url } },
          scheduledAt: '2026-09-28T10:00:00.000Z',
        },
      },
    });
    expect(saved.statusCode).toBe(200);
  } finally {
    await app.close();
  }
  const restored = buildApp({ matchManifestPath: manifestPath, localTournamentPath: localPath });
  try {
    await restored.ready();
    const view = (
      await restored.inject({ method: 'GET', url: '/local/v1/tournament' })
    ).json<TournamentView>();
    expect(view.matches[0]?.entrants.a.logoUrl).toMatch(/^\/local\/v1\/local-assets\//);
    expect(view.matches[0]?.scheduledAt).toBe('2026-09-28T10:00:00.000Z');
    expect(
      (await restored.inject({ method: 'GET', url: view.matches[0]!.entrants.a.logoUrl! }))
        .statusCode,
    ).toBe(200);
    expect(await readFile(localPath, 'utf8')).not.toContain('rivalhub.broadcast-manifest.v1');
  } finally {
    await restored.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('serves the same Mizar document envelope for a RivalHub binding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-online-document-'));
  const fixture: unknown = JSON.parse(
    await readFile(
      join(process.cwd(), 'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  );
  const validated = validateBroadcastManifest(fixture);
  if (!validated.ok) throw new Error('RivalHub fixture invalid');
  const app = buildApp({
    matchManifestPath: join(directory, 'match.json'),
    matchContextBinding: {
      manifest: validated.value,
      context: toMatchContext(validated.value),
      origin: 'online',
      freshness: 'fresh',
      diagnostics: [],
    },
  });
  try {
    await app.ready();
    const response = await app.inject({ url: '/local/v1/match-document' });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ source: string; document: { schemaVersion: string } }>()).toMatchObject({
      source: 'rivalhub',
      document: { schemaVersion: 'mizar.match-document.v1' },
    });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('restores whichever provider was explicitly selected last', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-provider-selection-'));
  const manifestPath = join(directory, 'match.json');
  const localPath = join(directory, 'tournament.json');
  const fixture: unknown = JSON.parse(
    await readFile(
      join(process.cwd(), 'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  );
  const validated = validateBroadcastManifest(fixture);
  if (!validated.ok) throw new Error('RivalHub fixture invalid');
  const local = new LocalTournamentStore(localPath);
  try {
    const oldOnline = new MatchManifestLkgStore({
      filePath: manifestPath,
      clock: () => '2026-01-01T00:00:00.000Z',
    });
    expect((await oldOnline.save(validated.value, 'online')).ok).toBe(true);
    await local.createMatch({
      teamA: '甲队',
      teamB: '乙队',
      format: 'bo1',
      mapPool: DEFAULT_LOCAL_BP_MAP_POOL,
    });
    const localApp = buildApp({ matchManifestPath: manifestPath, localTournamentPath: localPath });
    try {
      await localApp.ready();
      const response = await localApp.inject({ url: '/local/v1/match-document' });
      expect(response.json<{ source: string }>().source).toBe('local');
    } finally {
      await localApp.close();
    }
    const newerOnline = new MatchManifestLkgStore({
      filePath: manifestPath,
      clock: () => '2030-01-01T00:00:00.000Z',
    });
    expect((await newerOnline.save(validated.value, 'online')).ok).toBe(true);
    const onlineApp = buildApp({ matchManifestPath: manifestPath, localTournamentPath: localPath });
    try {
      await onlineApp.ready();
      const response = await onlineApp.inject({ url: '/local/v1/match-document' });
      expect(response.json<{ source: string }>().source).toBe('cache');
    } finally {
      await onlineApp.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
