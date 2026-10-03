export const RADAR_CANVAS_GEOMETRY = Object.freeze({
  logicalSize: 1000,
  inset: 10,
  artworkSize: 980,
});

export interface NormalizedRadarPoint {
  readonly x: number;
  readonly y: number;
}

export interface RadarCanvasViewport {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RadarCanvasRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface RadarCanvasPlacement {
  readonly viewport: RadarCanvasViewport;
  readonly rect: RadarCanvasRect;
}

/**
 * EWC-style Nuke composition: the canonical upper overview remains the dominant
 * map while the lower/B-site view is detached underneath it. Both placements
 * still use the same Valve 1024 overview calibration; only presentation changes.
 */
const ANCIENT_PLACEMENT: RadarCanvasPlacement = Object.freeze({
  viewport: Object.freeze({ x: 0.095, y: 0.025, width: 0.81, height: 0.95 }),
  rect: Object.freeze({ x: 55, y: 4, width: 890, height: 992 }),
});

const VERTIGO_PLACEMENT: RadarCanvasPlacement = Object.freeze({
  viewport: Object.freeze({ x: 0.075, y: 0.1, width: 0.78, height: 0.78 }),
  rect: Object.freeze({ x: 25, y: 15, width: 950, height: 950 }),
});

const NUKE_UPPER_PLACEMENT: RadarCanvasPlacement = Object.freeze({
  viewport: Object.freeze({ x: 0.04, y: 0.22, width: 0.94, height: 0.56 }),
  rect: Object.freeze({ x: 0, y: 0, width: 980, height: 595 }),
});

const NUKE_LOWER_PLACEMENT: RadarCanvasPlacement = Object.freeze({
  viewport: Object.freeze({ x: 0.5, y: 0.28, width: 0.2, height: 0.52 }),
  rect: Object.freeze({ x: 90, y: 460, width: 280, height: 540 }),
});

export function radarBroadcastPlacement(
  mapKey: string,
  layer: string,
): RadarCanvasPlacement | null {
  if (mapKey === 'de_ancient') return ANCIENT_PLACEMENT;
  if (mapKey === 'de_vertigo') return VERTIGO_PLACEMENT;
  if (mapKey !== 'de_nuke') return null;
  return layer === 'lower' ? NUKE_LOWER_PLACEMENT : NUKE_UPPER_PLACEMENT;
}

export function radarCanvasArtworkRect(viewport: RadarCanvasViewport | null): RadarCanvasRect {
  if (viewport === null) {
    return {
      x: RADAR_CANVAS_GEOMETRY.inset,
      y: RADAR_CANVAS_GEOMETRY.inset,
      width: RADAR_CANVAS_GEOMETRY.artworkSize,
      height: RADAR_CANVAS_GEOMETRY.artworkSize,
    };
  }
  const aspect = viewport.width / viewport.height;
  const width =
    aspect >= 1 ? RADAR_CANVAS_GEOMETRY.artworkSize : RADAR_CANVAS_GEOMETRY.artworkSize * aspect;
  const height =
    aspect >= 1 ? RADAR_CANVAS_GEOMETRY.artworkSize / aspect : RADAR_CANVAS_GEOMETRY.artworkSize;
  return {
    x: (RADAR_CANVAS_GEOMETRY.logicalSize - width) / 2,
    y: (RADAR_CANVAS_GEOMETRY.logicalSize - height) / 2,
    width,
    height,
  };
}

export function radarPointInsideViewport(
  point: NormalizedRadarPoint,
  viewport: RadarCanvasViewport,
): boolean {
  return (
    point.x >= viewport.x &&
    point.x <= viewport.x + viewport.width &&
    point.y >= viewport.y &&
    point.y <= viewport.y + viewport.height
  );
}

/** Map pixels and projected entities share the same normalized 1024 overview. */
export function radarCanvasPoint(
  point: NormalizedRadarPoint,
  viewport: RadarCanvasViewport | null = null,
  rectOverride: RadarCanvasRect | null = null,
) {
  if (viewport === null) {
    return {
      x: RADAR_CANVAS_GEOMETRY.inset + point.x * RADAR_CANVAS_GEOMETRY.artworkSize,
      y: RADAR_CANVAS_GEOMETRY.inset + point.y * RADAR_CANVAS_GEOMETRY.artworkSize,
    };
  }
  const rect = rectOverride ?? radarCanvasArtworkRect(viewport);
  return {
    x: rect.x + ((point.x - viewport.x) / viewport.width) * rect.width,
    y: rect.y + ((point.y - viewport.y) / viewport.height) * rect.height,
  };
}

/** Radius projections are normalized to the same display transform as points. */
export function radarCanvasRadius(
  normalizedRadius: number,
  viewport: RadarCanvasViewport | null = null,
  rectOverride: RadarCanvasRect | null = null,
): number {
  if (viewport === null) return normalizedRadius * RADAR_CANVAS_GEOMETRY.artworkSize;
  const rect = rectOverride ?? radarCanvasArtworkRect(viewport);
  return normalizedRadius * (rect.width / viewport.width);
}
