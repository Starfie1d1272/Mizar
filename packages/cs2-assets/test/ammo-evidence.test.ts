import { describe, expect, it } from 'vitest';

import { getCs2Item, resolveCs2ItemByGsiName } from '../src/index.js';

// Independent per-item ammo evidence from Valve build 25218825 and live GSI.
const AMMO_EVIDENCE_TABLE = [
  ['weapon.ssg08', 'magazine'],
  ['weapon.mag7', 'magazine'],
  ['weapon.nova', 'shells'],
  ['weapon.xm1014', 'shells'],
  ['weapon.sawedoff', 'shells'],
  ['weapon.m249', 'magazine'],
  ['weapon.negev', 'magazine'],
  ['weapon.knife', 'none'],
  ['utility.flashbang', 'utility'],
  ['utility.hegrenade', 'utility'],
  ['utility.smokegrenade', 'utility'],
  ['utility.molotov', 'utility'],
  ['utility.incgrenade', 'utility'],
  ['objective.c4', 'objective'],
  ['weapon.ak47', 'magazine'],
  ['weapon.m4a1', 'magazine'],
  ['weapon.m4a1-silencer', 'magazine'],
  ['weapon.mp9', 'magazine'],
  ['weapon.awp', 'magazine'],
  ['weapon.glock', 'magazine'],
  ['weapon.usp-silencer', 'magazine'],
  ['weapon.galilar', 'magazine'],
  ['weapon.hkp2000', 'magazine'],
] as const;

describe('@mizar/cs2-assets ammo evidence matrix', () => {
  it('resolves the pinned Valve reserve-magazine HUD graphic without assigning it a GSI weapon identity', () => {
    const magazine = getCs2Item('ammo.magazine');

    expect(magazine).toMatchObject({
      canonicalKey: 'ammo.magazine',
      sourcePath: 'panorama/images/hud/ammo_reserve_magazine.vsvg_c',
      assetId: 'ammo.magazine',
      ammoPresentation: 'magazine',
      gsiWeaponNames: [],
      aliases: [],
    });
    expect(
      magazine?.evidence.some(
        (evidence) =>
          evidence.kind === 'official-game-data' &&
          evidence.reference.includes('2053759441494650084'),
      ),
    ).toBe(true);
  });

  it.each(AMMO_EVIDENCE_TABLE)('%s uses the evidenced %s ammo unit', (canonicalKey, ammo) => {
    const item = getCs2Item(canonicalKey)!;
    expect(item.ammoPresentation).toBe(ammo);
    const live = canonicalKey === 'weapon.hkp2000';
    expect(
      item.evidence.some(
        (evidence) =>
          evidence.kind === (live ? 'live-gsi' : 'official-game-data') &&
          evidence.reference.includes(
            live ? 'packages/telemetry-gsi/test/fixtures/real-derived.ts' : 'Steam build 25218825',
          ),
      ),
    ).toBe(true);
  });

  it('strictly verifies Zeus/Taser: ammoPresentation is none while still carrying official game-data evidence', () => {
    const taser = getCs2Item('utility.taser');
    expect(taser).toBeDefined();
    // Must remain none without fabricated recharge timer
    expect(taser?.ammoPresentation).toBe('none');

    // Despite ammoPresentation = none, Zeus must still explicitly carry official game-data evidence
    const officialData = taser?.evidence.find((e) => e.kind === 'official-game-data');
    expect(officialData).toBeDefined();
    expect(officialData?.reference).toContain('Steam build 25218825');

    const resolution = resolveCs2ItemByGsiName('weapon_taser');
    expect(resolution).toMatchObject({
      kind: 'known',
      item: {
        canonicalKey: 'utility.taser',
        ammoPresentation: 'none',
      },
    });
  });

  it('resolves items by GSI weapon names consistent with the ammo evidence matrix', () => {
    expect(resolveCs2ItemByGsiName('weapon_ssg08')).toMatchObject({
      kind: 'known',
      item: { ammoPresentation: 'magazine' },
    });
    expect(resolveCs2ItemByGsiName('weapon_nova')).toMatchObject({
      kind: 'known',
      item: { ammoPresentation: 'shells' },
    });
    expect(resolveCs2ItemByGsiName('weapon_xm1014')).toMatchObject({
      kind: 'known',
      item: { ammoPresentation: 'shells' },
    });
    expect(resolveCs2ItemByGsiName('weapon_sawedoff')).toMatchObject({
      kind: 'known',
      item: { ammoPresentation: 'shells' },
    });
    expect(resolveCs2ItemByGsiName('weapon_mag7')).toMatchObject({
      kind: 'known',
      item: { ammoPresentation: 'magazine' },
    });
    expect(resolveCs2ItemByGsiName('weapon_m249')).toMatchObject({
      kind: 'known',
      item: { ammoPresentation: 'magazine' },
    });
    expect(resolveCs2ItemByGsiName('weapon_negev')).toMatchObject({
      kind: 'known',
      item: { ammoPresentation: 'magazine' },
    });
    expect(resolveCs2ItemByGsiName('weapon_knife')).toMatchObject({
      kind: 'known',
      item: { ammoPresentation: 'none' },
    });
    expect(resolveCs2ItemByGsiName('weapon_c4')).toMatchObject({
      kind: 'known',
      item: { ammoPresentation: 'objective' },
    });
  });
});
