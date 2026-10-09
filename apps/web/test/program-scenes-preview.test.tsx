// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { ProgramScenePage } from '../src/program/ProgramScenePage';
import { BpPresentation } from '../src/bp/BpPresentation';
import { getBuiltinResolvedPreset } from '@mizar/hud-config';
import { getProgramFixture } from '../src/program/fixtures';
import { presentationPreview, programPreviewSnapshot } from '../src/program/presentation-preview';

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    expect(container.querySelector('[data-hud-widget]')).toBeNull();
  });

  it('applies the same preview variants to HUD teams, players and series without changing fixtures', () => {
    const original = structuredClone(getProgramFixture('epl-live'));
    const noMedia = programPreviewSnapshot('gameplay', 'no-media').payload;
    expect(Object.values(noMedia.teams).every((team) => team.logoUrl === null)).toBe(true);
    expect(noMedia.players.every((player) => player.avatarUrl === null)).toBe(true);
    const long = programPreviewSnapshot('matchup', 'long-names').payload;
    for (const team of Object.values(long.teams)) {
      expect(team.name.length).toBeGreaterThan(original!.payload.teams.ct.name.length);
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

      expect(container.textContent, sceneId).toContain('Falcons');
      expect(container.textContent, sceneId).toContain('Natus Vincere');
      expect(container.textContent).toContain('示例画面');
    }

    // A preview query must never fabricate BP data or bypass the session.
    window.history.replaceState({}, '', '/program/bp?preview=1');
    await act(async () => {
      root!.render(<BpPresentation snapshot={null} />);
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('Falcons');
    expect(container.textContent).not.toContain('Natus Vincere');
  });

  it('renders the server presentation on air without substituting preview data', async () => {
    window.history.replaceState({}, '', '/program/waiting');
    const presentation = structuredClone(presentationPreview('waiting', null));
    presentation.series!.entrants.a.name = 'On-air Alpha';
    presentation.series!.entrants.b.name = 'On-air Beta';
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        if (path !== '/local/v1/program-presentation') throw new Error('offline');
        return Promise.resolve({ ok: true, json: () => Promise.resolve(presentation) });
      }),
    );
    await act(async () => {
      root!.render(<ProgramScenePage sceneId="waiting" />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain('On-air Alpha');
    expect(container.textContent).toContain('On-air Beta');
    expect(container.textContent).not.toContain('示例画面');
    expect(container.textContent).not.toContain('Falcons');
  });

  it('does not put preview teams on air when the presentation endpoint is offline', async () => {
    window.history.replaceState({}, '', '/program/matchup');
    // A live Program snapshot does not authorize a fabricated scene presentation.
    mockChannelState.state = 'live';
    mockChannelState.current = structuredClone(getProgramFixture('epl-live'));
    await act(async () => {
      root!.render(<ProgramScenePage sceneId="matchup" />);
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain('Falcons');
    expect(container.textContent).not.toContain('Natus Vincere');
    expect(container.textContent).not.toContain('示例画面');
  });
});
