// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { getProgramFixture } from '../src/program/fixtures';
import {
  buildFocusedPlayerPresentation,
  buildReserveAmmoPresentation,
} from '../src/program/widgets/focused-player/presentation';
import { FocusedPlayerCard } from '../src/program/widgets/focused-player/FocusedPlayer';
import { TopScoreBar } from '../src/program/widgets/match-header/TopScoreBar';
import { getBuiltinResolvedPreset, placementToBox } from '@mizar/hud-config';

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
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
  it('separates Shanghai round kills and live ADR and preserves a reported death zero', () => {
    const container = host();
    const player = buildFocusedPlayerPresentation(getProgramFixture('real-live-rich')!.payload)!;
    act(() =>
      root!.render(
        <FocusedPlayerCard
          design="perfectworld"
          player={{ ...player, roundKills: 3, liveAdr: 123, completedAdr: 82 }}
        />,
      ),
    );
    expect(container.querySelector('.shanghai-focus-kills')?.textContent).toBe('3');
    expect(container.querySelector('.focused-player__metrics')?.textContent).toContain('ADR123');
    act(() =>
      root!.render(
        <FocusedPlayerCard
          design="perfectworld"
          player={{ ...player, dead: true, health: null, reportedHealth: 0 }}
        />,
      ),
    );
    expect(container.querySelector('.focused-player__dead-state')?.textContent).toBe('0');
  });
  it('shows a held firearm together with Shanghai ammunition', () => {
    const container = host();
    const player = buildFocusedPlayerPresentation(getProgramFixture('real-live-rich')!.payload)!;
    act(() => root!.render(<FocusedPlayerCard design="perfectworld" player={player} />));
    expect(player.activeItemKind).toBe('firearm');
    {
      expect(
        container
          .querySelector('.focused-player__ammo .shanghai-focus-firearm [data-asset-id]')
          ?.getAttribute('data-asset-id'),
      ).toBe(player.activeItem?.asset?.canonicalKey);
    }
    act(() =>
      root!.render(
        <FocusedPlayerCard
          design="perfectworld"
          player={{
            ...player,
            activeItemKind: 'knife',
            clip: null,
            reserveMagazine: null,
            reserveText: null,
          }}
        />,
      ),
    );
    expect(container.querySelector('.shanghai-focus-firearm')).toBeNull();
    expect(container.querySelector('.focused-player__ammo')?.textContent).toBe('');
  });
  it('uses remaining rather than completed defuse time for Shanghai', () => {
    const container = host();
    const preset = getBuiltinResolvedPreset('builtin:perfectworld-preset');
    const placement = preset.layout.widgets['top-score-bar'];
    const snapshot = getProgramFixture('real-live-rich')!;
    act(() =>
      root!.render(
        <TopScoreBar
          design="perfectworld"
          resolvedPreset={preset}
          placement={placement}
          box={placementToBox('top-score-bar', placement)}
          widgetId="top-score-bar"
          settings={preset.widgets['top-score-bar']}
          snapshot={{
            ...snapshot,
            payload: {
              ...snapshot.payload,
              round: { ...snapshot.payload.round!, phase: 'live' },
              bomb: {
                state: 'defusing',
                sourcePlayerId: null,
                explosion: { remainingSeconds: 20, durationSeconds: 40 },
                action: {
                  kind: 'defuse',
                  sourcePlayerId: null,
                  remainingSeconds: 4,
                  durationSeconds: 5,
                  hasDefuseKit: true,
                },
              },
            },
          }}
        />,
      ),
    );
    expect(container.querySelector<HTMLElement>('.shanghai-action-track i')?.style.width).toBe(
      '80%',
    );
    expect(container.querySelector<HTMLElement>('.shanghai-fuse i')?.style.width).toBe('50%');
  });
});
