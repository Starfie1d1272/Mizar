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
      pause: { enabled: true, visual: 'default' },
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
    });
  vi.stubGlobal('fetch', fetch);
  let state: BroadcastDisplayClientState | undefined;
  function Probe() {
    state = useBroadcastDisplayConfig();
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
  act(() => root.unmount());
});
