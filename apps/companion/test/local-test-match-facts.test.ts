import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { DEFAULT_LOCAL_BP_MAP_POOL } from '@mizar/core/projection';
import { deriveScheduleNeighborhood } from '@mizar/core/match-context';
import { toMatchDocumentV1, validateBroadcastManifest } from '@mizar/rivalhub';
import { LocalTournamentStore } from '../src/match-context/local-tournament-store.js';
import { MatchContextController } from '../src/match-context/controller.js';
import { MatchManifestLkgStore } from '../src/match-context/lkg-store.js';
import { registerLocalTournamentRoutes } from '../src/match-context/local-tournament-routes.js';
import { registerBpWorkspaceRoutes } from '../src/bp/workspace-controller.js';
import { bpAuthoringDraftFromBinding, createLocalBpManifest } from '../src/bp/local-draft.js';

it('retains an imported test match through BP saves, restart, and isolated schedule neighbors', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-local-test-facts-'));
  const path = join(directory, 'local.json');
  const store = new LocalTournamentStore(path);
  const lkg = new MatchManifestLkgStore({ filePath: join(directory, 'manifest.json') });
  const controller = new MatchContextController({ lkgStore: lkg });
  const app = Fastify();
  const originPolicy = { mode: 'loopback' as const, bindHost: '127.0.0.1', allowedOrigins: [] };
  registerLocalTournamentRoutes(app, {
    store,
    controller,
    originPolicy,
    canReleaseLocalSelection: () => false,
    canConfirmLocalExit: () => false,
    withLocalSelectionRelease: async () => false,
  });
  registerBpWorkspaceRoutes(app, {
    controller,
    localTournamentStore: store,
    originPolicy,
    projections: {} as Parameters<typeof registerBpWorkspaceRoutes>[1]['projections'],
    demoState: {} as Parameters<typeof registerBpWorkspaceRoutes>[1]['demoState'],
  });
  try {
    // Synthetic legal manifest uses the same legacy restoration and import path as app.restoreFormal.
    const pool = [...DEFAULT_LOCAL_BP_MAP_POOL];
    const compiled = createLocalBpManifest({
      competitionName: 'Synthetic event',
      stage: 'Test match',
      format: 'bo3',
      entrants: { a: { name: 'A', logoUrl: null }, b: { name: 'B', logoUrl: null } },
      vetoA: 'a',
      mapPool: pool,
      bans: pool.slice(0, 4),
      picks: pool.slice(4, 6).map((mapName) => ({ mapName, side: 'CT' })),
      deciderSide: 'CT',
    });
    if (!compiled.ok) throw new Error(compiled.code);
    const manifest = { ...compiled.manifest, match: { ...compiled.manifest.match, isTest: true } };
    expect(validateBroadcastManifest(manifest).ok).toBe(true);
    expect((await lkg.save(manifest, 'local', { localAuthoringMode: 'standalone' })).ok).toBe(true);
    const restored = await controller.restoreLatest();
    expect(restored?.localAuthoringMode).toBe('standalone');
    const test = await store.importLegacyMatch(toMatchDocumentV1(restored!.manifest));
    expect(test.isTest).toBe(true);
    const createFormal = () =>
      store.createMatch({
        teamA: 'A',
        teamB: 'B',
        teamAId: test.entrants.a.entryId,
        teamBId: test.entrants.b.entryId,
        eventId: test.competition!.competitionId,
        format: 'bo3',
        mapPool: pool,
      });
    const first = await createFormal();
    const last = await createFormal();
    expect(first.isTest).toBe(false);
    await store.reorder(test.competition!.competitionId, [
      first.matchId,
      test.matchId,
      last.matchId,
    ]);
    const select = (matchId: string) => controller.selectLocalTournamentMatch(store, matchId);
    await select(first.matchId);
    const formalView = (await app.inject('/local/v1/tournament')).json();
    expect.soft(formalView.neighborhood.next?.matchId).toBe(last.matchId);
    await select(test.matchId);
    const testView = (await app.inject('/local/v1/tournament')).json();
    expect.soft(testView.neighborhood.previous).toBeNull();
    expect.soft(testView.neighborhood.next).toBeNull();
    expect.soft(testView.neighborhood.upcoming).toEqual([]);
    expect.soft(controller.getActiveBinding()?.manifest.match.isTest).toBe(true);

    const response = await app.inject({
      method: 'POST',
      url: '/operator/bp-local-save',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {
        draft: bpAuthoringDraftFromBinding(controller.getActiveBinding()!),
        expectedContextRevision: controller.getActiveRevision(),
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect.soft(controller.getActiveBinding()?.context.isTest).toBe(true);
    const restarted = new LocalTournamentStore(path);
    await restarted.load();
    expect
      .soft(restarted.getSnapshot().matches.find((match) => match.matchId === test.matchId)?.isTest)
      .toBe(true);
    const schedule = restarted.scheduleWindow(test.competition!.competitionId)!;
    expect
      .soft(deriveScheduleNeighborhood(schedule, first.matchId).next?.matchId)
      .toBe(last.matchId);
    expect
      .soft(deriveScheduleNeighborhood(schedule, test.matchId))
      .toMatchObject({ previous: null, next: null, upcoming: [] });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
