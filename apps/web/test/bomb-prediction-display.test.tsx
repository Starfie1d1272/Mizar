// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { getBuiltinResolvedPreset, placementToBox } from '@mizar/hud-config';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import { getProgramFixture } from '../src/program/fixtures';
import { PlayerRail } from '../src/program/widgets/player-rails/PlayerRail';

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});

describe('C4 prediction display window', () => {
  it.each(['current', 'ewc', 'iem', 'perfectworld', 'esl'] as const)(
    '%s waits for the final ten explosion seconds, including during defuse',
    (design) => {
      const preset = getBuiltinResolvedPreset(
        design === 'current' ? 'builtin:mizar-default-preset' : `builtin:${design}-preset`,
      );
      const node = document.createElement('div');
      root = createRoot(node);
      const widgetId = 'team-ct-rail';
      const placement = preset.layout.widgets[widgetId];
      const render = (snapshot: ProgramSnapshot) => {
        act(() =>
          root!.render(
            <PlayerRail
              snapshot={snapshot}
              resolvedPreset={preset}
              design={design}
              widgetId={widgetId}
              placement={placement}
              box={placementToBox(widgetId, placement)}
              settings={preset.widgets[widgetId]}
            />,
          ),
        );
      };
      for (const id of ['real-planted', 'real-defusing']) {
        const base = getProgramFixture(id)!;
        expect(base.payload.bombDamage.status).toBe('available');
        // Defuse has its own five-second clock; the explosion clock owns this window.
        render(base);
        expect(node.querySelector('[data-bomb-prediction]')).toBeNull();
        for (const seconds of [10.001, 10, 9.999, 0.001, 0, -1, null, NaN]) {
          const snapshot = {
            ...base,
            payload: {
              ...base.payload,
              bomb: {
                ...base.payload.bomb!,
                explosion: { ...base.payload.bomb!.explosion!, remainingSeconds: seconds },
              },
            },
          };
          render(snapshot);
          expect(
            node.querySelectorAll('[data-bomb-prediction]').length > 0,
            `${id}: ${seconds} explosion seconds`,
          ).toBe(seconds !== null && seconds >= 0 && seconds <= 10);
          const visible = node.querySelector('[data-health-value]')?.textContent;
          for (const payload of [
            {
              ...snapshot.payload,
              status: { ...snapshot.payload.status, telemetry: 'stale' as const },
            },
            { ...snapshot.payload, clock: { phase: 'paused' as const, endsInSeconds: 8 } },
            { ...snapshot.payload, round: { phase: 'over' as const, winnerSide: 'T' as const } },
            { ...snapshot.payload, bomb: { ...snapshot.payload.bomb, state: 'defused' as const } },
            { ...snapshot.payload, bomb: { ...snapshot.payload.bomb, explosion: null } },
          ]) {
            render({ ...snapshot, payload });
            expect(node.querySelector('[data-bomb-prediction]')).toBeNull();
            expect(node.querySelector('[data-health-value]')?.textContent).toBe(visible);
          }
        }
      }
    },
  );
});
