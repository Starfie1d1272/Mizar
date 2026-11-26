// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBuiltinResolvedPreset } from '@mizar/hud-config';
import type { ProgramSceneState } from '@mizar/protocol/program-scenes';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const sceneMock = vi.hoisted(() => ({
  scenes: null as ProgramSceneState | null,
  channelCalls: [] as Array<{ channel: string; enabled: boolean }>,
  presentationFetches: 0,
  hudCurrent: null as unknown as ReturnType<typeof getBuiltinResolvedPreset>,
}));

vi.mock('../realtime/broadcast-display-client', () => ({
  useBroadcastDisplayConfig: () => ({
    status: 'ready',
    current: {
      activeRevision: 'bd-1',
      hud: {
        renderer: 'native',
        config: sceneMock.hudCurrent,
        overlays: {
          pause: { enabled: false, visual: 'legacy' },
          chat: { enabled: false, placement: 'auto' },
        },
        accent: { source: 'theme' },
      },
      program: { themeId: 'mizar-pulse' },
    },
    reason: null,
  }),
}));
vi.mock('../realtime/hud-config-client', () => ({
  useHudConfigClient: () => ({
    status: 'ready',
    current: sceneMock.hudCurrent,
    etag: '"e1"',
    activeRevision: 'h1',
    error: null,
    applyResponse: vi.fn(),
  }),
}));
vi.mock('../realtime', () => ({
  useLocalChannelClient: (channel: string, enabled = true) => {
    sceneMock.channelCalls.push({ channel, enabled });
    const snapshot = { state: enabled ? 'live' : 'idle', current: null, reset: null, error: null };
    return { channel, subscribe: () => () => {}, getSnapshot: () => snapshot };
  },
}));
vi.mock('../workspace/client', async () => {
  const actual = await vi.importActual<typeof import('../workspace/client')>('../workspace/client');
  return { ...actual, useProgramScenes: () => sceneMock.scenes };
});
vi.mock('./broadcast-display', () => ({ pulseTokenStyle: () => undefined }));
vi.mock('./useStatsRotation', () => ({ useStatsRotation: () => null }));
vi.mock('@mizar/hud-view', () => ({
  ProgramView: () => null,
  StatsInsertView: () => null,
}));

import { ProgramScenePage } from './ProgramScenePage';

function makeScenes(
  active: ProgramSceneState['active'],
  next: ProgramSceneState['active'] | null,
): ProgramSceneState {
  return {
    schemaVersion: 'mizar.program-scenes.v1',
    active,
    revision: 'rev-1',
    available: ['waiting', 'matchup', 'gameplay', 'halftime'],
    director: {
      mode: 'auto',
      next,
      nextStatus: 'predicted',
      nextReason: null,
      reason: null,
      introDurationMs: 0,
      sceneElapsedMs: 1000,
    },
    blocked: {},
  };
}

describe('ProgramScenePage & useProgramScenes lifecycle', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    sceneMock.hudCurrent = getBuiltinResolvedPreset();
    sceneMock.scenes = makeScenes('waiting', 'halftime');
    sceneMock.channelCalls = [];
    sceneMock.presentationFetches = 0;
    window.history.replaceState({}, '', '/program/matchup');
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input === '/local/v1/program-presentation') {
          sceneMock.presentationFetches += 1;
          return new Response(
            JSON.stringify({
              schemaVersion: 'mizar.program-presentation.v1',
              match: null,
              maps: [],
            }),
            { status: 200 },
          );
        }
        return new Response(null, { status: 404 });
      }),
    );
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('skips program WebSocket connection in ?preview=1 mode', async () => {
    window.history.replaceState({}, '', '/program/matchup?preview=1');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ProgramScenePage sceneId="matchup" />);
      await Promise.resolve();
    });
    expect(sceneMock.channelCalls).toContainEqual({ channel: 'program', enabled: false });
    expect(sceneMock.presentationFetches).toBe(0);
  });

  it('pauses presentation polling and subscriptions when hidden in OBS background, and resumes when next', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<ProgramScenePage sceneId="matchup" />);
      await Promise.resolve();
    });
    expect(sceneMock.presentationFetches).toBe(1);
    expect(sceneMock.channelCalls.slice(-2)).toEqual([
      { channel: 'program', enabled: true },
      { channel: 'radar', enabled: true },
    ]);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('obsSourceActiveChanged', { detail: { active: false } }),
      );
      await Promise.resolve();
    });
    expect(sceneMock.channelCalls.slice(-2)).toEqual([
      { channel: 'program', enabled: false },
      { channel: 'radar', enabled: false },
    ]);

    const fetchesWhileHidden = sceneMock.presentationFetches;
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(sceneMock.presentationFetches).toBe(fetchesWhileHidden);

    sceneMock.scenes = makeScenes('waiting', 'matchup');
    await act(async () => {
      root?.render(<ProgramScenePage sceneId="matchup" />);
      await Promise.resolve();
    });
    expect(sceneMock.presentationFetches).toBeGreaterThan(fetchesWhileHidden);
    expect(sceneMock.channelCalls.slice(-2)).toEqual([
      { channel: 'program', enabled: true },
      { channel: 'radar', enabled: true },
    ]);
  });

  it('relaxes useProgramScenes polling when hidden and refreshes immediately on visibility restore', async () => {
    let sceneFetches = 0;
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input === '/local/v1/program-scenes') {
          sceneFetches += 1;
          return new Response(JSON.stringify(makeScenes('waiting', 'matchup')), { status: 200 });
        }
        return new Response(null, { status: 404 });
      }),
    );

    const { useProgramScenes: realUseProgramScenes } =
      await vi.importActual<typeof import('../workspace/client')>('../workspace/client');
    function Probe() {
      realUseProgramScenes();
      return null;
    }

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(<Probe />);
      await Promise.resolve();
    });
    expect(sceneFetches).toBe(1);

    visibility = 'hidden';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(250);
      await Promise.resolve();
    });
    expect(sceneFetches).toBe(2);

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
    });
    expect(sceneFetches).toBe(2);

    visibility = 'visible';
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(sceneFetches).toBe(3);
  });
});
