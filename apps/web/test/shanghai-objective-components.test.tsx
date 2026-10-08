// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { getBuiltinResolvedPreset, placementToBox } from '@mizar/hud-config';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import { getProgramFixture } from '../src/program/fixtures';
import { TopScoreBar } from '../src/program/widgets/match-header/TopScoreBar';

it.each(['plant', 'defuse'] as const)(
  'removes the Shanghai %s panel immediately when timing ends or becomes unavailable',
  (kind) => {
    const snapshot = getProgramFixture('real-defusing')!;
    const preset = getBuiltinResolvedPreset('builtin:perfectworld-preset');
    const placement = preset.layout.widgets['top-score-bar'];
    const node = document.createElement('div');
    const root = createRoot(node);
    const render = (
      remainingSeconds: number | null,
      state: 'planting' | 'defusing' | 'planted' = kind === 'plant' ? 'planting' : 'defusing',
      mapped = true,
    ) => {
      const frame: ProgramSnapshot = {
        ...snapshot,
        payload: {
          ...snapshot.payload,
          series: mapped
            ? snapshot.payload.series
            : {
                ...snapshot.payload.series!,
                entrants: {
                  a: { ...snapshot.payload.series!.entrants.a, entryId: 'unresolved-a' },
                  b: { ...snapshot.payload.series!.entrants.b, entryId: 'unresolved-b' },
                },
              },
          bomb: {
            ...snapshot.payload.bomb!,
            state,
            action:
              kind === 'plant'
                ? {
                    kind,
                    sourcePlayerId: snapshot.payload.players[0]!.sourcePlayerId,
                    remainingSeconds,
                    durationSeconds: 3.2,
                  }
                : {
                    kind,
                    sourcePlayerId: snapshot.payload.players[0]!.sourcePlayerId,
                    remainingSeconds,
                    durationSeconds: 5,
                    hasDefuseKit: true,
                  },
          },
        },
      };
      act(() =>
        root.render(
          <TopScoreBar
            design="perfectworld"
            snapshot={frame}
            resolvedPreset={preset}
            widgetId="top-score-bar"
            placement={placement}
            box={placementToBox('top-score-bar', placement)}
            settings={preset.widgets['top-score-bar']}
          />,
        ),
      );
    };
    try {
      render(1.25);
      expect(node.querySelector('.shanghai-event-panel b')?.textContent).toBe('1:25');
      for (const remaining of [0, null, -0.01]) {
        render(remaining);
        expect(node.querySelector('.shanghai-event-panel')).toBeNull();
        expect(node.querySelector('.shanghai-action-track')).toBeNull();
      }
      render(1.25);
      expect(node.querySelector('.shanghai-event-panel')).not.toBeNull();
      render(1.25, 'planted');
      expect(node.querySelector('.shanghai-event-panel')).toBeNull();
      const icon = node.querySelector('.objective-center .shanghai-c4');
      expect(icon?.getAttribute('data-asset-id')).toBe('objective.c4');
      expect((icon as HTMLElement).style.getPropertyValue('--objective-icon')).toContain(
        '/assets/cs2/objective/c4.',
      );
      render(1.25, kind === 'plant' ? 'planting' : 'defusing', false);
      expect(node.querySelector('.shanghai-event-panel')).toBeNull();
      expect(node.querySelector('.shanghai-fuse')).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  },
);

it('recovers a round-winner logo when its failed URL is replaced', () => {
  const snapshot = structuredClone(getProgramFixture('real-defusing')!);
  snapshot.payload.bomb = null;
  snapshot.payload.round = { phase: 'over', winnerSide: 'CT' };
  const winner = Object.values(snapshot.payload.series!.entrants).find(
    (team) => team.entryId === snapshot.payload.teams.ct.entryId,
  )!;
  winner.logoUrl = '/broken-logo.png';
  const preset = getBuiltinResolvedPreset('builtin:perfectworld-preset');
  const placement = preset.layout.widgets['top-score-bar'];
  const node = document.createElement('div');
  const root = createRoot(node);
  const render = () => {
    act(() =>
      root.render(
        <TopScoreBar
          design="perfectworld"
          snapshot={structuredClone(snapshot)}
          resolvedPreset={preset}
          widgetId="top-score-bar"
          placement={placement}
          box={placementToBox('top-score-bar', placement)}
          settings={preset.widgets['top-score-bar']}
        />,
      ),
    );
  };
  try {
    render();
    const logo = node.querySelector('.shanghai-round-winner img')!;
    expect(logo).not.toBeNull();
    act(() => {
      logo.dispatchEvent(new Event('error'));
    });
    expect(node.querySelector('.shanghai-round-winner svg')?.getAttribute('aria-label')).toContain(
      winner.name,
    );
    expect(node.querySelector('.shanghai-round-winner')?.textContent).not.toContain(winner.name);
    winner.logoUrl = '/replacement-logo.svg';
    render();
    expect(node.querySelector('.shanghai-round-winner img')?.getAttribute('src')).toBe(
      '/replacement-logo.svg',
    );
    expect(node.querySelector('.shanghai-winner-name')).toBeNull();
  } finally {
    act(() => root.unmount());
  }
});
