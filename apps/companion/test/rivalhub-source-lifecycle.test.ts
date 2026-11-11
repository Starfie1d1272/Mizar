import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseLiveSnapshotV1, parseReliableEventV1 } from '@mizar/protocol/output';
import { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
import { ReliableOutbox } from '../src/output/reliable-outbox.js';
import { OutputService } from '../src/output/service.js';

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
  let retryAfter: string | null = null;
  let liveStatus = 200;
  let reliableStatus = 204;
  let loseClaim = false;
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
      if (claimRefusal) return claimRefusal();
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
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
    if (url.pathname.endsWith('/source-status'))
      return Response.json(
        ambiguous
          ? { status: 'ambiguous' }
          : serverClaim
            ? {
                status: 'found',
                source: staleStatus
                  ? { ...serverClaim, authorityRevision: 1, state: 'closed' }
                  : serverClaim,
              }
            : { status: 'not_found' },
      );
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
    await owner.abortSourceCaptureStartup();
    await output?.close();
    await rm(dir, { recursive: true, force: true });
  });
  connection.setSourceSettlement(
    async () => settle,
    () => undefined,
  );
  return {
    connection,
    setOutput: (value: OutputService) => {
      output = value;
    },
    snapshot,
    event,
    path,
    releases,
    claimStarted,
    reliableRequests: () => reliableRequests,
    liveRequests: () => liveRequests,
    restart: async () => {
      await owner.abortSourceCaptureStartup();
      const restarted = new RivalHubConnection(path, fetcher, 'https://example.com');
      await restarted.load();
      assert.equal(restarted.view().sourceState, 'ready');
      owner = restarted;
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
    setSettle: (v: boolean) => {
      settle = v;
    },
  };
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

for (const operation of ['switch', 'backoff'] as const) {
  test(`a LIVE 403 drains the existing outbox during ${operation}`, async (t) => {
    const h = await setup(t);
    const tail = parseReliableEventV1({
      ...h.event,
      kind: 'series_ended',
      payload: { scoreA: 2, scoreB: 0 },
      observedAt: new Date().toISOString(),
      idempotencyKey: 'pending-series-end',
      cursor: { ...h.event.cursor, runtimeSeq: h.event.cursor.runtimeSeq + 1 },
    });
    const outbox = new ReliableOutbox(join(h.path, '..', 'reliable.json'));
    let now = new Date();
    const output = new OutputService({
      outbox,
      now: () => now,
      exactSource: () => h.connection.reliableExactSource(),
      authorityScope: () => h.connection.reliableAuthorityScope(),
      sink: {
        send: (event, signal, lineup, source) =>
          source
            ? h.connection.sendRetainedReliable(event, source, h.snapshot, signal, lineup)
            : h.connection.sendReliable(event, h.snapshot, signal, lineup),
      },
    });
    await output.start();
    h.setOutput(output);
    const binding = {
      origin: 'online',
      freshness: 'fresh',
      manifest: { revision: tail.contextRevision },
      context: {
        matchId: tail.matchId,
        competition: { competitionId: tail.competitionId },
        entrants: { a: { entryId: tail.entryAId }, b: { entryId: tail.entryBId } },
      },
    };
    const bundle = {
      program: {
        cursor: h.snapshot.cursor,
        match: { matchId: tail.matchId },
        status: { context: 'fresh', telemetry: 'fresh', identity: 'matched' },
        map: { phase: 'gameover', name: tail.mapName },
        players: h.snapshot.players,
        series: { status: 'completed', currentMapOrder: 1, maps: [] },
      },
      operator: { activeLineup: { ctCount: 5, tCount: 5 }, identity: { state: 'ok' } },
      identity: { issues: [] },
    };
    output.setCurrent(bundle as never, binding as never);
    await h.connection.setSourceCaptureLifecycle({
      createReference: (cursor) => output.createCaptureReference(cursor),
      arm: (identity, reference) => output.armSourceCapture(identity, reference),
      activate: (identity) => output.activateSourceCapture(identity),
      restore: (identity, reference) => output.restoreSourceCapture(identity, reference),
      seal: (identity) => output.sealSourceCapture(identity),
      coverage: (identity) => output.sourceCaptureCoverage(identity),
    });
    await h.connection.claim(h.snapshot, 'revision', false);
    await h.connection.sendReliable(h.event, h.snapshot);
    h.setLive(403);
    await assert.rejects(h.connection.sendLive(h.snapshot));
    const before = h.reliableRequests();
    assert.equal(await h.connection.sendReliable(tail, h.snapshot), 'retry');
    assert.equal(h.reliableRequests(), before);
    await outbox.enqueue(
      tail,
      now,
      undefined,
      undefined,
      undefined,
      undefined,
      h.connection.reliableExactSource(),
    );
    h.connection.setSourceSettlement(
      (scope) => output.settleSourceForRelease(scope),
      (scope) => output.resumeSource(scope),
    );
    if (operation === 'switch') {
      const next = structuredClone(h.snapshot);
      next.matchId = 'match-b';
      next.cursor.liveSessionId = 'live-b';
      output.setCurrent(
        {
          ...bundle,
          program: { ...bundle.program, cursor: next.cursor, match: { matchId: next.matchId } },
        } as never,
        { ...binding, context: { ...binding.context, matchId: next.matchId } } as never,
      );
      await h.connection.claim(next, 'revision', false);
      assert.equal(h.connection.view().activeSourceMatchId, 'match-b');
    } else {
      await output.retry();
      assert.equal(
        outbox.getRecords().find((record) => record.event.idempotencyKey === tail.idempotencyKey)
          ?.status,
        'pending',
      );
      await assert.rejects(h.connection.release(), /待重试或核对/);
      assert.equal(h.releases.length, 0);
      const liveBefore = h.liveRequests();
      h.setLive(200);
      await assert.rejects(h.connection.sendLive(h.snapshot), /rivalhub_live_unavailable/);
      assert.equal(h.liveRequests(), liveBefore);
      now = new Date(now.getTime() + 1001);
      await output.retry();
      await h.connection.release();
    }
    assert.equal(h.reliableRequests(), before + 1);
    assert.equal(
      outbox.getRecords().find((record) => record.event.idempotencyKey === tail.idempotencyKey)
        ?.status,
      'accepted',
    );
    assert.equal(h.releases.length, 1);
    assert.deepEqual(h.releases[0], {
      matchId: h.snapshot.matchId,
      authority: '1',
      authorization: 'Bearer old-secret',
    });
  });
}

test(
  'failed durable handoff never enables reliable draining after a LIVE 403',
  {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async (t) => {
    const h = await setup(t);
    await h.connection.claim(h.snapshot, 'revision', false);
    await h.connection.sendReliable(h.event, h.snapshot);
    h.setLive(403);
    await assert.rejects(h.connection.sendLive(h.snapshot));
    const before = h.reliableRequests();
    const dir = join(h.path, '..');
    await chmod(dir, 0o500);
    try {
      await assert.rejects(h.connection.release());
      assert.equal(await h.connection.sendReliable(h.event, h.snapshot), 'retry');
      assert.equal(h.reliableRequests(), before);
      assert.equal(h.releases.length, 0);
    } finally {
      await chmod(dir, 0o700);
    }
    await h.connection.release();
    assert.equal(h.releases.length, 1);
  },
);

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

test('retirement fences new events before enabling drain while LIVE is still in flight', async (t) => {
  const h = await setup(t);
  await h.connection.claim(h.snapshot, 'revision', false);
  await h.connection.sendReliable(h.event, h.snapshot);
  let finishLive!: () => void;
  h.setLiveGate(
    new Promise<void>((resolve) => {
      finishLive = resolve;
    }),
  );
  const live = h.connection.sendLive(h.snapshot);
  h.setLiveGate(null);
  h.setLive(403);
  await assert.rejects(h.connection.sendLive(h.snapshot));
  let markFenced!: () => void;
  const fenced = new Promise<void>((resolve) => {
    markFenced = resolve;
  });
  h.connection.setSourceSettlement(
    async () => {
      markFenced();
      return true;
    },
    () => undefined,
  );
  const identity = h.connection.reliableExactSource()!;
  const release = h.connection.release();
  await fenced;
  const before = h.reliableRequests();
  assert.equal(await h.connection.sendRetainedReliable(h.event, identity, h.snapshot), 'accepted');
  assert.equal(h.reliableRequests(), before + 1);
  assert.equal(h.releases.length, 0);
  finishLive();
  await assert.rejects(live);
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
