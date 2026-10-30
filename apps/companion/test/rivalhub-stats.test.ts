import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
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
    expect(await connection.stats(fixture.matchId, true)).toBeNull();
    expect(await connection.getStats(fixture.matchId)).toBeNull();
    connection.clearStats();
    expect(await connection.stats(fixture.matchId)).toMatchObject({ revision: 'example' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('discards an older in-flight response after a manual refresh or match switch', async () => {
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
    const fetcher = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json({ ...fixture, revision: 'new' }))
      .mockResolvedValueOnce(Response.json({ ...fixture, matchId: 'other', revision: 'other' }));
    const connection = new RivalHubConnection(path, fetcher as typeof fetch);
    await connection.load();
    const old = connection.stats(fixture.matchId);
    expect(await connection.stats(fixture.matchId, true)).toMatchObject({ revision: 'new' });
    resolveOld(Response.json({ ...fixture, revision: 'old' }));
    expect(await old).toBeNull();
    expect(await connection.getStats(fixture.matchId)).toMatchObject({ revision: 'new' });
    expect(await connection.stats('other')).toMatchObject({ revision: 'other' });
    expect(await connection.getStats(fixture.matchId)).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
