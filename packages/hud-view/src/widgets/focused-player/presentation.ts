import type { ProgramPayload } from '@mizar/protocol/program';
import {
  assetForCanonicalKey,
  weaponPresentation,
  utilityPresentation,
} from '../player-rails/presentation.js';
import { playerStatusEffectState } from '../player-status-effects/presentation.js';
import { heldWeapon, magazineFill } from '../player-equipment/presentation.js';

export type FocusedPlayerItemKind =
  'firearm' | 'knife' | 'grenade' | 'objective' | 'taser' | 'other';

function activeItemKind(
  item: ReturnType<typeof weaponPresentation>['item'],
): FocusedPlayerItemKind {
  if (item === null) return 'other';
  if (item.canonicalKey === 'utility.taser') return 'taser';
  switch (item.kind) {
    case 'firearm':
      return 'firearm';
    case 'melee':
      return 'knife';
    case 'objective':
      return 'objective';
    case 'utility':
      return item.family === 'grenade' ? 'grenade' : 'other';
    default:
      return 'other';
  }
}

export function buildReserveAmmoPresentation(
  ammoPresentation: string | undefined,
  reserve: number | null | undefined,
  magazineAsset: ReturnType<typeof assetForCanonicalKey>,
) {
  if (reserve == null || !Number.isSafeInteger(reserve) || reserve < 0) {
    return { reserveText: null, reserveMagazine: null };
  }

  if (ammoPresentation === 'magazine') {
    return magazineAsset === null
      ? { reserveText: null, reserveMagazine: null }
      : { reserveText: null, reserveMagazine: { asset: magazineAsset, count: reserve } };
  }

  if (ammoPresentation === 'shells') {
    return { reserveText: `SHELL ${reserve}`, reserveMagazine: null };
  }
  if (ammoPresentation === 'reserve-rounds') {
    return { reserveText: `RDS ${reserve}`, reserveMagazine: null };
  }

  return { reserveText: null, reserveMagazine: null };
}

export function buildFocusedPlayerPresentation(payload: ProgramPayload) {
  if (payload.observedPlayerSourceId === null) return null;
  const matches = payload.players.filter(
    (p) => p.sourcePlayerId === payload.observedPlayerSourceId,
  );
  const player = matches.length === 1 ? matches[0] : undefined;
  if (
    player === undefined ||
    player.lineupEvidence !== 'current' ||
    player.state === null ||
    player.lifeState === 'unknown'
  )
    return null;
  const dead = player.lifeState === 'dead';
  const statusEffectsVisible =
    !dead && (payload.round?.phase === 'live' || payload.clock?.phase === 'live');
  const team =
    player.side === 'CT' ? payload.teams.ct : player.side === 'T' ? payload.teams.t : null;
  const hasC4 = !dead && player.equipment.hasC4 === true;
  const weapons = player.equipment.available ? player.weapons.map(weaponPresentation) : [];
  const active = heldWeapon(player, payload.status.telemetry === 'fresh');
  const resolved = active === null ? null : weaponPresentation(active);
  const activeItem =
    dead || resolved?.item == null || (resolved.item.kind === 'objective' && !hasC4)
      ? null
      : resolved;
  const firearm = activeItem?.item?.kind === 'firearm';
  const reserve = active?.ammoReserve;
  const ammoPresentation = activeItem?.item?.ammoPresentation;
  const reserveAmmo = buildReserveAmmoPresentation(
    firearm ? ammoPresentation : undefined,
    firearm ? reserve : undefined,
    assetForCanonicalKey('ammo.magazine'),
  );
  return {
    sourcePlayerId: player.sourcePlayerId,
    avatarUrl: player.avatarUrl,
    displayName: player.displayName ?? 'PLAYER',
    observerSlot: player.observerSlot,
    side: player.side,
    teamName: team?.mode === 'canonical' ? team.name : (player.side ?? '—'),
    teamLogoUrl: team?.mode === 'canonical' ? team.logoUrl : null,
    dead,
    statusEffects: playerStatusEffectState(player, statusEffectsVisible),
    stats: {
      kills: player.statistics.scoreboard.kills.value,
      assists: player.statistics.scoreboard.assists.value,
      deaths: player.statistics.scoreboard.deaths.value,
    },
    completedAdr: player.statistics.completed.adr.value,
    liveAdr: player.statistics.includingCurrentRound.adr.value,
    roundKills: player.state.roundKills,
    reportedHealth: dead && player.state.health !== 0 ? null : player.state.health,
    health: dead ? null : player.state.health,
    healthFill:
      dead || player.state.health === null ? null : Math.max(0, Math.min(100, player.state.health)),
    armor: dead ? null : player.state.armor,
    armorAsset:
      !dead &&
      player.state.armor !== null &&
      player.state.armor > 0 &&
      player.state.hasHelmet !== null
        ? assetForCanonicalKey(
            player.state.hasHelmet ? 'equipment.armor-helmet' : 'equipment.armor',
          )
        : null,
    utility: dead ? [] : utilityPresentation(player, player.side === 'T' ? 'T' : 'CT', weapons),
    zeus: dead ? null : (weapons.find((w) => w.item?.canonicalKey === 'utility.taser') ?? null),
    kit:
      !dead && player.state.hasDefuser === true
        ? assetForCanonicalKey('equipment.defuse-kit')
        : null,
    c4: hasC4 ? assetForCanonicalKey('objective.c4') : null,
    activeItem,
    activeItemKind: activeItemKind(activeItem?.item ?? null),
    clip: firearm ? (active?.ammoClip ?? null) : null,
    clipFill: firearm ? magazineFill(active) : null,
    ...reserveAmmo,
  };
}
export type FocusedPlayerPresentation = NonNullable<
  ReturnType<typeof buildFocusedPlayerPresentation>
>;
