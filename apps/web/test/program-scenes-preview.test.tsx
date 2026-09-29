// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { ProgramScenePage } from '../src/program/ProgramScenePage';
import { BpPresentation } from '../src/bp/BpPresentation';

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
      const main = container.querySelector('.program-scene__content');
      expect(main, `scene ${sceneId} should render default content in preview mode`).not.toBeNull();
      expect(container.textContent).toContain('MIZAR');
    }

    // BP scene in preview mode with null snapshot renders default BP projection
    window.history.replaceState({}, '', '/program/bp?preview=1');
    await act(async () => {
      root!.render(<BpPresentation snapshot={null} />);
      await Promise.resolve();
    });
    const bpScene = container.querySelector('.bp-scene');
    expect(bpScene).not.toBeNull();
    expect(container.textContent).toContain('FURIA');
    expect(container.textContent).toContain('G2.Esports');
    expect(container.textContent).toContain('MAP VETO');
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
    expect(container.querySelector('.program-scene__content')).toBeNull();

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
    expect(container.querySelector('.program-scene__content')).toBeNull();

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
    expect(container.querySelector('.program-scene__content')).toBeNull();
  });
});
