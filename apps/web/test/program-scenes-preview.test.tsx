// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { ProgramScenePage } from '../src/program/ProgramScenePage';
import { BpPresentation } from '../src/bp/BpPresentation';
import { getBuiltinResolvedPreset } from '@mizar/hud-config';
import { getProgramFixture } from '../src/program/fixtures';
import { programPreviewSnapshot } from '../src/program/presentation-preview';

let root: Root | undefined;
let container: HTMLDivElement;

const mockChannelState: {
  state: 'live' | 'closed' | 'error';
  current: { payload: Record<string, unknown> } | null;
} = {
  state: 'closed',
  current: null,
};

vi.mock('../src/realtime', () => ({
  useLocalChannelClient: () => ({
    subscribe: () => () => {},
    getSnapshot: () => mockChannelState,
  }),
}));

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
  window.matchMedia = vi
    .fn()
    .mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  mockChannelState.state = 'closed';
  mockChannelState.current = null;
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  root = undefined;
  window.history.replaceState({}, '', '/');
});

describe('Program scenes preview and safety boundaries', () => {
  it('reads the activated HUD configuration in preview mode', async () => {
    const resolved = structuredClone(getBuiltinResolvedPreset());
    for (const placement of Object.values(resolved.layout.widgets)) placement.visible = false;
    const fetchMock = vi.fn((path: string) => {
      if (path !== '/local/v1/hud-config') throw new Error('offline');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ resolved, etag: '"activated"', activeRevision: 'activated' }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState({}, '', '/program?preview=1');
    await act(async () => {
      root!.render(<ProgramScenePage sceneId="gameplay" />);
      await Promise.resolve();
    });
    expect(fetchMock.mock.calls.some(([path]) => path === '/local/v1/hud-config')).toBe(true);
    expect(container.querySelector('.gameplay-hud')).not.toBeNull();
    expect(container.querySelector('[data-hud-widget]')).toBeNull();
  });

  it('applies the same preview variants to HUD teams, players and series without changing fixtures', () => {
    const original = structuredClone(getProgramFixture('epl-live'));
    const noMedia = programPreviewSnapshot('gameplay', 'no-media').payload;
    expect(Object.values(noMedia.teams).every((team) => team.logoUrl === null)).toBe(true);
    expect(noMedia.players.every((player) => player.avatarUrl === null)).toBe(true);
    const long = programPreviewSnapshot('matchup', 'long-names').payload;
    for (const team of Object.values(long.teams)) {
      expect(team.name).toContain('长名称战队');
      expect(Object.values(long.series!.entrants).some((entry) => entry.name === team.name)).toBe(
        true,
      );
    }
    for (const [format, maps, wins] of [
      ['bo1', 1, 1],
      ['bo5', 5, 3],
    ] as const) {
      const snapshot = programPreviewSnapshot('gameplay', format).payload;
      expect(snapshot.match?.format).toBe(format);
      expect(snapshot.series?.format).toBe(format);
      expect(snapshot.series?.requiredWins).toBe(wins);
      expect(snapshot.series?.maps).toHaveLength(maps);
    }
    expect(getProgramFixture('epl-live')).toEqual(original);
  });

  it('renders default visual for all program scenes in preview mode when no match is bound', async () => {
    window.history.replaceState({}, '', '/program/waiting?preview=1');

    const scenes: ProgramSceneId[] = [
      'waiting',
      'matchup',
      'halftime',
      'map_result',
      'intermap',
      'match_result',
    ];

    for (const sceneId of scenes) {
      await act(async () => {
        root!.render(<ProgramScenePage sceneId={sceneId} />);
        await Promise.resolve();
      });

      // Header, brand, or main content is visible
      const main = container.querySelector(
        '.waiting-layout, .intro-body, .summary-players, .result-sting',
      );
      expect(main, `scene ${sceneId} should render default content in preview mode`).not.toBeNull();
      expect(container.textContent).toContain('示例画面');
      expect(container.textContent).toContain('Falcons');
    }

    // A preview query must never fabricate BP data or bypass the session.
    window.history.replaceState({}, '', '/program/bp?preview=1');
    await act(async () => {
      root!.render(<BpPresentation snapshot={null} />);
      await Promise.resolve();
    });
    const bpScene = container.querySelector('.bp-scene');
    expect(bpScene).toBeNull();
  });

  it('strictly enforces safety gates for production broadcast (without preview flag)', async () => {
    window.history.replaceState({}, '', '/program/matchup');

    // 1. When context is unbound or stale, production broadcast does not render
    mockChannelState.state = 'live';
    mockChannelState.current = {
      payload: {
        status: { context: 'stale', identity: 'matched', telemetry: 'fresh' },
        series: { bindingState: 'bound' },
      },
    };

    await act(async () => {
      root!.render(<ProgramScenePage sceneId="matchup" />);
      await Promise.resolve();
    });
    expect(
      container.querySelector('.waiting-layout, .intro-body, .summary-players, .result-sting'),
    ).toBeNull();

    // 2. When identity is mismatch, production broadcast does not render
    mockChannelState.current = {
      payload: {
        status: { context: 'fresh', identity: 'mismatch', telemetry: 'fresh' },
        series: { bindingState: 'bound' },
      },
    };
    await act(async () => {
      root!.render(<ProgramScenePage sceneId="matchup" />);
      await Promise.resolve();
    });
    expect(
      container.querySelector('.waiting-layout, .intro-body, .summary-players, .result-sting'),
    ).toBeNull();

    // 3. When series is not bound, production broadcast does not render
    mockChannelState.current = {
      payload: {
        status: { context: 'fresh', identity: 'matched', telemetry: 'fresh' },
        series: { bindingState: 'unbound' },
        match: { competition: { name: '2026 NJU Rivals' } },
      },
    };
    await act(async () => {
      root!.render(<ProgramScenePage sceneId="matchup" />);
      await Promise.resolve();
    });
    // Even if competition name includes Rivals, heuristic does NOT bypass gate!
    expect(
      container.querySelector('.waiting-layout, .intro-body, .summary-players, .result-sting'),
    ).toBeNull();
  });
});
