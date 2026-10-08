// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { getBuiltinResolvedPreset, placementToBox } from '@mizar/hud-config';
import { getProgramFixture } from '../src/program/fixtures';
import { TopScoreBar } from '../src/program/widgets/match-header/TopScoreBar';
import { ALIVE_MATCHUP_HOLD_MS } from '../src/program/widgets/match-header/useAliveMatchup';

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  vi.useRealTimers();
});
function rig(design: 'current' | 'ewc' | 'iem' | 'esl' | 'perfectworld' = 'current') {
  vi.useFakeTimers();
  const node = document.createElement('div');
  root = createRoot(node);
  const preset = getBuiltinResolvedPreset(
    design === 'current' ? 'builtin:mizar-default-preset' : `builtin:${design}-preset`,
  );
  const placement = preset.layout.widgets['top-score-bar'];
  const frame = structuredClone(getProgramFixture('real-live-rich')!);
  let revision = 0;
  const render = () => {
    frame.cursor.programReceiveSequence = (frame.cursor.programReceiveSequence ?? 0) + 1;
    act(() =>
      root!.render(
        <TopScoreBar
          design={design}
          snapshot={structuredClone(frame)}
          presentationRevision={revision}
          resolvedPreset={preset}
          widgetId="top-score-bar"
          placement={placement}
          box={placementToBox('top-score-bar', placement)}
          settings={preset.widgets['top-score-bar']}
        />,
      ),
    );
  };
  return {
    node,
    frame,
    render,
    reset: () => {
      revision++;
      render();
    },
    panel: () => node.querySelector('.match-header__alive-matchup'),
  };
}

it.each(['current', 'ewc', 'iem', 'esl', 'perfectworld'] as const)(
  '%s shows only new losses, refreshes one panel and expires it',
  (design) => {
    const r = rig(design);
    r.render();
    expect(r.panel()).toBeNull();
    r.frame.payload.players[0]!.lifeState = 'dead';
    r.render();
    if (design === 'perfectworld') {
      expect(r.panel()).toBeNull();
      return;
    }
    const panel = r.panel();
    expect(panel?.textContent).toBe('4VS5');
    act(() => {
      vi.advanceTimersByTime(ALIVE_MATCHUP_HOLD_MS - 100);
    });
    r.frame.payload.players[1]!.lifeState = 'dead';
    r.render();
    expect(r.panel()).toBe(panel);
    expect(panel?.textContent).toBe('4VS4');
    act(() => {
      vi.advanceTimersByTime(ALIVE_MATCHUP_HOLD_MS - 1);
    });
    expect(r.panel()?.getAttribute('data-motion-phase')).not.toBe('exit');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(r.panel()?.getAttribute('data-motion-phase')).toBe('exit');
    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(r.panel()).toBeNull();
  },
);

it.each(['round', 'source', 'epoch', 'seek', 'stale', 'pause', 'freeze', 'over', 'lineup'])(
  'clears %s boundaries and does not replay the recovered count',
  (boundary) => {
    const r = rig();
    r.render();
    r.frame.payload.players[0]!.lifeState = 'dead';
    r.render();
    expect(r.panel()).not.toBeNull();
    const payload = structuredClone(r.frame.payload);
    if (boundary === 'round') r.frame.payload.map.roundNumber!++;
    if (boundary === 'source') r.frame.cursor.programSourceGeneration++;
    if (boundary === 'epoch') r.frame.cursor.mapEpoch++;
    if (boundary === 'stale') r.frame.payload.status.telemetry = 'stale';
    if (boundary === 'pause') r.frame.payload.clock!.phase = 'paused';
    if (boundary === 'freeze') r.frame.payload.round!.phase = 'freezetime';
    if (boundary === 'over') r.frame.payload.round!.phase = 'over';
    if (boundary === 'lineup') r.frame.payload.players.pop();
    if (boundary === 'seek') r.reset();
    else r.render();
    expect(r.panel()).toBeNull();
    r.frame.payload = payload;
    r.render();
    expect(r.panel()).toBeNull();
  },
);

it('does not announce losses on initial attachment or incomplete sample recovery', () => {
  const r = rig();
  r.frame.payload.players[0]!.lifeState = 'dead';
  r.render();
  expect(r.panel()).toBeNull();
  r.frame.cursor.programReceiveSequence! += 10;
  r.frame.payload.players[1]!.lifeState = 'dead';
  r.render();
  expect(r.panel()).toBeNull();
});
