// @vitest-environment jsdom

import { act } from 'react';
import { playerRailSettingsSchema } from '@mizar/hud-config';
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

  it.each(['current', 'ewc', 'iem', 'esl', 'perfectworld'] as const)(
    '%s shares low-armor semantics and clears unavailable/dead state',
    (design) => {
      const snapshot = structuredClone(getProgramFixture('real-live-rich')!);
      const source = snapshot.payload.players[0]!;
      source.lifeState = 'alive';
      source.lineupEvidence = 'current';
      snapshot.payload.status.telemetry = 'fresh';
      const container = document.createElement('div');
      root = createRoot(container);
      const render = (armor: number | null, helmet = false) => {
        source.state = { ...source.state!, armor, hasHelmet: helmet };
        const player = buildPlayerRailsPresentation(snapshot.payload).ct.players.find(
          (p) => p.sourcePlayerId === source.sourcePlayerId,
        )!;
        act(() => root!.render(<PlayerCard design={design} player={player} />));
        return player;
      };
      for (const armor of [100, 26, 0, null]) {
        expect(render(armor).lowArmor).toBeNull();
        expect(container.querySelector('.player-rail__low-armor')).toBeNull();
      }
      for (const armor of [25, 7, 1]) {
        expect(render(armor, true).armorAsset?.canonicalKey).toBe('equipment.armor-helmet');
        expect(container.querySelector('.player-rail__low-armor')?.textContent).toBe(String(armor));
      }
      source.lifeState = 'dead';
      expect(render(7).lowArmor).toBeNull();
      expect(container.querySelector('.player-rail__low-armor')).toBeNull();
      source.lifeState = 'unknown';
      expect(render(7).lowArmor).toBeNull();
      source.lifeState = 'alive';
      snapshot.payload.status.telemetry = 'stale';
      expect(render(7).lowArmor).toBeNull();
    },
  );
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

  it.each(['ewc', 'perfectworld'] as const)(
    '%s renders the estimate separately from HP and removes it when disabled or unavailable',
    (design) => {
      const fixture = getProgramFixture('real-planted')!;
      const players = buildPlayerRailsPresentation(fixture.payload);
      const player = [...players.left.players, ...players.right.players].find(
        (p) => p.mode !== 'dead',
      )!;
      const container = document.createElement('div');
      root = createRoot(container);
      const prediction = {
        status: 'predicted' as const,
        sourcePlayerId: player.sourcePlayerId,
        stance: 'standing' as const,
        damage: 255,
        hpAfter: 0,
        lethal: true,
        modelRevision: 'test',
        assumptions: ['standing'],
        unknownInputs: ['collision'],
      };
      act(() =>
        root?.render(<PlayerCard design={design} player={player} prediction={prediction} />),
      );
      expect(container.querySelector('[data-bomb-prediction="lethal"]')).not.toBeNull();
      expect(container.querySelector('[data-health-value]')?.textContent).toBe(
        String(player.health),
      );
      expect(container.querySelector('[data-life-state-label="dead"]')).toBeNull();
      act(() =>
        root?.render(
          <PlayerCard
            design={design}
            player={player}
            prediction={prediction}
            options={playerRailSettingsSchema.parse({ showBombPrediction: false })}
          />,
        ),
      );
      expect(container.querySelector('[data-bomb-prediction]')).toBeNull();
      act(() => root?.render(<PlayerCard design={design} player={player} />));
      expect(container.querySelector('[data-bomb-prediction]')).toBeNull();
    },
  );

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
    expect(ghost).not.toBeNull();

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
