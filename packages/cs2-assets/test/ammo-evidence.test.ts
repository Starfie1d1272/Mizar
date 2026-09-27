import { describe, expect, it } from 'vitest';

import { CS2_ITEM_CATALOG, getCs2Item, resolveCs2ItemByGsiName } from '../src/index.js';

interface AmmoEvidenceCase {
  readonly canonicalKey: string;
  readonly expectedAmmo: string;
  readonly requiredEvidenceKind: 'live-gsi' | 'official-game-data';
  readonly expectedReferenceFragment: string;
}

const AMMO_EVIDENCE_TABLE: readonly AmmoEvidenceCase[] = [
  // Sniper with reserve clips (m_bReserveAmmoAsClips = true)
  {
    canonicalKey: 'weapon.ssg08',
    expectedAmmo: 'magazine',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  // Shotguns: MAG-7 has clip reload; Nova, XM1014, Sawed-off reload per shell
  {
    canonicalKey: 'weapon.mag7',
    expectedAmmo: 'magazine',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'weapon.nova',
    expectedAmmo: 'shells',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'weapon.xm1014',
    expectedAmmo: 'shells',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'weapon.sawedoff',
    expectedAmmo: 'shells',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  // Machine guns: M249 and Negev both reserve clips (m_bReserveAmmoAsClips = true)
  {
    canonicalKey: 'weapon.m249',
    expectedAmmo: 'magazine',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'weapon.negev',
    expectedAmmo: 'magazine',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  // Melee
  {
    canonicalKey: 'weapon.knife',
    expectedAmmo: 'none',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  // Utility grenades
  {
    canonicalKey: 'utility.flashbang',
    expectedAmmo: 'utility',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'utility.hegrenade',
    expectedAmmo: 'utility',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'utility.smokegrenade',
    expectedAmmo: 'utility',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'utility.molotov',
    expectedAmmo: 'utility',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'utility.incgrenade',
    expectedAmmo: 'utility',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  // Objective
  {
    canonicalKey: 'objective.c4',
    expectedAmmo: 'objective',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  // Rifles and standard firearms
  {
    canonicalKey: 'weapon.ak47',
    expectedAmmo: 'magazine',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'weapon.m4a1',
    expectedAmmo: 'magazine',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'weapon.m4a1-silencer',
    expectedAmmo: 'magazine',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'weapon.mp9',
    expectedAmmo: 'magazine',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'weapon.awp',
    expectedAmmo: 'magazine',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'weapon.glock',
    expectedAmmo: 'magazine',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'weapon.usp-silencer',
    expectedAmmo: 'magazine',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  {
    canonicalKey: 'weapon.galilar',
    expectedAmmo: 'magazine',
    requiredEvidenceKind: 'official-game-data',
    expectedReferenceFragment: 'Steam build 25218825',
  },
  // H&K P2000 has explicit sanitized real-derived live GSI evidence
  {
    canonicalKey: 'weapon.hkp2000',
    expectedAmmo: 'magazine',
    requiredEvidenceKind: 'live-gsi',
    expectedReferenceFragment: 'packages/telemetry-gsi/test/fixtures/real-derived.ts',
  },
];

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

  it('strictly validates every HUD item against the official ammo evidence matrix (table-driven)', () => {
    for (const testCase of AMMO_EVIDENCE_TABLE) {
      const item = getCs2Item(testCase.canonicalKey);
      expect(item, `Item ${testCase.canonicalKey} must exist in catalog`).toBeDefined();
      expect(item?.ammoPresentation, `Item ${testCase.canonicalKey} ammoPresentation`).toBe(
        testCase.expectedAmmo,
      );

      const matchingEvidence = item?.evidence.find((e) => e.kind === testCase.requiredEvidenceKind);
      expect(
        matchingEvidence,
        `Item ${testCase.canonicalKey} must have evidence of kind ${testCase.requiredEvidenceKind}`,
      ).toBeDefined();
      expect(
        matchingEvidence?.reference,
        `Item ${testCase.canonicalKey} evidence reference must contain ${testCase.expectedReferenceFragment}`,
      ).toContain(testCase.expectedReferenceFragment);
    }
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

  it('proves that ammo presentation is strictly per-item metadata and forbids family-wide heuristics', () => {
    // Shotgun family: MAG-7 has clip reload and reserve clips; others reload per shell
    const shotguns = CS2_ITEM_CATALOG.filter((item) => item.family === 'shotgun');
    expect(shotguns.length).toBeGreaterThanOrEqual(4);
    const shotgunAmmoTypes = new Set(shotguns.map((item) => item.ammoPresentation));
    expect(shotgunAmmoTypes.has('magazine')).toBe(true);
    expect(shotgunAmmoTypes.has('shells')).toBe(true);
    expect(shotgunAmmoTypes.size).toBe(2);

    for (const shotgun of shotguns) {
      const evidence = shotgun.evidence.find((e) => e.kind === 'official-game-data');
      expect(
        evidence,
        `Shotgun ${shotgun.canonicalKey} must have official game-data evidence`,
      ).toBeDefined();
      expect(evidence?.reference).toContain('Steam build 25218825');
    }

    // Machinegun family: M249 and Negev both report magazine, not reserve-rounds
    const machineguns = CS2_ITEM_CATALOG.filter((item) => item.family === 'machinegun');
    expect(machineguns.length).toBe(2);
    for (const mg of machineguns) {
      expect(mg.ammoPresentation).toBe('magazine');
      const evidence = mg.evidence.find((e) => e.kind === 'official-game-data');
      expect(evidence, `Machine gun ${mg.canonicalKey} must cite official game-data`).toBeDefined();
      expect(evidence?.reference).toContain('Steam build 25218825');
    }

    // Sniper rifle family: each item has explicit official game-data evidence
    const snipers = CS2_ITEM_CATALOG.filter((item) => item.family === 'sniper-rifle');
    expect(snipers.length).toBeGreaterThanOrEqual(4);
    for (const sniper of snipers) {
      expect(sniper.ammoPresentation).toBe('magazine');
      const evidence = sniper.evidence.find((e) => e.kind === 'official-game-data');
      expect(evidence, `Sniper ${sniper.canonicalKey} must cite official game-data`).toBeDefined();
      expect(evidence?.reference).toContain('Steam build 25218825');
    }
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
