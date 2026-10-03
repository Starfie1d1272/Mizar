import { describe, expect, it } from 'vitest';
import { radarCanvasPoint, radarCanvasRadius } from '@mizar/radar-view/geometry';

describe('Radar shared overview canvas', () => {
  it('maps every floor through the same 1024 overview transform', () => {
    expect(radarCanvasPoint({ x: 0, y: 0 })).toEqual({ x: 10, y: 10 });
    expect(radarCanvasPoint({ x: 1, y: 1 })).toEqual({ x: 990, y: 990 });
    expect(radarCanvasPoint({ x: 0.5, y: 0.5 })).toEqual({ x: 500, y: 500 });
  });

  it('scales radii against the same artwork extent', () => {
    expect(radarCanvasRadius(0.025)).toBe(24.5);
  });
});
