// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBuiltinResolvedPreset, HUD_WIDGET_IDS } from '@mizar/hud-config';
import type { OverlayPolicy } from '../preparation/desktop-overlay';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  display: {
    status: 'ready' as 'loading' | 'ready' | 'unavailable' | 'unsupported',
    current: null as {
      activeRevision: string;
      hud: {
        renderer: 'native';
        config: ReturnType<typeof getBuiltinResolvedPreset>;
        overlays: {
          pause: { enabled: boolean; visual: string };
          chat: { enabled: boolean; placement: 'auto' };
        };
        accent: { source: 'theme' };
      };
      program: { themeId: 'mizar-pulse' };
    } | null,
    reason: null as string | null,
  },
  hudConfig: {
    status: 'ready' as const,
    current: null as unknown as ReturnType<typeof getBuiltinResolvedPreset>,
    etag: '"etag-1"',
    activeRevision: 'hud-1',
    error: null,
    applyResponse: vi.fn(),
  },
  scenes: null as {
    active: string;
    director?: { gg?: { mapEpoch: number; remainingMs: number } };
  } | null,
  channelCalls: [] as Array<{ channel: string; enabled: boolean }>,
  radarSourceCalls: [] as Array<boolean>,
  cueStartCount: 0,
  cueDisposeCount: 0,
  programPageProps: [] as Array<{
    resolvedPreset: unknown;
    overlays: unknown;
    radarSource: unknown;
  }>,
  policyResponse: null as OverlayPolicy | null,
}));

vi.mock('../realtime/broadcast-display-client', () => ({
  useBroadcastDisplayConfig: () => mockState.display,
}));

vi.mock('../realtime/hud-config-client', () => ({
  useHudConfigClient: () => mockState.hudConfig,
}));

vi.mock('../workspace/client', () => ({
  useProgramScenes: () => mockState.scenes,
  desktopInvoke: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../debug/control-journal', () => ({
  nativeSnapshot: vi.fn(),
}));

vi.mock('../realtime/radar-view-source', () => ({
  useRadarViewSource: (_client: unknown, enabled = true) => {
    mockState.radarSourceCalls.push(enabled);
    return enabled ? { subscribe: () => () => {}, getSnapshot: () => null } : undefined;
  },
}));

vi.mock('../realtime', () => ({
  useLocalChannelClient: (channel: string, enabled = true) => {
    mockState.channelCalls.push({ channel, enabled });
    const snapshot = {
      state: enabled ? 'live' : 'idle',
      current: null,
      reset: null,
      error: null,
    };
    return {
      channel,
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
    };
  },
  createProgramCueClient: () => ({
    start: () => {
      mockState.cueStartCount += 1;
    },
    dispose: () => {
      mockState.cueDisposeCount += 1;
    },
    observeProgramSnapshot: vi.fn(),
    subscribe: () => () => {},
    subscribeCues: () => () => {},
    subscribeResets: () => () => {},
    getSnapshot: () => ({ state: 'idle', baseline: null, error: null }),
  }),
}));

vi.mock('./ProgramCueRendererBridge', () => ({
  ProgramCueRendererBridge: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./ProgramPage', () => ({
  ProgramPage: (props: { resolvedPreset: unknown; overlays: unknown; radarSource: unknown }) => {
    mockState.programPageProps.push({
      resolvedPreset: props.resolvedPreset,
      overlays: props.overlays,
      radarSource: props.radarSource,
    });
    return <div data-testid="program-page" />;
  },
}));

import { ProgramRoute } from './ProgramRoute';

function makeDesktopPolicy(overrides: Partial<OverlayPolicy> = {}): OverlayPolicy {
  const visibility: Record<string, boolean> = {};
  for (const id of HUD_WIDGET_IDS) {
    visibility[id] = false;
  }
  return {
    revision: 'rev-1',
    enabled: true,
    visibility,
    ...overrides,
  };
}

describe('ProgramRoute lifecycle & policy stability', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    mockState.hudConfig.current = getBuiltinResolvedPreset();
    mockState.display = {
      status: 'ready',
      current: {
        activeRevision: 'bd-1',
        hud: {
          renderer: 'native',
          config: getBuiltinResolvedPreset(),
          overlays: {
            pause: { enabled: false, visual: 'legacy' },
            chat: { enabled: false, placement: 'auto' },
          },
          accent: { source: 'theme' },
        },
        program: { themeId: 'mizar-pulse' },
      },
      reason: null,
    };
    mockState.scenes = null;
    mockState.channelCalls = [];
    mockState.radarSourceCalls = [];
    mockState.cueStartCount = 0;
    mockState.cueDisposeCount = 0;
    mockState.programPageProps = [];
    mockState.policyResponse = null;
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    window.history.replaceState({}, '', '/program');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (input === '/local/v1/desktop-overlay' && mockState.policyResponse) {
          return new Response(JSON.stringify({ ...mockState.policyResponse }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
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

  function mountRoute() {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<ProgramRoute />);
    });
  }

  it('disables radar, program, and cue subscriptions when display is unsupported', () => {
    mockState.display = { status: 'unsupported', current: null, reason: 'unsupported' };
    mountRoute();

    expect(mockState.channelCalls).toContainEqual({ channel: 'radar', enabled: false });
    expect(mockState.channelCalls).toContainEqual({ channel: 'program', enabled: false });
    expect(mockState.radarSourceCalls.at(-1)).toBe(false);
    expect(mockState.cueStartCount).toBe(0);
  });

  it('enables only radar channel when desktop policy shows only radar, and toggles program/cue on demand', async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    window.history.replaceState({}, '', '/program?host=desktop');
    const policy = makeDesktopPolicy();
    policy.visibility.radar = true;
    mockState.policyResponse = policy;

    mountRoute();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockState.channelCalls.at(-2)).toEqual({ channel: 'radar', enabled: true });
    expect(mockState.channelCalls.at(-1)).toEqual({ channel: 'program', enabled: false });
    expect(mockState.radarSourceCalls.at(-1)).toBe(true);
    expect(mockState.cueStartCount).toBe(0);

    // Enable a non-radar HUD widget in a new policy revision
    const policyWithHud = makeDesktopPolicy({ revision: 'rev-2' });
    policyWithHud.visibility.radar = true;
    policyWithHud.visibility['top-score-bar'] = true;
    mockState.policyResponse = policyWithHud;

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockState.channelCalls.at(-2)).toEqual({ channel: 'radar', enabled: true });
    expect(mockState.channelCalls.at(-1)).toEqual({ channel: 'program', enabled: true });
    expect(mockState.cueStartCount).toBe(1);
  });

  it('keeps resolvedPreset and overlays object references stable across polls with the same policy revision', async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    window.history.replaceState({}, '', '/program?host=desktop');
    const policy = makeDesktopPolicy({ revision: 'rev-stable' });
    policy.visibility['top-score-bar'] = true;
    mockState.policyResponse = policy;

    mountRoute();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const firstProps = mockState.programPageProps.at(-1)!;
    const countBeforeSecondPoll = mockState.programPageProps.length;

    // Poll again with a fresh JSON object but identical revision/enabled/visibility
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });

    const afterProps = mockState.programPageProps.at(-1)!;
    expect(mockState.programPageProps.length).toBeGreaterThanOrEqual(countBeforeSecondPoll);
    expect(afterProps.resolvedPreset).toBe(firstProps.resolvedPreset);
    expect(afterProps.overlays).toBe(firstProps.overlays);

    // Now bump revision -> resolvedPreset reference updates
    mockState.policyResponse = makeDesktopPolicy({ revision: 'rev-next' });
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });

    const updatedProps = mockState.programPageProps.at(-1)!;
    expect(updatedProps.resolvedPreset).not.toBe(firstProps.resolvedPreset);
  });
});
