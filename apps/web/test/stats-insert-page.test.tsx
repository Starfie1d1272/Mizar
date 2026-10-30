// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/mizar-broadcast-stats-presentation-v1.json';

vi.mock('../src/workspace/client', () => ({ useProgramScenes: () => ({ active: 'waiting' }) }));
vi.mock('../src/realtime/broadcast-display-client', () => ({
  useBroadcastDisplayConfig: () => ({ current: { program: { tokens: {}, assets: {} } } }),
}));
vi.mock('../src/realtime', () => {
  const snapshot = { current: null };
  return {
    useLocalChannelClient: () => ({ subscribe: () => () => {}, getSnapshot: () => snapshot }),
  };
});
vi.mock('../src/program/ProgramScenePage', () => ({ ProgramScenePage: () => null }));
vi.mock('@mizar/protocol/program-scenes', () => ({
  programPresentationSchema: { parse: (value: unknown) => value },
}));
vi.mock('@mizar/hud-view', () => ({
  StatsInsertView: ({ insert }: { insert: { teams: string[] } }) => (
    <div>{insert.teams.join(' / ')}</div>
  ),
}));
import { StatsInsertPage } from '../src/program/StatsInsertPage';

it('recovers and updates a same-match local snapshot while retaining it on read failure', async () => {
  vi.useFakeTimers();
  let data: unknown = null;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('program-presentation'))
        return Response.json({ match: { matchId: fixture.matchId } });
      if (data === 'error') throw new Error('offline');
      return Response.json(data);
    }),
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<StatsInsertPage />));
  expect(host.textContent).toContain('统计暂不可用');
  data = fixture;
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.textContent).toContain(fixture.teams[0]!.name);
  const refreshed = structuredClone(fixture);
  refreshed.teams[0]!.name = 'Updated team';
  data = refreshed;
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.textContent).toContain('Updated team');
  data = 'error';
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.textContent).toContain('Updated team');
  data = null;
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.textContent).toContain('统计暂不可用');
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('discards a late prior-match snapshot while the next presentation is already loaded', async () => {
  vi.useFakeTimers();
  let matchId = fixture.matchId;
  let resolveOld!: (response: Response) => void;
  const next = structuredClone(fixture);
  next.matchId = 'other';
  next.teams[0]!.name = 'New match team';
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      if (url.includes('program-presentation'))
        return Promise.resolve(Response.json({ match: { matchId } }));
      if (matchId === fixture.matchId)
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      return Promise.resolve(Response.json(next));
    }),
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<StatsInsertPage />));
  matchId = 'other';
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(host.textContent).toContain('New match team');
  await act(async () => {
    resolveOld(Response.json(fixture));
  });
  expect(host.textContent).toContain('New match team');
  expect(host.textContent).not.toContain(fixture.teams[0]!.name);
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
