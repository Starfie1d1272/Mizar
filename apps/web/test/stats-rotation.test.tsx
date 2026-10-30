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

it('uses Companion page order, freezes each card, and stops on manual takeover', async () => {
  vi.useFakeTimers();
  const data = structuredClone(fixture);
  const fetcher = vi.fn(async () => Response.json(data));
  vi.stubGlobal('fetch', fetcher);
  const host = document.createElement('div');
  const root = createRoot(host);
  function Rotation({ enabled = true }: { enabled?: boolean }) {
    const card = useStatsRotation(enabled, fixture.matchId);
    return <span>{card ? `${card.id} ${card.teams[0]}` : 'MAIN'}</span>;
  }
  await act(async () => root.render(<Rotation />));
  expect(host.textContent).toBe('MAIN');
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(host.textContent).toBe(`match ${fixture.teams[0]!.name}`);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/local/v1/broadcast-stats-program');
  data.teams[0]!.name = 'Updated team';
  await act(async () => vi.advanceTimersByTimeAsync(14_999));
  expect(host.textContent).toBe(`match ${fixture.teams[0]!.name}`);
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(host.textContent).toBe('lineup Updated team');
  await act(async () => root.render(<Rotation enabled={false} />));
  expect(host.textContent).toBe('MAIN');
  await act(async () => root.render(<Rotation />));
  await act(async () => vi.advanceTimersByTimeAsync(19_999));
  expect(host.textContent).toBe('MAIN');
  await act(async () => root.unmount());
});

it('visits every qualified page in order, including multiple map pages, before returning to the scene', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json(fixture)),
  );
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
    const duration = ['lineup', 'players', 'economy', 'utility'].includes(page.kind)
      ? 12_000
      : 15_000;
    await act(async () => vi.advanceTimersByTimeAsync(duration));
  }
  expect(host.textContent).toBe('MAIN');
  await act(async () => root.unmount());
});

it('ignores a late response after a match change', async () => {
  vi.useFakeTimers();
  let resolveOld!: (value: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveOld = resolve;
        }),
    ),
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  function Rotation({ matchId }: { matchId: string }) {
    const card = useStatsRotation(true, matchId);
    return <span>{card?.id ?? 'MAIN'}</span>;
  }
  await act(async () => root.render(<Rotation matchId={fixture.matchId} />));
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  await act(async () => root.render(<Rotation matchId="another-match" />));
  await act(async () => resolveOld(Response.json(fixture)));
  expect(host.textContent).toBe('MAIN');
  await act(async () => root.unmount());
});
