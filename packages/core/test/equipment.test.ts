import { describe, expect, it } from 'vitest';
import { projectPlayerEquipment, projectTeamEconomy } from '../src/projection/index.js';

const catalog = {
  weapon_ak47: { canonicalKey: 'firearm.ak47', kind: 'firearm', family: 'rifle' },
  weapon_glock: { canonicalKey: 'firearm.glock', kind: 'firearm', family: 'pistol' },
  weapon_flashbang: { canonicalKey: 'utility.flashbang', kind: 'utility', family: 'grenade' },
  weapon_c4: { canonicalKey: 'objective.c4', kind: 'objective', family: 'bomb' },
} as const;

describe('equipment facts', () => {
  it('selects weapons, retains C4 and counts known utility without paths', () => {
    const equipment = projectPlayerEquipment(
      [
        { sourceWeaponId: '0', name: 'weapon_ak47', state: 'active' },
        { sourceWeaponId: '1', name: 'weapon_glock', state: 'holstered' },
        { sourceWeaponId: '2', name: 'weapon_flashbang', ammoReserve: 2 },
        { sourceWeaponId: '3', name: 'weapon_c4' },
      ],
      catalog,
    );
    expect(equipment).toEqual({
      available: true,
      primary: '0',
      secondary: '1',
      heldWeaponId: '0',
      utility: { smoke: 0, fire: 0, flash: 2, he: 0 },
      hasC4: true,
    });
    const players = Array.from({ length: 5 }, () => ({
      current: true,
      lifeState: 'alive' as const,
      money: 1000,
      equipmentValue: 2000,
      equipment,
    }));
    expect(projectTeamEconomy(players, 'live', 2)).toEqual({
      lineupComplete: true,
      alive: 5,
      money: 5000,
      equipmentValue: 10000,
      lossBonus: 2400,
      utility: { smoke: 0, fire: 0, flash: 10, he: 0 },
    });
  });
  it('does not turn missing metadata, ammunition or roster into zero facts', () => {
    expect(
      projectPlayerEquipment([{ sourceWeaponId: '0', name: 'unknown' }], catalog),
    ).toMatchObject({ available: false, primary: null, utility: null, hasC4: null });
    const equipment = projectPlayerEquipment(
      [{ sourceWeaponId: '0', name: 'weapon_flashbang' }],
      catalog,
    );
    expect(equipment.utility).toBeNull();
    expect(
      projectTeamEconomy(
        [{ current: true, lifeState: 'unknown', money: null, equipmentValue: null, equipment }],
        'live',
        null,
      ),
    ).toMatchObject({
      alive: null,
      money: null,
      equipmentValue: null,
      utility: null,
      lossBonus: null,
    });
  });
});
