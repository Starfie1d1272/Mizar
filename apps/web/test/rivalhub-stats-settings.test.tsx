// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { broadcastStatsPresentationSchema } from '@mizar/protocol/broadcast-stats-presentation';
import { statsInserts } from '../src/program/stats-inserts';
import fixture from '../../../tests/fixtures/mizar-broadcast-stats-presentation-v1.json';

vi.mock('../src/bp/client', () => ({
  useBpWorkspace: () => ({ workspace: null }),
  switchToRivalhubBp: vi.fn(),
}));
vi.mock('../src/operator/RivalHubSyncControls', () => ({ RivalHubSyncControls: () => null }));
vi.mock('../src/operator/RivalHubMatchLibrary', () => ({ RivalHubMatchLibrary: () => null }));
import { RivalHubPreparationPanel } from '../src/operator/RivalHubPreparationPanel';

it('counts presentation cards and refreshes through the existing operator action', async () => {
  vi.useFakeTimers();
  const calls: Array<{ path: string; method: string }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ path: url, method: init?.method ?? 'GET' });
      if (url === '/local/v1/rivalhub-connection')
        return Response.json({ paired: true, activeMatchId: fixture.matchId, displayName: 'test' });
      if (url === '/local/v1/rivalhub-schedule')
        return Response.json({ competition: { name: '赛事' }, matches: [] });
      if (url === '/local/v1/broadcast-stats-status')
        return Response.json({ fetchedAt: '2025-01-01T00:00:00.000Z' });
      if (url === '/local/v1/broadcast-stats-presentation') return Response.json(fixture);
      if (url === '/operator/rivalhub/stats/refresh') return Response.json({ ok: true });
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<RivalHubPreparationPanel mode="settings" />);
      await vi.advanceTimersByTimeAsync(0);
    });
    const count = statsInserts(broadcastStatsPresentationSchema.parse(fixture)).length;
    expect(host.textContent).toContain(`${count} 张可用`);
    const button = [...host.querySelectorAll('button')].find(
      (item) => item.textContent === '刷新统计',
    );
    expect(button?.disabled).toBe(false);
    await act(async () => {
      button!.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(calls.filter((call) => call.path === '/operator/rivalhub/stats/refresh')).toEqual([
      { path: '/operator/rivalhub/stats/refresh', method: 'POST' },
    ]);
    expect(
      calls.filter((call) => call.path === '/local/v1/broadcast-stats-presentation'),
    ).toHaveLength(2);
    expect(
      calls.every(
        (call) => call.path.startsWith('/local/v1/') || call.path.startsWith('/operator/'),
      ),
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
