import type { RadarFrame } from './frame.js';
import { defaultMapGeometryProvider } from './default-map-geometry-provider.js';
import {
  projectWorldDirection,
  projectWorldPosition,
  type MapGeometry,
  type RadarLayer,
} from './map-geometry.js';

type KnownLayer = Exclude<RadarLayer, 'unknown'>;

/** Shared stateless floor selection; renderer animation/history never enters this decision. */
export function selectActiveRadarLayer(
  frame: Pick<RadarFrame, 'players' | 'observedPlayerSourceId'>,
  geometry: MapGeometry,
): RadarLayer {
  if (geometry.layerRule.kind === 'single') return 'single';
  const focused = frame.players.find((p) => p.sourcePlayerId === frame.observedPlayerSourceId);
  const focusPosition = focused && projectWorldPosition(focused.position, geometry);
  if (focusPosition && !focusPosition.outOfBounds && focusPosition.layer !== 'unknown')
    return focusPosition.layer;
  let upper = 0;
  let lower = 0;
  for (const player of frame.players) {
    if (player.lifeState !== 'alive') continue;
    const point = projectWorldPosition(player.position, geometry);
    if (!point || point.outOfBounds) continue;
    if (point.layer === 'upper') upper++;
    if (point.layer === 'lower') lower++;
  }
  return upper === lower ? 'unknown' : upper > lower ? 'upper' : 'lower';
}

/** Current Program Radar only. No clamping, retained positions, guessed lifecycle or smoothing. */
export function projectPublicRadarFrame(frame: RadarFrame) {
  if (frame.telemetryFreshness !== 'fresh' || frame.identityState === 'mismatch') return null;
  const geometry = defaultMapGeometryProvider.resolve(frame.mapName);
  if (geometry === null) return null;
  const project = (world: RadarFrame['players'][number]['position']) => {
    const point = projectWorldPosition(world, geometry);
    return point === null || point.outOfBounds || point.layer === 'unknown'
      ? null
      : { x: point.x, y: point.y, layer: point.layer };
  };
  const activeLayer = selectActiveRadarLayer(frame, geometry);
  return {
    mapName: geometry.mapKey,
    calibrationRevision: geometry.calibrationRevision,
    layers: (geometry.layerRule.kind === 'single'
      ? ['single']
      : ['upper', 'lower']) as KnownLayer[],
    activeLayer: activeLayer === 'unknown' ? null : activeLayer,
    players: frame.players.map((player) => ({
      sourcePlayerId: player.sourcePlayerId,
      canonicalPlayerId: player.canonicalPlayerId,
      side: player.side,
      lifeState: player.lifeState,
      position: project(player.position),
      facing: player.lifeState === 'alive' ? projectWorldDirection(player.forward) : null,
    })),
    bomb: frame.bomb === null ? null : { position: project(frame.bomb.position) },
    utility: frame.grenades.map((grenade) => ({
      sourceEntityId: grenade.sourceEntityId,
      kind: grenade.kind,
      ownerSourceId: grenade.ownerSourceId,
      position: project(grenade.position),
      lifetimeSeconds: grenade.lifetimeSeconds,
      effectTimeSeconds: grenade.effectTimeSeconds,
      flames: grenade.flames.flatMap((flame) => {
        const position = project(flame.position);
        return position === null ? [] : [{ sourceFlameId: flame.sourceFlameId, position }];
      }),
    })),
  };
}
