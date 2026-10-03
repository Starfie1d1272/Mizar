import type { RadarViewFrame, RadarPlayer, RadarUtility, RadarBomb, RadarLayer } from './types.js';

/** Structural subset of LiveSnapshotV1.radar, also preserved by RivalHub public Live. */
export interface PublicRadarInput {
  readonly mapName: string;
  readonly calibrationRevision: string;
  readonly layers: readonly RadarLayer[];
  readonly activeLayer: RadarLayer | null;
  readonly players: readonly RadarPlayer[];
  readonly bomb: RadarBomb | null;
  readonly utility: readonly RadarUtility[];
}
export interface PublicRadarContext {
  readonly boundary: string;
  readonly sequence: number;
  /** The host has accepted the current connection, freshness and identity. */
  readonly current: boolean;
  readonly sampleGapMs?: number;
  readonly bomb?: Pick<RadarBomb, 'state' | 'sourcePlayerId'> | null;
}
export function fromPublicRadar(
  radar: PublicRadarInput | null,
  context: PublicRadarContext,
): RadarViewFrame | null {
  if (!context.current || !radar) return null;
  return {
    boundary: context.boundary,
    sequence: context.sequence,
    sampleGapMs: context.sampleGapMs ?? 1500,
    mapName: radar.mapName,
    calibrationRevision: radar.calibrationRevision,
    layers: radar.layers,
    activeLayer: radar.activeLayer,
    payload: {
      players: radar.players,
      bomb:
        radar.bomb || context.bomb
          ? { position: radar.bomb?.position ?? null, ...context.bomb }
          : null,
      grenades: radar.utility,
    },
  };
}
