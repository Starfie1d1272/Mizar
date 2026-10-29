// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_PLACEMENTS, getBuiltinResolvedPreset, getBuiltinTheme } from '@mizar/hud-config';
import {
  useBroadcastDisplayConfig,
  type BroadcastDisplayClientState,
} from '../src/realtime/broadcast-display-client';

const visual = { kind: 'builtin', id: 'pulse', apiVersion: 1 };
const projection = {
  activeRevision: 'active-1',
  hud: {
    renderer: 'native',
    config: getBuiltinResolvedPreset(),
    overlays: {
      pause: { enabled: true, visual: 'legacy' },
      chat: { enabled: true, placement: DEFAULT_PLACEMENTS['team-t-rail'] },
    },
    accent: { source: 'fixed', value: getBuiltinTheme().brandColor },
  },
  program: {
    scenes: {
      waiting: visual,
      matchup: visual,
      bp: visual,
      halftime: visual,
      map_result: visual,
      intermap: visual,
      match_result: visual,
    },
    tokens: {},
    assets: {},
  },
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('accepts a complete display projection and retains it across an unavailable or invalid response', async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(projection) })
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ...projection, program: {} }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          ...projection,
          program: { ...projection.program, tokens: { unknown: 1 } },
        }),
    });
  vi.stubGlobal('fetch', fetch);
  let state: BroadcastDisplayClientState | undefined;
  function Probe() {
    state = useBroadcastDisplayConfig(true, 'waiting');
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  expect(state?.status).toBe('ready');
  expect(state?.current?.activeRevision).toBe('active-1');
  const accepted = state?.current;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(state).toEqual({ status: 'unavailable', current: accepted });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(state).toEqual({ status: 'unavailable', current: accepted });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(state).toEqual({ status: 'unsupported', current: accepted });
  act(() => root.unmount());
});

it('does not substitute legacy visuals after the active configuration is known to be unsupported', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            ...projection,
            program: { ...projection.program, tokens: { unknown: 1 } },
          }),
      })
      .mockResolvedValueOnce({ ok: false }),
  );
  let state: BroadcastDisplayClientState | undefined;
  function Probe() {
    state = useBroadcastDisplayConfig(true, 'waiting');
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => {
    root.render(<Probe />);
    await Promise.resolve();
  });
  expect(state).toEqual({ status: 'unsupported', current: null });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(state).toEqual({ status: 'unsupported', current: null });
  act(() => root.unmount());
});

it('accepts a HUD or a selected scene independently of unsupported unrelated visuals', async () => {
  const { supportsBroadcastDisplay } = await import('../src/program/broadcast-display');
  const config = {
    ...projection,
    program: {
      ...projection.program,
      scenes: { ...projection.program.scenes, matchup: { ...visual, id: 'other' } },
    },
  } as Parameters<typeof supportsBroadcastDisplay>[0];
  expect(supportsBroadcastDisplay(config, 'gameplay')).toBe(true);
  expect(supportsBroadcastDisplay(config, 'waiting')).toBe(true);
  expect(supportsBroadcastDisplay(config, 'bp')).toBe(true);
  expect(supportsBroadcastDisplay(config, 'matchup')).toBe(false);
});
