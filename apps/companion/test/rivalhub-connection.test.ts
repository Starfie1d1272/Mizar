import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { type LiveSnapshotV1, type ReliableEventV1 } from '@mizar/protocol/output';
import {
  RivalHubConnection,
  OFFICIAL_RIVALHUB_URL,
} from '../src/match-context/rivalhub-connection.js';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const validPairingId = '00000000-0000-0000-0000-000000000001';
const validPollToken = 'a'.repeat(64);
const validAuthorizeUrl = `${OFFICIAL_RIVALHUB_URL}/integrations/mizar/connect?pairingId=${validPairingId}`;
const validExpiresAt = new Date(Date.now() + 60_000).toISOString();

it('pairs via browser authorization, persists only in Companion, and claims with observed starters', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-rivalhub-'));
  temporary.push(directory);
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn((url: string | URL | Request, init: RequestInit = {}) => {
    const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    requests.push({ url: requestUrl, init });
    if (requestUrl.endsWith('/pairing/start')) {
      return Promise.resolve(
        Response.json({
          pairingId: validPairingId,
          pollToken: validPollToken,
          authorizeUrl: validAuthorizeUrl,
          expiresAt: validExpiresAt,
        }),
      );
    }
    if (requestUrl.endsWith('/pairing/poll')) {
      return Promise.resolve(
        Response.json({
          status: 'authorized',
          credential: `rh_mizar_${validPairingId}_${'a'.repeat(64)}`,
          installationId: 'installation',
          competitionId: 'competition',
          displayName: '星宇',
        }),
      );
    }
    if (requestUrl.endsWith('/claim'))
      return Promise.resolve(Response.json({ claimed: true, authorityRevision: 4 }));
    if (requestUrl.endsWith('/release')) return Promise.resolve(Response.json({ released: true }));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  const path = join(directory, 'connection.json');
  const connection = new RivalHubConnection(path, fetchImpl);
  const { authorizeUrl, expiresAt } = await connection.startPairing();
  expect(authorizeUrl).toBe(validAuthorizeUrl);
  expect(expiresAt).toBe(validExpiresAt);

  const status = await connection.pollPairing();
  expect(status).toBe('authorized');
  expect(await readFile(path, 'utf8')).toContain('installation');

  const restored = new RivalHubConnection(path, fetchImpl);
  await restored.load();
  expect(restored.view()).toMatchObject({
    paired: true,
    displayName: '星宇',
    activeSourceMatchId: null,
  });

  const players = Array.from({ length: 10 }, (_, index) => ({
    sourcePlayerId: `7656119${String(index).padStart(10, '0')}`,
    lineupEvidence: 'current',
  }));
  const snapshot = {
    matchId: 'match',
    competitionId: 'competition',
    cursor: {
      producerInstanceId: 'producer',
      liveSessionId: 'session',
      programSourceGeneration: 2,
      mapEpoch: 3,
    },
    players,
  } as LiveSnapshotV1;

  expect(restored.reliableAuthorityScope()).toBeNull();
  await restored.claim(snapshot, 'revision', false);
  const firstClaimScope = restored.reliableAuthorityScope();
  expect(firstClaimScope).not.toBeNull();
  await restored.claim(snapshot, 'revision', false);
  expect(restored.reliableAuthorityScope()).not.toBe(firstClaimScope);
  const claim = requests.find((request) => request.url.endsWith('/claim'))!;
  expect(JSON.parse(claim.init.body as string)).toMatchObject({
    matchId: 'match',
    lineupSteam64: players.map((player) => player.sourcePlayerId),
  });

  await restored.sendReliable(
    { kind: 'map_started', matchId: snapshot.matchId, cursor: snapshot.cursor } as ReliableEventV1,
    snapshot,
  );
  await restored.sendLive(snapshot);
  const live = requests.find((request) => request.url.endsWith('/live'))!;
  expect(new Headers(live.init.headers).get('x-rivalhub-authority')).toBe('4');

  await restored.release();
  const release = requests.find((request) => request.url.endsWith('/release'))!;
  expect(new Headers(release.init.headers).get('x-rivalhub-authority')).toBe('4');
  expect(JSON.parse(release.init.body as string)).toEqual({
    matchId: 'match',
    producerInstanceId: 'producer',
    liveSessionId: 'session',
  });
  expect(restored.view().activeSourceMatchId).toBeNull();
  expect(restored.reliableAuthorityScope()).toBeNull();
});

it('waits for the current authority and execution start acknowledgement before uploading live frames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-live-start-'));
  temporary.push(directory);
  const path = join(directory, 'connection.json');
  await writeFile(
    path,
    JSON.stringify({
      baseUrl: OFFICIAL_RIVALHUB_URL,
      credential: 'test',
      installationId: 'installation',
      competitionId: 'competition',
      displayName: 'Test',
    }),
  );
  let acknowledge: ((response: Response) => void) | undefined;
  const request = vi.fn<typeof fetch>((url) => {
    if (
      (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/claim')
    )
      return Promise.resolve(Response.json({ claimed: true, authorityRevision: 1 }));
    if (
      (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith(
        '/reliable',
      )
    )
      return new Promise<Response>((resolve) => {
        acknowledge = resolve;
      });
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const connection = new RivalHubConnection(path, request);
  await connection.load();
  const snapshot = {
    matchId: 'match',
    competitionId: 'competition',
    cursor: {
      producerInstanceId: 'producer',
      liveSessionId: 'session',
      programSourceGeneration: 1,
      mapEpoch: 1,
    },
    players: [],
  } as unknown as LiveSnapshotV1;
  const start = {
    kind: 'map_started',
    matchId: 'match',
    cursor: snapshot.cursor,
  } as ReliableEventV1;
  await connection.claim(snapshot, 'revision', false);
  await expect(connection.sendLive(snapshot)).rejects.toThrow('rivalhub_map_start_pending');
  const delivery = connection.sendReliable(start, snapshot);
  await expect(connection.sendLive(snapshot)).rejects.toThrow('rivalhub_map_start_pending');
  expect(
    request.mock.calls.filter(([url]) =>
      (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/live'),
    ),
  ).toHaveLength(0);
  acknowledge!(new Response(null, { status: 204 }));
  expect(await delivery).toBe('accepted');
  await connection.sendLive(snapshot);
  expect(
    request.mock.calls.filter(([url]) =>
      (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/live'),
    ),
  ).toHaveLength(1);
  for (const cursor of [
    { ...snapshot.cursor, programSourceGeneration: 2 },
    { ...snapshot.cursor, mapEpoch: 2 },
  ])
    await expect(connection.sendLive({ ...snapshot, cursor })).rejects.toThrow(
      'rivalhub_map_start_pending',
    );

  const oldDelivery = connection.sendReliable(start, snapshot);
  await connection.claim(snapshot, 'revision', false);
  acknowledge!(new Response(null, { status: 204 }));
  await oldDelivery;
  await expect(connection.sendLive(snapshot)).rejects.toThrow('rivalhub_map_start_pending');
  const retry = connection.sendReliable(start, snapshot);
  acknowledge!(new Response(null, { status: 503 }));
  expect(await retry).toBe('retry');
  await expect(connection.sendLive(snapshot)).rejects.toThrow('rivalhub_map_start_pending');
  expect(connection.view().activeSourceMatchId).toBe('match');

  const restored = connection.sendReliable(start, snapshot);
  acknowledge!(new Response(null, { status: 204 }));
  await restored;
  let rejectOldLive: ((response: Response) => void) | undefined;
  request.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        rejectOldLive = resolve;
      }),
  );
  const oldLive = connection.sendLive(snapshot);
  await connection.claim(snapshot, 'revision', false);
  rejectOldLive!(new Response(null, { status: 403 }));
  await expect(oldLive).rejects.toThrow('rivalhub_live_unavailable');
  expect(connection.view().activeSourceMatchId).toBe('match');
  expect(connection.view().activeDeviceName).toBeNull();
});

it.each(['producerInstanceId', 'liveSessionId'] as const)(
  'rejects recovered events from an old %s without sending them under a new claim',
  async (field) => {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-recovered-authority-'));
    temporary.push(directory);
    const path = join(directory, 'connection.json');
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: OFFICIAL_RIVALHUB_URL,
        credential: 'test',
        installationId: 'installation',
        competitionId: 'competition',
        displayName: 'Test',
      }),
    );
    const request = vi.fn<typeof fetch>((url, init) => {
      if (
        (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/claim')
      )
        return Promise.resolve(Response.json({ claimed: true, authorityRevision: 2 }));
      const body = JSON.parse(init?.body as string) as { event?: ReliableEventV1 };
      // The real website binds both producer and session to the claimed authority.
      return Promise.resolve(
        new Response(null, {
          status: body.event?.cursor[field] === 'previous' ? 403 : 204,
        }),
      );
    });
    const connection = new RivalHubConnection(path, request);
    await connection.load();
    const current = {
      matchId: 'match',
      competitionId: 'competition',
      cursor: {
        producerInstanceId: 'current',
        liveSessionId: 'session',
        programSourceGeneration: 1,
        mapEpoch: 1,
      },
      players: [],
    } as unknown as LiveSnapshotV1;
    await connection.claim(current, 'revision', true);
    for (const kind of ['map_started', 'match_started'] as const) {
      const recovered = {
        kind,
        matchId: 'match',
        cursor: { ...current.cursor, [field]: 'previous' },
      } as ReliableEventV1;
      const original = JSON.stringify(recovered);
      expect(await connection.sendReliable(recovered, current)).toBe('rejected');
      expect(JSON.stringify(recovered)).toBe(original);
    }
    expect(request).toHaveBeenCalledTimes(1);
    await expect(connection.sendLive(current)).rejects.toThrow('rivalhub_map_start_pending');
    expect(connection.view().activeSourceMatchId).toBe('match');
    await connection.sendReliable(
      { kind: 'map_started', matchId: 'match', cursor: current.cursor } as ReliableEventV1,
      current,
    );
    await connection.sendLive(current);
    expect(request).toHaveBeenCalledTimes(3);
    expect(connection.view().activeSourceMatchId).toBe('match');
    expect(connection.view().activeDeviceName).toBeNull();
  },
);

it.each([false, true])(
  'does not let a late map A acknowledgement replace confirmed map B (cancelled=%s)',
  async (cancelled) => {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-late-map-'));
    temporary.push(directory);
    const path = join(directory, 'connection.json');
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: OFFICIAL_RIVALHUB_URL,
        credential: 'private',
        installationId: 'installation',
        competitionId: 'competition',
      }),
    );
    const pending: ((response: Response) => void)[] = [];
    const request = vi.fn<typeof fetch>((url) => {
      if (
        (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith('/claim')
      )
        return Promise.resolve(Response.json({ claimed: true, authorityRevision: 1 }));
      if (
        (typeof url === 'string' ? url : url instanceof URL ? url.href : url.url).endsWith(
          '/reliable',
        )
      )
        return new Promise<Response>((resolve) => pending.push(resolve));
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    const connection = new RivalHubConnection(path, request);
    await connection.load();
    const a = {
      matchId: 'match',
      competitionId: 'competition',
      cursor: {
        producerInstanceId: 'producer',
        liveSessionId: 'session',
        programSourceGeneration: 1,
        mapEpoch: 1,
      },
      players: [],
    } as unknown as LiveSnapshotV1;
    const b = { ...a, cursor: { ...a.cursor, mapEpoch: 2 } };
    await connection.claim(a, 'revision', false);
    const controller = new AbortController();
    const first = connection.sendReliable(
      { kind: 'map_started', matchId: 'match', cursor: a.cursor } as ReliableEventV1,
      a,
      controller.signal,
    );
    if (cancelled) controller.abort();
    const second = connection.sendReliable(
      { kind: 'map_started', matchId: 'match', cursor: b.cursor } as ReliableEventV1,
      b,
    );
    pending[1]!(new Response(null, { status: 204 }));
    expect(await second).toBe('accepted');
    await connection.sendLive(b);
    pending[0]!(new Response(null, { status: 204 }));
    expect(await first).toBe('retry');
    await connection.sendLive(b);
    await expect(connection.sendLive(a)).rejects.toThrow('rivalhub_map_start_pending');
    expect(connection.view().activeSourceMatchId).toBe('match');
  },
);

it('fails closed when remote server returns 403 indicating authority loss', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-rivalhub-403-'));
  temporary.push(directory);
  const fetchImpl = vi.fn((url: string | URL | Request) => {
    const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (requestUrl.endsWith('/pairing/start')) {
      return Promise.resolve(
        Response.json({
          pairingId: validPairingId,
          pollToken: validPollToken,
          authorizeUrl: validAuthorizeUrl,
          expiresAt: validExpiresAt,
        }),
      );
    }
    if (requestUrl.endsWith('/pairing/poll')) {
      return Promise.resolve(
        Response.json({
          status: 'authorized',
          credential: `rh_mizar_${validPairingId}_${'a'.repeat(64)}`,
          installationId: 'inst-1',
          competitionId: 'comp-1',
          displayName: '操作者',
        }),
      );
    }
    if (requestUrl.endsWith('/claim'))
      return Promise.resolve(Response.json({ claimed: true, authorityRevision: 1 }));
    if (requestUrl.endsWith('/live')) return Promise.resolve(new Response(null, { status: 403 }));
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  const path = join(directory, 'connection.json');
  const connection = new RivalHubConnection(path, fetchImpl);
  await connection.startPairing();
  await connection.pollPairing();

  const snapshot = {
    matchId: 'match-1',
    competitionId: 'comp-1',
    cursor: {
      producerInstanceId: 'p',
      liveSessionId: 's',
      programSourceGeneration: 1,
      mapEpoch: 1,
    },
    players: [],
  } as unknown as LiveSnapshotV1;

  await connection.claim(snapshot, 'rev-1', false);
  expect(connection.view().activeSourceMatchId).toBe('match-1');

  await connection.sendReliable(
    { kind: 'map_started', matchId: snapshot.matchId, cursor: snapshot.cursor } as ReliableEventV1,
    snapshot,
  );
  await expect(connection.sendLive(snapshot)).rejects.toThrow('rivalhub_live_unavailable');
  expect(connection.view().activeSourceMatchId).toBeNull();
  expect(connection.view().activeDeviceName).toBeNull(); // A 403 does not prove another device owns the source.
});

it('watches matched formal executions, needs fresh receiver acceptance, and respects stop and another device', async () => {
  let now = 100;
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  const directory = await mkdtemp(join(tmpdir(), 'mizar-sync-health-'));
  temporary.push(directory);
  const path = join(directory, 'connection.json');
  await writeFile(
    path,
    JSON.stringify({
      baseUrl: OFFICIAL_RIVALHUB_URL,
      credential: 'test',
      installationId: 'test',
      competitionId: 'competition',
      displayName: 'test',
    }),
  );
  let liveResult = 'accepted';
  let otherDevice = false;
  let liveRequests = 0;
  let releaseFails = false;
  const connection = new RivalHubConnection(path, (url) => {
    const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const operation = requestUrl.split('/').at(-1);
    if (operation === 'release' && releaseFails) return Promise.reject(new TypeError('offline'));
    if (operation === 'claim')
      return Promise.resolve(
        Response.json({
          claimed: !otherDevice,
          authorityRevision: 1,
          activeDeviceName: otherDevice ? '另一制播机' : undefined,
        }),
      );
    if (operation === 'live') {
      liveRequests++;
      if (liveResult === 'network') return Promise.reject(new TypeError('offline'));
      return Promise.resolve(
        Response.json({ accepted: liveResult === 'accepted', reason: 'delivery_dropped' }),
      );
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const snapshot = {
    matchId: 'match',
    competitionId: 'competition',
    cursor: {
      producerInstanceId: 'producer',
      liveSessionId: 'session',
      programSourceGeneration: 1,
      mapEpoch: 1,
    },
    map: { phase: 'live', mapId: 'map-1' },
    capability: { identity: 'matched', canonicalTeams: true, lineupComplete: true },
    players: [],
  } as unknown as LiveSnapshotV1;
  const start = (value: LiveSnapshotV1) =>
    connection.sendReliable(
      { kind: 'map_started', matchId: value.matchId, cursor: value.cursor } as ReliableEventV1,
      value,
    );
  try {
    await connection.load();
    for (const candidate of [
      null,
      { ...snapshot, map: { ...snapshot.map, phase: 'warmup' } },
      { ...snapshot, map: { ...snapshot.map, mapId: null } },
    ]) {
      expect(connection.syncHealth(candidate, true).status).toBe('inactive');
      now += 60_000;
      expect(connection.syncHealth(candidate, true).status).toBe('inactive');
    }
    expect(connection.syncHealth(snapshot, false).status).toBe('inactive');
    expect(connection.syncHealth(snapshot, true).status).toBe('waiting');
    now += 15_001;
    const missing = connection.syncHealth(snapshot, true);
    expect(missing).toMatchObject({
      status: 'attention',
      reason: 'source_unavailable',
    });
    expect(typeof missing.incidentId).toBe('string');
    expect(connection.syncHealth(snapshot, false).status).toBe('inactive');
    expect(connection.syncHealth(snapshot, true).incidentId).toBe(missing.incidentId);
    await connection.claim(snapshot, 'rev', false);
    await expect(connection.sendLive(snapshot)).rejects.toThrow('rivalhub_map_start_pending');
    expect(connection.syncHealth(snapshot, true)).toMatchObject({
      status: 'attention',
      reason: 'map_start_pending',
      incidentId: missing.incidentId,
    });
    await start(snapshot);
    expect(connection.syncHealth(snapshot, true).status).toBe('attention');
    await connection.sendLive(snapshot);
    expect(connection.syncHealth(snapshot, true)).toMatchObject({
      status: 'healthy',
      incidentId: null,
    });
    now += 16_000;
    liveResult = 'network';
    await connection.sendLive(snapshot);
    const broken = connection.syncHealth(snapshot, true);
    expect(broken).toMatchObject({ status: 'attention', reason: 'network_failed' });
    expect(broken.incidentId).not.toBe(missing.incidentId);
    const before = liveRequests;
    await connection.sendLive(snapshot);
    expect(liveRequests).toBe(before); // finite backoff; no old frame queue
    connection.retryLive();
    liveResult = 'drop';
    await connection.sendLive(snapshot);
    expect(connection.syncHealth(snapshot, true).status).toBe('attention');
    liveResult = 'accepted';
    await connection.sendLive(snapshot);
    expect(connection.syncHealth(snapshot, true).status).toBe('healthy');
    const next = { ...snapshot, cursor: { ...snapshot.cursor, mapEpoch: 2 } };
    expect(connection.syncHealth(next, true).status).toBe('waiting');
    now += 15_001;
    expect(connection.syncHealth(next, true).status).toBe('attention');
    // Reclaiming and a reliable ACK are not receiver recovery, even in the same map.
    await connection.claim(next, 'rev', false);
    await start(snapshot);
    expect(connection.syncHealth(next, true).status).toBe('attention');
    await expect(connection.sendLive(next)).rejects.toThrow('rivalhub_map_start_pending');
    connection.stopSync('match');
    releaseFails = true;
    await expect(connection.release()).rejects.toThrow();
    const stoppedRequests = liveRequests;
    expect(await start(next)).toBe('retry');
    await connection.sendLive(next);
    expect(liveRequests).toBe(stoppedRequests);
    releaseFails = false;
    await connection.release();
    expect(connection.syncHealth(next, true).status).toBe('stopped');
    otherDevice = true;
    await connection.claim(next, 'rev', false);
    // Explicitly stopped remains stopped until this machine actually reclaims.
    expect(connection.syncHealth(next, true).status).toBe('stopped');
    otherDevice = false;
    await connection.claim(next, 'rev', false);
    otherDevice = true;
    await connection.claim(next, 'rev', false);
    now += 60_000;
    expect(connection.syncHealth(next, true)).toMatchObject({
      status: 'other_device',
      deviceName: '另一制播机',
    });
    const anotherMatch = { ...next, matchId: 'match-b' };
    expect(connection.syncHealth(anotherMatch, true).status).toBe('waiting');
    now += 16_000;
    expect(connection.syncHealth(anotherMatch, true)).toMatchObject({
      status: 'attention',
      reason: 'source_unavailable',
    });
  } finally {
    clock.mockRestore();
  }
});

it('reports connection load failures without exposing credential excerpts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-rivalhub-load-'));
  temporary.push(directory);
  const path = join(directory, 'connection.json');
  const secret = 'PRIVATE-CREDENTIAL-CANARY';
  const events: { stage: string; error: unknown }[] = [];
  const connection = new RivalHubConnection(path);
  connection.setDiagnosticHandler((stage, error) => events.push({ stage, error }));
  await connection.load();
  expect(events).toEqual([]);
  for (const [raw, stage] of [
    [secret, 'connection_parse'],
    ['{"credential":"' + secret + '",oops}', 'connection_parse'],
    ['null', 'connection_validate'],
    [
      JSON.stringify({
        credential: secret,
        installationId: 'i',
        competitionId: 'c',
        baseUrl: secret,
      }),
      'connection_validate',
    ],
  ]) {
    await writeFile(path, raw!);
    await connection.load();
    const last = events.at(-1)!;
    expect(last.stage).toBe(stage);
    expect(last.error).toBeInstanceOf(Error);
    expect(String(last.error) + (last.error as Error).stack).not.toContain(secret);
    expect(connection.view().paired).toBe(false);
  }
  const unreadable = new RivalHubConnection(directory);
  unreadable.setDiagnosticHandler((stage, error) => events.push({ stage, error }));
  await unreadable.load();
  expect(events.at(-1)?.stage).toBe('connection_read');
  expect(events.at(-1)?.error).toMatchObject({ code: 'EISDIR' });
});
