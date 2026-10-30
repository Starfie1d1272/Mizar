import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
import { projectHistoricalStats } from '../src/projections/historical-stats.js';
import fixture from '../../../tests/fixtures/rivalhub-provider-stats-v1.json' with { type: 'json' };

it('keeps a match snapshot until an explicit refresh and revalidates with ETag', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-stats-'));
  try {
    const path = join(directory, 'connection.json');
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: 'https://match.starfie1d.top',
        credential: 'secret',
        installationId: 'install',
        competitionId: fixture.competitionId,
        displayName: 'test',
      }),
    );
    let now = 0;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(fixture, { headers: { etag: '"one"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json(fixture));
    const connection = new RivalHubConnection(path, fetcher as typeof fetch, undefined, () => now);
    await connection.load();
    expect(await connection.stats(fixture.matchId)).toMatchObject({ revision: 'example' });
    expect(await connection.stats(fixture.matchId)).toMatchObject({ revision: 'example' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 60_001;
    expect(await connection.stats(fixture.matchId)).toMatchObject({ revision: 'example' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await connection.stats(fixture.matchId, true)).toMatchObject({ revision: 'example' });
    expect(fetcher.mock.calls[1]![1].headers).toMatchObject({
      'if-none-match': '"one"',
      authorization: 'Bearer secret',
    });
    expect(await connection.stats(fixture.matchId, true)).toBeNull();
    expect(await connection.getStats(fixture.matchId)).toMatchObject({ revision: 'example' });
    now += 30_000;
    expect(await connection.stats(fixture.matchId, true)).toBeNull();
    expect(await connection.getStats(fixture.matchId)).toBeNull();
    connection.clearStats();
    expect(await connection.stats(fixture.matchId)).toBeNull();
    await connection.load();
    expect(await connection.stats(fixture.matchId)).toBeNull();
    expect(await connection.stats('another-match')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(4);
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: 'https://match.starfie1d.top',
        credential: 'new-secret',
        installationId: 'new-install',
        competitionId: fixture.competitionId,
        displayName: 'test',
      }),
    );
    await connection.load();
    expect(await connection.stats(fixture.matchId)).toMatchObject({ revision: 'example' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('joins an in-flight request for concurrent manual refresh', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-stats-race-'));
  try {
    const path = join(directory, 'connection.json');
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: 'https://match.starfie1d.top',
        credential: 'secret',
        installationId: 'install',
        competitionId: fixture.competitionId,
        displayName: 'test',
      }),
    );
    let resolveOld!: (response: Response) => void;
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveOld = resolve;
        }),
    );
    const connection = new RivalHubConnection(path, fetcher as typeof fetch);
    await connection.load();
    const first = connection.stats(fixture.matchId);
    const manual = connection.stats(fixture.matchId, true);
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveOld(Response.json(fixture));
    expect(await first).toMatchObject({ revision: 'example' });
    expect(await manual).toMatchObject({ revision: 'example' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('uses one real HTTP snapshot for repeated local readers and refreshes only on demand', async () => {
  const { createServer } = await import('node:http');
  const directory = await mkdtemp(join(tmpdir(), 'mizar-stats-http-'));
  let requests = 0;
  let status = 200;
  const headers: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    requests++;
    headers.push(request.headers['if-none-match']);
    response.writeHead(status, { 'content-type': 'application/json', etag: '"snapshot"' });
    response.end(status === 200 ? JSON.stringify(fixture) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing HTTP address');
    const path = join(directory, 'connection.json');
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        credential: 'secret',
        installationId: 'install',
        competitionId: fixture.competitionId,
        displayName: 'test',
      }),
    );
    let now = 0;
    const connection = new RivalHubConnection(path, fetch, undefined, () => now);
    await connection.load();
    await Promise.all(Array.from({ length: 4 }, () => connection.stats(fixture.matchId)));
    for (let i = 0; i < 20; i++)
      expect(await connection.getStats(fixture.matchId)).toMatchObject({
        revision: fixture.revision,
      });
    expect(requests).toBe(1);
    status = 503;
    expect(await connection.stats(fixture.matchId, true)).toBeNull();
    expect(await connection.getStats(fixture.matchId)).toMatchObject({
      revision: fixture.revision,
    });
    status = 304;
    now += 30_000;
    expect(await connection.stats(fixture.matchId, true)).toMatchObject({
      revision: fixture.revision,
    });
    expect(headers).toEqual([undefined, '"snapshot"', '"snapshot"']);
    status = 403;
    await connection.stats(fixture.matchId, true);
    expect(await connection.getStats(fixture.matchId)).toBeNull();
    expect(requests).toBe(4);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects a late real HTTP response after switching matches', async () => {
  const { createServer } = await import('node:http');
  const directory = await mkdtemp(join(tmpdir(), 'mizar-stats-switch-'));
  let releaseOld!: () => void;
  let receivedOld!: () => void;
  const received = new Promise<void>((resolve) => {
    receivedOld = resolve;
  });
  const server = createServer((request, response) => {
    const matchId = new URL(request.url!, 'http://127.0.0.1').searchParams.get('matchId');
    if (matchId === fixture.matchId) {
      releaseOld = () => response.end(JSON.stringify(fixture));
      receivedOld();
      return;
    }
    response.end(JSON.stringify({ ...fixture, matchId, revision: 'new-match' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing HTTP address');
    const path = join(directory, 'connection.json');
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${address.port}`,
        credential: 'secret',
        installationId: 'install',
        competitionId: fixture.competitionId,
        displayName: 'test',
      }),
    );
    const connection = new RivalHubConnection(path);
    await connection.load();
    const old = connection.stats(fixture.matchId);
    await received;
    expect(await connection.stats('other')).toMatchObject({
      matchId: 'other',
      revision: 'new-match',
    });
    releaseOld();
    expect(await old).toBeNull();
    expect(await connection.getStats(fixture.matchId)).toBeNull();
    expect(await connection.getStats('other')).toMatchObject({ revision: 'new-match' });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

it('retries indefinitely on transient failures with shared cooldown and stops on a valid empty snapshot', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-stats-retry-'));
  const wall = Date.parse('2026-10-30T06:00:00Z');
  const clock = vi.spyOn(Date, 'now').mockReturnValue(wall);
  try {
    const path = join(directory, 'connection.json');
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: 'https://match.starfie1d.top',
        credential: 'secret',
        installationId: 'install',
        competitionId: fixture.competitionId,
        displayName: 'test',
      }),
    );
    const empty = structuredClone(fixture);
    for (const team of empty.entrants) {
      team.starters = [];
      team.playerPerformance.players = [];
      team.mapPerformance.available = false;
      team.recentResults.available = false;
      team.pistol.available = false;
      team.economy.available = false;
      team.utility.available = false;
    }
    let now = 0;
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'retry-after': '120' } }))
      .mockResolvedValueOnce(
        new Response(null, {
          status: 504,
          headers: { 'retry-after': new Date(wall + 300_000).toUTCString() },
        }),
      )
      .mockResolvedValueOnce(Response.json(empty))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const connection = new RivalHubConnection(path, fetcher as typeof fetch, undefined, () => now);
    await connection.load();
    expect(await connection.stats(fixture.matchId)).toBeNull();
    now = 29_999;
    expect(await connection.stats(fixture.matchId, true)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 30_000;
    expect(await connection.stats(fixture.matchId)).toBeNull();
    now = 60_000;
    expect(await connection.stats(fixture.matchId)).toBeNull();
    now = 179_999;
    expect(await connection.stats(fixture.matchId)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
    now = 180_000;
    expect(await connection.stats(fixture.matchId)).toBeNull();
    now = 479_999;
    expect(await connection.stats(fixture.matchId)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(4);
    now = 480_000;
    expect(await connection.stats(fixture.matchId)).toMatchObject({
      entrants: [{ starters: [] }, { starters: [] }],
    });
    const emptyProjection = projectHistoricalStats((await connection.getStats(fixture.matchId))!)!;
    expect(
      [
        emptyProjection.maps,
        emptyProjection.recent,
        emptyProjection.lineups,
        emptyProjection.pistol,
        emptyProjection.economy,
        emptyProjection.utility,
        emptyProjection.playerComparison,
        emptyProjection.playerAttributes,
      ].every((topic) => !topic.eligible),
    ).toBe(true);
    now += 1_000_000;
    expect(await connection.stats(fixture.matchId)).toMatchObject({ revision: fixture.revision });
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(await connection.stats(fixture.matchId, true)).toBeNull();
    expect(await connection.getStats(fixture.matchId)).toMatchObject({
      revision: fixture.revision,
    });
    expect(await connection.stats(fixture.matchId, true)).toBeNull();
    now += 1_000_000;
    expect(await connection.stats(fixture.matchId)).toMatchObject({ revision: fixture.revision });
    expect(fetcher).toHaveBeenCalledTimes(6);
  } finally {
    clock.mockRestore();
    await rm(directory, { recursive: true, force: true });
  }
});

it('retries invalid identity and oversized data until a valid snapshot arrives', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-stats-invalid-'));
  try {
    const path = join(directory, 'connection.json');
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: 'https://match.starfie1d.top',
        credential: 'secret',
        installationId: 'install',
        competitionId: fixture.competitionId,
        displayName: 'test',
      }),
    );
    let now = 0;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ ...fixture, matchId: 'wrong' }))
      .mockResolvedValueOnce(new Response('{}', { headers: { 'content-length': '1000001' } }))
      .mockResolvedValueOnce(Response.json(fixture));
    const connection = new RivalHubConnection(path, fetcher as typeof fetch, undefined, () => now);
    await connection.load();
    expect(await connection.stats(fixture.matchId)).toBeNull();
    now = 1_000_000;
    expect(await connection.stats(fixture.matchId)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
    now += 30_000;
    expect(await connection.stats(fixture.matchId)).toMatchObject({
      revision: fixture.revision,
    });
    now += 1_000_000;
    expect(await connection.stats(fixture.matchId)).toMatchObject({ revision: fixture.revision });
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('retries interrupted response streams and aborts a replaced scope', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-stats-stream-'));
  try {
    const path = join(directory, 'connection.json');
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: 'https://match.starfie1d.top',
        credential: 'secret',
        installationId: 'install',
        competitionId: fixture.competitionId,
        displayName: 'test',
      }),
    );
    let now = 0;
    let firstSignal!: AbortSignal;
    let release!: (response: Response) => void;
    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('stream interrupted'));
      },
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(interrupted))
      .mockImplementationOnce((_url, init: RequestInit) => {
        firstSignal = init.signal!;
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      })
      .mockResolvedValueOnce(Response.json({ ...fixture, matchId: 'other' }));
    const connection = new RivalHubConnection(path, fetcher as typeof fetch, undefined, () => now);
    await connection.load();
    expect(await connection.stats(fixture.matchId)).toBeNull();
    now = 30_000;
    const pending = connection.stats(fixture.matchId);
    expect(firstSignal.aborted).toBe(false);
    expect(await connection.stats('other')).toMatchObject({ matchId: 'other' });
    expect(firstSignal.aborted).toBe(true);
    release(Response.json(fixture));
    expect(await pending).toBeNull();
    expect(await connection.getStats('other')).toMatchObject({ matchId: 'other' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
