import { describe, expect, it } from 'vitest';
import {
  radarCanvasPoint,
  radarCanvasRadius,
  radarBroadcastPlacement,
} from '../src/canvas-geometry.js';

describe('Radar shared overview canvas', () => {
  it('maps every floor through the same 1024 overview transform', () => {
    expect(radarCanvasPoint({ x: 0, y: 0 })).toEqual({ x: 10, y: 10 });
    expect(radarCanvasPoint({ x: 1, y: 1 })).toEqual({ x: 990, y: 990 });
    expect(radarCanvasPoint({ x: 0.5, y: 0.5 })).toEqual({ x: 500, y: 500 });
  });

  it('uses the full canonical artwork for ESL without detaching or recalibrating floors', () => {
    for (const map of ['de_ancient', 'de_nuke', 'de_vertigo']) {
      expect(radarBroadcastPlacement(map, 'upper', 'esl')).toBeNull();
      expect(radarBroadcastPlacement(map, 'lower', 'esl')).toBeNull();
    }
  });
  it('scales radii against the same artwork extent', () => {
    expect(radarCanvasRadius(0.025)).toBe(24.5);
  });
  it('keeps Shanghai lower-floor entities aligned with the inset artwork', () => {
    const placement = radarBroadcastPlacement('de_nuke', 'lower', 'shanghai')!;
    expect(radarCanvasPoint({ x: 0.6, y: 0.54 }, placement.viewport, placement.rect)).toEqual({
      x: 275,
      y: 602.5,
    });
    const lower = radarBroadcastPlacement('de_nuke', 'lower')!;
    expect(lower.rect.x + lower.rect.width / 2).toBeCloseTo(230);
    expect(lower.rect.y + lower.rect.height / 2).toBeCloseTo(730);
  });
  it.each(['de_ancient', 'de_vertigo', 'de_nuke'])(
    'preserves a world-space circle in every %s crop',
    (map) => {
      for (const appearance of ['default', 'shanghai', 'esl'] as const) {
        for (const layer of ['upper', 'lower']) {
          const p = radarBroadcastPlacement(map, layer, appearance);
          const origin = radarCanvasPoint({ x: 0.5, y: 0.5 }, p?.viewport, p?.rect);
          const x = radarCanvasPoint({ x: 0.52, y: 0.5 }, p?.viewport, p?.rect);
          const y = radarCanvasPoint({ x: 0.5, y: 0.52 }, p?.viewport, p?.rect);
          const radius = radarCanvasRadius(0.02, p?.viewport, p?.rect);
          expect(x.x - origin.x).toBeCloseTo(radius);
          expect(y.y - origin.y).toBeCloseTo(radius);
        }
      }
    },
  );
});
