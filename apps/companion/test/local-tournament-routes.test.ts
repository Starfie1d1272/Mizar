import { gunzipSync } from 'node:zlib';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { MatchDocumentV1 } from '@mizar/protocol/context';
import type { BpWorkspace } from '@mizar/protocol/bp';
import { toMatchContext, type BroadcastManifest } from '@mizar/rivalhub';
import { DEFAULT_LOCAL_BP_MAP_POOL } from '@mizar/core/projection';
import { expect, it } from 'vitest';

import { buildApp } from '../src/app.js';

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

const exitProduct = {
  artifactSha256: 'a'.repeat(64),
  gitSha: 'b'.repeat(40),
  instanceId: 'local-exit-test',
  controlToken: 'c'.repeat(64),
  stop: () => {},
};
interface ExitQualification {
  readonly ticket: string;
  readonly matchId: string;
  readonly contextRevision: string;
}

it('uses only a private Host acknowledgement to recycle the last match after accepted GSI, and invalidates stale qualifications', async () => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'mizar-local-host-exit-'));
  const app = buildApp({
    localTournamentPath: join(directory, 'local.json'),
    matchManifestPath: join(directory, 'context.json'),
    productRuntime: exitProduct,
    gsiToken: 'exit-gsi',
    supportLogsDirectory: join(directory, 'logs'),
  });
  const headers = { origin: 'http://127.0.0.1:3000' };
  const privateHeaders = { 'x-runtime-token': exitProduct.controlToken };
  const privateRequest = (payload: Record<string, unknown>, requestHeaders = privateHeaders) =>
    app.inject({
      method: 'POST',
      url: '/operator/runtime/local-match-exit',
      headers: requestHeaders,
      payload,
    });
  const prepare = async () => {
    const response = await privateRequest({ action: 'prepare' });
    expect(response.statusCode).toBe(200);
    const qualification = response.json<{ qualification: ExitQualification | null }>()
      .qualification;
    if (!qualification) throw new Error('Host qualification missing');
    return qualification;
  };
  const confirm = (qualification: ExitQualification) =>
    privateRequest({ action: 'confirm', qualification });
  const game = async () => {
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          payload: {
            auth: { token: 'exit-gsi' },
            map: { name: 'de_mirage', phase: 'gameover' },
            round: { phase: 'over' },
          },
        })
      ).statusCode,
    ).toBe(204);
  };
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
  try {
    await app.ready();
    const matchId = (
      await app.inject({
        method: 'POST',
        url: '/operator/local-match/create',
        headers,
        payload: { teamA: '实际试播', teamB: '对手', format: 'bo1' },
      })
    ).json<{ matchId: string }>().matchId;
    const trash = () =>
      app.inject({
        method: 'POST',
        url: '/operator/local-match/trash',
        headers,
        payload: { matchId, confirmed: true, releaseCurrent: true },
      });
    expect((await app.inject('/local/v1/tournament')).json()).toMatchObject({
      canReleaseLocalSelection: true,
    });
    // Host invalidates before launching, so no-GSI startup cannot use the fresh-selection fallback.
    expect((await privateRequest({ action: 'invalidate' })).statusCode).toBe(200);
    expect((await trash()).statusCode).toBe(409);
    expect((await confirm(await prepare())).statusCode).toBe(200);
    await game();
    expect((await trash()).statusCode).toBe(409);
    expect(
      (await privateRequest({ action: 'prepare' }, { 'x-runtime-token': 'bad' })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/runtime/local-match-exit',
          headers,
          payload: { action: 'prepare' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/runtime/local-match-exit',
          headers: { ...headers, ...privateHeaders },
          payload: { action: 'prepare' },
        })
      ).statusCode,
    ).toBe(403);
    const first = await prepare();
    expect(first.matchId).toBe(matchId);
    const support = await app.inject({
      method: 'POST',
      url: '/debug/support-bundle',
      headers,
      payload: {},
    });
    expect(support.statusCode).toBe(200);
    const files = support.json<{
      fullLogs: { files: { name: string; status: string; volumes: { gzipBase64: string }[] }[] };
    }>().fullLogs.files;
    const raw = files
      .filter((file) => file.name.startsWith('session.ndjson') && file.status === 'read')
      .map((file) =>
        Buffer.concat(
          file.volumes.map((volume) => gunzipSync(Buffer.from(volume.gzipBase64, 'base64'))),
        ).toString('utf8'),
      )
      .join('\n');
    expect(raw).not.toContain(first.ticket);
    expect(raw).not.toContain(exitProduct.controlToken);
    expect(raw).toContain(first.matchId);
    expect(raw).toContain(first.contextRevision);
    const events = raw
      .split('\n')
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            stage: string;
            evidence: {
              route?: string;
              result?: { qualification?: { ticket?: string; matchId?: string } };
            };
          },
      );
    const prepared = events.find(
      (event) =>
        event.stage === 'operation_result' &&
        event.evidence.route === '/operator/runtime/local-match-exit' &&
        event.evidence.result?.qualification?.matchId === matchId,
    );
    expect(prepared?.evidence.result?.qualification?.ticket).toMatch(
      /^\[redacted-ticket:[a-f0-9]{64}\]$/,
    );

    expect((await trash()).statusCode).toBe(409);
    expect((await confirm({ ...first, matchId: 'different-match' })).statusCode).toBe(409);
    expect((await confirm(first)).statusCode).toBe(200);
    expect((await confirm(first)).statusCode).toBe(409);
    const eligible = await app.inject('/local/v1/tournament');
    expect(eligible.json()).toMatchObject({ inUseMatchId: null, canReleaseLocalSelection: true });
    expect(eligible.body).not.toContain(first.ticket);
    expect(eligible.body).not.toContain(exitProduct.controlToken);
    await game();
    expect((await trash()).statusCode).toBe(409);
    const changedGame = await prepare();
    await game();
    expect((await confirm(changedGame)).statusCode).toBe(409);
    expect((await confirm(await prepare())).statusCode).toBe(200);
    expect((await privateRequest({ action: 'invalidate' })).statusCode).toBe(200);
    expect((await trash()).statusCode).toBe(409);
    const beforeEnter = await prepare();
    expect((await production('enter')).statusCode).toBe(200);
    expect((await confirm(beforeEnter)).statusCode).toBe(409);
    expect((await privateRequest({ action: 'prepare' })).json()).toEqual({ qualification: null });
    expect((await trash()).statusCode).toBe(409);
    expect((await production('finish')).statusCode).toBe(200);
    expect((await confirm(await prepare())).statusCode).toBe(200);
    expect((await production('enter')).statusCode).toBe(200);
    expect((await production('finish')).statusCode).toBe(200);
    expect((await trash()).statusCode).toBe(409);
    const beforeSelect = await prepare();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/local-match/select',
          headers,
          payload: { matchId },
        })
      ).statusCode,
    ).toBe(200);
    expect((await confirm(beforeSelect)).statusCode).toBe(409);
    expect((await trash()).statusCode).toBe(409);
    expect((await confirm(await prepare())).statusCode).toBe(200);
    expect((await trash()).statusCode).toBe(200);
    expect((await app.inject('/local/v1/match-document')).statusCode).toBe(404);
    expect((await app.inject('/local/v1/tournament')).json()).toMatchObject({
      matches: [],
      selectedMatchId: null,
    });
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('does not reuse Host exit qualifications after restarting with a restored local selection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-local-exit-restart-'));
  const options = {
    localTournamentPath: join(directory, 'local.json'),
    matchManifestPath: join(directory, 'context.json'),
    productRuntime: exitProduct,
    gsiToken: 'restart-gsi',
  };
  let app = buildApp(options);
  const headers = { origin: 'http://127.0.0.1:3000' };
  const host = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/operator/runtime/local-match-exit',
      headers: { 'x-runtime-token': exitProduct.controlToken },
      payload,
    });
  try {
    await app.ready();
    const matchId = (
      await app.inject({
        method: 'POST',
        url: '/operator/local-match/create',
        headers,
        payload: { teamA: 'A', teamB: 'B', format: 'bo1' },
      })
    ).json<{ matchId: string }>().matchId;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/gsi',
          payload: {
            auth: { token: 'restart-gsi' },
            map: { name: 'de_mirage', phase: 'gameover' },
          },
        })
      ).statusCode,
    ).toBe(204);
    const old = (await host({ action: 'prepare' })).json<{ qualification: ExitQualification }>()
      .qualification;
    expect((await host({ action: 'confirm', qualification: old })).statusCode).toBe(200);
    await app.close();
    app = buildApp(options);
    await app.ready();
    expect((await host({ action: 'confirm', qualification: old })).statusCode).toBe(409);
    const trash = () =>
      app.inject({
        method: 'POST',
        url: '/operator/local-match/trash',
        headers,
        payload: { matchId, confirmed: true, releaseCurrent: true },
      });
    expect((await trash()).statusCode).toBe(409);
    const fresh = (await host({ action: 'prepare' })).json<{ qualification: ExitQualification }>()
      .qualification;
    expect(fresh.contextRevision).not.toBe(old.contextRevision);
    expect((await host({ action: 'confirm', qualification: fresh })).statusCode).toBe(200);
    expect((await trash()).statusCode).toBe(200);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('candidate edits preserve production and reject stale or active writes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-candidate-'));
  const app = buildApp({
    matchManifestPath: join(directory, 'match.json'),
    localTournamentPath: join(directory, 'library.json'),
  });
  const headers = { origin: 'http://127.0.0.1:3000' };
  try {
    await app.ready();
    const created = await app.inject({
      method: 'POST',
      url: '/operator/local-match/create',
      headers,
      payload: { teamA: 'A', teamB: 'B', format: 'bo3' },
    });
    expect(created.statusCode).toBe(200);
    const { matchId } = created.json<{ matchId: string }>();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/local-match/create',
          headers,
          payload: { teamA: 'NJU C', teamB: 'NJU D', format: 'bo1' },
        })
      ).statusCode,
    ).toBe(200);
    const before = (await app.inject('/local/v1/tournament')).json<TournamentView>();
    const activeDocument = (await app.inject('/local/v1/match-document')).body;
    const production = (await app.inject('/local/v1/production')).body;
    const candidate = before.matches.find((item) => item.matchId === matchId)!;
    const candidateUrl = `/operator/local-match/${matchId}/save`;
    const payload = {
      expectedDocument: candidate,
      document: { ...candidate, stageLabel: 'Candidate edited', scoreA: 99, maps: [] },
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: candidateUrl,
          headers: { origin: 'https://untrusted.example' },
          payload,
        })
      ).statusCode,
    ).toBe(403);
    const saves = await Promise.all(
      ['Candidate edited', 'Concurrent editor'].map((stageLabel) =>
        app.inject({
          method: 'POST',
          url: candidateUrl,
          headers,
          payload: { ...payload, document: { ...payload.document, stageLabel } },
        }),
      ),
    );
    expect(saves.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    const after = (await app.inject('/local/v1/tournament')).json<TournamentView>();
    expect(after.selectedMatchId).toBe(before.selectedMatchId);
    expect(after.contextRevision).toBe(before.contextRevision);
    expect((await app.inject('/local/v1/match-document')).body).toBe(activeDocument);
    expect((await app.inject('/local/v1/production')).body).toBe(production);
    const edited = after.matches.find((item) => item.matchId === matchId)!;
    expect(['Candidate edited', 'Concurrent editor']).toContain(edited.stageLabel);
    expect(edited.scoreA).toBe(candidate.scoreA);
    expect(edited.maps).toEqual(candidate.maps);
    expect(edited.veto).toEqual(candidate.veto);
    const active = after.matches.find((item) => item.matchId === after.selectedMatchId)!;
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/operator/local-match/${active.matchId}/save`,
          headers,
          payload: {
            expectedDocument: active,
            document: { ...active, stageLabel: 'Reject active' },
          },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'POST', url: candidateUrl, headers, payload })).statusCode,
    ).toBe(409);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects local BP overrides for website matches without changing the website binding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-website-readonly-'));
  const manifest = JSON.parse(
    await readFile(
      new URL(
        '../../../packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as BroadcastManifest;
  const app = buildApp({
    matchManifestPath: join(directory, 'match.json'),
    matchContextBinding: {
      manifest,
      context: toMatchContext(manifest),
      origin: 'online',
      freshness: 'fresh',
      diagnostics: [],
    },
  });
  try {
    await app.ready();
    const before = (await app.inject({ url: '/local/v1/bp-workspace' })).json<BpWorkspace>();
    const response = await app.inject({
      method: 'POST',
      url: '/operator/bp-local-save',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { expectedContextRevision: before.contextRevision, draft: before.authoringDraft },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: 'bp_website_readonly' });
    expect((await app.inject({ url: '/local/v1/bp-workspace' })).json<BpWorkspace>()).toEqual(
      before,
    );
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
