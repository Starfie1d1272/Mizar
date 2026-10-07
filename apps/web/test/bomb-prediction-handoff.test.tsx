// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { BombPredictionBar } from '../src/program/widgets/player-rails/BombPredictionBar';

describe('pre-explosion estimate visual handoff', () => {
  it.each(['damage', 'timeout', 'scope', 'stale', 'defused', 'gap', 'round', 'later-gap'] as const)(
    'keeps the last painted area only until %s, without a current prediction',
    (boundary) => {
      vi.useFakeTimers();
      const node = document.createElement('div');
      const root = createRoot(node);
      const prediction = {
        sourcePlayerId: 'p',
        status: 'predicted' as const,
        stance: 'standing' as const,
        damage: 60,
        hpAfter: 40,
        lethal: false,
        modelRevision: 'test',
        assumptions: [],
        unknownInputs: [],
      };
      const render = (
        sequence: number,
        health: number,
        scope: string | null,
        explosionHandoff: boolean,
        active = false,
        roundNumber = 1,
      ) =>
        act(() =>
          root.render(
            <BombPredictionBar
              prediction={active ? prediction : undefined}
              health={health}
              scope={scope}
              sequence={sequence}
              explosionHandoff={explosionHandoff}
              roundNumber={roundNumber}
            />,
          ),
        );
      try {
        render(1, 100, 'map1-round1', false, true);
        expect(node.querySelector('[data-bomb-prediction]')).not.toBeNull();
        render(boundary === 'gap' ? 3 : 2, 100, 'map1-round1', boundary !== 'defused');
        expect(node.querySelector('[data-bomb-prediction]')).toBeNull();
        if (boundary === 'gap' || boundary === 'defused') {
          expect(node.querySelector('[data-bomb-estimate-echo]')).toBeNull();
          return;
        }
        expect(node.querySelector('[data-bomb-estimate-echo]')).not.toBeNull();
        render(3, 100, 'map1-round1', true);
        act(() => {
          vi.advanceTimersByTime(200);
        });
        expect(node.querySelector('[data-bomb-estimate-echo]')).not.toBeNull();
        if (boundary === 'damage') render(4, 40, 'map1-round1', true);
        if (boundary === 'scope') render(4, 100, 'map2-round1', true);
        if (boundary === 'stale') render(4, 100, null, true);
        if (boundary === 'round') render(4, 100, 'map1-round1', true, false, 2);
        if (boundary === 'later-gap') render(5, 100, 'map1-round1', true);
        if (boundary === 'timeout')
          act(() => {
            vi.advanceTimersByTime(300);
          });
        expect(node.querySelector('[data-bomb-estimate-echo]')).toBeNull();
      } finally {
        act(() => root.unmount());
        vi.useRealTimers();
      }
    },
  );
});
