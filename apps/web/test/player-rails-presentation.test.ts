import { describe, expect, it } from 'vitest';

import { getProgramFixture } from '../src/program/fixtures';
import {
  buildPlayerRailsPresentation,
  weaponPresentation,
  lossBonusForConsecutiveRoundLosses,
} from '../src/program/widgets/player-rails/presentation';

function payload() {
  const snapshot = getProgramFixture('player-rails-dead-observed');
  if (snapshot === null) throw new Error('fixture missing');
  return snapshot.payload;
}

describe('Player Rails presentation selector', () => {
  it('maps the frozen loss-bonus tiers and fails closed for invalid values', () => {
    expect([0, 1, 2, 3, 4, 8].map(lossBonusForConsecutiveRoundLosses)).toEqual([
      1_400, 1_900, 2_400, 2_900, 3_400, 3_400,
    ]);
    expect(lossBonusForConsecutiveRoundLosses(null)).toBeNull();
    expect(lossBonusForConsecutiveRoundLosses(-1)).toBeNull();
    expect(lossBonusForConsecutiveRoundLosses(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
  });

  it('sorts by observer slot with source id tie-break and caps each rail at five cards', () => {
    const current = payload();
    const players = current.players.map((player, index) =>
      index === 0 || index === 4
        ? { ...player, observerSlot: null }
        : index === 1
          ? { ...player, observerSlot: 1 }
          : player,
    );
    players.push({ ...players[0]!, sourcePlayerId: 'stress-player-6' });
    const presentation = buildPlayerRailsPresentation({ ...current, players });

    expect(presentation.ct.players.map((player) => player.sourcePlayerId)).toEqual([
      'stress-player-2',
      'stress-player-3',
      'stress-player-4',
      'stress-player-1',
      'stress-player-5',
    ]);
    expect(presentation.ct.players.map((player) => player.observerSlot)).toEqual([
      1,
      3,
      4,
      null,
      null,
    ]);
    expect(presentation.ct.players).toHaveLength(5);
    expect(presentation.t.players).toHaveLength(5);
  });

  it('uses official assets and applies alive/dead phase presentation rules', () => {
    const current = payload();
    const freezetime = buildPlayerRailsPresentation({
      ...current,
      round: { phase: 'freezetime', winnerSide: 'unknown' },
      clock: { phase: 'freezetime', endsInSeconds: 12 },
      players: current.players.map((player) => ({
        ...player,
        currentRoundDamage: 72,
        roundMoneySpent: 1_200,
      })),
    });
    const pistolPlayer = freezetime.ct.players[1];
    expect(freezetime.phase).toBe('freezetime');
    expect(pistolPlayer?.primaryWeapon?.asset).not.toBeNull();
    expect(pistolPlayer?.secondaryWeapon?.asset).not.toBeNull();
    expect(pistolPlayer?.roundMoneySpent).toBe(1_200);

    const live = buildPlayerRailsPresentation(current);
    const livePaired = [...live.ct.players, ...live.t.players].find(
      (player) => player.primaryWeapon !== null && player.secondaryWeapon !== null,
    );
    expect(live.phase).toBe('live');
    expect(livePaired?.secondaryWeapon?.item?.family).toBe('pistol');

    const deadPlayer = freezetime.ct.players[2];
    expect(deadPlayer).toMatchObject({ mode: 'dead', primaryWeapon: null, utility: [] });
    expect(deadPlayer?.currentRoundDamage).toBe(72);
  });

  it('exposes complete five-player team totals and utility only with complete evidence', () => {
    const snapshot = getProgramFixture('player-rails-freezetime');
    if (snapshot === null) throw new Error('fixture missing');
    const presentation = buildPlayerRailsPresentation(snapshot.payload);

    expect(presentation.ct.summary).toMatchObject({
      lineupComplete: true,
      utilityAvailable: true,
      money: 35_550,
      equip: 20_200,
      utility: { smoke: 4, flash: 9 },
    });
  });

  it('counts live utility from alive inventories and fails closed on uncertain live truth', () => {
    const snapshot = getProgramFixture('player-rails-freezetime');
    if (snapshot === null) throw new Error('fixture missing');
    const livePayload = {
      ...structuredClone(snapshot.payload),
      round: { phase: 'live' as const, winnerSide: 'unknown' as const },
      clock: { phase: 'live' as const, endsInSeconds: 90 },
    };
    const baseline = buildPlayerRailsPresentation(livePayload);
    const utility = baseline.ct.summary.utility;
    if (utility === null) throw new Error('live utility baseline missing');
    const carrier = baseline.ct.players.find((player) => player.utility.length > 0);
    if (carrier === undefined) throw new Error('utility carrier missing');

    const expected = { ...utility };
    for (const item of carrier.utility) expected[item.family] -= item.count;

    const deadPayload = structuredClone(livePayload);
    const dead = deadPayload.players.find(
      (player) => player.sourcePlayerId === carrier.sourcePlayerId,
    );
    if (dead === undefined) throw new Error('dead target missing');
    dead.lifeState = 'dead';
    dead.weaponsAvailable = false;
    expect(buildPlayerRailsPresentation(deadPayload).ct.summary.utility).toEqual(expected);

    const unknownPayload = structuredClone(livePayload);
    const unknown = unknownPayload.players.find(
      (player) => player.sourcePlayerId === carrier.sourcePlayerId,
    );
    if (unknown === undefined) throw new Error('unknown target missing');
    unknown.lifeState = 'unknown';
    expect(buildPlayerRailsPresentation(unknownPayload).ct.summary).toMatchObject({
      utility: null,
      utilityAvailable: false,
    });

    const missingAlivePayload = structuredClone(livePayload);
    const missingAlive = missingAlivePayload.players.find(
      (player) => player.side === 'CT' && player.sourcePlayerId !== carrier.sourcePlayerId,
    );
    if (missingAlive === undefined) throw new Error('alive target missing');
    missingAlive.weaponsAvailable = false;
    expect(buildPlayerRailsPresentation(missingAlivePayload).ct.summary).toMatchObject({
      utility: null,
      utilityAvailable: false,
    });
  });

  it('withholds team subtotals until the current five-player lineup is complete', () => {
    const current = payload();
    const incomplete = buildPlayerRailsPresentation({
      ...current,
      players: current.players.filter((player) => player.sourcePlayerId !== 'stress-player-5'),
    });

    expect(incomplete.ct.summary).toMatchObject({
      lineupComplete: false,
      money: null,
      equip: null,
      utility: null,
      utilityAvailable: false,
    });
  });
});

it('preserves observed held/holstered weapon state instead of highlighting the primary slot', () => {
  const weapon = payload().players.flatMap((player) => player.weapons)[0]!;
  expect(weaponPresentation({ ...weapon, name: 'weapon_ak47', state: 'active' }).active).toBe(true);
  expect(weaponPresentation({ ...weapon, name: 'weapon_ak47', state: 'holstered' }).active).toBe(
    false,
  );
  expect(weaponPresentation({ ...weapon, name: 'weapon_ak47', state: null }).active).toBe(false);
});
