import Fastify from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { registerRivalHubConnectionRoutes } from '../src/match-context/rivalhub-routes.js';
import { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
import fixture from '../../../tests/fixtures/rivalhub-provider-stats-v1.json' with { type: 'json' };

it('recovers cached statistics on maintenance ticks while an online candidate is loading', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-stats-team-retry-'));
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
  const wrong = structuredClone(fixture);
  wrong.entrants[0]!.entryId = 'other-team';
  let now = 0;
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json(wrong))
    .mockResolvedValueOnce(Response.json(fixture));
  const connection = new RivalHubConnection(path, fetcher as typeof fetch, undefined, () => now);
  await connection.load();
  vi.spyOn(connection, 'library').mockResolvedValue(
    {} as Awaited<ReturnType<typeof connection.library>>,
  );
  vi.useFakeTimers();
  const app = Fastify();
  const binding = {
    origin: 'online',
    context: {
      matchId: fixture.matchId,
      competition: { competitionId: fixture.competitionId },
      entrants: {
        a: { entryId: fixture.entrants[0]!.entryId },
        b: { entryId: fixture.entrants[1]!.entryId },
      },
    },
    manifest: { match: { competition: { competitionId: fixture.competitionId } } },
  };
  const controller = { getActiveBinding: () => binding, isOnlineCandidateLoading: () => true };
  registerRivalHubConnectionRoutes(app, {
    connection,
    controller,
    canFetchStats: () => true,
    currentSnapshot: () => null,
    originPolicy: { mode: 'loopback' },
  } as unknown as Parameters<typeof registerRivalHubConnectionRoutes>[1]);
  const target = {
    matchId: fixture.matchId,
    competitionId: fixture.competitionId,
    entrantIds: [fixture.entrants[0]!.entryId, fixture.entrants[1]!.entryId] as const,
  };
  try {
    await app.ready();
    now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connection.getStatsSnapshot(target)).toBeNull();
    for (let tick = 0; tick < 3; tick++) {
      now += 10_000;
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(connection.getStatsSnapshot(target)).toEqual(fixture);
  } finally {
    await app.close();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
});

it('claims from background maintenance only after current production and lineup are ready', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-auto-source-'));
  const path = join(directory, 'connection.json');
  await writeFile(
    path,
    JSON.stringify({
      baseUrl: 'https://example.com',
      credential: 'fixture',
      installationId: 'install',
      competitionId: 'competition',
      displayName: 'test',
    }),
  );
  const claims: Record<string, unknown>[] = [];
  const connection = new RivalHubConnection(path, async (_input, init) => {
    claims.push(JSON.parse(String(init?.body)));
    return Response.json({ claimed: true, authorityRevision: 1 });
  });
  await connection.load();
  const automaticClaim = vi.spyOn(connection, 'claimAutomatically');
  const snapshot = {
    matchId: 'match',
    competitionId: 'competition',
    cursor: {
      producerInstanceId: 'producer',
      liveSessionId: 'session',
      programSourceGeneration: 1,
      mapEpoch: 1,
    },
    capability: { telemetryFresh: true, contextFresh: true, identity: 'matched' },
    players: Array.from({ length: 10 }, (_, i) => ({
      sourcePlayerId: `7656119800000000${i}`,
      lineupEvidence: 'current',
    })),
  };
  const binding = {
    origin: 'online',
    context: { matchId: 'match', competition: { competitionId: 'competition' } },
    manifest: { revision: 'revision', match: { competition: { competitionId: 'competition' } } },
  };
  let production = false;
  vi.useFakeTimers();
  const app = Fastify();
  registerRivalHubConnectionRoutes(app, {
    connection,
    controller: { getActiveBinding: () => binding, isOnlineCandidateLoading: () => true },
    canClaim: () => production,
    currentSnapshot: () => snapshot,
    originPolicy: { mode: 'loopback' },
  } as unknown as Parameters<typeof registerRivalHubConnectionRoutes>[1]);
  try {
    await app.ready();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claims).toHaveLength(0);
    production = true;
    snapshot.capability.telemetryFresh = false;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claims).toHaveLength(0);
    snapshot.capability.telemetryFresh = true;
    const player = snapshot.players.pop()!;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claims).toHaveLength(0);
    snapshot.players.push(player);
    await vi.advanceTimersByTimeAsync(10_000);
    // The tick starts durable work; wait for the source queue without advancing another tick.
    await Promise.all(automaticClaim.mock.results.map((result) => result.value));
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({
      matchId: 'match',
      contextRevision: 'revision',
      takeover: false,
    });
    expect(connection.view().activeSourceMatchId).toBe('match');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(claims).toHaveLength(1);
  } finally {
    await app.close();
    vi.useRealTimers();
    await connection.abortSourceCaptureStartup();
    await rm(directory, { recursive: true, force: true });
  }
});
