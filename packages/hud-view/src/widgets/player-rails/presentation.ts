import {
  getCs2Asset,
  getCs2Item,
  resolveCs2ItemByGsiName,
  type Cs2ItemMetadata,
} from '@mizar/cs2-assets';
import type { ProgramPayload } from '@mizar/protocol/program';
import {
  playerStatusEffectState,
  type PlayerStatusEffectState,
} from '../player-status-effects/presentation.js';
import { heldWeapon, magazineFill } from '../player-equipment/presentation.js';

export const LOW_ARMOR_THRESHOLD = 25;

export type PlayerRailSide = 'CT' | 'T';
export type PlayerRailsPhase = 'freezetime' | 'live' | 'unknown';

export interface PlayerRailAsset {
  readonly canonicalKey: string;
  readonly outputPath: string;
}

export interface PlayerRailWeapon {
  readonly sourceWeaponId: string;
  readonly name: string | null;
  readonly item: Cs2ItemMetadata | null;
  readonly asset: PlayerRailAsset | null;
  readonly ammoReserve: number | null;
  readonly active?: boolean;
  readonly clipFill?: number | null;
}

export type WeaponVisualRole = 'primary-firearm' | 'standalone-pistol' | 'secondary-pistol';

export function weaponVisualRole(
  weapon: PlayerRailWeapon,
  pairedWithFirearm: boolean,
): WeaponVisualRole {
  if (weapon.item?.family === 'pistol')
    return pairedWithFirearm ? 'secondary-pistol' : 'standalone-pistol';
  return 'primary-firearm';
}

export interface PlayerRailUtility extends PlayerRailWeapon {
  readonly family: 'smoke' | 'fire' | 'flash' | 'he';
  readonly count: number;
}

export interface PlayerRailStats {
  readonly kills: number | null;
  readonly assists: number | null;
  readonly deaths: number | null;
}

export interface PlayerCardPresentation {
  readonly sourcePlayerId: string;
  readonly avatarUrl: string | null;
  readonly side: PlayerRailSide;
  readonly displayName: string | null;
  readonly observerSlot: number | null;
  readonly lifeState: 'alive' | 'dead' | 'unknown';
  readonly mode: 'freezetime' | 'live' | 'dead' | 'unknown';
  readonly observed: boolean;
  readonly statusEffects: PlayerStatusEffectState;
  readonly health: number | null;
  readonly healthPercent: number | null;
  readonly armorAsset: PlayerRailAsset | null;
  readonly lowArmor: number | null;
  readonly defuserAsset: PlayerRailAsset | null;
  readonly c4Asset: PlayerRailAsset | null;
  readonly hasDefuser: boolean;
  readonly hasC4: boolean;
  readonly primaryWeapon: PlayerRailWeapon | null;
  readonly secondaryWeapon: PlayerRailWeapon | null;
  readonly zeus: PlayerRailWeapon | null;
  readonly utility: readonly PlayerRailUtility[];
  readonly money: number | null;
  readonly roundMoneySpent: number | null;
  readonly roundKills: number | null;
  readonly stats: PlayerRailStats;
  readonly liveAdr: number | null;
  readonly completedAdr: number | null;
  readonly currentRoundDamage: number | null;
  readonly weaponsAvailable: boolean;
}

export interface TeamUtilitySummary {
  readonly smoke: number;
  readonly fire: number;
  readonly flash: number;
  readonly he: number;
}

export type TeamUtilityFamily = keyof TeamUtilitySummary;

export interface TeamSummaryPresentation {
  readonly side: PlayerRailSide;
  readonly money: number | null;
  readonly equip: number | null;
  readonly lossBonus: number | null;
  readonly utility: TeamUtilitySummary | null;
  readonly lineupComplete: boolean;
  readonly utilityAvailable: boolean;
}

export interface PlayerRailPresentation {
  readonly side: PlayerRailSide;
  readonly entrantKey: 'a' | 'b' | null;
  readonly entrantName: string | null;
  readonly players: readonly PlayerCardPresentation[];
  readonly summary: TeamSummaryPresentation;
}

export interface PlayerRailsPresentation {
  readonly phase: PlayerRailsPhase;
  readonly ct: PlayerRailPresentation;
  readonly t: PlayerRailPresentation;
  readonly left: PlayerRailPresentation;
  readonly right: PlayerRailPresentation;
}

export function assetForCanonicalKey(canonicalKey: string): PlayerRailAsset | null {
  const item = getCs2Item(canonicalKey);
  if (item === undefined) return null;
  const asset = getCs2Asset(item.assetId);
  if (asset === undefined) return null;
  return { canonicalKey, outputPath: asset.outputPath };
}

function utilityCanonicalKey(side: PlayerRailSide, family: TeamUtilityFamily): string {
  switch (family) {
    case 'smoke':
      return 'utility.smokegrenade';
    case 'fire':
      return side === 'CT' ? 'utility.incgrenade' : 'utility.molotov';
    case 'flash':
      return 'utility.flashbang';
    case 'he':
      return 'utility.hegrenade';
  }
}

export function teamUtilityAsset(
  side: PlayerRailSide,
  family: TeamUtilityFamily,
): PlayerRailAsset | null {
  return assetForCanonicalKey(utilityCanonicalKey(side, family));
}

export function weaponPresentation(
  weapon: ProgramPayload['players'][number]['weapons'][number],
): PlayerRailWeapon {
  const resolution = weapon.name === null ? null : resolveCs2ItemByGsiName(weapon.name);
  if (resolution === null || resolution.kind === 'unknown') {
    return {
      sourceWeaponId: weapon.sourceWeaponId,
      name: weapon.name,
      item: null,
      asset: null,
      ammoReserve: weapon.ammoReserve,
      active: weapon.state === 'active',
    };
  }
  return {
    sourceWeaponId: weapon.sourceWeaponId,
    name: weapon.name,
    item: resolution.item,
    asset: { canonicalKey: resolution.item.canonicalKey, outputPath: resolution.asset.outputPath },
    ammoReserve: weapon.ammoReserve,
    active: weapon.state === 'active',
  };
}

function utilityFamily(item: Cs2ItemMetadata | null): PlayerRailUtility['family'] | null {
  if (item?.kind !== 'utility' || item.family !== 'grenade') return null;
  switch (item.canonicalKey) {
    case 'utility.smokegrenade':
      return 'smoke';
    case 'utility.molotov':
    case 'utility.incgrenade':
      return 'fire';
    case 'utility.flashbang':
      return 'flash';
    case 'utility.hegrenade':
      return 'he';
    default:
      return null;
  }
}

export function utilityPresentation(
  player: ProgramPayload['players'][number],
  side: PlayerRailSide,
  weapons: readonly PlayerRailWeapon[],
): readonly PlayerRailUtility[] {
  const counts = player.equipment.utility;
  if (counts === null) return [];
  return (['smoke', 'fire', 'flash', 'he'] as const).flatMap((family) => {
    const count = counts[family];
    if (count === 0) return [];
    const weapon = weapons.find((item) => utilityFamily(item.item) === family);
    return [
      {
        sourceWeaponId: weapon?.sourceWeaponId ?? family,
        name: weapon?.name ?? null,
        item: weapon?.item ?? null,
        asset: weapon?.asset ?? teamUtilityAsset(side, family),
        ammoReserve: weapon?.ammoReserve ?? null,
        active: weapon?.active ?? false,
        family,
        count,
      },
    ];
  });
}

function healthPercent(health: number | null): number | null {
  if (health === null || !Number.isFinite(health)) return null;
  return Math.max(0, Math.min(100, health));
}

function comparePlayers(
  left: ProgramPayload['players'][number],
  right: ProgramPayload['players'][number],
): number {
  if (left.observerSlot !== null && right.observerSlot === null) return -1;
  if (left.observerSlot === null && right.observerSlot !== null) return 1;
  if (left.observerSlot !== null && right.observerSlot !== null) {
    if (left.observerSlot !== right.observerSlot) return left.observerSlot - right.observerSlot;
  }
  return left.sourcePlayerId.localeCompare(right.sourcePlayerId);
}

function playerPresentation(
  player: ProgramPayload['players'][number],
  phase: PlayerRailsPhase,
  payload: ProgramPayload,
): PlayerCardPresentation {
  const held = heldWeapon(player);
  const weapons = player.weapons.map((weapon) => {
    const presented = weaponPresentation(weapon);
    const active = weapon === held;
    return {
      ...presented,
      active,
      clipFill:
        active && presented.item?.kind === 'firearm' && presented.item.family !== 'pistol'
          ? magazineFill(held)
          : null,
    };
  });
  const dead = player.lifeState === 'dead';
  const primary =
    weapons.find((weapon) => weapon.sourceWeaponId === player.equipment.primary) ?? null;
  const secondary =
    weapons.find((weapon) => weapon.sourceWeaponId === player.equipment.secondary) ?? null;
  const armorAsset =
    player.state?.armor !== null && player.state?.armor !== undefined && player.state.armor > 0
      ? assetForCanonicalKey(
          player.state.hasHelmet === true ? 'equipment.armor-helmet' : 'equipment.armor',
        )
      : null;
  const hasC4 = !dead && player.equipment.hasC4 === true;
  const mode = dead ? 'dead' : player.lifeState === 'alive' ? phase : 'unknown';

  return {
    sourcePlayerId: player.sourcePlayerId,
    avatarUrl: player.avatarUrl,
    side: player.side === 'T' ? 'T' : 'CT',
    displayName: player.displayName,
    observerSlot: player.observerSlot,
    lifeState: player.lifeState,
    mode,
    observed: payload.observedPlayerSourceId === player.sourcePlayerId,
    statusEffects: playerStatusEffectState(player, mode === 'live'),
    health: dead ? null : (player.state?.health ?? null),
    healthPercent: dead ? null : healthPercent(player.state?.health ?? null),
    armorAsset: dead ? null : armorAsset,
    lowArmor:
      player.lifeState === 'alive' &&
      payload.status.telemetry === 'fresh' &&
      player.lineupEvidence === 'current' &&
      player.state?.armor != null &&
      Number.isFinite(player.state.armor) &&
      player.state.armor > 0 &&
      player.state.armor <= LOW_ARMOR_THRESHOLD
        ? player.state.armor
        : null,
    defuserAsset:
      !dead && player.state?.hasDefuser === true
        ? assetForCanonicalKey('equipment.defuse-kit')
        : null,
    c4Asset: hasC4 ? assetForCanonicalKey('objective.c4') : null,
    hasDefuser: !dead && player.state?.hasDefuser === true,
    hasC4,
    primaryWeapon: dead ? null : primary,
    secondaryWeapon: dead ? null : secondary,
    zeus: dead
      ? null
      : (weapons.find((weapon) => weapon.sourceWeaponId === player.equipment.zeusWeaponId) ?? null),
    utility: dead ? [] : utilityPresentation(player, player.side === 'T' ? 'T' : 'CT', weapons),
    money: player.state?.money ?? null,
    roundMoneySpent: player.statistics.currentRound.moneySpent.value,
    roundKills: player.state?.roundKills ?? null,
    stats: {
      kills: player.statistics.scoreboard.kills.value,
      assists: player.statistics.scoreboard.assists.value,
      deaths: player.statistics.scoreboard.deaths.value,
    },
    liveAdr: player.statistics.includingCurrentRound.adr.value,
    completedAdr: player.statistics.completed.adr.value,
    currentRoundDamage: player.statistics.currentRound.damage.value,
    weaponsAvailable: player.equipment.available,
  };
}

function teamSummary(side: PlayerRailSide, payload: ProgramPayload): TeamSummaryPresentation {
  const economy = payload.teamEconomy[side === 'CT' ? 'ct' : 't'];
  return {
    side,
    money: economy.money,
    equip: economy.equipmentValue,
    lossBonus: economy.lossBonus,
    utility: economy.utility,
    lineupComplete: economy.lineupComplete,
    utilityAvailable: economy.utility !== null,
  };
}

function phaseForPayload(payload: ProgramPayload): PlayerRailsPhase {
  if (payload.round?.phase === 'freezetime' || payload.clock?.phase === 'freezetime')
    return 'freezetime';
  if (payload.round?.phase === 'live' || payload.clock?.phase === 'live') return 'live';
  return 'unknown';
}

function entrantSideMapping(payload: ProgramPayload): {
  readonly a: PlayerRailSide | null;
  readonly b: PlayerRailSide | null;
} {
  const series = payload.series;
  if (series === null) return { a: null, b: null };
  const ct = payload.teams.ct.mode === 'canonical' ? payload.teams.ct.entryId : null;
  const t = payload.teams.t.mode === 'canonical' ? payload.teams.t.entryId : null;
  if (ct === null || t === null || ct === t) return { a: null, b: null };
  if (ct === series.entrants.a.entryId && t === series.entrants.b.entryId)
    return { a: 'CT', b: 'T' };
  if (ct === series.entrants.b.entryId && t === series.entrants.a.entryId)
    return { a: 'T', b: 'CT' };
  return { a: null, b: null };
}

function buildRail(
  side: PlayerRailSide,
  entrantKey: 'a' | 'b' | null,
  players: readonly ProgramPayload['players'][number][],
  phase: PlayerRailsPhase,
  payload: ProgramPayload,
): PlayerRailPresentation {
  const sorted = players
    .filter((player) => player.side === side)
    .sort(comparePlayers)
    .slice(0, 5);
  return {
    side,
    entrantKey,
    entrantName: null,
    players: sorted.map((player) => playerPresentation(player, phase, payload)),
    summary: teamSummary(side, payload),
  };
}

export function buildPlayerRailsPresentation(payload: ProgramPayload): PlayerRailsPresentation {
  const phase = phaseForPayload(payload);
  const mapping = entrantSideMapping(payload);
  const ct = buildRail(
    'CT',
    mapping.a === 'CT' ? 'a' : mapping.b === 'CT' ? 'b' : null,
    payload.players,
    phase,
    payload,
  );
  const t = buildRail(
    'T',
    mapping.a === 'T' ? 'a' : mapping.b === 'T' ? 'b' : null,
    payload.players,
    phase,
    payload,
  );
  const leftSide = mapping.a ?? 'CT';
  const rightSide = mapping.b ?? 'T';
  const left = leftSide === 'CT' ? ct : t;
  const right = rightSide === 'CT' ? ct : t;
  const series = payload.series;
  const entrantName = (key: 'a' | 'b' | null): string | null =>
    key === null || series === null ? null : series.entrants[key].name;
  return {
    phase,
    ct,
    t,
    left:
      mapping.a === null
        ? { ...left, entrantKey: null, entrantName: null }
        : { ...left, entrantKey: 'a', entrantName: entrantName('a') },
    right:
      mapping.b === null
        ? { ...right, entrantKey: null, entrantName: null }
        : { ...right, entrantKey: 'b', entrantName: entrantName('b') },
  };
}
