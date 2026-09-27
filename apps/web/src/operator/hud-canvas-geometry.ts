import { HUD_CANVAS_HEIGHT, HUD_CANVAS_WIDTH } from '@mizar/hud-config';

export interface HudLogicalPoint {
  readonly x: number;
  readonly y: number;
}

/** Convert a browser pointer coordinate into the fixed 1920 × 1080 HUD space. */
export function clientPointToHudLogicalPoint(
  clientX: number,
  clientY: number,
  rect: Pick<DOMRectReadOnly, 'left' | 'top' | 'width' | 'height'>,
): HudLogicalPoint {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: ((clientX - rect.left) / rect.width) * HUD_CANVAS_WIDTH,
    y: ((clientY - rect.top) / rect.height) * HUD_CANVAS_HEIGHT,
  };
}
