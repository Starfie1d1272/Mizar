import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MatchDocumentV1 } from '@mizar/protocol/context';
import type { BpWorkspace } from '@mizar/protocol/bp';
import { DEFAULT_LOCAL_BP_MAP_POOL } from '@mizar/core/projection';
import { toMatchContext, validateBroadcastManifest } from '@mizar/rivalhub';
import { expect, it, vi } from 'vitest';

import { buildApp } from '../src/app.js';
import { MatchManifestLkgStore } from '../src/match-context/lkg-store.js';
import { LocalTournamentStore } from '../src/match-context/local-tournament-store.js';

interface TournamentView {
  readonly selectedMatchId: string | null;
  readonly contextRevision: string;
  readonly matches: readonly MatchDocumentV1[];
}

it('inherits persisted event rules, preserves existing BP when defaults change, and restores after restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-event-bp-rules-'));
  const options = {
    matchManifestPath: join(directory, 'context.json'),
    localTournamentPath: join(directory, 'local.json'),
  };
  const headers = { origin: 'http://127.0.0.1:3000' };
  const eplRules = { finalBanOrder: 'veto_a_first', deciderSideChoice: 'in_game' } as const;
  const classicRules = { finalBanOrder: 'veto_b_first', deciderSideChoice: 'veto_b' } as const;
  let app = buildApp(options);
  try {
    await app.ready();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/local-match/create',
          headers,
          payload: { teamA: 'Falcons', teamB: 'NAVI', format: 'bo3' },
        })
      ).statusCode,
    ).toBe(200);
    const initial = (await app.inject({ url: '/local/v1/tournament' })).json<TournamentView>();
    const eventId = initial.matches[0]!.competition?.competitionId;
    const event = {
      eventId,
      name: 'ESL Pro League Season 24',
      logoUrl: null,
      themeColor: null,
      mapPool: [...DEFAULT_LOCAL_BP_MAP_POOL],
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/local-event/save',
          headers,
          payload: { ...event, bo3Rules: eplRules },
        })
      ).statusCode,
    ).toBe(200);
    const workspace = (await app.inject({ url: '/local/v1/bp-workspace' })).json<BpWorkspace>();
    expect(workspace.schemaVersion).toBe('mizar.bp-workspace.v5');
    expect(workspace.authoringDraft!.bo3Rules).toEqual(eplRules);
    const draft = {
      ...workspace.authoringDraft!,
      bo3Rules: undefined,
      vetoA: 'b',
      bans: ['de_dust2', 'de_cache', 'de_ancient', 'de_nuke'],
      picks: [
        { mapName: 'de_inferno', side: 'CT' },
        { mapName: 'de_anubis', side: 'T' },
      ],
      deciderSide: null,
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/bp-local-save',
          headers,
          payload: { expectedContextRevision: workspace.contextRevision, draft },
        })
      ).statusCode,
    ).toBe(200);
    const after = (await app.inject({ url: '/local/v1/tournament' })).json<TournamentView>();
    expect(after.matches[0]!.veto).toHaveLength(9);
    expect(after.matches[0]!.maps.map((map) => map.teamAStartSide)).toEqual(['CT', 'CT', null]);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/local-event/save',
          headers,
          payload: { ...event, bo3Rules: classicRules },
        })
      ).statusCode,
    ).toBe(200);
    const unchanged = (await app.inject({ url: '/local/v1/tournament' })).json<TournamentView>();
    expect(unchanged.matches[0]!.veto).toEqual(after.matches[0]!.veto);
    const existing = (await app.inject({ url: '/local/v1/bp-workspace' })).json<BpWorkspace>();
    expect(existing.authoringDraft!.bo3Rules).toEqual(eplRules);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/bp-local-save',
          headers,
          payload: {
            expectedContextRevision: existing.contextRevision,
            draft: existing.authoringDraft,
          },
        })
      ).statusCode,
    ).toBe(200);
    const persisted = JSON.parse(await readFile(options.localTournamentPath, 'utf8')) as {
      events: { bo3Rules: unknown }[];
    };
    expect(persisted.events[0]!.bo3Rules).toEqual(classicRules);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/local-event/save',
          headers,
          payload: { ...event, bo3Rules: { ...classicRules, deciderSideChoice: 'invalid' } },
        })
      ).statusCode,
    ).toBe(400);
    await app.close();
    app = buildApp(options);
    await app.ready();
    const restored = (await app.inject({ url: '/local/v1/bp-workspace' })).json<BpWorkspace>();
    expect(restored.readiness).toBe('ready');
    expect(restored.authoringDraft!.bo3Rules).toEqual(eplRules);
    const restoredMatches = (
      await app.inject({ url: '/local/v1/tournament' })
    ).json<TournamentView>();
    expect(restoredMatches.matches[0]!.veto).toEqual(after.matches[0]!.veto);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

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
    expect(firstView.matches[0]?.stage).toBe('local');
    expect(bp.json<{ match: { stage: string } }>().match.stage).toBe('本地比赛');
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

it('requires explicit confirmation, protects the current context and restores without activating', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-trash-routes-'));
  const app = buildApp({
    localTournamentPath: join(directory, 'local.json'),
    matchManifestPath: join(directory, 'match.json'),
  });
  const headers = { origin: 'http://127.0.0.1:3000' };
  try {
    await app.ready();
    const create = async (name: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/operator/local-match/create',
          headers,
          payload: { teamA: name, teamB: '对手', format: 'bo1' },
        })
      ).json<{ matchId: string }>().matchId;
    const first = await create('旧比赛');
    const mutate = (
      operation: string,
      matchId: string,
      confirmed = true,
      origin = headers.origin,
    ) =>
      app.inject({
        method: 'POST',
        url: `/operator/local-match/${operation}`,
        headers: { origin },
        payload: { matchId, confirmed },
      });
    expect((await mutate('trash', first)).statusCode).toBe(409);
    const second = await create('当前比赛');
    const context = (await app.inject({ url: '/local/v1/match-document' })).body;
    expect((await mutate('trash', first, false)).statusCode).toBe(400);
    expect((await mutate('trash', first, true, 'https://example.com')).statusCode).toBe(403);
    expect((await mutate('trash', first)).statusCode).toBe(200);
    expect((await mutate('trash', first)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/local-match/select',
          headers,
          payload: { matchId: first },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: '/local/v1/tournament' })).json<TournamentView>().selectedMatchId,
    ).toBe(second);
    expect((await mutate('restore', first)).statusCode).toBe(200);
    expect((await mutate('restore', first)).statusCode).toBe(200);
    expect((await app.inject({ url: '/local/v1/match-document' })).body).toBe(context);
    expect(
      (await app.inject({ url: '/local/v1/tournament' })).json<TournamentView>().matches,
    ).toHaveLength(2);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('can confirm release and recycle the last local selection after finishing preparation-only production', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-last-local-'));
  const options = {
    localTournamentPath: join(directory, 'local.json'),
    matchManifestPath: join(directory, 'context.json'),
  };
  let app = buildApp(options);
  const headers = { origin: 'http://127.0.0.1:3000' };
  try {
    await app.ready();
    const created = await app.inject({
      method: 'POST',
      url: '/operator/local-match/create',
      headers,
      payload: { teamA: '最后一场', teamB: '对手', format: 'bo1' },
    });
    const matchId = created.json<{ matchId: string }>().matchId;
    const trash = () =>
      app.inject({
        method: 'POST',
        url: '/operator/local-match/trash',
        headers,
        payload: { matchId, confirmed: true, releaseCurrent: true },
      });
    const production = async (action: string) =>
      app.inject({
        method: 'POST',
        url: '/operator/production',
        headers,
        payload: {
          action,
          expectedRevision: (await app.inject('/local/v1/production')).json<{ revision: string }>()
            .revision,
        },
      });
    expect((await production('enter')).statusCode).toBe(200);
    expect((await trash()).statusCode).toBe(409);
    expect((await production('hide')).statusCode).toBe(200);
    expect((await trash()).statusCode).toBe(409);
    expect((await production('finish')).statusCode).toBe(200);
    expect((await trash()).statusCode).toBe(200);
    expect((await app.inject('/local/v1/match-document')).statusCode).toBe(404);
    expect((await app.inject('/local/v1/tournament')).json()).toMatchObject({
      matches: [],
      selectedMatchId: null,
      activeLocalMatchId: null,
    });
    expect((await app.inject('/local/v1/production')).json()).toMatchObject({
      mode: 'preparation',
      canEnter: false,
    });
    await app.close();
    app = buildApp(options);
    await app.ready();
    expect((await app.inject('/local/v1/match-document')).statusCode).toBe(404);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/local-match/restore',
          headers,
          payload: { matchId, confirmed: true },
        })
      ).statusCode,
    ).toBe(200);
    expect((await app.inject('/local/v1/match-document')).statusCode).toBe(404);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('keeps previously received game data as a protection instead of accepting a browser game-closed claim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-local-game-protection-'));
  const app = buildApp({
    localTournamentPath: join(directory, 'local.json'),
    matchManifestPath: join(directory, 'context.json'),
    gsiToken: 'trash-test',
    projectionNowMonotonicMs: () => 1_000_000,
  });
  const headers = { origin: 'http://127.0.0.1:3000' };
  try {
    await app.ready();
    const created = await app.inject({
      method: 'POST',
      url: '/operator/local-match/create',
      headers,
      payload: { teamA: 'A', teamB: 'B', format: 'bo1' },
    });
    const matchId = created.json<{ matchId: string }>().matchId;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          payload: {
            auth: { token: 'trash-test' },
            map: { name: 'de_mirage', phase: 'gameover' },
            round: { phase: 'over' },
          },
        })
      ).statusCode,
    ).toBe(204);
    const response = await app.inject({
      method: 'POST',
      url: '/operator/local-match/trash',
      headers,
      payload: { matchId, confirmed: true, releaseCurrent: true, gameClosed: true },
    });
    expect(response.statusCode).toBe(409);
    expect((await app.inject('/local/v1/tournament')).json<TournamentView>().matches).toHaveLength(
      1,
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('reports storage failures distinctly and records the underlying diagnostic', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-local-storage-failure-'));
  const app = buildApp({
    localTournamentPath: join(directory, 'local.json'),
    matchManifestPath: join(directory, 'context.json'),
  });
  const headers = { origin: 'http://127.0.0.1:3000' };
  const errorLog = vi.spyOn(app.log, 'error');
  const trash = vi
    .spyOn(LocalTournamentStore.prototype, 'trashMatch')
    .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
  try {
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/operator/local-match/trash',
      headers,
      payload: { matchId: 'unselected', confirmed: true },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      error: 'local_match_storage_failed',
    });
    expect(response.json<{ message: string }>().message).toContain('磁盘空间');
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'local_match',
        operation: 'trash',
        diagnostic: expect.objectContaining({ code: 'EACCES' }) as unknown,
      }),
      'Local match persistence failed',
    );
    trash.mockRejectedValueOnce(new Error('local_trash_full'));
    const full = await app.inject({
      method: 'POST',
      url: '/operator/local-match/trash',
      headers,
      payload: { matchId: 'unselected', confirmed: true },
    });
    expect(full.statusCode).toBe(409);
    expect(full.json<{ error: string; message: string }>().error).toBe('local_trash_full');
    expect(full.json<{ message: string }>().message).toContain('256');
    expect(errorLog).toHaveBeenCalledOnce();
  } finally {
    trash.mockRestore();
    errorLog.mockRestore();
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
