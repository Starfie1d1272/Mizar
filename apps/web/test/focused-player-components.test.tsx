// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getProgramFixture } from '../src/program/fixtures';
import {
  buildFocusedPlayerPresentation,
  buildReserveAmmoPresentation,
} from '../src/program/widgets/focused-player/presentation';
import { FocusedPlayerCard } from '../src/program/widgets/focused-player/FocusedPlayer';
import { TopScoreBar } from '../src/program/widgets/match-header/TopScoreBar';
import { getBuiltinResolvedPreset, placementToBox } from '@mizar/hud-config';

const BUILTIN_RESOLVED_PRESET = getBuiltinResolvedPreset();
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  vi.useRealTimers();
});
function host() {
  const container = document.createElement('div');
  root = createRoot(container);
  return container;
}
describe('Focused media and combat presentation lifecycle', () => {
  it('loads optional media, hides failed image without retry, resets on player/URL/boundary', () => {
    const container = host();
    const player = {
      ...buildFocusedPlayerPresentation(getProgramFixture('focused-avatar')!.payload)!,
      observerSlot: 9,
    };
    const render = (p = player, key = 'boundary') => {
      act(() => {
        root!.render(<FocusedPlayerCard key={key} player={p} />);
      });
    };
    render();
    const media = () => container.querySelector<HTMLImageElement>('.focused-player__media img');
    expect(container.querySelector('[data-avatar="true"]')).toBeNull();
    expect(container.querySelector('.focused-player__observer-tile-number')?.textContent).toBe('0');
    expect(container.querySelector('.focused-player__media')?.getAttribute('aria-label')).toBe(
      'Observer hotkey 0',
    );
    act(() => {
      media()!.dispatchEvent(new Event('load'));
    });
    expect(container.querySelector('[data-avatar="true"]')).not.toBeNull();
    expect(container.querySelector('.focused-player__slot-badge')?.textContent).toBe('0');
    expect(container.querySelector('.focused-player__media')?.getAttribute('aria-label')).toBe(
      `${player.displayName} avatar, observer hotkey 0`,
    );
    act(() => {
      media()!.dispatchEvent(new Event('error'));
    });
    expect(media()).toBeNull();
    render();
    expect(media()).toBeNull();
    render({ ...player, sourcePlayerId: 'next' });
    expect(media()).not.toBeNull();
    act(() => {
      media()!.dispatchEvent(new Event('error'));
    });
    render({ ...player, sourcePlayerId: 'next', avatarUrl: `${player.avatarUrl}#new` });
    expect(media()).not.toBeNull();
    act(() => {
      media()!.dispatchEvent(new Event('error'));
    });
    render(player, 'new-boundary');
    expect(media()).not.toBeNull();
    render({ ...player, avatarUrl: null });
    expect(media()).toBeNull();
  });
  it('renders status effects across the focused player surface', () => {
    const container = host();
    const player = buildFocusedPlayerPresentation(getProgramFixture('real-live-rich')!.payload)!;
    act(() =>
      root!.render(
        <FocusedPlayerCard
          player={{
            ...player,
            statusEffects: { smoked: 255, burning: 0, flashed: 0 },
          }}
        />,
      ),
    );
    expect(container.querySelector('[data-smoked="true"]')).not.toBeNull();
    expect(container.querySelector('.player-status-effects')?.getAttribute('data-anchor')).toBe(
      'left',
    );
  });
  it('keeps the fixed avatar slot while removing team identity duplication', () => {
    const container = host();
    const player = buildFocusedPlayerPresentation(getProgramFixture('focused-long-name')!.payload)!;
    act(() => root!.render(<FocusedPlayerCard player={player} />));
    expect(container.querySelector('[data-avatar-slot="true"]')).not.toBeNull();
    expect(container.querySelector('.focused-player__team-logo')).toBeNull();
    expect(container.textContent).not.toContain(player.teamName);
    expect(container.textContent).toContain(player.displayName);
  });
  it('clears weapon/ammo on missing evidence or death without retaining old icon', () => {
    const container = host();
    const player = buildFocusedPlayerPresentation(getProgramFixture('real-live-rich')!.payload)!;
    act(() => root!.render(<FocusedPlayerCard player={player} />));
    expect(player.reserveMagazine).toMatchObject({
      count: 3,
      asset: { canonicalKey: 'ammo.magazine' },
    });
    expect(container.querySelector('[data-ammo-presentation="magazine"]')?.textContent).toBe('3');
    expect(container.querySelector('.focused-player__reserve-magazine-icon')).not.toBeNull();
    expect(container.textContent).not.toContain('MAG');
    act(() =>
      root!.render(
        <FocusedPlayerCard
          player={{
            ...player,
            activeItem: null,
            clip: null,
            clipFill: null,
            reserveText: null,
            reserveMagazine: null,
          }}
        />,
      ),
    );
    expect(container.querySelector('.focused-player__active [data-asset-id]')).toBeNull();
    expect(container.querySelector('.focused-player__reserve-magazine-icon')).toBeNull();
    expect(container.textContent).not.toContain('MAG');
    act(() => root!.render(<FocusedPlayerCard player={{ ...player, dead: true }} />));
    expect(container.textContent).toContain('DEAD');
    expect(container.querySelector('.focused-player__dead-state')).not.toBeNull();
    expect(container.querySelector('.focused-player__death-mark')).toBeNull();
    expect(container.querySelector('.focused-player__active')).toBeNull();
    expect(container.querySelector('.focused-player__ammo')).toBeNull();
    expect(container.querySelector('.focused-player__utility')).toBeNull();
    expect(container.querySelector('.focused-player__vitals')?.textContent).toBe('');
  });
  it('shows a trailing damage ghost for continuous focused-player HP loss', () => {
    const container = host();
    const snapshot = getProgramFixture('real-live-rich')!;
    const player = buildFocusedPlayerPresentation(snapshot.payload)!;
    const baseCursor = snapshot.cursor;
    const nextCursor = {
      ...baseCursor,
      runtimeSeq: baseCursor.runtimeSeq + 1,
      programReceiveSequence: (baseCursor.programReceiveSequence ?? baseCursor.runtimeSeq) + 1,
    };

    act(() =>
      root!.render(
        <FocusedPlayerCard
          cursor={baseCursor}
          player={{ ...player, health: 100, healthFill: 100 }}
        />,
      ),
    );
    act(() =>
      root!.render(
        <FocusedPlayerCard
          cursor={nextCursor}
          player={{ ...player, health: 38, healthFill: 38 }}
        />,
      ),
    );

    expect(container.querySelector('.focused-player__hp')?.textContent).toBe('38');
    const ghost = container.querySelector<HTMLElement>('[data-damage-ghost="true"]');
    expect(ghost?.style.getPropertyValue('--rh-damage-from')).toBe('100%');
    expect(ghost?.style.getPropertyValue('--rh-damage-to')).toBe('38%');
  });

  it('keeps shell and reserve-round counts textual and fails closed without the magazine icon', () => {
    const magazineAsset = { canonicalKey: 'ammo.magazine', outputPath: '/unused.svg' };
    expect(buildReserveAmmoPresentation('shells', 12, magazineAsset)).toEqual({
      reserveText: 'SHELL 12',
      reserveMagazine: null,
    });
    expect(buildReserveAmmoPresentation('reserve-rounds', 42, magazineAsset)).toEqual({
      reserveText: 'RDS 42',
      reserveMagazine: null,
    });
    expect(buildReserveAmmoPresentation('magazine', 3, null)).toEqual({
      reserveText: null,
      reserveMagazine: null,
    });
    expect(buildReserveAmmoPresentation('charge', 1, magazineAsset)).toEqual({
      reserveText: null,
      reserveMagazine: null,
    });
  });
  it('renders completed ADR and partial KAD independently', () => {
    const container = host();
    const player = buildFocusedPlayerPresentation(getProgramFixture('real-live-rich')!.payload)!;
    act(() =>
      root!.render(
        <FocusedPlayerCard
          player={{
            ...player,
            completedAdr: 82.25,
            stats: { kills: null, assists: 4, deaths: 11 },
          }}
        />,
      ),
    );
    expect(container.querySelector('.focused-player__metrics')?.textContent).toBe('K—A4D11ADR82.3');
  });
  it('keeps timeout exit motion presentation-local and clears it on a new revision', () => {
    vi.useFakeTimers();
    const container = host();
    const placement = BUILTIN_RESOLVED_PRESET.layout.widgets['top-score-bar'];
    const common = {
      resolvedPreset: BUILTIN_RESOLVED_PRESET,
      widgetId: 'top-score-bar' as const,
      placement,
      box: placementToBox('top-score-bar', placement),
      settings: BUILTIN_RESOLVED_PRESET.widgets['top-score-bar'],
    };
    const timeout = getProgramFixture('real-timeout-ct')!;
    const live = getProgramFixture('real-live-rich')!;

    act(() => {
      root!.render(<TopScoreBar {...common} snapshot={timeout} presentationRevision={0} />);
    });
    expect(container.querySelector('[data-timeout-panel="true"]')).not.toBeNull();

    act(() => {
      root!.render(<TopScoreBar {...common} snapshot={live} presentationRevision={0} />);
    });
    expect(
      container.querySelector('[data-timeout-panel="true"]')?.getAttribute('data-motion-phase'),
    ).toBe('exit');

    act(() => {
      vi.advanceTimersByTime(160);
    });
    expect(container.querySelector('[data-timeout-panel="true"]')).toBeNull();

    act(() => {
      root!.render(<TopScoreBar {...common} snapshot={timeout} presentationRevision={0} />);
    });
    act(() => {
      root!.render(<TopScoreBar {...common} snapshot={live} presentationRevision={1} />);
    });
    expect(container.querySelector('[data-timeout-panel="true"]')).toBeNull();
  });

  it('maps plant samples to four code steps, clears on seek and keeps fuse centered', () => {
    const container = host();
    const base = getProgramFixture('real-planting')!;
    const placement = BUILTIN_RESOLVED_PRESET.layout.widgets['top-score-bar'];
    const render = (snapshot = base, revision = 0) =>
      act(() =>
        root!.render(
          <TopScoreBar
            design="arena"
            snapshot={snapshot}
            resolvedPreset={BUILTIN_RESOLVED_PRESET}
            widgetId="top-score-bar"
            placement={placement}
            box={placementToBox('top-score-bar', placement)}
            settings={BUILTIN_RESOLVED_PRESET.widgets['top-score-bar']}
            presentationRevision={revision}
          />,
        ),
      );
    for (const [progress, steps] of [
      [0, 1],
      [0.3, 2],
      [0.55, 3],
      [0.8, 4],
    ] as const) {
      render({
        ...base,
        payload: {
          ...base.payload,
          bomb: {
            ...base.payload.bomb!,
            state: 'planting',
            action: {
              ...base.payload.bomb!.action!,
              kind: 'plant',
              durationSeconds: 4,
              remainingSeconds: 4 * (1 - progress),
            },
          },
        },
      });
      expect(
        container.querySelectorAll('.objective-center__code [data-filled="true"]'),
      ).toHaveLength(steps);
      expect(
        container.querySelector('.objective-center')?.getAttribute('data-objective-mode'),
      ).toBe('planting');
    }
    render(base, 1);
    expect(
      container.querySelector('.objective-center')?.getAttribute('data-planted-transition'),
    ).toBe('false');
    render(
      { ...base, payload: { ...base.payload, bomb: { ...base.payload.bomb!, action: null } } },
      2,
    );
    expect(container.querySelector('.objective-center__code')).toBeNull();
    const planted = getProgramFixture('real-planted')!;
    for (const remainingSeconds of [40, 20, 5]) {
      render({
        ...planted,
        payload: {
          ...planted.payload,
          bomb: {
            ...planted.payload.bomb!,
            explosion: {
              ...planted.payload.bomb!.explosion!,
              durationSeconds: 40,
              remainingSeconds,
            },
          },
        },
      });
      expect(
        container.querySelectorAll('.objective-center__code [data-filled="true"]'),
      ).toHaveLength(4);
      const fill = container.querySelector<HTMLElement>('[data-fuse-value]')!;
      expect(fill.style.left).toBe('50%');
      expect(fill.style.transform).toBe('translateX(-50%)');
      expect(fill.style.width).toBe(`${(remainingSeconds / 40) * 100}%`);
    }
  });

  it.each(['current', 'arena', 'studio'] as const)(
    '%s objective never invents seconds or action progress',
    (design) => {
      const container = host();
      for (const id of [
        'real-planting',
        'real-planted',
        'real-defusing',
        'objective-dual-progress-edge',
      ]) {
        const snapshot = getProgramFixture(id)!;
        const placement = BUILTIN_RESOLVED_PRESET.layout.widgets['top-score-bar'];
        act(() =>
          root!.render(
            <TopScoreBar
              design={design}
              snapshot={snapshot}
              resolvedPreset={BUILTIN_RESOLVED_PRESET}
              widgetId="top-score-bar"
              placement={placement}
              box={placementToBox('top-score-bar', placement)}
              settings={BUILTIN_RESOLVED_PRESET.widgets['top-score-bar']}
            />,
          ),
        );
        expect(container.querySelector('.objective-center')?.textContent).not.toMatch(
          /\d+\.\d|\d+s/,
        );
        const mode = container
          .querySelector('.objective-center')
          ?.getAttribute('data-objective-mode');
        expect(container.querySelector('.objective-center')?.textContent).not.toMatch(
          /[\u4e00-\u9fff]/,
        );
        expect(container.querySelector('.objective-center__readout')).toBeNull();
        if (mode === 'planting' || mode === 'defusing') {
          expect(container.querySelectorAll('[data-objective-track="action"]')).toHaveLength(1);
        }
      }
    },
  );
});
