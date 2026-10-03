import type { RadarSnapshot } from '@mizar/protocol/radar';
import type { RadarViewFrame } from '@mizar-hud/radar-view';
import {
  defaultMapGeometryProvider,
  projectWorldPosition,
  projectWorldDirection,
  projectWorldRadius,
  selectActiveRadarLayer,
} from '@mizar/radar';
import { resolveCs2ItemByGsiName } from '@mizar/cs2-assets';
import { observerHotkeyLabel } from '../../observer-hotkey';

/** Local protocol and world calibration stay in Mizar's adapter. */
export function toRadarViewFrame(snapshot: RadarSnapshot | null): RadarViewFrame | null {
  if (
    !snapshot ||
    snapshot.payload.telemetryFreshness !== 'fresh' ||
    snapshot.payload.identityState === 'mismatch'
  )
    return null;
  const geometry = defaultMapGeometryProvider.resolve(snapshot.payload.mapName);
  if (!geometry) return null;
  const unitRadius = projectWorldRadius(1, geometry)!;
  const project = (position: { x: number; y: number; z: number } | null) => {
    const point = projectWorldPosition(position, geometry);
    return point && position ? { ...point, z: position.z * unitRadius } : null;
  };
  const { cursor: c, payload: p } = snapshot;
  return {
    boundary: JSON.stringify([
      c.producerInstanceId,
      c.liveSessionId,
      c.programSourceGeneration,
      c.mapEpoch,
    ]),
    sequence: snapshot.channelSeq,
    sampleSequence: c.programReceiveSequence,
    mapName: geometry.mapKey,
    calibrationRevision: geometry.calibrationRevision,
    layers: geometry.layerRule.kind === 'single' ? ['single'] : ['upper', 'lower'],
    activeLayer: selectActiveRadarLayer(p, geometry),
    payload: {
      observedPlayerSourceId: p.observedPlayerSourceId,
      retainEffectAnchors: true,
      playersComplete: p.coverage.allPlayers === 'present',
      players: p.players.map((player) => {
        const item = resolveCs2ItemByGsiName(player.activeWeapon?.name ?? '');
        return {
          sourcePlayerId: player.sourcePlayerId,
          side: player.side,
          lifeState: player.lifeState,
          position: project(player.position),
          facing: projectWorldDirection(player.forward),
          label: observerHotkeyLabel(player.observerSlot),
          health: player.health,
          flashAmount: player.flashAmount,
          activeWeapon: player.activeWeapon
            ? {
                ...player.activeWeapon,
                firearm: item.kind === 'known' && item.item.kind === 'firearm',
              }
            : null,
        };
      }),
      bomb: p.bomb ? { ...p.bomb, position: project(p.bomb.position) } : null,
      grenades: p.grenades.map((g) => ({
        sourceEntityId: g.sourceEntityId,
        kind: g.kind,
        ownerSourceId: g.ownerSourceId,
        position: project(g.position),
        lifetimeSeconds: g.lifetimeSeconds,
        effectTimeSeconds: g.effectTimeSeconds,
        moving:
          g.velocity === null ? null : Math.hypot(g.velocity.x, g.velocity.y, g.velocity.z) > 0.01,
        flames: g.flames.flatMap((f) => {
          const position = project(f.position);
          return position ? [{ sourceFlameId: f.sourceFlameId, position }] : [];
        }),
      })),
    },
  };
}
