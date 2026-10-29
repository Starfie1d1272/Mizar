import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
import fixture from '../../../tests/fixtures/rivalhub-provider-stats-v1.json' with { type: 'json' };

it('caches a bounded stats response by installation and match and revalidates with ETag', async () => {
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
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const connection = new RivalHubConnection(path, fetcher as typeof fetch, undefined, () => now);
    await connection.load();
    expect(await connection.stats(fixture.matchId)).toMatchObject({ revision: 'example' });
    expect(await connection.stats(fixture.matchId)).toMatchObject({ revision: 'example' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    now = 60_001;
    expect(await connection.stats(fixture.matchId)).toMatchObject({ revision: 'example' });
    expect(fetcher.mock.calls[1]![1].headers).toMatchObject({
      'if-none-match': '"one"',
      authorization: 'Bearer secret',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
