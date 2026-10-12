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
  expect(connection.view().activeDeviceName).toBe('另一台制播设备');
});
