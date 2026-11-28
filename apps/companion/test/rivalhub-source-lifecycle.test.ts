import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseLiveSnapshotV1, parseReliableEventV1 } from '@mizar/protocol/output';
import { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
import { RivalHubReadClient } from '../src/match-context/rivalhub-read-client.js';

import { OutputService } from '../src/output/service.js';
import Fastify from 'fastify';
import { registerRivalHubConnectionRoutes } from '../src/match-context/rivalhub-routes.js';
import { claimRecoveryProof } from '../src/match-context/rivalhub-source-recovery.js';

test('manifest refresh bounds automatic retries, allows explicit recovery, and honors Retry-After', async () => {
  const fixture = async (name: string) =>
    JSON.parse(
      await readFile(
        new URL(`../../../packages/rivalhub/test/fixtures/${name}`, import.meta.url),
        'utf8',
      ),
    );
  const manifest = await fixture('broadcast-manifest-v1.valid.json');
  const schedule = await fixture('broadcast-schedule-window-v1.valid.json');
  const installation = {
    baseUrl: 'https://example.com',
    credential: 'test-credential',
    installationId: 'installation-a',
    competitionId: 'competition-m2',
    displayName: 'test',
  };
  let now = 0;
  let requests = 0;
  let scheduleRequests = 0;
  let status = 503;
  const diagnostics: string[] = [];
  const client = new RivalHubReadClient(
    'unused',
    async () => {
      requests++;
      if (status === 200) return Response.json(manifest);
      return new Response(null, { status, headers: { 'Retry-After': '120' } });
    },
    () => installation,
    async () => {
      scheduleRequests++;
      return Response.json(schedule);
    },
    (response) => response.json(),
    () => now,
    async () => {},
    (stage) => diagnostics.push(stage),
  );
  const matchId = manifest.match.matchId;
  const explicit = client.matchSource(matchId, true);
  await assert.rejects(explicit.load(), /503/);
  for (; now < 10000; now += 1000) {
    assert.equal(client.automaticManifestDeferred(matchId), true);
    await assert.rejects(client.matchSource(matchId, false).load(), /503/);
  }
  assert.equal(requests, 1);
  assert.deepEqual(diagnostics, ['manifest_refresh_failed']);
  assert.equal(client.automaticManifestDeferred(matchId), false);
  status = 200;
  const [a, b] = await Promise.all([explicit.load(), explicit.load()]);
  assert.equal(requests, 2);
  assert.deepEqual(a, b);
  assert.equal(diagnostics.at(-1), 'manifest_refresh_recovered');
  status = 429;
  await assert.rejects(explicit.load(), /429/);
  await assert.rejects(explicit.load(), (error: { status?: number }) => error.status === 429);
  assert.equal(requests, 3);
  assert.equal(client.automaticManifestDeferred(matchId), true);
  await Promise.all([
    client.schedule(schedule.from, schedule.to),
    client.schedule(schedule.from, schedule.to),
    client.schedule('2026-09-16T07:00:00.000Z', schedule.to),
  ]);
  assert.equal(scheduleRequests, 2);
});

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-lifecycle-'));
  const path = join(dir, 'connection.json');
  const snapshot = parseLiveSnapshotV1(
    JSON.parse(
      await readFile(
        new URL('../../../packages/protocol/test/fixtures/live-snapshot-v1.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  snapshot.cursor.liveSessionId = 'live-a';
  const event = parseReliableEventV1({
    ...JSON.parse(
      await readFile(
        new URL('../../../packages/protocol/test/fixtures/reliable-event-v1.json', import.meta.url),
        'utf8',
      ),
    ),
    kind: 'map_started',
    payload: {},
    cursor: snapshot.cursor,
  });
  const installation = {
    baseUrl: 'https://example.com',
    credential: 'old-secret',
    installationId: 'installation-a',
    competitionId: snapshot.competitionId,
    displayName: 'test',
  };
  await writeFile(path, JSON.stringify(installation));
  const releases: { matchId: string; authority: string | null; authorization: string | null }[] =
    [];
  let failRelease = false;
  let takenOverSource: Record<string, unknown> | undefined;
  const statusQueries: URLSearchParams[] = [];
  let retryAfter: string | null = null;
  let liveStatus = 200;
  let reliableStatus = 204;
  let loseClaim = false;
  let claimRecoverySupported = false;
  let legacyClaimRecoverySupported = false;
  let legacyRecovery: 'fenced' | 'foreign-fence' | 'found' | 'ambiguous' = 'fenced';
  let loseBeforeClaim = false;
  let lastClaimRequestId: string | undefined;
  const recoveredClaimIds: string[] = [];
  let idempotentClaim = false;
  let claimRefusal: (() => Response) | undefined;
  let reliableRequests = 0;
  let liveRequests = 0;
  let ambiguous = false;
  let staleStatus = false;
  let liveGate: Promise<void> | null = null;
  let claimGate: Promise<void> | null = null;
  let releaseGate: ((signal: AbortSignal | null | undefined) => Promise<void>) | undefined;
  let notifyClaim!: () => void;
  const claimStarted = new Promise<void>((resolve) => {
    notifyClaim = resolve;
  });

  let serverClaim: Record<string, unknown> | null = null;
  let revision = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/pairing/start'))
      return Response.json({
        pairingId: '11111111-1111-1111-1111-111111111111',
        pollToken: 'a'.repeat(64),
        expiresAt: '2099-01-01T00:00:00.000Z',
        authorizeUrl:
          'https://example.com/integrations/mizar/connect?pairingId=11111111-1111-1111-1111-111111111111',
      });
    if (url.pathname.endsWith('/pairing/poll'))
      return Response.json({
        status: 'authorized',
        credential: `rh_mizar_${'2'.repeat(36)}_${'a'.repeat(64)}`,
        installationId: 'installation-b',
        competitionId: installation.competitionId,
      });
    if (url.pathname.endsWith('/disconnect')) return Response.json({ revoked: true });
    if (url.pathname.endsWith('/claim-recovery')) {
      if (!claimRecoverySupported) return new Response(null, { status: 404 });
      if (init?.method !== 'POST')
        return Response.json({ version: 1, legacyScope: legacyClaimRecoverySupported });
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (request.legacy === true) {
        if (legacyRecovery === 'ambiguous') return Response.json({ status: 'ambiguous' });
        if (legacyRecovery === 'found')
          return Response.json({ status: 'found', source: serverClaim });
        return Response.json({
          status: 'fenced',
          scope: {
            ...request,
            installationId:
              legacyRecovery === 'foreign-fence'
                ? 'installation-other'
                : installation.installationId,
            competitionId: installation.competitionId,
          },
        });
      }
      const { claimRequestId } = JSON.parse(String(init.body)) as { claimRequestId: string };
      recoveredClaimIds.push(claimRequestId);
      return Response.json(
        serverClaim?.claimRequestId === claimRequestId
          ? { status: 'found', claimRequestId, source: serverClaim }
          : { status: 'cancelled', claimRequestId },
      );
    }
    if (url.pathname.endsWith('/claim')) {
      if (claimRefusal) return claimRefusal();
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      lastClaimRequestId = body.claimRequestId as string | undefined;
      if (loseBeforeClaim) throw new TypeError('request not received');
      if (
        !idempotentClaim ||
        !serverClaim ||
        serverClaim.state !== 'open' ||
        serverClaim.matchId !== body.matchId ||
        serverClaim.producerInstanceId !== body.producerInstanceId ||
        serverClaim.liveSessionId !== body.liveSessionId
      )
        revision++;
      serverClaim = {
        ...body,
        installationId: installation.installationId,
        competitionId: installation.competitionId,
        authorityRevision: revision,
        state: 'open',
        sessionId: 'session',
        closeReason: null,
        matchStatus: 'finished',
      };
      notifyClaim();
      if (claimGate) await claimGate;
      if (loseClaim) throw new TypeError('lost response');
      return Response.json({ claimed: true, authorityRevision: revision });
    }
    if (url.pathname.endsWith('/source-status')) {
      statusQueries.push(url.searchParams);
      const source =
        takenOverSource &&
        url.searchParams.get('authorityRevision') === String(takenOverSource.authorityRevision)
          ? takenOverSource
          : serverClaim;
      return Response.json(
        ambiguous
          ? { status: 'ambiguous' }
          : source
            ? {
                status: 'found',
                source: staleStatus ? { ...source, authorityRevision: 1, state: 'closed' } : source,
              }
            : { status: 'not_found' },
      );
    }
    if (url.pathname.endsWith('/reliable')) {
      reliableRequests++;
      return new Response(null, { status: reliableStatus });
    }
    if (url.pathname.endsWith('/live')) {
      liveRequests++;
      if (liveGate) await liveGate;
      return liveStatus === 200
        ? Response.json({ accepted: true })
        : new Response(null, { status: liveStatus });
    }
    if (url.pathname.endsWith('/release')) {
      const body = JSON.parse(String(init?.body)) as { matchId: string };
      const headers = new Headers(init?.headers);
      releases.push({
        matchId: body.matchId,
        authority: headers.get('x-rivalhub-authority'),
        authorization: headers.get('authorization'),
      });
      await releaseGate?.(init?.signal);
      if (
        takenOverSource &&
        headers.get('x-rivalhub-authority') === String(takenOverSource.authorityRevision)
      )
        return new Response(null, { status: 403 });
      if (failRelease)
        return new Response(null, {
          status: 503,
          ...(retryAfter ? { headers: { 'Retry-After': retryAfter } } : {}),
        });
      if (
        serverClaim &&
        headers.get('x-rivalhub-authority') === String(serverClaim.authorityRevision)
      )
        serverClaim = { ...serverClaim, state: 'closed', closeReason: 'released' };
      return Response.json({ released: true });
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  const connection = new RivalHubConnection(path, fetcher, 'https://example.com');
  await connection.load();
  let owner = connection;
  let output: OutputService | undefined;
  t.after(async () => {
    await owner.closeSourceState();
    await output?.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    connection,
    setOutput: (value: OutputService) => {
      output = value;
    },
    snapshot,
    event,
    path,
    releases,
    statusQueries,
    claimStarted,
    recoveredClaimIds,
    lastClaimRequestId: () => lastClaimRequestId,
    enableClaimRecovery: () => {
      claimRecoverySupported = true;
    },
    enableLegacyClaimRecovery: () => {
      claimRecoverySupported = true;
      legacyClaimRecoverySupported = true;
    },
    setLegacyRecovery: (value: 'fenced' | 'foreign-fence' | 'found' | 'ambiguous') => {
      legacyRecovery = value;
    },
    loseBeforeClaim: () => {
      loseBeforeClaim = true;
    },
    reliableRequests: () => reliableRequests,
    liveRequests: () => liveRequests,
    restart: async () => {
      await owner.closeSourceState();
      const restarted = new RivalHubConnection(path, fetcher, 'https://example.com');
      await restarted.load();
      assert.equal(restarted.view().sourceState, 'ready');
      owner = restarted;
      return restarted;
    },
    setFail: (v: boolean) => {
      failRelease = v;
    },
    closeByTakeover: () => {
      assert.ok(serverClaim);
      takenOverSource = { ...serverClaim, state: 'closed', closeReason: 'handover' };
      serverClaim = takenOverSource;
    },
    setRetryAfter: (v: string) => {
      retryAfter = v;
    },
    setLive: (v: number) => {
      liveStatus = v;
    },
    setReliable: (v: number) => {
      reliableStatus = v;
    },
    setLose: (v: boolean) => {
      loseClaim = v;
    },
    setIdempotent: (v: boolean) => {
      idempotentClaim = v;
    },
    setClaimRefusal: (value: (() => Response) | undefined) => {
      claimRefusal = value;
    },
    setAmbiguous: (v: boolean) => {
      ambiguous = v;
    },
    setStaleStatus: (v: boolean) => {
      staleStatus = v;
    },
    setLiveGate: (v: Promise<void> | null) => {
      liveGate = v;
    },
    setClaimGate: (v: Promise<void>) => {
      claimGate = v;
    },
    setReleaseGate: (value: typeof releaseGate) => {
      releaseGate = value;
    },
  };
}

test('background maintenance records blocked sync without opening its status page', async (t) => {
  const h = await setup(t);
  const logs: { msg?: string; diagnostic?: { snapshotAvailable: boolean } }[] = [];
  const app = Fastify({
    logger: { stream: { write: (line: string) => logs.push(JSON.parse(line)) } },
  });
  t.after(() => app.close());
  t.mock.timers.enable({ apis: ['setInterval'] });
  let snapshot: typeof h.snapshot | null = null;
  registerRivalHubConnectionRoutes(app, {
    connection: h.connection,
    controller: null,
    currentSnapshot: () => snapshot,
    originPolicy: { mode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: [] },
  });
  await app.ready();
  const evidence = () =>
    logs.filter((entry) => entry.msg === 'Website sync prerequisites and health changed');
  t.mock.timers.tick(10_000);
  assert.equal(evidence().length, 1);
  assert.equal(evidence()[0]?.diagnostic?.snapshotAvailable, false);
  t.mock.timers.tick(10_000);
  assert.equal(evidence().length, 1, 'unchanged background state must not flood the journal');
  snapshot = h.snapshot;
  t.mock.timers.tick(10_000);
  assert.equal(evidence().length, 2);
  assert.equal(evidence()[1]?.diagnostic?.snapshotAvailable, true);
  await app.inject({ method: 'GET', url: '/local/v1/rivalhub-connection' });
  assert.equal(evidence().length, 2, 'UI reads share the same evidence deduplication');
});

test('background cleanup confirms an exact old authority after a release 403', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  h.closeByTakeover();
  await assert.rejects(h.connection.release(), /待重试或核对/);
  assert.equal(h.connection.view().sourceCleanup.blocked, 1);
  assert.equal(h.connection.matchSourceRecovery(h.snapshot.matchId), 'remote_cleanup');
  assert.equal(h.connection.matchSourceRecovery('another-match'), 'idle');

  const restarted = await h.restart();
  assert.equal(restarted.matchSourceRecovery(h.snapshot.matchId), 'remote_cleanup');

  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  h.setAmbiguous(true);
  restarted.startSourceCleanup();
  const waitForCleanup = () =>
    assert.rejects(
      restarted.resumeSync(h.snapshot, 'revision', () => false),
      /比赛已变化/,
    );
  // The initial automatic probe sees an ambiguous result and leaves the record intact.
  await waitForCleanup();
  assert.equal(h.statusQueries.length, 1);
  assert.equal(restarted.view().sourceCleanup.blocked, 1);

  const next = structuredClone(h.snapshot);
  next.matchId = 'another-match';
  next.cursor.liveSessionId = 'another-session';
  await restarted.claim(next, 'revision', false);
  h.setAmbiguous(false);
  t.mock.timers.tick(10_000);
  await waitForCleanup();
  assert.equal(h.statusQueries.length, 1, 'the check is rate-limited');
  t.mock.timers.tick(60_000);
  await waitForCleanup();
  assert.equal(restarted.view().sourceCleanup.blocked, 0);
  assert.equal(restarted.matchSourceRecovery(h.snapshot.matchId), 'idle');
  assert.equal(restarted.view().activeSourceMatchId, next.matchId);

  assert.deepEqual(
    h.statusQueries.map((query) => [query.get('matchId'), query.get('authorityRevision')]),
    [
      [h.snapshot.matchId, '1'],
      [h.snapshot.matchId, '1'],
    ],
  );
  assert.equal(h.releases.length, 1, 'readback must never send another release');
});

for (const committed of [false, true]) {
  test(`request receipts settle a lost claim after restart (committed=${committed})`, async (t) => {
    const h = await setup(t);
    h.enableClaimRecovery();
    if (committed) h.setLose(true);
    else h.loseBeforeClaim();
    await assert.rejects(h.connection.claim(h.snapshot, 'revision', false));
    const requestId = h.lastClaimRequestId();
    assert.ok(requestId);
    const restarted = await h.restart();
    assert.equal(restarted.view().sourceCleanup.claimIntent, true);
    await restarted.release();
    assert.deepEqual(h.recoveredClaimIds, [requestId]);
    assert.equal(restarted.view().sourceCleanup.claimIntent, false);
    assert.equal(restarted.view().activeSourceMatchId, null);
    assert.equal(h.releases.length, committed ? 1 : 0);
    assert.deepEqual(h.statusQueries, []);
  });
}

test('an unconfirmed claim error remains durable rather than assuming not_found', async (t) => {
  const h = await setup(t);
  h.setClaimRefusal(() =>
    Response.json(
      { code: 'VALIDATION_FAILED', error: 'stale context' },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    ),
  );
  await assert.rejects(h.connection.claim(h.snapshot, 'revision', false));
  assert.equal(h.connection.view().sourceCleanup.claimIntent, true);
  const restarted = await h.restart();
  await assert.rejects(restarted.release());
  assert.equal(restarted.view().sourceCleanup.claimIntent, true);
});

test('an upgraded installation clears an old unnumbered intent only after a scoped website fence', async (t) => {
  const h = await setup(t);
  h.loseBeforeClaim();
  await assert.rejects(h.connection.claim(h.snapshot, 'revision', false));
  assert.equal(h.lastClaimRequestId(), undefined);
  assert.equal(h.connection.view().sourceCleanup.claimIntent, true);

  h.enableLegacyClaimRecovery();
  const restarted = await h.restart();
  await restarted.release();
  assert.equal(restarted.view().sourceCleanup.claimIntent, false);
  assert.deepEqual(h.releases, []);
  assert.deepEqual(h.statusQueries, []);
});

test('recovers a legacy source for cleanup when the website still owns the exact claim', async (t) => {
  const h = await setup(t);
  h.setLose(true);
  await assert.rejects(h.connection.claim(h.snapshot, 'revision', false));
  assert.equal(h.lastClaimRequestId(), undefined);
  assert.equal(h.connection.view().sourceCleanup.claimIntent, true);

  h.enableLegacyClaimRecovery();
  h.setLegacyRecovery('found');
  const restarted = await h.restart();
  await restarted.release();
  assert.equal(restarted.view().sourceCleanup.claimIntent, false);
  assert.equal(h.releases.length, 1);
  assert.equal(h.releases[0]?.authority, '1');
  assert.deepEqual(h.recoveredClaimIds, []);
  assert.deepEqual(h.statusQueries, []);
});

test('keeps a legacy intent when the website reports an ambiguous source', async (t) => {
  const h = await setup(t);
  h.setLose(true);
  await assert.rejects(h.connection.claim(h.snapshot, 'revision', false));
  h.enableLegacyClaimRecovery();
  h.setLegacyRecovery('ambiguous');
  const restarted = await h.restart();
  await assert.rejects(restarted.release());
  assert.equal(restarted.view().sourceCleanup.claimIntent, true);
  assert.deepEqual(h.releases, []);
  assert.deepEqual(h.statusQueries, []);
});

test('keeps a legacy intent when the website fences another installation', async (t) => {
  const h = await setup(t);
  h.loseBeforeClaim();
  await assert.rejects(h.connection.claim(h.snapshot, 'revision', false));
  h.enableLegacyClaimRecovery();
  h.setLegacyRecovery('foreign-fence');
  const restarted = await h.restart();
  await assert.rejects(restarted.release());
  assert.equal(restarted.view().sourceCleanup.claimIntent, true);
  assert.deepEqual(h.releases, []);
});

test('falls back to source status when the website has no legacy scope capability', async (t) => {
  const h = await setup(t);
  h.setLose(true);
  await assert.rejects(h.connection.claim(h.snapshot, 'revision', false));
  h.enableClaimRecovery();
  const restarted = await h.restart();
  await restarted.release();
  assert.equal(restarted.view().sourceCleanup.claimIntent, false);
  assert.ok(h.statusQueries.length > 0);
  assert.equal(h.releases.length, 1);
});

test('switch preserves failed old release when the new claim succeeds', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  h.setFail(true);
  const next = structuredClone(h.snapshot);
  next.matchId = 'match-b';
  next.cursor.liveSessionId = 'live-b';
  await h.connection.claim(next, 'revision', false);
  const state = JSON.parse(
    await readFile(join(h.path, '..', 'rivalhub-source-state.json'), 'utf8'),
  );
  assert.equal(
    state.records.find(
      (item: { identity: { matchId: string } }) => item.identity.matchId === h.snapshot.matchId,
    ).state,
    'release_pending',
  );
  assert.equal(
    state.records.find(
      (item: { identity: { matchId: string } }) => item.identity.matchId === 'match-b',
    ).state,
    'owned',
  );
  h.setFail(false);
  await h.connection.release();
  assert.deepEqual(
    h.releases.map((item) => item.authority),
    ['1', '1', '2'],
  );
});

test('lost claim response is reconciled by exact status and released after restart', async (t) => {
  const h = await setup(t);
  h.setLose(true);
  await assert.rejects(h.connection.claim(h.snapshot, 'revision', false));
  const restarted = await h.restart();
  await restarted.release();
  assert.equal(h.releases.length, 1);
  assert.equal(h.releases[0]?.authority, '1');
});

test(`lost idempotent claim survives restart and ambiguous status`, async (t) => {
  const h = await setup(t);
  h.setIdempotent(true);
  await h.connection.claim(h.snapshot, 'revision', false);
  h.setLose(true);
  await assert.rejects(h.connection.claim(h.snapshot, 'revision', false));
  h.setAmbiguous(true);
  const restarted = await h.restart();
  await assert.rejects(restarted.release(), /待重试或核对/);
  assert.equal(h.releases.length, 1);
  assert.equal(restarted.view().sourceCleanup.claimIntent, true);
  h.setAmbiguous(false);
  await restarted.release();
  assert.equal(restarted.view().sourceCleanup.claimIntent, false);
  assert.deepEqual(
    h.releases.map((item) => item.authority),
    ['1'],
  );
  h.setLose(false);
  await restarted.claim(h.snapshot, 'revision', false);
  await restarted.release();
  assert.deepEqual(
    h.releases.map((item) => item.authority),
    ['1', '2'],
  );
});

test('replacement pairing preserves pending old responsibility while accepting new credentials', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  await h.connection.startPairing();
  h.setFail(true);
  assert.equal(await h.connection.pollPairing(), 'authorized');
  assert.equal(JSON.parse(await readFile(h.path, 'utf8')).installationId, 'installation-b');
  const state = JSON.parse(
    await readFile(join(h.path, '..', 'rivalhub-source-state.json'), 'utf8'),
  );
  assert.equal(state.records[0]?.state, 'release_pending');
  assert.equal(state.records[0]?.identity.installationId, 'installation-a');
  assert.equal(state.records[0]?.identity.matchId, h.snapshot.matchId);
  assert.ok(h.releases.length > 0);
  assert.ok(h.releases.every((item) => item.authorization === 'Bearer old-secret'));
});

test('a previously released authority cannot resolve a later uncertain claim', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  await h.connection.release();
  h.setLose(true);
  await assert.rejects(h.connection.claim(h.snapshot, 'revision', false));
  h.setStaleStatus(true);
  const restarted = await h.restart();
  await assert.rejects(restarted.release(), /待重试或核对/);
  assert.equal(restarted.view().sourceCleanup.claimIntent, true);
  assert.equal(h.releases.length, 1);
});

test('a tampered queue URL cannot receive installation credentials', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  const path = join(h.path, '..', 'rivalhub-source-state.json');
  const state = JSON.parse(await readFile(path, 'utf8'));
  state.records[0].identity.baseUrl = 'https://attacker.example';
  await writeFile(path, JSON.stringify(state));
  const restarted = await h.restart();
  await assert.rejects(restarted.release(), /待重试或核对/);
  assert.equal(h.releases.length, 0);
});

test('a delayed claim after a binding switch cannot enable the old source', async (t) => {
  const h = await setup(t);
  let resume!: () => void;
  h.setClaimGate(
    new Promise<void>((resolve) => {
      resume = resolve;
    }),
  );
  const claim = h.connection.claim(h.snapshot, 'revision', false);
  await h.claimStarted;
  h.connection.bindingChanged('new-match');
  resume();
  await assert.rejects(claim, /比赛已变化/);
  assert.equal(h.connection.view().activeSourceMatchId, null);
  assert.equal(h.connection.view().sourceCleanup.pending, 1);
  await h.connection.release();
  assert.equal(h.releases.length, 1);
});

test('local exit accepts the durable claim intent while its remote response is pending', async (t) => {
  const h = await setup(t);
  let respond!: () => void;
  h.setClaimGate(
    new Promise<void>((resolve) => {
      respond = resolve;
    }),
  );
  const claiming = h.connection.claim(h.snapshot, 'revision', false);
  await h.claimStarted;
  await h.connection.handoffForExit();
  const file = join(h.path, '..', 'rivalhub-source-state.json');
  const pending = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(pending.intents[0]?.scope.matchId, h.snapshot.matchId);
  assert.equal(h.connection.view().activeSourceMatchId, null);
  h.setFail(true);
  respond();
  await assert.rejects(claiming, /比赛已变化/);
  const handedOff = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(handedOff.records[0]?.identity.matchId, h.snapshot.matchId);
  assert.equal(handedOff.records[0]?.state, 'release_pending');
  const restarted = await h.restart();
  h.setFail(false);
  await restarted.release();
  assert.equal(restarted.view().sourceCleanup.pending, 0);
  assert.ok(h.releases.every((release) => release.authority === '1'));
});

test('a release response after shutdown cancellation preserves the original handoff for recovery', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  let releaseStarted!: (signal: AbortSignal | null | undefined) => void;
  let respond!: () => void;
  const started = new Promise<AbortSignal | null | undefined>((resolve) => {
    releaseStarted = resolve;
  });
  const response = new Promise<void>((resolve) => {
    respond = resolve;
  });
  h.setReleaseGate((signal) => {
    releaseStarted(signal);
    return response;
  });
  const shutdown = new AbortController();
  await h.connection.prepareSourceShutdown();
  const pending = h.connection.shutdownSource(shutdown.signal);
  const requestSignal = await started;
  shutdown.abort(new Error('shutdown timeout'));
  assert.equal(requestSignal?.aborted, true);
  await h.connection.closeSourceState();
  respond();
  await assert.rejects(pending, /shutdown timeout/);
  const sourceState = JSON.parse(
    await readFile(join(h.path, '..', 'rivalhub-source-state.json'), 'utf8'),
  );
  assert.equal(sourceState.records[0]?.state, 'release_pending');
  assert.equal(sourceState.records[0]?.identity.matchId, h.snapshot.matchId);
  const restarted = await h.restart();
  await restarted.release();
  assert.equal(restarted.view().sourceCleanup.pending, 0);
});

test('claimRecoveryProof enforces request receipt id, cancelled, ambiguous, and foreign fences', () => {
  const scope = {
    baseUrl: 'https://example.com',
    competitionId: 'competition-1',
    installationId: 'installation-a',
    matchId: 'match-1',
    producerInstanceId: 'producer-1',
    liveSessionId: 'session-1',
  };
  const numberedIntent = {
    id: '11111111-1111-4111-8111-111111111111',
    scope,
    previousAuthorityRevision: 1,
    claimRecoveryVersion: 1 as const,
  };
  const foundSource = {
    competitionId: scope.competitionId,
    installationId: scope.installationId,
    matchId: scope.matchId,
    producerInstanceId: scope.producerInstanceId,
    liveSessionId: scope.liveSessionId,
    authorityRevision: 2,
    state: 'open',
  };

  assert.equal(
    claimRecoveryProof(
      { status: 'found', claimRequestId: 'req-other', source: foundSource },
      numberedIntent,
      true,
    ),
    undefined,
  );
  assert.equal(
    claimRecoveryProof({ status: 'cancelled', claimRequestId: 'req-other' }, numberedIntent, true),
    undefined,
  );
  assert.deepEqual(
    claimRecoveryProof(
      { status: 'cancelled', claimRequestId: numberedIntent.id },
      numberedIntent,
      false,
    ),
    { kind: 'clear' },
  );
  assert.equal(
    claimRecoveryProof(
      { status: 'ambiguous', claimRequestId: numberedIntent.id },
      numberedIntent,
      true,
    ),
    undefined,
  );
  assert.deepEqual(
    claimRecoveryProof(
      { status: 'found', claimRequestId: numberedIntent.id, source: foundSource },
      numberedIntent,
      false,
    ),
    { kind: 'authority', authorityRevision: 2, state: 'open' },
  );

  const legacyIntent = {
    id: '22222222-2222-4222-8222-222222222222',
    scope,
    previousAuthorityRevision: 1,
  };
  const wireScope = {
    competitionId: scope.competitionId,
    installationId: scope.installationId,
    matchId: scope.matchId,
    producerInstanceId: scope.producerInstanceId,
    liveSessionId: scope.liveSessionId,
  };
  assert.equal(
    claimRecoveryProof(
      { status: 'fenced', scope: { ...wireScope, installationId: 'installation-b' } },
      legacyIntent,
      true,
    ),
    undefined,
  );
  assert.equal(claimRecoveryProof({ status: 'ambiguous' }, legacyIntent, true), undefined);
  assert.deepEqual(claimRecoveryProof({ status: 'fenced', scope: wireScope }, legacyIntent, true), {
    kind: 'clear',
  });
});

test('historical unnumbered intent recovery validates exact source, previousAuthorityRevision, idempotentAuthorityRevision, and watermarks', async (t) => {
  const writeLegacyIntent = async (
    h: Awaited<ReturnType<typeof setup>>,
    options: {
      previousAuthorityRevision: number | null;
      idempotentAuthorityRevision?: number;
      record?: boolean;
      recordSessionId?: string;
      watermarkRevision?: number;
      quarantineWatermarkRevision?: number;
    },
  ) => {
    const file = join(h.path, '..', 'rivalhub-source-state.json');
    const state = JSON.parse(await readFile(file, 'utf8')) as {
      records: unknown[];
      watermarks: unknown[];
      intents: unknown[];
    };
    const scope = {
      baseUrl: 'https://example.com',
      competitionId: h.snapshot.competitionId,
      installationId: 'installation-a',
      matchId: h.snapshot.matchId,
      producerInstanceId: h.snapshot.cursor.producerInstanceId,
      liveSessionId: h.snapshot.cursor.liveSessionId,
    };
    state.records = options.record
      ? [
          {
            identity: {
              ...scope,
              liveSessionId: options.recordSessionId ?? scope.liveSessionId,
              authorityRevision: 1,
            },
            state: 'release_pending',
            cause: 'recovery',
            attempts: 0,
            nextAttemptAt: null,
            lastFailureCode: null,
          },
        ]
      : [];
    state.watermarks =
      options.watermarkRevision !== undefined
        ? [{ ...scope, authorityRevision: options.watermarkRevision }]
        : [];
    state.intents = [
      {
        id: '33333333-3333-4333-8333-333333333333',
        scope,
        previousAuthorityRevision: options.previousAuthorityRevision,
        ...(options.idempotentAuthorityRevision !== undefined
          ? { idempotentAuthorityRevision: options.idempotentAuthorityRevision }
          : {}),
      },
    ];
    await writeFile(file, JSON.stringify(state));

    if (options.quarantineWatermarkRevision !== undefined) {
      const { createHash } = await import('node:crypto');
      const { mkdir } = await import('node:fs/promises');
      const qDir = join(h.path, '..', 'rivalhub-source-state.json.revoked');
      await mkdir(qDir, { recursive: true });
      const sha = (value: string) => createHash('sha256').update(value).digest('hex');
      const identity = { ...scope, authorityRevision: options.quarantineWatermarkRevision };
      const scopePrefix = sha(
        JSON.stringify([
          scope.baseUrl,
          scope.competitionId,
          scope.installationId,
          scope.matchId,
          scope.producerInstanceId,
          scope.liveSessionId,
        ]),
      );
      const itemDigest = sha(
        `watermark:${JSON.stringify([
          identity.baseUrl,
          identity.competitionId,
          identity.installationId,
          identity.matchId,
          identity.producerInstanceId,
          identity.liveSessionId,
          identity.authorityRevision,
        ])}`,
      );
      const evidence = { kind: 'watermark', identity };
      const body = JSON.stringify(evidence);
      await writeFile(join(qDir, `${scopePrefix}-w-${itemDigest}-${sha(body)}.json`), body);
    }
  };

  const blockedCases: Parameters<typeof writeLegacyIntent>[1][] = [
    { previousAuthorityRevision: 2, record: false },
    { previousAuthorityRevision: 1, record: false },
    { previousAuthorityRevision: 1, record: true, recordSessionId: 'other-session' },
    { previousAuthorityRevision: 1, record: true, watermarkRevision: 1 },
    { previousAuthorityRevision: 1, record: true, quarantineWatermarkRevision: 1 },
    { previousAuthorityRevision: 1, idempotentAuthorityRevision: 2, record: true },
  ];
  for (const [index, spec] of blockedCases.entries()) {
    const h = await setup(t);
    if (index === 0) h.setIdempotent(true);
    await h.connection.claim(h.snapshot, 'revision', false);
    await writeLegacyIntent(h, spec);
    const restarted = await h.restart();
    await assert.rejects(restarted.release(), /待重试或核对/);
    assert.equal(restarted.view().sourceCleanup.claimIntent, true);
    if (index <= 1) assert.deepEqual(h.releases, []);
  }

  for (const spec of [
    { previousAuthorityRevision: 1, idempotentAuthorityRevision: 1, record: false },
    { previousAuthorityRevision: 1, record: true },
  ] satisfies Parameters<typeof writeLegacyIntent>[1][]) {
    const h = await setup(t);
    await h.connection.claim(h.snapshot, 'revision', false);
    await writeLegacyIntent(h, spec);
    const restarted = await h.restart();
    await restarted.release();
    assert.equal(restarted.view().sourceCleanup.claimIntent, false);
    assert.deepEqual(
      h.releases.map((item) => item.authority),
      ['1'],
    );
  }

  // 9. revision > previousAuthorityRevision -> recovers newer authority (rev 2)
  {
    const h = await setup(t);
    await h.connection.claim(h.snapshot, 'revision', false); // rev 1
    await h.connection.release();
    await h.connection.claim(h.snapshot, 'revision', false); // rev 2
    await writeLegacyIntent(h, {
      previousAuthorityRevision: 1,
      record: false,
    });
    const restarted = await h.restart();
    await restarted.release();
    assert.equal(restarted.view().sourceCleanup.claimIntent, false);
    assert.deepEqual(
      h.releases.map((item) => item.authority),
      ['1', '2'],
    );
  }
});

test('lost claim response clears cleanly after restart when a new source takes over and closes the old claim', async (t) => {
  const h = await setup(t);
  h.setLose(true);
  await assert.rejects(h.connection.claim(h.snapshot, 'revision', false));
  assert.equal(h.connection.view().sourceCleanup.claimIntent, true);
  h.closeByTakeover();
  const restarted = await h.restart();
  await restarted.release();
  assert.equal(restarted.view().sourceCleanup.claimIntent, false);
  assert.deepEqual(h.releases, []);
});
