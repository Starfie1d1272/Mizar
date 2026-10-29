// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/rivalhub-provider-stats-v1.json';

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
  expect(host.textContent).toContain(fixture.entrants[0]!.name);
  const refreshed = structuredClone(fixture);
  refreshed.entrants[0]!.name = 'Updated team';
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
