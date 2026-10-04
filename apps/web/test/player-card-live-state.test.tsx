// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { PlayerCard } from '../src/program/widgets/player-rails/PlayerCard';
import {
  buildPlayerRailsPresentation,
  assetForCanonicalKey,
} from '../src/program/widgets/player-rails/presentation';
import { getProgramFixture } from '../src/program/fixtures';

it.each(['ewc', 'iem', 'perfectworld'] as const)(
  'updates held utility with unchanged inventory in %s',
  (design) => {
    vi.useFakeTimers();
    const player = buildPlayerRailsPresentation(getProgramFixture('real-live-rich')!.payload).left
      .players[0]!;
    const container = document.createElement('div');
    const root = createRoot(container);
    const render = (active: boolean) =>
      act(() =>
        root.render(
          <PlayerCard
            design={design}
            player={{
              ...player,
              utility: [
                {
                  sourceWeaponId: 'smoke',
                  name: 'weapon_smokegrenade',
                  asset: assetForCanonicalKey('utility.smokegrenade'),
                  item: null,
                  ammoReserve: 1,
                  family: 'smoke',
                  count: 1,
                  active,
                },
              ],
            }}
          />,
        ),
      );
    try {
      render(false);
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(
        container
          .querySelector('[data-asset-id="utility.smokegrenade"]')
          ?.getAttribute('data-weapon-active'),
      ).toBe('false');
      render(true);
      expect(
        container
          .querySelector('[data-asset-id="utility.smokegrenade"]')
          ?.getAttribute('data-weapon-active'),
      ).toBe('true');
      expect(
        container
          .querySelector('[data-asset-id="utility.smokegrenade"]')
          ?.closest('[data-motion-phase]')
          ?.getAttribute('data-motion-phase'),
      ).not.toBe('enter');
      render(false);
      expect(
        container
          .querySelector('[data-asset-id="utility.smokegrenade"]')
          ?.getAttribute('data-weapon-active'),
      ).toBe('false');
    } finally {
      act(() => root.unmount());
      vi.useRealTimers();
    }
  },
);

it('shows a new successful rail avatar after a failed URL', () => {
  const player = buildPlayerRailsPresentation(getProgramFixture('real-live-rich')!.payload).left
    .players[0]!;
  const container = document.createElement('div');
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <PlayerCard design="perfectworld" player={{ ...player, avatarUrl: '/failed.png' }} />,
      ),
    );
    act(() => {
      container.querySelector('img')!.dispatchEvent(new Event('error'));
    });
    act(() =>
      root.render(
        <PlayerCard design="perfectworld" player={{ ...player, avatarUrl: '/available.png' }} />,
      ),
    );
    act(() => {
      container.querySelector('img')!.dispatchEvent(new Event('load'));
    });
    expect(container.querySelector('article')?.getAttribute('data-avatar')).toBe('true');
    expect(container.querySelector('img')!.hidden).toBe(false);
  } finally {
    act(() => root.unmount());
  }
});
