import type { BombState, ObservedWeapon, RoundPhase } from '../telemetry/index.js';

/** Semantic catalog only. The adapter supplies these facts without asset paths. */
export interface EquipmentMetadata {
  readonly canonicalKey: string;
  readonly kind: 'firearm' | 'melee' | 'utility' | 'equipment' | 'objective';
  readonly family: string;
}
export type EquipmentCatalog = Readonly<Record<string, EquipmentMetadata>>;
export interface UtilityCounts {
  readonly smoke: number;
  readonly fire: number;
  readonly flash: number;
  readonly he: number;
}
export interface PlayerEquipmentProjection {
  readonly available: boolean;
  readonly primary: string | null;
  readonly secondary: string | null;
  readonly heldWeaponId: string | null;
  readonly zeusWeaponId: string | null;
  readonly utility: UtilityCounts | null;
  readonly hasC4: boolean | null;
}
export interface TeamEconomyProjection {
  readonly lineupComplete: boolean;
  readonly alive: number | null;
  readonly money: number | null;
  readonly equipmentValue: number | null;
  readonly lossBonus: number | null;
  readonly utility: UtilityCounts | null;
}

export interface PlayerEquipmentContext {
  readonly sourcePlayerId: string;
  readonly bomb: {
    readonly state: BombState | null;
    readonly sourcePlayerId: string | null;
  } | null;
  readonly telemetryFresh: boolean;
  readonly lineupCurrent: boolean;
  readonly lifeState: 'alive' | 'dead' | 'unknown';
}

function playerHasC4(context: PlayerEquipmentContext): boolean | null {
  if (context.lifeState === 'dead') return false;
  const bomb = context.bomb;
  if (bomb === null || bomb.state === null || bomb.state === 'unknown') return null;
  if (bomb.state !== 'carried' && bomb.state !== 'planting') return false;
  return bomb.sourcePlayerId === null ? null : bomb.sourcePlayerId === context.sourcePlayerId;
}

export function projectPlayerEquipment(
  weapons: readonly ObservedWeapon[] | undefined,
  catalog: EquipmentCatalog | undefined,
  context: PlayerEquipmentContext,
): PlayerEquipmentProjection {
  const hasC4 = playerHasC4(context);
  if (weapons === undefined)
    return {
      available: false,
      primary: null,
      secondary: null,
      heldWeaponId: null,
      zeusWeaponId: null,
      utility: null,
      hasC4,
    };
  const sorted = [...weapons].sort((a, b) => a.sourceWeaponId.localeCompare(b.sourceWeaponId));
  const known = sorted.map((weapon) => ({
    weapon,
    item: weapon.name === undefined ? undefined : catalog?.[weapon.name],
  }));
  const available = known.every(({ item }) => item !== undefined);
  const firearms = known.filter(({ item }) => item?.kind === 'firearm' && item.family !== 'pistol');
  const pistols = known.filter(({ item }) => item?.kind === 'firearm' && item.family === 'pistol');
  const held = sorted.filter((weapon) => weapon.state === 'active' || weapon.state === 'reloading');
  const zeus = known.find(({ item }) => item?.canonicalKey === 'utility.taser');
  const utility = { smoke: 0, fire: 0, flash: 0, he: 0 };
  let utilityKnown = available;
  for (const { weapon, item } of known) {
    const family =
      item?.canonicalKey === 'utility.smokegrenade'
        ? 'smoke'
        : item?.canonicalKey === 'utility.molotov' || item?.canonicalKey === 'utility.incgrenade'
          ? 'fire'
          : item?.canonicalKey === 'utility.flashbang'
            ? 'flash'
            : item?.canonicalKey === 'utility.hegrenade'
              ? 'he'
              : null;
    if (family !== null) {
      if (
        weapon.ammoReserve === undefined ||
        !Number.isSafeInteger(weapon.ammoReserve) ||
        weapon.ammoReserve < 0
      )
        utilityKnown = false;
      else utility[family] += weapon.ammoReserve;
    }
  }
  return {
    available,
    primary: available
      ? (firearms[0]?.weapon.sourceWeaponId ?? pistols[0]?.weapon.sourceWeaponId ?? null)
      : null,
    secondary:
      available && firearms.length > 0 ? (pistols[0]?.weapon.sourceWeaponId ?? null) : null,
    heldWeaponId:
      context.telemetryFresh &&
      context.lineupCurrent &&
      context.lifeState === 'alive' &&
      held.length === 1
        ? held[0]!.sourceWeaponId
        : null,
    zeusWeaponId: zeus?.weapon.sourceWeaponId ?? null,
    utility: utilityKnown ? utility : null,
    hasC4,
  };
}

export interface TeamEconomyPlayer {
  readonly current: boolean;
  readonly lifeState: 'alive' | 'dead' | 'unknown';
  readonly money: number | null;
  readonly equipmentValue: number | null;
  readonly equipment: PlayerEquipmentProjection;
}
export function projectTeamEconomy(
  players: readonly TeamEconomyPlayer[],
  roundPhase: RoundPhase | null,
  consecutiveLosses: number | null,
): TeamEconomyProjection {
  const lineupComplete = players.length === 5 && players.every((p) => p.current);
  const total = (read: (p: TeamEconomyPlayer) => number | null) => {
    const values = players.map(read);
    return lineupComplete &&
      values.every((v): v is number => v !== null && Number.isFinite(v) && v >= 0)
      ? values.reduce((a, b) => a + b, 0)
      : null;
  };
  const alive =
    lineupComplete && players.every((p) => p.lifeState !== 'unknown')
      ? players.filter((p) => p.lifeState === 'alive').length
      : null;
  const contributors =
    roundPhase === 'live' ? players.filter((p) => p.lifeState === 'alive') : players;
  const utility = { smoke: 0, fire: 0, flash: 0, he: 0 };
  const utilityKnown =
    lineupComplete &&
    (roundPhase !== 'live' || alive !== null) &&
    contributors.every((p) => p.equipment.utility !== null);
  if (utilityKnown)
    for (const p of contributors)
      for (const key of ['smoke', 'fire', 'flash', 'he'] as const)
        utility[key] += p.equipment.utility![key];
  return {
    lineupComplete,
    alive,
    money: total((p) => p.money),
    equipmentValue: total((p) => p.equipmentValue),
    lossBonus:
      consecutiveLosses !== null &&
      Number.isSafeInteger(consecutiveLosses) &&
      consecutiveLosses >= 0
        ? 1400 + Math.min(consecutiveLosses, 4) * 500
        : null,
    utility: utilityKnown ? utility : null,
  };
}
