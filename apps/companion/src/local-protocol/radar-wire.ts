import type { RadarPayload } from '@mizar/protocol/radar';
import type { RadarFrame } from '@mizar/radar';

export function mapRadarFrame(frame: RadarFrame): RadarPayload {
  return {
    telemetryFreshness: frame.telemetryFreshness,
    identityState: frame.identityState,
    mapName: frame.mapName,
    observedPlayerSourceId: frame.observedPlayerSourceId,
    coverage: frame.coverage,
    players: frame.players.map((player) => ({ ...player })),
    bomb: frame.bomb,
    grenades: frame.grenades.map((grenade) => ({
      ...grenade,
      flames: grenade.flames.map((flame) => ({ ...flame })),
    })),
  };
}
