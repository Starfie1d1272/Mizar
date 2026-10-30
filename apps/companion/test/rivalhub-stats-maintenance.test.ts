import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { registerRivalHubConnectionRoutes } from '../src/match-context/rivalhub-routes.js';

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
    context: { matchId: 'match' },
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
