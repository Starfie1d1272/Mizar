import type { ObservedVector3 } from '@mizar/core/telemetry';

export type RadarLayer = 'single' | 'upper' | 'lower' | 'unknown';

export type RadarLayerRule =
  { readonly kind: 'single' } | { readonly kind: 'z-threshold'; readonly splitZ: number };

export interface MapGeometry {
  /** Provider-canonical map id, e.g. de_mirage. */
  readonly mapKey: string;

  /** Auditable calibration snapshot revision. */
  readonly calibrationRevision: string;

  /** Upper-left world coordinate represented by radar (0, 0). */
  readonly originWorld: {
    readonly x: number;
    readonly y: number;
  };

  /** Valve overview scale: world units per reference radar pixel. */
  readonly scaleWorldUnitsPerPixel: number;

  /** Calibration reference raster size; not a renderer/CSS size. */
  readonly referenceSize: {
    readonly width: number;
    readonly height: number;
  };

  readonly layerRule: RadarLayerRule;
}

export interface MapGeometryProvider {
  /** Resolve a map identifier supported by this provider; return null when unresolved. */
  resolve(mapName: string | null): MapGeometry | null;
}

export interface RadarCoordinate {
  /** Unclamped normalized overview coordinate; 0 = left, 1 = right. */
  readonly x: number;
  /** Unclamped normalized overview coordinate; 0 = top, 1 = bottom. */
  readonly y: number;
  /** True iff x or y lies outside inclusive [0, 1]. */
  readonly outOfBounds: boolean;
}

export interface RadarProjectedPosition extends RadarCoordinate {
  readonly layer: RadarLayer;
}

export interface RadarDirection {
  /** Unit vector in radar image axes. */
  readonly x: number;
  readonly y: number;
}

function hasUsableCalibration(geometry: MapGeometry): boolean {
  return (
    Number.isFinite(geometry.originWorld.x) &&
    Number.isFinite(geometry.originWorld.y) &&
    Number.isFinite(geometry.scaleWorldUnitsPerPixel) &&
    geometry.scaleWorldUnitsPerPixel > 0 &&
    Number.isFinite(geometry.referenceSize.width) &&
    geometry.referenceSize.width > 0 &&
    Number.isFinite(geometry.referenceSize.height) &&
    geometry.referenceSize.height > 0
  );
}

export function classifyRadarLayer(z: number | null, geometry: MapGeometry): RadarLayer {
  if (geometry.layerRule.kind === 'single') {
    return 'single';
  }

  if (z === null || !Number.isFinite(z) || !Number.isFinite(geometry.layerRule.splitZ)) {
    return 'unknown';
  }

  return z < geometry.layerRule.splitZ ? 'lower' : 'upper';
}

export function projectWorldPosition(
  position: ObservedVector3 | null,
  geometry: MapGeometry,
): RadarProjectedPosition | null {
  if (
    position === null ||
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !hasUsableCalibration(geometry)
  ) {
    return null;
  }

  const pixelX = (position.x - geometry.originWorld.x) / geometry.scaleWorldUnitsPerPixel;
  const pixelY = (geometry.originWorld.y - position.y) / geometry.scaleWorldUnitsPerPixel;
  const x = pixelX / geometry.referenceSize.width;
  const y = pixelY / geometry.referenceSize.height;

  return {
    x,
    y,
    outOfBounds: x < 0 || x > 1 || y < 0 || y > 1,
    layer: classifyRadarLayer(position.z, geometry),
  };
}

export function projectWorldDirection(forward: ObservedVector3 | null): RadarDirection | null {
  if (forward === null) {
    return null;
  }

  const planarLength = Math.hypot(forward.x, forward.y);

  if (!Number.isFinite(planarLength) || planarLength === 0) {
    return null;
  }

  return {
    x: forward.x / planarLength,
    y: -forward.y / planarLength,
  };
}

/** Presentation distances share the same calibration owner as positions. */
export function projectWorldRadius(worldRadius: number, geometry: MapGeometry): number | null {
  if (!Number.isFinite(worldRadius) || worldRadius < 0 || !hasUsableCalibration(geometry))
    return null;
  return worldRadius / (geometry.scaleWorldUnitsPerPixel * geometry.referenceSize.width);
}
