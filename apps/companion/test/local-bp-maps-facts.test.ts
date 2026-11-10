import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { DEFAULT_LOCAL_BP_MAP_POOL } from '@mizar/core/projection';
import { toMatchDocumentV1, validateBroadcastManifest } from '@mizar/rivalhub';
import { LocalTournamentStore } from '../src/match-context/local-tournament-store.js';
import { MatchContextController } from '../src/match-context/controller.js';
import { MatchManifestLkgStore } from '../src/match-context/lkg-store.js';
import { registerBpWorkspaceRoutes } from '../src/bp/workspace-controller.js';
import { bpAuthoringDraftFromBinding, createLocalBpManifest } from '../src/bp/local-draft.js';

it.each([
  { scoreA: 13, scoreB: 7, completedAt: null, protected: true },
  { scoreA: 0, scoreB: 0, completedAt: null, protected: true },
  { scoreA: null, scoreB: null, completedAt: '2026-11-10T00:00:00.000Z', protected: true },
  { scoreA: null, scoreB: null, completedAt: null, protected: false },
])('preserves imported map evidence through BP saves: %j', async (evidence) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-bp-map-facts-'));
  const path = join(directory, 'tournament.json');
  const lkg = new MatchManifestLkgStore({ filePath: join(directory, 'lkg.json') });
  const store = new LocalTournamentStore(path);
  const controller = new MatchContextController({ lkgStore: lkg });
  const app = Fastify();
  registerBpWorkspaceRoutes(app, {
    controller,
    localTournamentStore: store,
    originPolicy: { mode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: [] },
    projections: {} as Parameters<typeof registerBpWorkspaceRoutes>[1]['projections'],
    demoState: {} as Parameters<typeof registerBpWorkspaceRoutes>[1]['demoState'],
  });
  try {
    // Synthetic old local document, imported through the production startup migration sequence.
    const pool = [...DEFAULT_LOCAL_BP_MAP_POOL];
    const compiled = createLocalBpManifest({
      competitionName: '本地赛事',
      stage: '决赛',
      format: 'bo5',
      entrants: { a: { name: 'A', logoUrl: null }, b: { name: 'B', logoUrl: null } },
      vetoA: 'a',
      mapPool: pool,
      bans: pool.slice(0, 2),
      picks: pool.slice(2, 6).map((mapName) => ({ mapName, side: 'CT' })),
      deciderSide: null,
    });
    if (!compiled.ok) throw new Error(compiled.code);
    const manifest = {
      ...compiled.manifest,
      maps: compiled.manifest.maps.map((map, index) =>
        index === 4
          ? {
              ...map,
              scoreA: evidence.scoreA,
              scoreB: evidence.scoreB,
              completedAt: evidence.completedAt,
            }
          : map,
      ),
    };
    expect(validateBroadcastManifest(manifest).ok).toBe(true);
    expect((await lkg.save(manifest, 'local', { localAuthoringMode: 'standalone' })).ok).toBe(true);
    const restored = await controller.restoreLatest();
    expect(restored?.cachedFrom).toBe('local');
    expect(restored?.localAuthoringMode).toBe('standalone');
    const migrated = await store.importLegacyMatch(toMatchDocumentV1(restored!.manifest));
    controller.activateLocalDocument(migrated);
    const initial = bpAuthoringDraftFromBinding(controller.getActiveBinding()!);
    const shrink = {
      ...initial,
      format: 'bo3',
      bans: [pool[0], pool[1], pool[4], pool[5]],
      picks: initial.picks.slice(0, 2),
      deciderSide: 'CT',
    };
    const before = store.getSnapshot();
    const bytes = await readFile(path, 'utf8');
    const binding = controller.getActiveBinding();
    const response = await app.inject({
      method: 'POST',
      url: '/operator/bp-local-save',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { draft: shrink, expectedContextRevision: controller.getActiveRevision() },
    });
    if (evidence.protected) {
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toBe('bp_played_map_conflict');
      // The persistence boundary also protects saves that do not use the BP compiler.
      for (const document of [
        { ...migrated, maps: migrated.maps.slice(0, 3) },
        { ...migrated, format: 'bo3' },
        {
          ...migrated,
          maps: migrated.maps.map((map) => ({
            ...map,
            scoreA: null,
            scoreB: null,
            completedAt: null,
          })),
        },
      ])
        await expect(store.saveMatch(document)).rejects.toThrow('local_match_identity_conflict');
      expect(store.getSnapshot()).toEqual(before);
      expect(await readFile(path, 'utf8')).toBe(bytes);
      expect(controller.getActiveBinding()).toBe(binding);
      const unchanged = await app.inject({
        method: 'POST',
        url: '/operator/bp-local-save',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: { draft: initial, expectedContextRevision: controller.getActiveRevision() },
      });
      expect(unchanged.statusCode, unchanged.body).toBe(200);
      expect(store.getSnapshot().matches[0]!.maps).toEqual(migrated.maps);
    } else {
      expect(response.statusCode, response.body).toBe(200);
      expect(store.getSnapshot().matches[0]!.maps).toHaveLength(3);
      expect(store.getSnapshot().matches[0]!.format).toBe('bo3');
    }
    const restarted = new LocalTournamentStore(path);
    await restarted.load();
    expect(restarted.getSnapshot()).toEqual(store.getSnapshot());
    controller.activateLocalDocument(restarted.getSnapshot().matches[0]);
    expect(controller.getActiveBinding()!.context.maps).toEqual(
      store.getSnapshot().matches[0]!.maps,
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
