// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { useStatsRotation } from '../src/program/useStatsRotation';
import fixture from './fixtures/stats-program.json';

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
  expect(host.textContent).toBe('MATCH');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(11_999);
  });
  expect(host.textContent).toBe('MATCH');
  expect(fetcher).toHaveBeenCalledTimes(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(host.textContent).toBe('LINEUPS');
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
  const lineup = data.pages.find((page) => page.kind === 'lineup')!;
  const maps = data.pages.find((page) => page.kind === 'maps')!;
  const recent = data.pages.find((page) => page.kind === 'recent')!;
  data.pages = [
    lineup,
    { ...maps, pageNumber: 1, pageCount: 2 },
    { ...structuredClone(maps), id: 'maps-2', pageNumber: 2, pageCount: 2 },
    recent,
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(data)),
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  function Rotation() {
    const card = useStatsRotation(true, data.matchId);
    return <span>{card ? `${card.subtitle} ${card.pageCount ?? ''}` : 'MAIN'}</span>;
  }
  await act(async () => root.render(<Rotation />));
  await act(async () => vi.advanceTimersByTimeAsync(32_000));
  expect(host.textContent).toContain('1 / 2');
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(host.textContent).toContain('2 / 2');
  await act(async () => vi.advanceTimersByTimeAsync(15_000));
  expect(host.textContent).toContain('RECENT RESULTS');
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
  expect(host.textContent).toContain(`MATCH ${fixture.teams[0]!.name}`);
  data.teams[0]!.name = 'Updated team';
  await act(async () => vi.advanceTimersByTimeAsync(11_999));
  expect(host.textContent).toContain(`MATCH ${fixture.teams[0]!.name}`);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(host.textContent).toContain('LINEUPS Updated team');
  await act(async () => root.unmount());
});

it('rotates every qualified program page in Companion order', async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn<(url: string) => Promise<Response>>(async () => Response.json(fixture));
  vi.stubGlobal('fetch', fetcher);
  const host = document.createElement('div');
  const root = createRoot(host);
  function Rotation() {
    const card = useStatsRotation(true, fixture.matchId);
    return <span>{card?.id ?? 'MAIN'}</span>;
  }
  await act(async () => root.render(<Rotation />));
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  for (const page of fixture.pages) {
    expect(host.textContent).toBe(page.id);
    const duration = ['maps', 'maps-info', 'recent', 'radar'].includes(page.kind) ? 15_000 : 12_000;
    await act(async () => vi.advanceTimersByTimeAsync(duration));
  }
  expect(host.textContent).toBe('MAIN');
  expect(fetcher.mock.calls.every(([url]) => url === '/local/v1/broadcast-stats-program')).toBe(
    true,
  );
  await act(async () => root.unmount());
});
