// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import fixture from '../../../tests/fixtures/rivalhub-provider-stats-v1.json';

const controls = vi.hoisted(() => ({
  mode: 'auto',
  matchId: '00000000-0000-4000-8000-000000000001',
}));
vi.mock('@mizar/protocol/program-scenes', () => ({
  programPresentationSchema: { parse: (value: unknown) => value },
}));
vi.mock('../src/workspace/client', () => ({
  useProgramScenes: () => ({
    active: 'waiting',
    preparing: false,
    director: { mode: controls.mode },
  }),
}));
vi.mock('../src/realtime/hud-config-client', () => ({
  useHudConfigClient: () => ({ current: null }),
}));
vi.mock('../src/realtime/broadcast-display-client', () => ({
  useBroadcastDisplayConfig: () => ({
    status: 'ready',
    current: {
      hud: { renderer: 'native', config: {} },
      program: {
        tokens: {},
        assets: {
          'pulse.background': {
            resource: { id: 'local:test', version: '1', digest: 'a'.repeat(64) },
            fileId: 'background',
          },
        },
      },
    },
  }),
}));
vi.mock('../src/realtime', () => {
  const value = {
    current: { payload: { clock: { phase: 'live' }, match: { matchId: controls.matchId } } },
  };
  return { useLocalChannelClient: () => ({ subscribe: () => () => {}, getSnapshot: () => value }) };
});
vi.mock('@mizar/hud-view', () => ({
  ProgramView: (props: { sceneStyle?: Record<string, string> }) => (
    <div data-testid="scene" data-background={props.sceneStyle?.['--pulse-background-image']} />
  ),
  StatsInsertView: (props: { insert: { subtitle: string } }) => (
    <div data-testid="insert">{props.insert.subtitle}</div>
  ),
}));
import { ProgramScenePage } from '../src/program/ProgramScenePage';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  controls.mode = 'auto';
});
it('preserves the configured background when the statistics rotation starts and stops', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      Response.json(
        path.endsWith('broadcast-stats') ? fixture : { match: { matchId: controls.matchId } },
      ),
    ),
  );
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(<ProgramScenePage sceneId="waiting" />);
      await Promise.resolve();
    });
    expect(host.querySelector('[data-testid=scene]')?.getAttribute('data-background')).toContain(
      '/local/v1/broadcast-assets?',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(host.querySelector('[data-testid=insert]')?.textContent).toBe('LINEUPS');
    controls.mode = 'manual';
    await act(async () => {
      root.render(<ProgramScenePage sceneId="waiting" />);
    });
    expect(host.querySelector('[data-testid=insert]')).toBeNull();
    expect(host.querySelector('[data-testid=scene]')?.getAttribute('data-background')).toContain(
      '/local/v1/broadcast-assets?',
    );
  } finally {
    act(() => root.unmount());
  }
});
