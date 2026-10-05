// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { getBuiltinResolvedPreset, placementToBox } from '@mizar/hud-config';
import { getProgramFixture } from '../src/program/fixtures';
import { TopScoreBar } from '../src/program/widgets/match-header/TopScoreBar';

it.each([
  'builtin:mizar-default-preset',
  'builtin:ewc-preset',
  'builtin:iem-preset',
  'builtin:esl-preset',
  'builtin:perfectworld-preset',
])('%s shows a shared GG cue without moving team scores, and clears it immediately', (id) => {
  const preset = getBuiltinResolvedPreset(id);
  const placement = preset.layout.widgets['top-score-bar'];
  const node = document.createElement('div');
  const root = createRoot(node);
  const snapshot = getProgramFixture('gameplay-map-ended-gg')!;
  const props = {
    snapshot,
    resolvedPreset: preset,
    widgetId: 'top-score-bar' as const,
    placement,
    box: placementToBox('top-score-bar', placement),
    settings: preset.widgets['top-score-bar'],
  };
  try {
    act(() => root.render(<TopScoreBar {...props} gg />));
    expect(node.querySelector('[data-map-end-gg]')?.textContent).toBe('GG');
    const teams = node.querySelectorAll('[data-team]');
    expect(teams).toHaveLength(2);
    const text = Array.from(teams, (team) => team.textContent);
    act(() => root.render(<TopScoreBar {...props} gg={false} />));
    expect(node.querySelector('[data-map-end-gg]')).toBeNull();
    expect(Array.from(node.querySelectorAll('[data-team]'), (team) => team.textContent)).toEqual(
      text,
    );
  } finally {
    act(() => root.unmount());
  }
});
