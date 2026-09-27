// @vitest-environment jsdom

import { act } from 'react';
import { getCs2Item } from '@mizar/cs2-assets';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getProgramFixture } from '../src/program/fixtures';
import { ProgramCueEffectProvider } from '../src/program/ProgramCueRendererBridge';
import { PlayerCard } from '../src/program/widgets/player-rails/PlayerCard';
import { SUMMARY_HOLD_MS, TeamSummary } from '../src/program/widgets/player-rails/TeamSummary';
import {
  buildPlayerRailsPresentation,
  utilityPresentation,
  type TeamSummaryPresentation,
} from '../src/program/widgets/player-rails/presentation';

const summary = (money: number): TeamSummaryPresentation => ({
  side: 'CT',
  money,
  equip: 10_000,
  lossBonus: 1_400,
  utility: { smoke: 1, fire: 2, flash: 3, he: 4 },
  lineupComplete: true,
  utilityAvailable: true,
});

describe('Player Rails summary lifecycle', () => {
  let root: Root | undefined;

  afterEach(() => {
    if (root !== undefined) {
      act(() => root?.unmount());
      root = undefined;
    }
    vi.useRealTimers();
  });

  it('holds economy for five seconds across live snapshots while keeping utility visible', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<TeamSummary phase="freezetime" side="CT" summary={summary(4_200)} />);
    });
    expect(container.querySelector('[data-summary-visible="true"]')).not.toBeNull();

    act(() => {
      root?.render(<TeamSummary phase="live" side="CT" summary={summary(1_000)} />);
    });
    expect(container.textContent).toContain('$1,000');
    expect(container.textContent).not.toContain('$4,200');
    expect(container.querySelector('[data-summary-visible="true"]')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(SUMMARY_HOLD_MS - 1);
    });
    expect(container.querySelector('[data-summary-visible="true"]')).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector('[data-summary-visible="true"]')).not.toBeNull();
    expect(container.querySelector('[data-summary-mode="utility-only"]')).not.toBeNull();
    expect(container.querySelector('[data-summary-economy-visible="false"]')).not.toBeNull();
    expect(container.querySelector('[data-summary-utility-visible="true"]')).not.toBeNull();
  });

  it('shows utility without economy on a direct live mount', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<TeamSummary phase="live" side="CT" summary={summary(4_200)} />);
    });
    expect(container.querySelector('[data-summary-visible="true"]')).not.toBeNull();
    expect(container.querySelector('[data-summary-mode="utility-only"]')).not.toBeNull();
    expect(container.querySelector('[data-summary-economy-visible="false"]')).not.toBeNull();
    expect(container.querySelector('[data-summary-utility-visible="true"]')).not.toBeNull();
  });

  it('clears economy carryover when the presentation boundary remounts', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<TeamSummary phase="freezetime" side="CT" summary={summary(4_200)} />);
    });
    act(() => {
      root?.render(<TeamSummary phase="live" side="CT" summary={summary(1_000)} />);
    });
    expect(container.querySelector('[data-summary-visible="true"]')).not.toBeNull();

    act(() => {
      root?.render(
        <TeamSummary key="new-boundary" phase="live" side="CT" summary={summary(1_000)} />,
      );
    });
    expect(container.querySelector('[data-summary-visible="true"]')).not.toBeNull();
    expect(container.querySelector('[data-summary-mode="utility-only"]')).not.toBeNull();
    expect(container.querySelector('[data-summary-economy-visible="false"]')).not.toBeNull();
  });

  it('clears economy carryover when an unknown phase interrupts the transition', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<TeamSummary phase="freezetime" side="CT" summary={summary(4_200)} />);
    });
    act(() => {
      root?.render(<TeamSummary phase="live" side="CT" summary={summary(1_000)} />);
    });
    expect(container.querySelector('[data-summary-visible="true"]')).not.toBeNull();

    act(() => {
      root?.render(<TeamSummary phase="unknown" side="CT" summary={summary(900)} />);
    });
    expect(container.querySelector('[data-summary-visible="true"]')).toBeNull();

    act(() => {
      root?.render(<TeamSummary phase="live" side="CT" summary={summary(800)} />);
    });
    expect(container.querySelector('[data-summary-visible="true"]')).not.toBeNull();
    expect(container.querySelector('[data-summary-mode="utility-only"]')).not.toBeNull();
    expect(container.querySelector('[data-summary-economy-visible="false"]')).not.toBeNull();
    expect(container.querySelector('[data-summary-utility-visible="true"]')).not.toBeNull();
  });
});

describe('Player Rails card presentation', () => {
  let root: Root | undefined;

  afterEach(() => {
    if (root !== undefined) {
      act(() => root?.unmount());
      root = undefined;
    }
  });

  it('renders real GSI smoke state across the full player card', () => {
    const snapshot = getProgramFixture('real-live-rich');
    if (snapshot === null) throw new Error('fixture missing');
    const presentation = buildPlayerRailsPresentation(snapshot.payload);
    const smoked = [...presentation.left.players, ...presentation.right.players].find(
      (player) => (player.statusEffects.smoked ?? 0) > 0,
    );
    if (smoked === undefined) throw new Error('real fixture has no smoked player');

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<PlayerCard player={smoked} />);
    });

    expect(container.querySelector('[data-smoked="true"]')).not.toBeNull();
    expect(container.querySelector('.player-status-effects')?.getAttribute('data-anchor')).toBe(
      'left',
    );

    act(() => {
      root?.render(
        <PlayerCard
          player={{
            ...smoked,
            statusEffects: { ...smoked.statusEffects, smoked: 0 },
          }}
        />,
      );
    });
    expect(container.querySelector('.player-status-effects')).not.toBeNull();
    expect(container.querySelector('[data-smoked="false"]')).not.toBeNull();
  });

  it('keeps live armor, kit, and C4 owner equipment visible', () => {
    const snapshot = getProgramFixture('player-rails-dead-observed');
    if (snapshot === null) throw new Error('fixture missing');
    const presentation = buildPlayerRailsPresentation(snapshot.payload);
    const carrier = presentation.ct.players.find(
      (player) => player.sourcePlayerId === 'stress-player-1',
    );
    if (carrier === undefined) throw new Error('carrier missing');

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(
        <>
          <PlayerCard player={carrier} />
          <PlayerCard player={presentation.t.players[0]!} />
        </>,
      );
    });

    expect(container.querySelector('[data-player-equipment="true"]')).not.toBeNull();
    expect(container.querySelector('[data-equipment="armor"] [data-asset-id]')).not.toBeNull();
    expect(container.querySelector('[data-equipment="kit"] [data-asset-id]')).not.toBeNull();
    expect(container.querySelector('[data-equipment="c4"] [data-asset-id]')).not.toBeNull();
  });

  it('gives equipment short exit/enter motion without retaining stale truth', () => {
    vi.useFakeTimers();
    const snapshot = getProgramFixture('player-rails-dead-observed');
    if (snapshot === null) throw new Error('fixture missing');
    const presentation = buildPlayerRailsPresentation(snapshot.payload);
    const carrier = presentation.ct.players.find((player) => player.defuserAsset !== null);
    if (carrier === undefined) throw new Error('kit carrier missing');

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<PlayerCard player={carrier} presentationRevision={0} />);
    });
    expect(container.querySelector('[data-equipment="kit"]')).not.toBeNull();

    act(() => {
      root?.render(
        <PlayerCard
          player={{ ...carrier, defuserAsset: null, hasDefuser: false }}
          presentationRevision={0}
        />,
      );
    });
    expect(
      container.querySelector('[data-equipment="kit"]')?.getAttribute('data-motion-phase'),
    ).toBe('exit');

    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(container.querySelector('[data-equipment="kit"]')).toBeNull();

    act(() => {
      root?.render(<PlayerCard player={carrier} presentationRevision={0} />);
    });
    expect(
      container.querySelector('[data-equipment="kit"]')?.getAttribute('data-motion-phase'),
    ).toBe('enter');

    act(() => {
      vi.advanceTimersByTime(110);
    });
    expect(
      container.querySelector('[data-equipment="kit"]')?.getAttribute('data-motion-phase'),
    ).toBe('steady');
  });

  it('keeps the dead structural row and renders unavailable spent as a single dash', () => {
    const snapshot = getProgramFixture('player-rails-freezetime');
    if (snapshot === null) throw new Error('fixture missing');
    const presentation = buildPlayerRailsPresentation(snapshot.payload);
    const player = presentation.ct.players[0];
    if (player === undefined) throw new Error('player missing');

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<PlayerCard player={{ ...player, roundMoneySpent: null }} />);
    });
    expect(container.querySelector('.player-rail__spent')?.textContent).toBe('—');
    expect(container.querySelector('.player-rail__spent')?.textContent).not.toBe('-—');

    act(() => {
      root?.render(<PlayerCard player={{ ...player, roundMoneySpent: 1_200 }} />);
    });
    expect(container.querySelector('.player-rail__spent')?.textContent).toBe('-$1,200');

    const dead = buildPlayerRailsPresentation(
      getProgramFixture('player-rails-dead-observed')?.payload ?? snapshot.payload,
    ).ct.players.find((candidate) => candidate.mode === 'dead');
    if (dead === undefined) throw new Error('dead player missing');
    act(() => {
      root?.render(<PlayerCard player={dead} />);
    });
    expect(container.querySelector('[data-health-spacer="true"]')).not.toBeNull();
    expect(container.querySelector('.player-rail__dead-stats')).not.toBeNull();
    expect(container.querySelector('[data-player-equipment="true"]')).toBeNull();
  });

  it('keeps KD in the same row for alive and dead players and preserves round kills', () => {
    const snapshot = getProgramFixture('player-rails-freezetime');
    if (snapshot === null) throw new Error('fixture missing');
    const presentation = buildPlayerRailsPresentation(snapshot.payload);
    const player = presentation.ct.players.find((candidate) => candidate.lifeState === 'alive');
    if (player === undefined) throw new Error('alive player missing');
    const alive = { ...player, mode: 'live' as const, roundKills: 0, observerSlot: 0 };
    const dead = {
      ...alive,
      lifeState: 'dead' as const,
      mode: 'dead' as const,
      primaryWeapon: null,
      secondaryWeapon: null,
      utility: [],
      roundKills: 2,
    };

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<PlayerCard player={alive} />);
    });

    const kdBefore = container.querySelector('.player-rail__combat > .player-rail__kd');
    expect(kdBefore).not.toBeNull();
    expect(
      [...container.querySelector('.player-rail__combat')!.children].map((child) =>
        child.getAttribute('data-player-rail-row-part'),
      ),
    ).toEqual(['kd', 'context']);
    expect(container.querySelector('.player-rail__round-kill-slot')).not.toBeNull();
    expect(container.querySelector('.player-rail__round-kill-badge')).toBeNull();
    expect(container.querySelector('[data-card-part="observer-endcap"]')?.textContent).toBe('1');
    expect(
      container.querySelector('[data-card-part="observer-endcap"]')?.getAttribute('aria-label'),
    ).toBe('Observer hotkey 1');

    act(() => {
      root?.render(<PlayerCard player={dead} />);
    });
    expect(container.querySelector('.player-rail__combat > .player-rail__kd')).toBe(kdBefore);
    expect(
      [...container.querySelector('.player-rail__combat')!.children].map((child) =>
        child.getAttribute('data-player-rail-row-part'),
      ),
    ).toEqual(['kd', 'context']);
    expect(container.querySelectorAll('.player-rail__kd')).toHaveLength(1);
    expect(container.querySelector('.player-rail__bottom .player-rail__kd')).toBeNull();
    expect(container.querySelector('[data-dead-stats="true"]')).not.toBeNull();
    expect(container.querySelector('[data-player-equipment="true"]')).toBeNull();
    expect(container.querySelector('.player-rail__death-watermark')).toBeNull();
    expect(container.querySelectorAll('.player-rail__kd svg')).toHaveLength(2);
    expect(
      container.querySelector('[data-round-kill-slot="true"] [data-round-kills="2"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-round-kill-slot="true"] [data-round-kills="2"] circle'),
    ).not.toBeNull();
  });

  it('shows immediate HP truth with a trailing ghost only across continuous samples', () => {
    const snapshot = getProgramFixture('player-rails-freezetime');
    if (snapshot === null) throw new Error('fixture missing');
    const player = buildPlayerRailsPresentation(snapshot.payload).ct.players[0];
    if (player === undefined) throw new Error('player missing');
    const baseCursor = snapshot.cursor;
    const nextCursor = {
      ...baseCursor,
      runtimeSeq: baseCursor.runtimeSeq + 1,
      programReceiveSequence: (baseCursor.programReceiveSequence ?? baseCursor.runtimeSeq) + 1,
    };
    const runtimeOnlyCursor = {
      ...nextCursor,
      runtimeSeq: nextCursor.runtimeSeq + 1,
    };
    const skippedCursor = {
      ...runtimeOnlyCursor,
      runtimeSeq: runtimeOnlyCursor.runtimeSeq + 1,
      programReceiveSequence:
        (runtimeOnlyCursor.programReceiveSequence ?? runtimeOnlyCursor.runtimeSeq) + 2,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <PlayerCard
          cursor={baseCursor}
          player={{ ...player, mode: 'live', health: 100, healthPercent: 100 }}
        />,
      );
    });
    act(() => {
      root?.render(
        <PlayerCard
          cursor={nextCursor}
          player={{ ...player, mode: 'live', health: 61, healthPercent: 61 }}
        />,
      );
    });

    expect(container.querySelector('[data-health-value="true"]')?.textContent).toBe('61');
    const ghost = container.querySelector<HTMLElement>('[data-damage-ghost="true"]');
    expect(ghost?.style.getPropertyValue('--rh-damage-from')).toBe('100%');
    expect(ghost?.style.getPropertyValue('--rh-damage-to')).toBe('61%');

    act(() => {
      root?.render(
        <PlayerCard
          cursor={runtimeOnlyCursor}
          player={{ ...player, mode: 'live', health: 61, healthPercent: 61 }}
        />,
      );
    });
    expect(container.querySelector('[data-damage-ghost="true"]')).not.toBeNull();

    act(() => {
      root?.render(
        <PlayerCard
          cursor={skippedCursor}
          player={{ ...player, mode: 'live', health: 40, healthPercent: 40 }}
        />,
      );
    });
    expect(container.querySelector('[data-health-value="true"]')?.textContent).toBe('40');
    expect(container.querySelector('[data-damage-ghost="true"]')).toBeNull();
  });

  it('clears a pending damage ghost when health is restored in a new life', () => {
    const snapshot = getProgramFixture('player-rails-freezetime');
    if (snapshot === null) throw new Error('fixture missing');
    const player = buildPlayerRailsPresentation(snapshot.payload).ct.players[0];
    if (player === undefined) throw new Error('player missing');
    const baseCursor = snapshot.cursor;
    const damagedCursor = {
      ...baseCursor,
      runtimeSeq: baseCursor.runtimeSeq + 1,
      programReceiveSequence: (baseCursor.programReceiveSequence ?? baseCursor.runtimeSeq) + 1,
    };
    const restoredCursor = {
      ...damagedCursor,
      runtimeSeq: damagedCursor.runtimeSeq + 1,
      programReceiveSequence:
        (damagedCursor.programReceiveSequence ?? damagedCursor.runtimeSeq) + 1,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(
        <PlayerCard
          cursor={baseCursor}
          player={{ ...player, mode: 'live', health: 100, healthPercent: 100 }}
        />,
      );
    });
    act(() => {
      root?.render(
        <PlayerCard
          cursor={damagedCursor}
          player={{ ...player, mode: 'live', health: 45, healthPercent: 45 }}
        />,
      );
    });
    expect(container.querySelector('[data-damage-ghost="true"]')).not.toBeNull();

    act(() => {
      root?.render(
        <PlayerCard
          cursor={restoredCursor}
          player={{ ...player, mode: 'live', health: 100, healthPercent: 100 }}
        />,
      );
    });
    expect(container.querySelector('[data-health-value="true"]')?.textContent).toBe('100');
    expect(container.querySelector('[data-damage-ghost="true"]')).toBeNull();
    expect(container.querySelector('[data-combat-transition]')).toBeNull();
  });

  it('hands continuous lethal damage into a restrained dead state', () => {
    const snapshot = getProgramFixture('player-rails-freezetime');
    if (snapshot === null) throw new Error('fixture missing');
    const player = buildPlayerRailsPresentation(snapshot.payload).ct.players[0];
    if (player === undefined) throw new Error('player missing');
    const baseCursor = snapshot.cursor;
    const nextCursor = {
      ...baseCursor,
      runtimeSeq: baseCursor.runtimeSeq + 1,
      programReceiveSequence: (baseCursor.programReceiveSequence ?? baseCursor.runtimeSeq) + 1,
    };
    const alive = {
      ...player,
      mode: 'live' as const,
      lifeState: 'alive' as const,
      health: 17,
      healthPercent: 17,
    };
    const dead = {
      ...alive,
      mode: 'dead' as const,
      lifeState: 'dead' as const,
      health: null,
      healthPercent: null,
      primaryWeapon: null,
      secondaryWeapon: null,
      utility: [],
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => root?.render(<PlayerCard cursor={baseCursor} player={alive} />));
    act(() => root?.render(<PlayerCard cursor={nextCursor} player={dead} />));

    expect(container.querySelector('[data-life-state-label="dead"]')?.textContent).toBe('DEAD');
    expect(container.querySelector('[data-combat-transition="death"]')).not.toBeNull();
    const ghost = container.querySelector<HTMLElement>('[data-damage-ghost="true"]');
    expect(ghost?.style.getPropertyValue('--rh-damage-from')).toBe('17%');
    expect(ghost?.style.getPropertyValue('--rh-damage-to')).toBe('0%');
  });

  it('renders accepted HE impact cues locally on the targeted player card', () => {
    const snapshot = getProgramFixture('player-rails-freezetime');
    if (snapshot === null) throw new Error('fixture missing');
    const player = buildPlayerRailsPresentation(snapshot.payload).ct.players[0];
    if (player === undefined) throw new Error('player missing');
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const effect = {
      expiresAtMonotonicMs: 1_000,
      cue: {
        id: 'impact-he-test',
        mapEpoch: snapshot.cursor.mapEpoch,
        source: { generation: 1, sequence: 2, tick: 128 },
        kind: 'player-impact' as const,
        effect: 'he' as const,
        targetSourcePlayerId: player.sourcePlayerId,
        attackerSourcePlayerId: null,
        weapon: 'hegrenade',
        damageHealth: 48,
        healthRemaining: 52,
        hitgroup: 0,
        lethal: false,
      },
    };

    act(() => {
      root?.render(
        <ProgramCueEffectProvider snapshot={{ effects: [effect] }}>
          <PlayerCard player={player} />
        </ProgramCueEffectProvider>,
      );
    });

    expect(container.querySelector('[data-player-impact="he"]')).not.toBeNull();
  });

  it('uses contextual weapon visual roles for paired and pistol-only loadouts', () => {
    const snapshot = getProgramFixture('player-rails-freezetime');
    if (snapshot === null) throw new Error('fixture missing');
    const presentation = buildPlayerRailsPresentation(snapshot.payload);
    const player = presentation.ct.players.find(
      (candidate) => candidate.primaryWeapon !== null && candidate.secondaryWeapon !== null,
    );
    if (player?.secondaryWeapon?.item?.family !== 'pistol') {
      throw new Error('freezetime fixture has no paired firearm and pistol');
    }

    const pistolOnly = {
      ...player,
      primaryWeapon: player.secondaryWeapon,
      secondaryWeapon: null,
    };
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<PlayerCard player={player} />);
    });

    expect(
      [...container.querySelectorAll('[data-weapon-visual-role]')].map((icon) =>
        icon.getAttribute('data-weapon-visual-role'),
      ),
    ).toEqual(['primary-firearm', 'secondary-pistol']);

    act(() => {
      root?.render(<PlayerCard player={pistolOnly} />);
    });
    expect(container.querySelector('[data-weapon-visual-role="standalone-pistol"]')).not.toBeNull();
    expect(container.querySelector('[data-weapon-visual-role="primary-firearm"]')).toBeNull();
  });

  it('omits unavailable dead ADR while keeping known damage', () => {
    const snapshot = getProgramFixture('player-rails-dead-observed');
    if (snapshot === null) throw new Error('fixture missing');
    const dead = buildPlayerRailsPresentation(snapshot.payload).ct.players.find(
      (candidate) => candidate.mode === 'dead',
    );
    if (dead === undefined) throw new Error('dead player missing');

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<PlayerCard player={{ ...dead, liveAdr: null }} />);
    });

    expect(container.querySelector('.player-rail__dead-stats')?.textContent).not.toContain('ADR');
    expect(container.querySelector('.player-rail__dead-stats')?.textContent).toContain('DMG96');
  });

  it('uses the official fixed team utility asset set for both side mappings', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<TeamSummary phase="freezetime" side="CT" summary={summary(4_200)} />);
    });

    expect(
      [...container.querySelectorAll('[data-utility] [data-asset-id]')].map((element) => [
        element.parentElement?.getAttribute('data-utility'),
        element.getAttribute('data-asset-id'),
      ]),
    ).toEqual([
      ['smoke', 'utility.smokegrenade'],
      ['flash', 'utility.flashbang'],
      ['he', 'utility.hegrenade'],
      ['fire', 'utility.incgrenade'],
    ]);
  });

  it('keeps decoys out of on-air utility clusters', () => {
    const decoy = getCs2Item('utility.decoy');
    expect(decoy).toBeDefined();
    expect(
      utilityPresentation([
        { sourceWeaponId: 'decoy', name: null, item: decoy!, asset: null, ammoReserve: 1 },
      ]),
    ).toEqual([]);
  });
});
