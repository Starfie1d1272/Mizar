import {
  RADAR_CALIBRATION_REVISION,
  RADAR_CALIBRATIONS,
  SUPPORTED_RADAR_MAP_KEYS,
  type RadarCalibrationSnapshot,
  type SupportedRadarMapKey,
} from './cs2-overview-calibrations.js';
import { canonicalizeCs2MapName } from '@mizar/core/map-name';
import type { MapGeometry, MapGeometryProvider } from './map-geometry.js';

const EXPECTED_SPLIT_Z: Readonly<Partial<Record<SupportedRadarMapKey, number>>> = {
  de_nuke: -495,
  de_train: -50,
  de_vertigo: 11700,
};

function fail(mapKey: string, message: string): never {
  throw new Error(`Invalid radar calibration for ${mapKey}: ${message}`);
}

function requireFinite(mapKey: string, field: string, value: number): void {
  if (!Number.isFinite(value)) {
    fail(mapKey, `${field} must be finite`);
  }
}

function snapshotKeysMatchSupportedSet(): boolean {
  const supported = [...SUPPORTED_RADAR_MAP_KEYS].sort();
  const snapshot = Object.keys(RADAR_CALIBRATIONS).sort();
  return (
    supported.length === snapshot.length &&
    supported.every((mapKey, index) => mapKey === snapshot[index])
  );
}

function validateCalibrationSnapshot(): void {
  if (RADAR_CALIBRATION_REVISION.trim().length === 0) {
    fail('snapshot', 'calibrationRevision must not be empty');
  }
  if (new Set(SUPPORTED_RADAR_MAP_KEYS).size !== SUPPORTED_RADAR_MAP_KEYS.length) {
    fail('snapshot', 'supported map keys must be unique');
  }
  if (!snapshotKeysMatchSupportedSet()) {
    fail('snapshot', 'snapshot keys must exactly match supported map keys');
  }

  for (const mapKey of SUPPORTED_RADAR_MAP_KEYS) {
    const calibration = RADAR_CALIBRATIONS[mapKey];
    if (calibration === undefined) {
      fail(mapKey, 'calibration is missing');
    }
    validateCalibration(mapKey, calibration);
  }
}

function validateCalibration(
  mapKey: SupportedRadarMapKey,
  calibration: RadarCalibrationSnapshot,
): void {
  if (calibration.mapKey !== mapKey) {
    fail(mapKey, `mapKey must equal ${mapKey}`);
  }
  requireFinite(mapKey, 'posX', calibration.posX);
  requireFinite(mapKey, 'posY', calibration.posY);
  requireFinite(mapKey, 'scale', calibration.scale);
  requireFinite(mapKey, 'radarSize', calibration.radarSize);
  if (calibration.scale <= 0) {
    fail(mapKey, 'scale must be greater than zero');
  }
  if (calibration.radarSize <= 0) {
    fail(mapKey, 'radarSize must be greater than zero');
  }

  const expectedSplitZ = EXPECTED_SPLIT_Z[mapKey];
  if (expectedSplitZ === undefined) {
    if (calibration.layerRule.kind !== 'single') {
      fail(mapKey, 'non-split map must use the single layer rule');
    }
    return;
  }

  if (calibration.layerRule.kind !== 'z-threshold') {
    fail(mapKey, 'split map must use the z-threshold layer rule');
  }
  requireFinite(mapKey, 'splitZ', calibration.layerRule.splitZ);
  if (calibration.layerRule.splitZ !== expectedSplitZ) {
    fail(mapKey, `splitZ must equal ${expectedSplitZ}`);
  }
}

function toMapGeometry(calibration: RadarCalibrationSnapshot): MapGeometry {
  return Object.freeze({
    mapKey: calibration.mapKey,
    calibrationRevision: RADAR_CALIBRATION_REVISION,
    originWorld: Object.freeze({ x: calibration.posX, y: calibration.posY }),
    scaleWorldUnitsPerPixel: calibration.scale,
    referenceSize: Object.freeze({
      width: calibration.radarSize,
      height: calibration.radarSize,
    }),
    layerRule: Object.freeze({ ...calibration.layerRule }),
  });
}

validateCalibrationSnapshot();

const MAP_GEOMETRIES = Object.freeze(
  Object.fromEntries(
    SUPPORTED_RADAR_MAP_KEYS.map((mapKey) => [mapKey, toMapGeometry(RADAR_CALIBRATIONS[mapKey])]),
  ) as Record<SupportedRadarMapKey, MapGeometry>,
);

function canonicalMapKey(mapName: string): SupportedRadarMapKey | undefined {
  const canonical = canonicalizeCs2MapName(mapName);
  return canonical !== null && SUPPORTED_RADAR_MAP_KEYS.includes(canonical as SupportedRadarMapKey)
    ? (canonical as SupportedRadarMapKey)
    : undefined;
}

export const defaultMapGeometryProvider: MapGeometryProvider = Object.freeze({
  resolve(mapName: string | null): MapGeometry | null {
    if (mapName === null) {
      return null;
    }

    const mapKey = canonicalMapKey(mapName);
    return mapKey === undefined ? null : MAP_GEOMETRIES[mapKey];
  },
});
