// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import type { BpSnapshot } from '@mizar/protocol/bp';
import { BpCompactPresentation } from '../src/bp/BpPresentation';

it('renders only revealed cards and side choices, and clears on disconnect', () => {
  const container = document.createElement('div');
  const root = createRoot(container);
  const snapshot: BpSnapshot = {
    schemaVersion: 'mizar.bp.v2',
    revision: '1',
    state: 'revealing',
    revealedCount: 1,
    projection: {
      competition: 'Fixture',
      stage: 'Fixture',
      format: 'bo3',
      entrants: { a: { name: '队伍甲', logoUrl: null }, b: { name: '队伍乙', logoUrl: null } },
      cards: [
        {
          mapName: 'de_ancient',
          kind: 'pick',
          entrant: 'a',
          sideChoice: { entrant: 'b', side: 'CT' },
        },
        { mapName: 'de_inferno', kind: 'ban', entrant: 'b', sideChoice: null },
      ],
      steps: [
        { cardIndex: 0, kind: 'card' },
        { cardIndex: 0, kind: 'side-choice' },
        { cardIndex: 1, kind: 'card' },
      ],
    },
  };
  // Synthetic pre-reveal rendering proves that no slot carries future information.
  act(() => root.render(<BpCompactPresentation snapshot={{ ...snapshot, revealedCount: 0 }} />));
  const pending = container.querySelectorAll('.bp-compact-card');
  expect(pending).toHaveLength(2);
  for (const slot of pending) {
    expect(slot.textContent).toBe('待揭示');
    expect(slot.outerHTML).not.toMatch(/ancient|inferno|pick|ban|队伍甲|队伍乙|<img/i);
  }
  act(() => root.render(<BpCompactPresentation snapshot={snapshot} />));
  expect(container.textContent).toContain('ANCIENT');
  expect(container.textContent).not.toContain('INFERNO');
  expect(container.querySelector('[data-kind="pending"] img')).toBeNull();
  expect(container.querySelector('[data-kind="pending"]')?.outerHTML).not.toMatch(
    /inferno|ban|队伍乙/i,
  );
  expect(container.textContent).not.toContain('CT');
  act(() => root.render(<BpCompactPresentation snapshot={{ ...snapshot, revealedCount: 2 }} />));
  expect(container.textContent).toContain('CT');
  expect(container.querySelector('.bp-compact-owner small')?.textContent).toContain('队伍乙');
  const unknown = {
    ...snapshot,
    projection: {
      ...snapshot.projection!,
      cards: [
        { ...snapshot.projection!.cards[0]!, mapName: 'de_unknown' },
        snapshot.projection!.cards[1]!,
      ],
    },
  };
  act(() => root.render(<BpCompactPresentation snapshot={unknown} />));
  expect(container.textContent).toContain('地图图片不可用');
  expect(container.textContent).toContain('UNKNOWN');
  act(() => root.render(<BpCompactPresentation snapshot={null} />));
  expect(container.querySelector('.bp-compact')).toBeNull();
  act(() => root.unmount());
});
