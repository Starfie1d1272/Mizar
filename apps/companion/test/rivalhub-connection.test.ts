import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  const fetchBadPath = vi.fn(() =>
    Promise.resolve(
      Response.json({
        pairingId: validPairingId,
        pollToken: validPollToken,
        authorizeUrl: validAuthorizeUrl.replace('/connect?', '/connect-extra?'),
        expiresAt: validExpiresAt,
      }),
    ),
  ) as typeof fetch;
  const connectionBadPath = new RivalHubConnection(join(directory, 'c3.json'), fetchBadPath);
  await expect(connectionBadPath.startPairing()).rejects.toThrow('授权页面地址无效。');
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
          credential: `rh_mizar_${validPairingId}_${'a'.repeat(64)}`,
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

  await expect(connection.sendLive(snapshot)).rejects.toThrow('rivalhub_live_unavailable');
  expect(connection.view().activeSourceMatchId).toBeNull();
  expect(connection.view().activeDeviceName).toBe('另一台制播设备');
});

it('handles authentic PR-766 pairing response and falls back to default operator display name when absent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-rivalhub-766-'));
  temporary.push(directory);
  const scopedCredential = `rh_mizar_${validPairingId}_${'f'.repeat(64)}`;
  const fetch766 = vi.fn((url: string | URL | Request) => {
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
          expiresAt: validExpiresAt,
          installationId: '40000000-0000-4000-8000-000000000001',
          competitionId: '30000000-0000-4000-8000-000000000001',
          credential: scopedCredential,
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  const path = join(directory, 'connection.json');
  const connection = new RivalHubConnection(path, fetch766);
  await connection.startPairing();
  const status = await connection.pollPairing();
  expect(status).toBe('authorized');

  const fileContent = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  expect(fileContent.credential).toBe(scopedCredential);
  expect(fileContent.displayName).toBe('赛事管理员');
  expect(connection.view().displayName).toBe('赛事管理员');
});

it('persists new installation when re-pairing even if old source release fails (re-pair cleanup failure)', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-rivalhub-repair-'));
  temporary.push(directory);
  let releaseCalls = 0;
  const initialCredential = `rh_mizar_${validPairingId}_${'1'.repeat(64)}`;
  const newPairingId = '20000000-0000-4000-8000-000000000002';
  const newCredential = `rh_mizar_${newPairingId}_${'2'.repeat(64)}`;

  const fetchImpl = vi.fn((url: string | URL | Request) => {
    const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    if (requestUrl.endsWith('/pairing/start')) {
      return Promise.resolve(
        Response.json({
          pairingId: newPairingId,
          pollToken: validPollToken,
          authorizeUrl: `${OFFICIAL_RIVALHUB_URL}/integrations/mizar/connect?pairingId=${newPairingId}`,
          expiresAt: validExpiresAt,
        }),
      );
    }
    if (requestUrl.endsWith('/pairing/poll')) {
      return Promise.resolve(
        Response.json({
          status: 'authorized',
          expiresAt: validExpiresAt,
          installationId: 'inst-new',
          competitionId: 'comp-new',
          credential: newCredential,
          displayName: '新操作员',
        }),
      );
    }
    if (requestUrl.endsWith('/release')) {
      releaseCalls++;
      // Simulate remote failure when releasing prior source
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'internal_error' }), { status: 500 }),
      );
    }
    return Promise.resolve(new Response(null, { status: 204 }));
  }) as typeof fetch;

  const path = join(directory, 'connection.json');
  // Pre-seed an existing connection with an active source
  const connection = new RivalHubConnection(path, fetchImpl);
  // @ts-expect-error test setup
  connection.installation = {
    baseUrl: OFFICIAL_RIVALHUB_URL,
    credential: initialCredential,
    installationId: 'inst-old',
    competitionId: 'comp-old',
    displayName: '旧操作员',
  };
  // @ts-expect-error test setup
  connection.source = {
    matchId: 'match-old',
    authorityRevision: 1,
    producerInstanceId: 'prod',
    liveSessionId: 'sess',
  };

  await connection.startPairing();
  const pollResult = await connection.pollPairing();

  expect(releaseCalls).toBe(1);
  expect(pollResult).toBe('authorized');
  // New installation was safely persisted despite release failure
  const saved = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  expect(saved.credential).toBe(newCredential);
  expect(saved.installationId).toBe('inst-new');
  expect(saved.displayName).toBe('新操作员');
  expect(connection.view().activeSourceMatchId).toBeNull();
});

describe('RivalHubConnection.disconnect lifecycle', () => {
  it('releases active source, calls POST /api/mizar/disconnect with Bearer credential, removes file, and clears state', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-rivalhub-disc-'));
    temporary.push(directory);
    const path = join(directory, 'connection.json');
    const credential = `rh_mizar_${validPairingId}_${'d'.repeat(64)}`;
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: OFFICIAL_RIVALHUB_URL,
        credential,
        installationId: 'inst-1',
        competitionId: 'comp-1',
        displayName: '操作员',
      }),
      'utf8',
    );

    const recorded: {
      url: string;
      method: string;
      headers: Headers;
      body: RequestInit['body'];
    }[] = [];
    const fetchImpl = vi.fn((url: string | URL | Request, init: RequestInit = {}) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      recorded.push({
        url: requestUrl,
        method: (init.method ?? 'GET').toUpperCase(),
        headers: new Headers(init.headers),
        body: init.body,
      });
      if (requestUrl.endsWith('/release')) {
        return Promise.resolve(Response.json({ released: true }));
      }
      if (requestUrl.endsWith('/disconnect')) {
        return Promise.resolve(Response.json({ revoked: true }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;

    const connection = new RivalHubConnection(path, fetchImpl);
    await connection.load();
    // @ts-expect-error test setup active source
    connection.source = {
      matchId: 'match-1',
      authorityRevision: 2,
      producerInstanceId: 'prod',
      liveSessionId: 'sess',
    };

    expect(connection.view().paired).toBe(true);
    expect(connection.view().activeSourceMatchId).toBe('match-1');

    await connection.disconnect();

    const releaseReq = recorded.find((r) => r.url.endsWith('/release'));
    expect(releaseReq).toBeDefined();
    expect(releaseReq!.method).toBe('POST');
    expect(releaseReq!.headers.get('authorization')).toBe(`Bearer ${credential}`);
    expect(releaseReq!.headers.get('x-rivalhub-authority')).toBe('2');
    expect(JSON.parse(releaseReq!.body as string)).toEqual({
      matchId: 'match-1',
      producerInstanceId: 'prod',
      liveSessionId: 'sess',
    });

    const discReq = recorded.find((r) => r.url.endsWith('/disconnect'));
    expect(discReq).toBeDefined();
    expect(discReq!.method).toBe('POST');
    expect(discReq!.headers.get('authorization')).toBe(`Bearer ${credential}`);

    expect(existsSync(path)).toBe(false);
    expect(connection.view()).toEqual({
      paired: false,
      competitionId: null,
      displayName: null,
      activeSourceMatchId: null,
      activeDeviceName: null,
      pairing: 'idle',
    });
  });

  it('proceeds with disconnect best-effort even if active source release fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-rivalhub-disc-best-'));
    temporary.push(directory);
    const path = join(directory, 'connection.json');
    const credential = `rh_mizar_${validPairingId}_${'e'.repeat(64)}`;
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: OFFICIAL_RIVALHUB_URL,
        credential,
        installationId: 'inst-1',
        competitionId: 'comp-1',
        displayName: '操作员',
      }),
      'utf8',
    );

    let releaseAttempts = 0;
    const recorded: { url: string; method: string }[] = [];
    const fetchImpl = vi.fn((url: string | URL | Request, init: RequestInit = {}) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      recorded.push({
        url: requestUrl,
        method: (init.method ?? 'GET').toUpperCase(),
      });
      if (requestUrl.endsWith('/release')) {
        releaseAttempts++;
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'server_down' }), { status: 500 }),
        );
      }
      if (requestUrl.endsWith('/disconnect')) {
        return Promise.resolve(Response.json({ revoked: true }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;

    const connection = new RivalHubConnection(path, fetchImpl);
    await connection.load();
    // @ts-expect-error test setup active source
    connection.source = {
      matchId: 'match-1',
      authorityRevision: 1,
      producerInstanceId: 'prod',
      liveSessionId: 'sess',
    };

    await connection.disconnect();

    expect(releaseAttempts).toBe(1);
    const discReq = recorded.find((r) => r.url.endsWith('/disconnect'));
    expect(discReq).toBeDefined();
    expect(discReq!.method).toBe('POST');
    expect(existsSync(path)).toBe(false);
    expect(connection.view().paired).toBe(false);
  });

  it('retains local credential and connection state when remote disconnect fails, allowing retry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-rivalhub-disc-retry-'));
    temporary.push(directory);
    const path = join(directory, 'connection.json');
    const credential = `rh_mizar_${validPairingId}_${'f'.repeat(64)}`;
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: OFFICIAL_RIVALHUB_URL,
        credential,
        installationId: 'inst-1',
        competitionId: 'comp-1',
        displayName: '操作员',
      }),
      'utf8',
    );

    let shouldFail = true;
    const fetchImpl = vi.fn((url: string | URL | Request) => {
      const requestUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
      if (requestUrl.endsWith('/disconnect')) {
        if (shouldFail) {
          return Promise.resolve(
            new Response(JSON.stringify({ error: 'gateway_timeout' }), { status: 504 }),
          );
        }
        return Promise.resolve(Response.json({ revoked: true }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as typeof fetch;

    const connection = new RivalHubConnection(path, fetchImpl);
    await connection.load();

    // First attempt fails: server returns 504
    await expect(connection.disconnect()).rejects.toThrow('断开连接失败，请稍后重试。');

    // Local file and state MUST be retained
    expect(existsSync(path)).toBe(true);
    expect(connection.view().paired).toBe(true);
    expect(connection.view().displayName).toBe('操作员');

    // Retry succeeds
    shouldFail = false;
    await connection.disconnect();

    expect(existsSync(path)).toBe(false);
    expect(connection.view().paired).toBe(false);
  });

  it('is a safe no-op when disconnecting an already unpaired connection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-rivalhub-disc-noop-'));
    temporary.push(directory);
    const path = join(directory, 'connection.json');
    const fetchImpl = vi.fn() as typeof fetch;

    const connection = new RivalHubConnection(path, fetchImpl);
    await connection.load();
    expect(connection.view().paired).toBe(false);

    await expect(connection.disconnect()).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(connection.view().paired).toBe(false);
  });
});
