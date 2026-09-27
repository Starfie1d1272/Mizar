import { describe, expect, it } from 'vitest';
import type { ProgramPayload } from '@mizar/protocol/program';
import { getProgramFixture } from '../src/program/fixtures';
import { buildFocusedPlayerPresentation as build } from '../src/program/widgets/focused-player/presentation';

type Player = ProgramPayload['players'][number];
const base = getProgramFixture('real-live-rich')!.payload;
const observed = base.players.find((p) => p.sourcePlayerId === base.observedPlayerSourceId)!;
function payload(patch: Partial<Player> = {}, other: Partial<ProgramPayload> = {}): ProgramPayload {
  return {
    ...base,
    ...other,
    players: base.players.map((p) =>
      p.sourcePlayerId === observed.sourcePlayerId ? { ...p, ...patch } : p,
    ),
  };
}
function weapon(
  name: string,
  extra: Partial<Player['weapons'][number]> = {},
): Player['weapons'][number] {
  return {
    sourceWeaponId: 'active',
    name,
    paintKit: null,
    type: null,
    ammoClip: 5,
    ammoClipMax: 10,
    ammoReserve: 3,
    state: 'active',
    ...extra,
  };
}
describe('Focused current POV contract (real base, explicit synthetic evidence edges)', () => {
  it('uses exact current observed identity and stable completed ADR', () => {
    expect(build(base)?.sourcePlayerId).toBe(observed.sourcePlayerId);
    expect(build(payload({ completedAdr: 80.2, liveAdr: 200 }))?.completedAdr).toBe(80.2);
    expect(build(payload({ completedAdr: null }))?.completedAdr).toBeNull();
    expect(build({ ...base, observedPlayerSourceId: null })).toBeNull();
    expect(build({ ...base, observedPlayerSourceId: 'missing' })).toBeNull();
    expect(build({ ...base, players: [...base.players, observed] })).toBeNull();
  });
  it.each([{ lineupEvidence: 'retained' }, { state: null }, { lifeState: 'unknown' }] as const)(
    'hides unavailable combat evidence %j',
    (patch) => expect(build(payload(patch))).toBeNull(),
  );
  it('uses canonical team, neutral side, independent stats and PLAYER label', () => {
    const p = build(
      payload({
        displayName: null,
        matchStats: { ...observed.matchStats!, kills: null, assists: 4, deaths: 11 },
      }),
    )!;
    expect(p.displayName).toBe('PLAYER');
    expect(p.stats).toEqual({ kills: null, assists: 4, deaths: 11 });
    expect(p.teamName).toBe(base.teams.ct.name);
    expect(
      build({
        ...base,
        teams: {
          ...base.teams,
          ct: {
            ...base.teams.ct,
            mode: 'neutral',
            name: 'CT',
            logoUrl: null,
            entryId: null,
            seriesScore: null,
          },
        },
      })?.teamName,
    ).toBe('CT');
  });
  it.each([
    ['weapon_m4a1_silencer', 'magazine', null],
    ['weapon_mag7', 'magazine', null],
    ['weapon_nova', null, 'SHELL 3'],
  ] as const)('consumes metadata for %s', (name, reserveMagazine, reserveText) => {
    const p = build(payload({ weapons: [weapon(name)] }))!;
    expect(p.reserveMagazine?.count ?? null).toBe(reserveMagazine === 'magazine' ? 3 : null);
    expect(p.reserveMagazine?.asset.canonicalKey ?? null).toBe(
      reserveMagazine === 'magazine' ? 'ammo.magazine' : null,
    );
    expect(p.reserveText).toBe(reserveText);
    expect(p.clip).toBe(5);
    expect(p.clipFill).toBe(0.5);
  });
  it('preserves real magazine reserve, does not synthesize missing ammo evidence', () => {
    expect(build(base)?.reserveMagazine).toMatchObject({
      count: 3,
      asset: { canonicalKey: 'ammo.magazine' },
    });
    expect(
      build(
        payload({ weapons: [weapon('weapon_ak47', { ammoClipMax: null, ammoReserve: null })] }),
      ),
    ).toMatchObject({
      clip: 5,
      clipFill: null,
      reserveText: null,
      reserveMagazine: null,
    });
  });
  it.each(['weapon_knife', 'weapon_flashbang', 'weapon_taser'])(
    'shows %s without numeric ammo',
    (name) => {
      const p = build(payload({ weapons: [weapon(name)] }))!;
      expect(p.activeItem).not.toBeNull();
      expect(p.clip).toBeNull();
      expect(p.reserveText).toBeNull();
    },
  );
  it('shares flash counts, Zeus and kit classification', () => {
    const p = build(
      payload({
        state: { ...observed.state!, hasDefuser: true },
        weapons: [
          weapon('weapon_flashbang', { ammoReserve: 2 }),
          weapon('weapon_taser', { sourceWeaponId: 'taser', state: 'holstered' }),
        ],
      }),
    )!;
    expect(p.utility[0]?.count).toBe(2);
    expect(p.zeus?.item?.canonicalKey).toBe('utility.taser');
    expect(p.kit?.canonicalKey).toBe('equipment.defuse-kit');
  });
  it.each(['carried', 'planting'] as const)('uses bomb ownership for C4 %s', (state) => {
    const p = payload(
      { weapons: [weapon('weapon_c4')] },
      { bomb: { state, sourcePlayerId: observed.sourcePlayerId, explosion: null, action: null } },
    );
    expect(build(p)?.c4?.canonicalKey).toBe('objective.c4');
    expect(build(p)?.activeItem?.item?.canonicalKey).toBe('objective.c4');
    expect(build({ ...p, bomb: null })).toMatchObject({ c4: null, activeItem: null });
  });
  it.each(
    [
      [],
      [weapon('weapon_ak47', { state: 'holstered' })],
      [weapon('weapon_ak47'), weapon('weapon_nova')],
      [weapon('weapon_future')],
    ].map((weapons) => ({ weapons })),
  )('never falls back to loadout for unavailable/ambiguous active item', ({ weapons }) => {
    expect(build(payload({ weapons }))?.activeItem).toBeNull();
  });
  it('dead card clears every combat fact but retains identity and stats', () => {
    expect(build(payload({ lifeState: 'dead' }))).toMatchObject({
      dead: true,
      health: null,
      armor: null,
      activeItem: null,
      clip: null,
      utility: [],
      kit: null,
      c4: null,
      sourcePlayerId: observed.sourcePlayerId,
    });
  });
  it.each([
    [true, 'equipment.armor-helmet'],
    [false, 'equipment.armor'],
    [null, undefined],
  ] as const)('uses current helmet evidence %s', (hasHelmet, key) => {
    expect(
      build(payload({ state: { ...observed.state!, health: 20, armor: 70, hasHelmet } }))
        ?.armorAsset?.canonicalKey,
    ).toBe(key);
  });
  it('does not show zero armor or unavailable weapons', () => {
    expect(
      build(payload({ state: { ...observed.state!, armor: 0 }, weaponsAvailable: false })),
    ).toMatchObject({ armorAsset: null, activeItem: null, utility: [] });
  });
});
