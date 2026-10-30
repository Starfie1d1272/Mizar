import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseLiveSnapshotV1, parseReliableEventV1 } from '@mizar/protocol/output';
import { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-lifecycle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
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
  let retryAfter: string | null = null;
  let liveStatus = 200;
  let reliableStatus = 204;
  let loseClaim = false;
  let ambiguous = false;
  let liveGate: Promise<void> | null = null;
  let claimGate: Promise<void> | null = null;
  let notifyClaim!: () => void;
  const claimStarted = new Promise<void>((resolve) => {
    notifyClaim = resolve;
  });
  let settle = true;
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
    if (url.pathname.endsWith('/claim')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
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
    if (url.pathname.endsWith('/source-status'))
      return Response.json(
        ambiguous
          ? { status: 'ambiguous' }
          : serverClaim
            ? { status: 'found', source: serverClaim }
            : { status: 'not_found' },
      );
    if (url.pathname.endsWith('/reliable')) return new Response(null, { status: reliableStatus });
    if (url.pathname.endsWith('/live')) {
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
      return failRelease
        ? new Response(null, {
            status: 503,
            ...(retryAfter ? { headers: { 'Retry-After': retryAfter } } : {}),
          })
        : Response.json({ released: true });
    }
    throw new Error(`unexpected ${url.pathname}`);
  };
  const connection = new RivalHubConnection(path, fetcher, 'https://example.com');
  await connection.load();
  connection.setSourceSettlement(
    async () => settle,
    () => undefined,
  );
  return {
    connection,
    snapshot,
    event,
    path,
    releases,
    claimStarted,
    restart: async () => {
      const restarted = new RivalHubConnection(path, fetcher, 'https://example.com');
      await restarted.load();
      restarted.setSourceSettlement(
        async () => settle,
        () => undefined,
      );
      return restarted;
    },
    setFail: (v: boolean) => {
      failRelease = v;
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
    setAmbiguous: (v: boolean) => {
      ambiguous = v;
    },
    setLiveGate: (v: Promise<void>) => {
      liveGate = v;
    },
    setClaimGate: (v: Promise<void>) => {
      claimGate = v;
    },
    setSettle: (v: boolean) => {
      settle = v;
    },
  };
}

test('LIVE 403 stops delivery but finish releases the exact owned source', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  await h.connection.sendReliable(h.event, h.snapshot);
  h.setLive(403);
  await assert.rejects(h.connection.sendLive(h.snapshot));
  await h.connection.release();
  assert.deepEqual(h.releases, [
    { matchId: h.snapshot.matchId, authority: '1', authorization: 'Bearer old-secret' },
  ]);
});

test('reliable 403 retains the exact identity for finish', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  h.setReliable(403);
  assert.equal(await h.connection.sendReliable(h.event, h.snapshot), 'rejected');
  await h.connection.release();
  assert.equal(h.releases[0]?.authority, '1');
});

test('pending reliable scope prevents release and later retry retains identity', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  h.setSettle(false);
  await assert.rejects(h.connection.release(), /可靠事件/);
  assert.equal(h.releases.length, 0);
  h.setSettle(true);
  await h.connection.release();
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

test('replacement pairing keeps the old credential until cleanup succeeds', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  await h.connection.startPairing();
  h.setFail(true);
  await assert.rejects(h.connection.pollPairing());
  assert.equal(JSON.parse(await readFile(h.path, 'utf8')).credential, 'old-secret');
  h.setFail(false);
  assert.equal(await h.connection.pollPairing(), 'authorized');
  assert.equal(JSON.parse(await readFile(h.path, 'utf8')).installationId, 'installation-b');
  assert.ok(h.releases.every((item) => item.authorization === 'Bearer old-secret'));
});

test('explicit disconnect can revoke an installation after release fails', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  h.setFail(true);
  await h.connection.disconnect();
  assert.equal(h.connection.view().paired, false);
  assert.deepEqual(h.connection.view().sourceCleanup, {
    pending: 0,
    blocked: 0,
    claimIntent: false,
  });
  await assert.rejects(readFile(h.path), { code: 'ENOENT' });
});

test('explicit retry still honors the server Retry-After delay', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  h.setFail(true);
  h.setRetryAfter('60');
  await assert.rejects(h.connection.release());
  h.setFail(false);
  await assert.rejects(h.connection.release());
  assert.equal(h.releases.length, 1);
});

test('an ambiguous claim status is retained and does not release', async (t) => {
  const h = await setup(t);
  h.setLose(true);
  await assert.rejects(h.connection.claim(h.snapshot, 'revision', false));
  h.setAmbiguous(true);
  const restarted = await h.restart();
  await assert.rejects(restarted.release(), /待重试或核对/);
  assert.equal(h.releases.length, 0);
  assert.equal(restarted.view().sourceCleanup.claimIntent, true);
});

test('release waits for an already in-flight LIVE request', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  await h.connection.sendReliable(h.event, h.snapshot);
  let finish!: () => void;
  h.setLiveGate(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const live = h.connection.sendLive(h.snapshot);
  const release = h.connection.release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(h.releases.length, 0);
  finish();
  await live;
  await release;
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
