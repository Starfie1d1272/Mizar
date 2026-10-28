// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProgramSnapshot } from '@mizar/protocol/program';
import { getProgramFixture } from '../src/program/fixtures';
import { ProgramCueEffectProvider } from '../src/program/ProgramCueRendererBridge';
import { FocusedPlayerCard } from '../src/program/widgets/focused-player/FocusedPlayer';
import { buildFocusedPlayerPresentation } from '../src/program/widgets/focused-player/presentation';
import { PlayerCard } from '../src/program/widgets/player-rails/PlayerCard';
import { buildPlayerRailsPresentation } from '../src/program/widgets/player-rails/presentation';

const fixture = getProgramFixture('live-canonical')!;
const playerId = fixture.payload.observedPlayerSourceId!;
const impact = {
  effects: [
    {
      expiresAtMonotonicMs: 1000,
      cue: {
        id: 'impact-1',
        kind: 'player-impact' as const,
        effect: 'he' as const,
        targetSourcePlayerId: playerId,
        attackerSourcePlayerId: null,
        weapon: 'hegrenade',
        damageHealth: 35,
        healthRemaining: 65,
        hitgroup: 0,
        lethal: false,
        mapEpoch: fixture.cursor.mapEpoch,
        source: { generation: 0, sequence: 1, tick: 1 },
      },
    },
  ],
};

afterEach(() => vi.useRealTimers());

it('shows current primary magazine evidence and clears it on equipment and telemetry boundaries', () => {
  const original = fixture.payload.players.find((player) => player.sourcePlayerId === playerId)!;
  const rifle = {
    ...original.weapons[0]!,
    name: 'weapon_ak47',
    state: 'active' as const,
    ammoClip: 15,
    ammoClipMax: 30,
  };
  const present = (weapons = [rifle], overrides: Partial<typeof original> = {}, fresh = true) => {
    const payload = {
      ...fixture.payload,
      status: {
        ...fixture.payload.status,
        telemetry: fresh ? ('fresh' as const) : ('stale' as const),
      },
      players: fixture.payload.players.map((player) =>
        player.sourcePlayerId === playerId
          ? {
              ...player,
              lifeState: 'alive' as const,
              lineupEvidence: 'current' as const,
              weaponsAvailable: true,
              weapons,
              ...overrides,
            }
          : player,
      ),
    };
    const rails = buildPlayerRailsPresentation(payload);
    return [...rails.ct.players, ...rails.t.players].find(
      (player) => player.sourcePlayerId === playerId,
    )!;
  };
  expect(present().primaryWeapon?.clipFill).toBe(0.5);
  expect(present([{ ...rifle, ammoClip: 30 }]).primaryWeapon?.clipFill).toBe(1);
  expect(present([{ ...rifle, ammoClip: 0 }]).primaryWeapon?.clipFill).toBe(0);
  expect(
    present([{ ...rifle, state: 'reloading' as typeof rifle.state }]).primaryWeapon?.clipFill,
  ).toBe(0.5);
  expect(present([{ ...rifle, name: 'weapon_glock' }]).primaryWeapon).toMatchObject({
    active: true,
    clipFill: null,
  });
  expect(
    present([rifle, { ...rifle, sourceWeaponId: 'second' }]).primaryWeapon?.clipFill,
  ).toBeNull();
  expect(present([rifle], { weaponsAvailable: false }).primaryWeapon?.clipFill).toBeNull();
  expect(present([rifle], {}, false).primaryWeapon?.clipFill).toBeNull();
  expect(present([rifle], { lifeState: 'dead' }).primaryWeapon).toBeNull();
  expect(present([{ ...rifle, ammoClipMax: 0 }]).primaryWeapon?.clipFill).toBeNull();
});

it.each(['rail', 'focused'] as const)(
  '%s bounds repeated damage and clears feedback at death, revival and reset',
  (surface) => {
    vi.useFakeTimers();
    const node = document.createElement('div');
    const root = createRoot(node);
    let sequence = 100;
    let revision = 0;
    const render = (health: number, dead = false, effects = false, status = 255) => {
      const snapshot: ProgramSnapshot = {
        ...fixture,
        cursor: { ...fixture.cursor, runtimeSeq: sequence, programReceiveSequence: sequence++ },
        payload: {
          ...fixture.payload,
          players: fixture.payload.players.map((player) =>
            player.sourcePlayerId !== playerId
              ? player
              : {
                  ...player,
                  lifeState: dead ? 'dead' : 'alive',
                  state: {
                    ...player.state!,
                    health,
                    smoked: status,
                    flashed: status,
                    burning: status,
                  },
                },
          ),
        },
      };
      const rail = [
        ...buildPlayerRailsPresentation(snapshot.payload).ct.players,
        ...buildPlayerRailsPresentation(snapshot.payload).t.players,
      ].find((player) => player.sourcePlayerId === playerId)!;
      const focused = buildFocusedPlayerPresentation(snapshot.payload)!;
      act(() =>
        root.render(
          <ProgramCueEffectProvider snapshot={effects ? impact : { effects: [] }}>
            {surface === 'rail' ? (
              <PlayerCard player={rail} cursor={snapshot.cursor} presentationRevision={revision} />
            ) : (
              <FocusedPlayerCard
                player={focused}
                cursor={snapshot.cursor}
                presentationRevision={revision}
              />
            )}
          </ProgramCueEffectProvider>,
        ),
      );
    };
    try {
      render(100);
      render(80);
      expect(node.querySelector('[data-damage-ghost]')).not.toBeNull();
      act(() => {
        vi.advanceTimersByTime(200);
      });
      render(60);
      act(() => {
        vi.advanceTimersByTime(179);
      });
      expect(node.querySelector('[data-damage-ghost]')).not.toBeNull();
      render(50);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(node.querySelector('[data-damage-ghost]')).toBeNull();

      render(40, false, true);
      expect(node.querySelector('[data-player-impact="he"]')).not.toBeNull();
      expect(node.querySelector('[data-smoked="true"]')).not.toBeNull();
      render(0, true, true);
      expect(node.querySelector('[data-damage-ghost]')).toBeNull();
      expect(node.querySelector('[data-player-impact]')).toBeNull();
      expect(node.querySelector('[data-smoked="true"]')).toBeNull();
      expect(node.querySelector('[data-flashed="true"]')).toBeNull();
      expect(node.querySelector('[data-burning="true"]')).toBeNull();

      // A new life receives fresh status truth and a cleared cue stream.
      render(100, false, false, 0);
      expect(node.querySelector('[data-damage-ghost]')).toBeNull();
      expect(node.querySelector('[data-player-impact]')).toBeNull();
      expect(
        node.querySelector('[data-smoked="true"], [data-flashed="true"], [data-burning="true"]'),
      ).toBeNull();
      render(70);
      expect(node.querySelector('[data-damage-ghost]')).not.toBeNull();
      revision++;
      render(50, false, false, 0);
      expect(node.querySelector('[data-damage-ghost]')).toBeNull();
      expect(node.querySelector('[data-combat-transition]')).toBeNull();
      expect(
        node.querySelector('[data-smoked="true"], [data-flashed="true"], [data-burning="true"]'),
      ).toBeNull();
    } finally {
      act(() => root.unmount());
    }
  },
);
