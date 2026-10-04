import { describe, expect, it } from 'vitest';
import {
  radarCanvasPoint,
  radarCanvasRadius,
  radarBroadcastPlacement,
} from '@mizar-hud/radar-view/geometry';

describe('Radar shared overview canvas', () => {
  it('maps every floor through the same 1024 overview transform', () => {
    expect(radarCanvasPoint({ x: 0, y: 0 })).toEqual({ x: 10, y: 10 });
    expect(radarCanvasPoint({ x: 1, y: 1 })).toEqual({ x: 990, y: 990 });
    expect(radarCanvasPoint({ x: 0.5, y: 0.5 })).toEqual({ x: 500, y: 500 });
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
    expect(radarBroadcastPlacement('de_nuke', 'lower')?.rect).toEqual({
      x: 90,
      y: 460,
      width: 280,
      height: 540,
    });
  });
});
