import { describe, expect, it } from 'vitest';

import {
  CS2_ASSET_MANIFEST,
  CS2_ITEM_CATALOG,
  getCs2Asset,
  getCs2Item,
  resolveCs2ItemByGsiName,
} from '../src/index.js';

describe('@mizar/cs2-assets resolver', () => {
  it('keeps the checked-in catalog and manifest aligned', () => {
    expect(CS2_ITEM_CATALOG).toHaveLength(Object.keys(CS2_ASSET_MANIFEST.assets).length);
    for (const item of CS2_ITEM_CATALOG) {
      expect(getCs2Item(item.canonicalKey)).toEqual(item);
      expect(getCs2Asset(item.assetId)).toBeDefined();
    }
  });

  it('returns an explicit unknown result without guessing a filename', () => {
    expect(resolveCs2ItemByGsiName('weapon_future_unknown')).toEqual({
      kind: 'unknown',
      gsiWeaponName: 'weapon_future_unknown',
    });
  });

  it('resolves weapon, utility, objective and melee presentation metadata', () => {
    expect(resolveCs2ItemByGsiName('weapon_ak47')).toMatchObject({
      kind: 'known',
      item: { canonicalKey: 'weapon.ak47', ammoPresentation: 'magazine' },
    });
    expect(resolveCs2ItemByGsiName('weapon_flashbang')).toMatchObject({
      kind: 'known',
      item: { canonicalKey: 'utility.flashbang', ammoPresentation: 'utility' },
    });
    expect(resolveCs2ItemByGsiName('weapon_c4')).toMatchObject({
      kind: 'known',
      item: { canonicalKey: 'objective.c4', ammoPresentation: 'objective' },
    });
    expect(resolveCs2ItemByGsiName('weapon_knife')).toMatchObject({
      kind: 'known',
      item: { canonicalKey: 'weapon.knife', ammoPresentation: 'none' },
    });
  });

  it("audits that all 72 catalog items have tintMode: 'mask' for monochromatic presentation", () => {
    expect(CS2_ITEM_CATALOG).toHaveLength(72);
    for (const item of CS2_ITEM_CATALOG) {
      expect(item.tintMode, `Item ${item.canonicalKey} must have tintMode 'mask'`).toBe('mask');
      const asset = getCs2Asset(item.assetId);
      expect(asset?.tintMode).toBe('mask');
      expect(asset?.mediaType).toBe('image/svg+xml');
    }
  });

  it('uses only explicit aliases for legacy/current source ids', () => {
    expect(resolveCs2ItemByGsiName('weapon_p2000')).toMatchObject({
      kind: 'known',
      item: { canonicalKey: 'weapon.hkp2000' },
    });
    expect(resolveCs2ItemByGsiName('weapon_usp_silencer_off')).toEqual({
      kind: 'unknown',
      gsiWeaponName: 'weapon_usp_silencer_off',
    });
  });

  it('resolves Program weapon presentation from name and never from the weapons-object slot key', () => {
    const resolveProgramWeapon = (weapon: { readonly name: string | null }) =>
      weapon.name === null ? null : resolveCs2ItemByGsiName(weapon.name);

    const observed = { sourceWeaponId: 'weapon_2', name: 'weapon_ak47' } as const;
    expect(resolveProgramWeapon(observed)).toMatchObject({
      kind: 'known',
      item: { canonicalKey: 'weapon.ak47' },
    });
    expect(resolveCs2ItemByGsiName(observed.sourceWeaponId)).toEqual({
      kind: 'unknown',
      gsiWeaponName: 'weapon_2',
    });

    const unavailable = { sourceWeaponId: 'weapon_3', name: null } as const;
    expect(resolveProgramWeapon(unavailable)).toBeNull();
  });
});
