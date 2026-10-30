import Fastify from 'fastify';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { registerRivalHubConnectionRoutes } from '../src/match-context/rivalhub-routes.js';
import { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
import fixture from '../../../tests/fixtures/rivalhub-provider-stats-v1.json' with { type: 'json' };

it('only schedules current online statistics during production and retains cached-online scope', async () => {
  vi.useFakeTimers();
  const app = Fastify();
  let production = false;
  let origin = 'online';
  let cachedFrom: string | undefined;
  const stats = vi.fn().mockResolvedValue(null);
  const clearStats = vi.fn();
  const binding = () => ({
    origin,
    cachedFrom,
    context: {
      matchId: 'match',
      competition: { competitionId: 'competition' },
      entrants: { a: { entryId: 'a' }, b: { entryId: 'b' } },
    },
    manifest: { match: { competition: { competitionId: 'competition' } } },
  });
  const connection = {
    setDiagnosticHandler: vi.fn(),
    view: () => ({ paired: true, competitionId: 'competition' }),
    stats,
    clearStats,
    library: vi.fn().mockResolvedValue(null),
  };
  const controller = { getActiveBinding: binding, isOnlineCandidateLoading: () => true };
  registerRivalHubConnectionRoutes(app, {
    connection,
    controller,
    canFetchStats: () => production,
    currentSnapshot: () => null,
    originPolicy: { mode: 'loopback' },
  } as unknown as Parameters<typeof registerRivalHubConnectionRoutes>[1]);
  try {
    await app.ready();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stats).not.toHaveBeenCalled();
    production = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stats).toHaveBeenCalledTimes(1);
    origin = 'cache';
    cachedFrom = 'online';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stats).toHaveBeenCalledTimes(2);
    cachedFrom = 'local';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stats).toHaveBeenCalledTimes(2);
    production = false;
    origin = 'online';
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stats).toHaveBeenCalledTimes(2);
  } finally {
    await app.close();
    expect(clearStats).toHaveBeenCalledOnce();
    vi.useRealTimers();
  }
});

it('retries incorrect entrants on production maintenance ticks until the bound teams arrive', async () => {
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
    .mockResolvedValueOnce(Response.json(wrong))
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
    for (let i = 0; i < 10; i++) {
      now += 10_000;
      await vi.advanceTimersByTimeAsync(10_000);
      if (i < 9) expect(connection.getStatsSnapshot(target)).toBeNull();
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(connection.getStatsSnapshot(target)?.revision).toBe(fixture.revision);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetcher).toHaveBeenCalledTimes(4);
  } finally {
    await app.close();
    vi.useRealTimers();
    await rm(directory, { recursive: true, force: true });
  }
});
