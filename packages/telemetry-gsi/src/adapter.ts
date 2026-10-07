import type {
  ObservedTelemetry,
  TelemetryCoverage,
  TelemetryObservation,
  TelemetryReceiveContext,
} from '@mizar/core/telemetry';
import { DiagnosticCollector } from './diagnostics/collector.js';
import type { GsiDiagnosticBatch } from './diagnostics/types.js';
import { parseAllPlayers } from './blocks/all-players.js';
import { parseBomb } from './blocks/bomb.js';
import { parseGrenades } from './blocks/grenades.js';
import { parseMap } from './blocks/map.js';
import { parsePhaseCountdown } from './blocks/phase-countdowns.js';
import { parsePlayer } from './blocks/player.js';
import { parseProvider } from './blocks/provider.js';
import { parseRound } from './blocks/round.js';
import { asSourceRecord } from './parse/record.js';

export type GsiAdaptResult =
  | {
      readonly ok: true;
      readonly observation: TelemetryObservation;
      readonly diagnostics: GsiDiagnosticBatch;
    }
  | {
      readonly ok: false;
      readonly diagnostics: GsiDiagnosticBatch;
    };

function blockStatus(
  present: boolean,
  value: unknown,
  degraded: boolean,
): TelemetryCoverage['provider'] {
  if (!present) return 'absent';
  return value === undefined || degraded ? 'degraded' : 'present';
}

export function adaptGsiPayload(
  payload: unknown,
  receiveContext: TelemetryReceiveContext,
): GsiAdaptResult {
  const diagnostics = new DiagnosticCollector();
  const root = asSourceRecord(payload);
  if (root === undefined) {
    diagnostics.add('INVALID_ROOT', 'fatal', '$');
    return { ok: false, diagnostics: diagnostics.toBatch() };
  }

  const providerPresent = Object.hasOwn(root, 'provider');
  const provider = providerPresent
    ? parseProvider(root.provider, diagnostics, '$.provider')
    : undefined;
  const mapPresent = Object.hasOwn(root, 'map');
  const map = mapPresent ? parseMap(root.map, diagnostics, '$.map') : undefined;
  const roundPresent = Object.hasOwn(root, 'round');
  const round = roundPresent ? parseRound(root.round, diagnostics, '$.round') : undefined;
  const phaseCountdownsPresent = Object.hasOwn(root, 'phase_countdowns');
  const phaseCountdowns = phaseCountdownsPresent
    ? parsePhaseCountdown(root.phase_countdowns, diagnostics, '$.phase_countdowns')
    : undefined;
  const playerPresent = Object.hasOwn(root, 'player');
  const player = playerPresent ? parsePlayer(root.player, diagnostics, '$.player') : undefined;
  const allPlayersPresent = Object.hasOwn(root, 'allplayers');
  const allPlayers = allPlayersPresent
    ? parseAllPlayers(root.allplayers, diagnostics, '$.allplayers')
    : undefined;
  const bombPresent = Object.hasOwn(root, 'bomb');
  const bomb = bombPresent ? parseBomb(root.bomb, diagnostics, '$.bomb') : undefined;
  const grenadesPresent = Object.hasOwn(root, 'grenades');
  const grenades = grenadesPresent
    ? parseGrenades(root.grenades, diagnostics, '$.grenades')
    : undefined;

  // CS2 demo GSI can label a holstered, inventory-owned C4 as dropped.
  // Reconcile only explicit ownership in this same, fully parsed observation.
  const inventoryCarriers =
    bomb?.value?.state === 'dropped' && !bomb.degraded && !allPlayers?.degraded
      ? allPlayers?.value?.filter(
          (candidate) =>
            (candidate.state?.health ?? 0) > 0 &&
            candidate.weapons?.some(
              (weapon) =>
                weapon.name === 'weapon_c4' &&
                (weapon.state === 'active' || weapon.state === 'holstered'),
            ),
        )
      : undefined;
  const bombValue =
    bomb?.value?.state === 'dropped' &&
    !bomb.degraded &&
    !allPlayers?.degraded &&
    inventoryCarriers?.length === 1 &&
    inventoryCarriers[0]?.sourcePlayerId === bomb.value.sourcePlayerId
      ? { ...bomb.value, state: 'carried' as const }
      : bomb?.value;

  const telemetry: ObservedTelemetry = {
    ...(map?.value === undefined ? {} : { map: map.value }),
    ...(round?.value === undefined ? {} : { round: round.value }),
    ...(phaseCountdowns?.value === undefined ? {} : { phaseCountdowns: phaseCountdowns.value }),
    ...(player?.value === undefined ? {} : { player: player.value }),
    ...(allPlayers?.value === undefined ? {} : { allPlayers: allPlayers.value }),
    ...(bombValue === undefined ? {} : { bomb: bombValue }),
    ...(grenades?.value === undefined ? {} : { grenades: grenades.value }),
  };

  const coverage: TelemetryCoverage = {
    provider: blockStatus(providerPresent, provider?.value, provider?.degraded ?? false),
    map: blockStatus(mapPresent, map?.value, map?.degraded ?? false),
    round: blockStatus(roundPresent, round?.value, round?.degraded ?? false),
    phaseCountdowns: blockStatus(
      phaseCountdownsPresent,
      phaseCountdowns?.value,
      phaseCountdowns?.degraded ?? false,
    ),
    player: blockStatus(playerPresent, player?.value, player?.degraded ?? false),
    allPlayers: blockStatus(allPlayersPresent, allPlayers?.value, allPlayers?.degraded ?? false),
    bomb: blockStatus(bombPresent, bomb?.value, bomb?.degraded ?? false),
    grenades: blockStatus(grenadesPresent, grenades?.value, grenades?.degraded ?? false),
  };

  const providerTimestampSeconds = provider?.value?.timestampSeconds;
  const source = {
    kind: 'cs2-gsi' as const,
    ...(providerTimestampSeconds === undefined ? {} : { providerTimestampSeconds }),
  };

  return {
    ok: true,
    observation: {
      receive: { ...receiveContext },
      source,
      coverage,
      telemetry,
    },
    diagnostics: diagnostics.toBatch(),
  };
}
