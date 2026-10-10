import type { MatchContext } from '@mizar/core/match-context';
import type { IdentityResolution } from '@mizar/core/identity';
import {
  derivePlayerLifeState,
  livePlayerDisplayName,
  getProjectionIdentityState,
  getProgramSafeRuntimeFreshness,
  isProjectionIdentityCurrent,
  type ProgramSafeRuntimeView,
} from '@mizar/core/projection';
import type { RuntimeContinuityPolicy } from '@mizar/core/runtime';
import type { ObservedGrenade, ObservedPlayer } from '@mizar/core/telemetry';

import type { RadarFrame, RadarGrenade, RadarPlayer } from './frame.js';

export interface RadarProjectionInput {
  readonly runtime: ProgramSafeRuntimeView;
  readonly identity: IdentityResolution;
  readonly context?: MatchContext;
  readonly nowMonotonicMs: number;
  readonly continuityPolicy: RuntimeContinuityPolicy;
}

function identityIsCurrent(input: RadarProjectionInput): boolean {
  return isProjectionIdentityCurrent(input.runtime, input.identity);
}

function canonicalPlayerFor(input: RadarProjectionInput, sourcePlayerId: string) {
  if (
    !identityIsCurrent(input) ||
    !input.identity.capabilities.canonicalPlayerMapping ||
    input.identity.state === 'mismatch'
  ) {
    return undefined;
  }
  return input.identity.players.find((player) => player.sourcePlayerId === sourcePlayerId);
}

function projectRadarPlayer(input: RadarProjectionInput, player: ObservedPlayer): RadarPlayer {
  const canonical = canonicalPlayerFor(input, player.sourcePlayerId);
  const telemetry = input.runtime.telemetry;
  const fresh =
    getProgramSafeRuntimeFreshness(input.runtime, input.nowMonotonicMs, input.continuityPolicy) ===
    'fresh';
  const entrant =
    canonical === undefined || input.context === undefined
      ? undefined
      : [input.context.entrants.a, input.context.entrants.b].find(
          (item) => item.entryId === canonical.entryId,
        );
  const sideName =
    fresh && telemetry?.coverage.map === 'present'
      ? player.side === 'CT'
        ? telemetry.telemetry.map?.sides?.ct?.name
        : player.side === 'T'
          ? telemetry.telemetry.map?.sides?.t?.name
          : undefined
      : undefined;
  const { displayName } = livePlayerDisplayName(
    fresh && telemetry?.coverage.allPlayers === 'present' ? player.displayName : null,
    canonical?.displayName,
    [entrant?.name, sideName],
  );
  const candidates =
    player.weapons?.filter((weapon) => weapon.state === 'active' || weapon.state === 'reloading') ??
    [];
  const weapon = candidates.length === 1 ? candidates[0] : undefined;
  return {
    sourcePlayerId: player.sourcePlayerId,
    canonicalPlayerId: canonical?.canonicalPlayerId ?? null,
    displayName,
    side: player.side ?? 'unknown',
    observerSlot: player.observerSlot ?? null,
    lifeState: derivePlayerLifeState(player.state?.health),
    position: player.position ?? null,
    forward: player.forward ?? null,
    health: player.state?.health ?? null,
    flashAmount: player.state?.flashed ?? null,
    activeWeapon:
      weapon === undefined
        ? null
        : {
            name: weapon.name ?? null,
            ammoClip: weapon.ammoClip ?? null,
            state: weapon.state ?? null,
          },
  };
}

function projectRadarGrenade(grenade: ObservedGrenade): RadarGrenade {
  return {
    sourceEntityId: grenade.sourceEntityId,
    kind: grenade.kind ?? null,
    ownerSourceId: grenade.ownerSourceId ?? null,
    position: grenade.position ?? null,
    velocity: grenade.velocity ?? null,
    lifetimeSeconds: grenade.lifetimeSeconds ?? null,
    effectTimeSeconds: grenade.effectTimeSeconds ?? null,
    flames: [...(grenade.flames ?? [])].sort((left, right) =>
      left.sourceFlameId.localeCompare(right.sourceFlameId),
    ),
  };
}

export function projectRadarFrame(input: RadarProjectionInput): RadarFrame {
  const telemetry = input.runtime.telemetry;
  const freshness = getProgramSafeRuntimeFreshness(
    input.runtime,
    input.nowMonotonicMs,
    input.continuityPolicy,
  );
  const players = telemetry?.telemetry.allPlayers ?? [];
  const grenades = telemetry?.telemetry.grenades ?? [];

  return {
    cursor: input.runtime.cursor,
    telemetryFreshness: freshness,
    identityState: getProjectionIdentityState(input.runtime, input.identity),
    mapName: telemetry?.telemetry.map?.name ?? null,
    observedPlayerSourceId: telemetry?.telemetry.player?.sourcePlayerId ?? null,
    coverage: {
      allPlayers: telemetry?.coverage.allPlayers ?? 'absent',
      bomb: telemetry?.coverage.bomb ?? 'absent',
      grenades: telemetry?.coverage.grenades ?? 'absent',
    },
    players: [...players]
      .sort((left, right) => left.sourcePlayerId.localeCompare(right.sourcePlayerId))
      .map((player) => projectRadarPlayer(input, player)),
    bomb:
      telemetry?.telemetry.bomb === undefined
        ? null
        : {
            state: telemetry.telemetry.bomb.state ?? null,
            position: telemetry.telemetry.bomb.position ?? null,
            sourcePlayerId: telemetry.telemetry.bomb.sourcePlayerId ?? null,
          },
    grenades: [...grenades]
      .sort((left, right) => left.sourceEntityId.localeCompare(right.sourceEntityId))
      .map((grenade) => projectRadarGrenade(grenade)),
  };
}
