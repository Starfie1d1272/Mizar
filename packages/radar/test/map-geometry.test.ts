import { describe, expect, it } from 'vitest';

import type { MapGeometry } from '../src/map-geometry.js';
import {
  classifyRadarLayer,
  projectWorldDirection,
  projectWorldPosition,
} from '../src/map-geometry.js';

const MIRAGE: MapGeometry = {
  mapKey: 'de_mirage',
  calibrationRevision: 'cs2-overview/2026-09-16',
  originWorld: { x: -3230, y: 1713 },
  scaleWorldUnitsPerPixel: 5,
  referenceSize: { width: 1024, height: 1024 },
  layerRule: { kind: 'single' },
};

const SPLIT_GEOMETRY: MapGeometry = {
  ...MIRAGE,
  mapKey: 'de_nuke',
  layerRule: { kind: 'z-threshold', splitZ: -495 },
};

const CUSTOM_GEOMETRY: MapGeometry = {
  ...MIRAGE,
  mapKey: 'workshop/custom-map',
  calibrationRevision: 'custom-provider/1',
};

describe('Radar map geometry', () => {
  it('projects Mirage world coordinates with the frozen translation, scale, and Y flip', () => {
    const origin = projectWorldPosition({ x: -3230, y: 1713, z: 12 }, MIRAGE);
    const center = projectWorldPosition({ x: -670, y: -847, z: 12 }, MIRAGE);
    const lowerRight = projectWorldPosition({ x: 1890, y: -3407, z: 12 }, MIRAGE);
    const outside = projectWorldPosition({ x: -3235, y: 1713, z: 12 }, MIRAGE);

    expect(origin?.x).toBeCloseTo(0, 12);
    expect(origin?.y).toBeCloseTo(0, 12);
    expect(origin?.outOfBounds).toBe(false);
    expect(origin?.layer).toBe('single');
    expect(center?.x).toBeCloseTo(0.5, 12);
    expect(center?.y).toBeCloseTo(0.5, 12);
    expect(center?.outOfBounds).toBe(false);
    expect(center?.layer).toBe('single');
    expect(lowerRight?.x).toBeCloseTo(1, 12);
    expect(lowerRight?.y).toBeCloseTo(1, 12);
    expect(lowerRight?.outOfBounds).toBe(false);
    expect(lowerRight?.layer).toBe('single');
    expect(outside?.x).toBe(-1 / 1024);
    expect(outside?.y).toBe(0);
    expect(outside?.outOfBounds).toBe(true);
  });

  it('keeps pure geometry projection provider-neutral', () => {
    const projected = projectWorldPosition({ x: -670, y: -847, z: 0 }, CUSTOM_GEOMETRY);

    expect(CUSTOM_GEOMETRY.mapKey).toBe('workshop/custom-map');
    expect(projected?.x).toBeCloseTo(0.5, 12);
    expect(projected?.y).toBeCloseTo(0.5, 12);
    expect(projected?.layer).toBe('single');
  });

  it('keeps projected coordinates unclamped and classifies split-map layers independently', () => {
    const projected = projectWorldPosition({ x: -3230, y: 1713, z: -496 }, SPLIT_GEOMETRY);
    const upper = projectWorldPosition({ x: -3230, y: 1713, z: -495 }, SPLIT_GEOMETRY);
    const unknown = projectWorldPosition({ x: -3230, y: 1713, z: Number.NaN }, SPLIT_GEOMETRY);
    const farOutside = projectWorldPosition({ x: 2000, y: -4000, z: 0 }, MIRAGE);

    expect(projected?.layer).toBe('lower');
    expect(upper?.layer).toBe('upper');
    expect(unknown?.layer).toBe('unknown');
    expect(farOutside).toMatchObject({ outOfBounds: true });
    expect(farOutside?.x).toBeGreaterThan(1);
    expect(farOutside?.y).toBeGreaterThan(1);
  });

  it('returns single for single-layer maps regardless of Z availability', () => {
    expect(classifyRadarLayer(null, MIRAGE)).toBe('single');
    expect(classifyRadarLayer(Number.NaN, MIRAGE)).toBe('single');
    expect(classifyRadarLayer(123, MIRAGE)).toBe('single');
  });

  it('returns null for null positions and non-finite planar directions', () => {
    expect(projectWorldPosition(null, MIRAGE)).toBeNull();
    expect(projectWorldDirection(null)).toBeNull();
    expect(projectWorldDirection({ x: 0, y: 0, z: 1 })).toBeNull();
    expect(projectWorldDirection({ x: Number.NaN, y: 1, z: 0 })).toBeNull();
    expect(projectWorldDirection({ x: Number.POSITIVE_INFINITY, y: 0, z: 0 })).toBeNull();
  });

  it('rejects non-finite or non-positive geometry calibration values', () => {
    expect(
      projectWorldPosition(
        { x: -3230, y: 1713, z: 0 },
        { ...MIRAGE, originWorld: { x: Number.NaN, y: 1713 } },
      ),
    ).toBeNull();
    expect(
      projectWorldPosition({ x: -3230, y: 1713, z: 0 }, { ...MIRAGE, scaleWorldUnitsPerPixel: 0 }),
    ).toBeNull();
    expect(
      projectWorldPosition(
        { x: -3230, y: 1713, z: 0 },
        { ...MIRAGE, referenceSize: { width: 0, height: 1024 } },
      ),
    ).toBeNull();
    expect(
      projectWorldPosition(
        { x: -3230, y: 1713, z: 0 },
        { ...MIRAGE, referenceSize: { width: 1024, height: -1 } },
      ),
    ).toBeNull();
  });

  it('projects world forward vectors into radar-space unit vectors', () => {
    expect(projectWorldDirection({ x: 1, y: 0, z: 10 })?.x).toBeCloseTo(1, 12);
    expect(projectWorldDirection({ x: 1, y: 0, z: 10 })?.y).toBeCloseTo(0, 12);
    expect(projectWorldDirection({ x: 0, y: 1, z: 10 })?.x).toBeCloseTo(0, 12);
    expect(projectWorldDirection({ x: 0, y: 1, z: 10 })?.y).toBeCloseTo(-1, 12);
    expect(projectWorldDirection({ x: 0, y: -1, z: 10 })?.x).toBeCloseTo(0, 12);
    expect(projectWorldDirection({ x: 0, y: -1, z: 10 })?.y).toBeCloseTo(1, 12);

    const diagonal = projectWorldDirection({ x: 1, y: 1, z: 10 });
    expect(diagonal?.x).toBeCloseTo(Math.SQRT1_2, 12);
    expect(diagonal?.y).toBeCloseTo(-Math.SQRT1_2, 12);
    expect(Math.hypot(diagonal?.x ?? 0, diagonal?.y ?? 0)).toBeCloseTo(1, 12);
  });
});
