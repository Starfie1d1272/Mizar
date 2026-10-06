// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
    '%s bridges the recorded round-counter advance and 336ms HP delay',
    (design) => {
      vi.useFakeTimers();
      const preset = getBuiltinResolvedPreset(
        design === 'current' ? 'builtin:mizar-default-preset' : `builtin:${design}-preset`,
      );
      const node = document.createElement('div');
      root = createRoot(node);
      const widgetId = 'team-ct-rail';
      const placement = preset.layout.widgets[widgetId];
      const render = (snapshot: ProgramSnapshot) =>
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
      const base = getProgramFixture('real-planted')!;
      const target = base.payload.players.find((p) => p.side === 'CT' && p.lifeState === 'alive')!;
      expect(target.state).not.toBeNull();
      // Recorded private Nuke timing: receive 35374/round 14/HP 100, then
      // receive 35375/round 15/exploded/HP 100; damage arrives 336ms later.
      // Public fixture identities are reused only for this synthetic regression.
      const before: ProgramSnapshot = {
        ...base,
        cursor: { ...base.cursor, programReceiveSequence: 35374, runtimeSeq: 35375 },
        payload: {
          ...base.payload,
          map: { ...base.payload.map, roundNumber: 14 },
          round: { phase: 'live', winnerSide: 'unknown' },
          clock: { phase: 'bomb', endsInSeconds: 0 },
          players: base.payload.players.map((p) =>
            p.sourcePlayerId === target.sourcePlayerId
              ? { ...p, state: { ...p.state!, health: 100 } }
              : p,
          ),
          bomb: {
            ...base.payload.bomb!,
            state: 'planted',
            explosion: { ...base.payload.bomb!.explosion!, remainingSeconds: 0 },
          },
          bombDamage: {
            ...base.payload.bombDamage,
            players: base.payload.bombDamage.players.map((p) =>
              p.sourcePlayerId === target.sourcePlayerId && p.status === 'predicted'
                ? { ...p, damage: 77, hpAfter: 23, lethal: false }
                : p,
            ),
          },
        },
      };
      const exploded: ProgramSnapshot = {
        ...before,
        cursor: { ...before.cursor, programReceiveSequence: 35375, runtimeSeq: 35376 },
        payload: {
          ...before.payload,
          map: { ...before.payload.map, roundNumber: 15 },
          round: { phase: 'over', winnerSide: 'T' },
          clock: { phase: 'over', endsInSeconds: null },
          bomb: { ...before.payload.bomb!, state: 'exploded', explosion: null, action: null },
          bombDamage: { status: 'unavailable', reason: 'inactive', model: null, players: [] },
        },
      };
      const card = () =>
        [...node.querySelectorAll('.player-rail__card')].find(
          (p) => p.querySelector('.player-rail__name')?.textContent === target.displayName,
        )!;
      try {
        render(before);
        expect(card().querySelector('[data-bomb-prediction]')).not.toBeNull();
        render(exploded);
        expect(card().querySelector('[data-bomb-prediction]')).toBeNull();
        expect(card().querySelector('[data-bomb-estimate-echo]')).not.toBeNull();
        act(() => {
          vi.advanceTimersByTime(336);
        });
        expect(card().querySelector('[data-bomb-estimate-echo]')).not.toBeNull();
        expect(card().querySelector('[data-health-value]')?.textContent).toBe('100');
        render({
          ...exploded,
          cursor: { ...exploded.cursor, programReceiveSequence: 35382, runtimeSeq: 35383 },
          payload: {
            ...exploded.payload,
            players: exploded.payload.players.map((p) =>
              p.sourcePlayerId === target.sourcePlayerId
                ? { ...p, state: { ...p.state!, health: 22 } }
                : p,
            ),
          },
        });
        expect(card().querySelector('[data-bomb-estimate-echo]')).toBeNull();
        expect(card().querySelector('[data-health-value]')?.textContent).toBe('22');
      } finally {
        act(() => root?.unmount());
        root = undefined;
        vi.useRealTimers();
      }
    },
  );
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
