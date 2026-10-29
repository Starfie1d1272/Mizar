// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useStatsRotation } from '../src/program/useStatsRotation';
import fixture from '../../../tests/fixtures/rivalhub-provider-stats-v1.json';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('starts on the main scene, freezes each card, and restarts after unmount', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json(fixture)));
  vi.stubGlobal('fetch', fetcher);
  const host = document.createElement('div');
  const root = createRoot(host);
  function Rotation() {
    const card = useStatsRotation(true, fixture.matchId);
    return <span>{card?.subtitle ?? 'MAIN'}</span>;
  }
  await act(async () => root.render(<Rotation />));
  expect(host.textContent).toBe('MAIN');
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000);
  });
  expect(host.textContent).toBe('LINEUPS');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(11_999);
  });
  expect(host.textContent).toBe('LINEUPS');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(host.textContent).toBe('MAP PERFORMANCE');
  await act(async () => root.render(<div>MANUAL</div>));
  await act(async () => root.render(<Rotation />));
  expect(host.textContent).toBe('MAIN');
  await act(async () => root.unmount());
});
