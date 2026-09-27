import type { RadarLayerRule } from './map-geometry.js';

/**
 * Mizar-owned, checked-in V1 calibration snapshot.
 *
 * The numeric values originate from CS2 overview metadata (`pos_x`, `pos_y`,
 * `scale`, and vertical sections). This snapshot was re-audited on
 * 2026-09-16 and cross-checked against established implementations, including
 * DAK, without making DAK a runtime owner or update source. Calibration changes
 * require an explicit revision, fixture updates, and human-reviewable anchors.
 * Valve game files are intentionally not read at runtime.
 */
export const RADAR_CALIBRATION_REVISION = 'cs2-overview/2026-09-16' as const;

export const SUPPORTED_RADAR_MAP_KEYS = [
  'de_dust2',
  'de_mirage',
  'de_inferno',
  'de_nuke',
  'de_ancient',
  'de_anubis',
  'de_cache',
  'de_overpass',
  'de_train',
  'de_vertigo',
] as const;

export type SupportedRadarMapKey = (typeof SUPPORTED_RADAR_MAP_KEYS)[number];

export interface RadarCalibrationSnapshot {
  readonly mapKey: SupportedRadarMapKey;
  readonly posX: number;
  readonly posY: number;
  readonly scale: number;
  readonly radarSize: number;
  readonly layerRule: RadarLayerRule;
}

/** Internal snapshot; raw calibration records are not package-root exports. */
export const RADAR_CALIBRATIONS = {
  de_dust2: {
    mapKey: 'de_dust2',
    posX: -2476,
    posY: 3239,
    scale: 4.4,
    radarSize: 1024,
    layerRule: { kind: 'single' },
  },
  de_mirage: {
    mapKey: 'de_mirage',
    posX: -3230,
    posY: 1713,
    scale: 5,
    radarSize: 1024,
    layerRule: { kind: 'single' },
  },
  de_inferno: {
    mapKey: 'de_inferno',
    posX: -2087,
    posY: 3870,
    scale: 4.9,
    radarSize: 1024,
    layerRule: { kind: 'single' },
  },
  de_nuke: {
    mapKey: 'de_nuke',
    posX: -3453,
    posY: 2887,
    scale: 7,
    radarSize: 1024,
    layerRule: { kind: 'z-threshold', splitZ: -495 },
  },
  de_ancient: {
    mapKey: 'de_ancient',
    posX: -2953,
    posY: 2164,
    scale: 5,
    radarSize: 1024,
    layerRule: { kind: 'single' },
  },
  de_anubis: {
    mapKey: 'de_anubis',
    posX: -2796,
    posY: 3328,
    scale: 5.22,
    radarSize: 1024,
    layerRule: { kind: 'single' },
  },
  de_cache: {
    mapKey: 'de_cache',
    posX: -2000,
    posY: 3250,
    scale: 5.5,
    radarSize: 1024,
    layerRule: { kind: 'single' },
  },
  de_overpass: {
    mapKey: 'de_overpass',
    posX: -4831,
    posY: 1781,
    scale: 5.2,
    radarSize: 1024,
    layerRule: { kind: 'single' },
  },
  de_train: {
    mapKey: 'de_train',
    posX: -2308,
    posY: 2078,
    scale: 4.082077,
    radarSize: 1024,
    layerRule: { kind: 'z-threshold', splitZ: -50 },
  },
  de_vertigo: {
    mapKey: 'de_vertigo',
    posX: -3168,
    posY: 1762,
    scale: 4,
    radarSize: 1024,
    layerRule: { kind: 'z-threshold', splitZ: 11700 },
  },
} as const satisfies Readonly<Record<SupportedRadarMapKey, RadarCalibrationSnapshot>>;
