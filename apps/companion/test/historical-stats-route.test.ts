import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { broadcastStatsPresentationSchema } from '@mizar/protocol/broadcast-stats-presentation';
import { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
import { registerHistoricalStatsPresentationRoute } from '../src/match-context/rivalhub-routes.js';
import type { MatchContextBinding } from '../src/match-context/lkg-store.js';
import fixture from '../../../tests/fixtures/rivalhub-provider-stats-v1.json' with { type: 'json' };

it('serves bound projections over local HTTP without new upstream requests', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-presentation-http-'));
  let upstreamRequests = 0;
  const upstream = createServer((_request, response) => {
    upstreamRequests++;
    response.end(JSON.stringify(fixture));
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const app = Fastify();
  try {
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string')
      throw new Error('missing HTTP address');
    const path = join(directory, 'connection.json');
    await writeFile(
      path,
      JSON.stringify({
        baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
        credential: 'secret',
        installationId: 'install',
        competitionId: fixture.competitionId,
        displayName: 'test',
      }),
    );
    const connection = new RivalHubConnection(path);
    await connection.load();
    await connection.stats({
      matchId: fixture.matchId,
      competitionId: fixture.competitionId,
      entrantIds: [fixture.entrants[0]!.entryId, fixture.entrants[1]!.entryId],
    });
    const canonical = (entry: (typeof fixture.entrants)[number]) => ({
      entryId: entry.entryId,
      roster: {
        players: entry.starters.map((player) => ({ playerId: player.userId, isStarter: true })),
      },
    });
    let binding = {
      origin: 'online',
      context: {
        matchId: fixture.matchId,
        competition: { competitionId: fixture.competitionId },
        entrants: {
          a: { entryId: fixture.entrants[0]!.entryId },
          b: { entryId: fixture.entrants[1]!.entryId },
        },
      },
      manifest: {
        match: { matchId: fixture.matchId },
        entrants: { a: canonical(fixture.entrants[0]!), b: canonical(fixture.entrants[1]!) },
      },
    } as unknown as MatchContextBinding;
    registerHistoricalStatsPresentationRoute(app, { connection, getBinding: () => binding });
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => fetch(`${address}/local/v1/broadcast-stats-presentation`)),
    );
    for (const response of responses) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      const data = broadcastStatsPresentationSchema.parse(await response.json());
      expect(data.matchId).toBe(fixture.matchId);
      expect(data.playerComparison.eligible).toBe(true);
    }
    expect(upstreamRequests).toBe(1);
    binding = {
      ...binding,
      context: {
        ...binding.context,
        competition: { ...binding.context.competition!, competitionId: 'other-competition' },
      },
    };
    expect(
      await (await fetch(`${address}/local/v1/broadcast-stats-presentation`)).json(),
    ).toBeNull();
    binding = { ...binding, origin: 'local' };
    expect(
      await (await fetch(`${address}/local/v1/broadcast-stats-presentation`)).json(),
    ).toBeNull();
    expect(upstreamRequests).toBe(1);
  } finally {
    await app.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});
