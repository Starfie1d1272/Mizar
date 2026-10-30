// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useStatsRotation } from '../src/program/useStatsRotation';
import fixture from '../../../tests/fixtures/mizar-broadcast-stats-presentation-v1.json';

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
  function Rotation({ enabled = true }: { enabled?: boolean }) {
    const card = useStatsRotation(enabled, fixture.matchId);
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
  await act(async () => root.render(<Rotation enabled={false} />));
  await act(async () => root.render(<Rotation />));
  expect(host.textContent).toBe('MAIN');
  await act(async () => vi.advanceTimersByTimeAsync(19_999));
  expect(host.textContent).toBe('MAIN');
  await act(async () => root.render(<div>MANUAL</div>));
  await act(async () => root.render(<Rotation />));
  expect(host.textContent).toBe('MAIN');
  await act(async () => root.unmount());
});

it('shows each map page before continuing the rotation', async () => {
  vi.useFakeTimers();
  const data = structuredClone(fixture);
  data.maps.pages.push({ page: 2, rows: data.maps.pages[0]!.rows });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(data)),
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  function Rotation() {
    const card = useStatsRotation(true, data.matchId);
    return <span>{card ? `${card.subtitle} ${card.scope}` : 'MAIN'}</span>;
  }
  await act(async () => root.render(<Rotation />));
  await act(async () => vi.advanceTimersByTimeAsync(32_000));
  expect(host.textContent).toContain('1 / 2 页');
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(host.textContent).toContain('2 / 2 页');
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(host.textContent).toContain('RECENT MAPS');
  await act(async () => root.unmount());
});

it('keeps the displayed card unchanged until its next boundary reads the newer revision', async () => {
  vi.useFakeTimers();
  const data = structuredClone(fixture);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(data)),
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  function Rotation() {
    const card = useStatsRotation(true, fixture.matchId);
    return <span>{card ? `${card.subtitle} ${card.teams[0]}` : 'MAIN'}</span>;
  }
  await act(async () => root.render(<Rotation />));
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(host.textContent).toContain(`LINEUPS ${fixture.teams[0]!.name}`);
  data.teams[0]!.name = 'Updated team';
  await act(async () => vi.advanceTimersByTimeAsync(11_999));
  expect(host.textContent).toContain(`LINEUPS ${fixture.teams[0]!.name}`);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(host.textContent).toContain('MAP PERFORMANCE Updated team');
  await act(async () => root.unmount());
});
