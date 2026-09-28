import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';
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
          credential: 'a'.repeat(43),
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

  await restored.claim(snapshot, 'revision', false);
  const claim = requests.find((request) => request.url.endsWith('/claim'))!;
  expect(JSON.parse(claim.init.body as string)).toMatchObject({
    matchId: 'match',
    lineupSteam64: players.map((player) => player.sourcePlayerId),
  });

  await restored.sendLive(snapshot);
  const live = requests.find((request) => request.url.endsWith('/live'))!;
  expect(new Headers(live.init.headers).get('x-rivalhub-authority')).toBe('4');

  await restored.release();
  expect(restored.view().activeSourceMatchId).toBeNull();
});

it('does not discard reliable events while an online match is waiting for a source claim', async () => {
  const connection = new RivalHubConnection(join(tmpdir(), 'unused-rivalhub-connection.json'));
  const result = await connection.sendReliable({ matchId: 'match' } as ReliableEventV1, null);
  expect(result).toBe('retry');
});

it('rejects invalid pairing parameters fail-closed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-rivalhub-err-'));
  temporary.push(directory);
  const fetchBadStart = vi.fn(() =>
    Promise.resolve(Response.json({ pairingId: 'invalid-id' })),
  ) as typeof fetch;
  const connection = new RivalHubConnection(join(directory, 'c.json'), fetchBadStart);
  await expect(connection.startPairing()).rejects.toThrow('授权请求格式无效。');

  const fetchBadUrl = vi.fn(() =>
    Promise.resolve(
      Response.json({
        pairingId: validPairingId,
        pollToken: validPollToken,
        authorizeUrl:
          'https://evil.example.com/integrations/mizar/connect?pairingId=' + validPairingId,
        expiresAt: validExpiresAt,
      }),
    ),
  ) as typeof fetch;
  const connectionBadUrl = new RivalHubConnection(join(directory, 'c2.json'), fetchBadUrl);
  await expect(connectionBadUrl.startPairing()).rejects.toThrow('授权页面地址无效。');
});

it('handles discovery of existing active device and explicit takeover', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-rivalhub-takeover-'));
  temporary.push(directory);
  const requests: { url: string; init: RequestInit }[] = [];
  let claimCall = 0;
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
          credential: 'a'.repeat(43),
          installationId: 'inst-1',
          competitionId: 'comp-1',
          displayName: '操作者 A',
        }),
      );
    }
    if (requestUrl.endsWith('/claim')) {
      claimCall++;
      if (claimCall === 1) {
        return Promise.resolve(
          Response.json({ claimed: false, authorityRevision: 1, activeDeviceName: '备用设备 B' }),
        );
      }
      return Promise.resolve(Response.json({ claimed: true, authorityRevision: 2 }));
    }
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
      producerInstanceId: 'prod-1',
      liveSessionId: 'sess-1',
      programSourceGeneration: 1,
      mapEpoch: 1,
    },
    players: [],
  } as unknown as LiveSnapshotV1;

  const view1 = await connection.claim(snapshot, 'rev-1', false);
  expect(view1.activeSourceMatchId).toBeNull();
  expect(view1.activeDeviceName).toBe('备用设备 B');

  const view2 = await connection.claim(snapshot, 'rev-1', true);
  expect(view2.activeSourceMatchId).toBe('match-1');
  expect(view2.activeDeviceName).toBeNull();
  const claims = requests.filter((r) => r.url.endsWith('/claim'));
  expect(claims.length).toBe(2);
  const takeoverClaim = claims[1]!;
  expect(JSON.parse(takeoverClaim.init.body as string)).toMatchObject({
    takeover: true,
  });
});

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
          credential: 'a'.repeat(43),
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

  await expect(connection.sendLive(snapshot)).rejects.toThrow('rivalhub_live_unavailable');
  expect(connection.view().activeSourceMatchId).toBeNull();
  expect(connection.view().activeDeviceName).toBe('另一台制播设备');
});
