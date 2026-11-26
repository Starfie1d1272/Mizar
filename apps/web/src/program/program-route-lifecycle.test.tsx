// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBuiltinResolvedPreset, HUD_WIDGET_IDS } from '@mizar/hud-config';
import type { OverlayPolicy } from '../preparation/desktop-overlay';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mockState = vi.hoisted(() => ({
  display: {
    status: 'ready' as 'ready' | 'unsupported',
    current: null as unknown,
    reason: null as string | null,
  },
  hudCurrent: null as unknown as ReturnType<typeof getBuiltinResolvedPreset>,
  scenes: null as {
    active: string;
    director?: { next?: string | null; gg?: { mapEpoch: number; remainingMs: number } };
  } | null,
  channelCalls: [] as Array<{ channel: string; enabled: boolean }>,
  radarSourceCalls: [] as boolean[],
  cueStartCount: 0,
  programPageProps: [] as Array<{ resolvedPreset: unknown; overlays: unknown }>,
  policyResponse: null as OverlayPolicy | null,
}));

vi.mock('../realtime/broadcast-display-client', () => ({
  useBroadcastDisplayConfig: () => mockState.display,
}));
vi.mock('../realtime/hud-config-client', () => ({
  useHudConfigClient: () => ({
    status: 'ready',
    current: mockState.hudCurrent,
    etag: '"e1"',
    activeRevision: 'h1',
    error: null,
    applyResponse: vi.fn(),
  }),
}));
vi.mock('../workspace/client', () => ({
  useProgramScenes: () => mockState.scenes,
  desktopInvoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../debug/control-journal', () => ({ nativeSnapshot: vi.fn() }));
vi.mock('../realtime/radar-view-source', () => ({
  useRadarViewSource: (_client: unknown, enabled = true) => {
    mockState.radarSourceCalls.push(enabled);
    return enabled ? { subscribe: () => () => {}, getSnapshot: () => null } : undefined;
  },
}));
vi.mock('../realtime', () => ({
  useLocalChannelClient: (channel: string, enabled = true) => {
    mockState.channelCalls.push({ channel, enabled });
    const snapshot = { state: enabled ? 'live' : 'idle', current: null, reset: null, error: null };
    return { channel, subscribe: () => () => {}, getSnapshot: () => snapshot };
  },
  createProgramCueClient: () => ({
    start: () => {
      mockState.cueStartCount += 1;
    },
    dispose: vi.fn(),
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
  ProgramPage: (props: { resolvedPreset: unknown; overlays: unknown }) => {
    mockState.programPageProps.push({
      resolvedPreset: props.resolvedPreset,
      overlays: props.overlays,
    });
    return null;
  },
}));

import { ProgramRoute } from './ProgramRoute';

function makePolicy(revision: string, enabledWidgets: string[] = []): OverlayPolicy {
  const visibility = Object.fromEntries(
    HUD_WIDGET_IDS.map((id) => [id, enabledWidgets.includes(id)]),
  );
  return { revision, enabled: true, visibility };
}

describe('ProgramRoute lifecycle & policy stability', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    const preset = getBuiltinResolvedPreset();
    mockState.hudCurrent = preset;
    mockState.display = {
      status: 'ready',
      current: {
        activeRevision: 'bd-1',
        hud: {
          renderer: 'native',
          config: preset,
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
    mockState.programPageProps = [];
    mockState.policyResponse = null;
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    window.history.replaceState({}, '', '/program');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) =>
        input === '/local/v1/desktop-overlay' && mockState.policyResponse
          ? new Response(JSON.stringify({ ...mockState.policyResponse }), { status: 200 })
          : new Response(null, { status: 404 }),
      ),
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

  it('disables subscriptions when display is unsupported or OBS source is inactive in background', async () => {
    mockState.display = { status: 'unsupported', current: null, reason: 'unsupported' };
    mountRoute();
    expect(mockState.channelCalls.slice(-2)).toEqual([
      { channel: 'radar', enabled: false },
      { channel: 'program', enabled: false },
    ]);
    expect(mockState.cueStartCount).toBe(0);

    // Switch to supported display, then simulate OBS background scene
    mockState.display = {
      ...mockState.display,
      status: 'ready',
      current: {
        activeRevision: 'bd-1',
        hud: {
          renderer: 'native',
          config: mockState.hudCurrent,
          overlays: {
            pause: { enabled: false, visual: 'legacy' },
            chat: { enabled: false, placement: 'auto' },
          },
          accent: { source: 'theme' },
        },
        program: { themeId: 'mizar-pulse' },
      },
    };
    mockState.scenes = { active: 'waiting', director: { next: 'matchup' } };
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('obsSourceActiveChanged', { detail: { active: false } }),
      );
      root?.render(<ProgramRoute />);
    });
    expect(mockState.channelCalls.slice(-2)).toEqual([
      { channel: 'radar', enabled: false },
      { channel: 'program', enabled: false },
    ]);
  });

  it('enables only radar when desktop policy shows only radar, and toggles program/cue on demand', async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    window.history.replaceState({}, '', '/program?host=desktop');
    mockState.policyResponse = makePolicy('rev-1', ['radar']);

    mountRoute();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockState.channelCalls.slice(-2)).toEqual([
      { channel: 'radar', enabled: true },
      { channel: 'program', enabled: false },
    ]);
    expect(mockState.radarSourceCalls.at(-1)).toBe(true);
    expect(mockState.cueStartCount).toBe(0);

    mockState.policyResponse = makePolicy('rev-2', ['radar', 'top-score-bar']);
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockState.channelCalls.slice(-2)).toEqual([
      { channel: 'radar', enabled: true },
      { channel: 'program', enabled: true },
    ]);
    expect(mockState.cueStartCount).toBe(1);
  });

  it('keeps resolvedPreset and overlays references stable when policy revision is unchanged', async () => {
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    window.history.replaceState({}, '', '/program?host=desktop');
    mockState.policyResponse = makePolicy('rev-stable', ['top-score-bar']);

    mountRoute();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstProps = mockState.programPageProps.at(-1)!;

    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    const afterProps = mockState.programPageProps.at(-1)!;
    expect(afterProps.resolvedPreset).toBe(firstProps.resolvedPreset);
    expect(afterProps.overlays).toBe(firstProps.overlays);

    mockState.policyResponse = makePolicy('rev-next', []);
    await act(async () => {
      vi.advanceTimersByTime(1000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockState.programPageProps.at(-1)!.resolvedPreset).not.toBe(firstProps.resolvedPreset);
  });
});
