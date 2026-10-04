import type { HudWidgetId } from './types.js';

export const WIDGET_DIMENSIONS: Record<
  HudWidgetId,
  { readonly width: number; readonly height: number }
> = {
  'top-score-bar': { width: 480, height: 152 },
  'team-ct-rail': { width: 440, height: 478 },
  'team-t-rail': { width: 440, height: 478 },
  radar: { width: 400, height: 400 },
  'focused-player': { width: 360, height: 176 },
  'series-strip': { width: 400, height: 72 },
  'series-overview': { width: 340, height: 180 },
  'round-history': { width: 560, height: 56 },
  objective: { width: 360, height: 160 },
  'round-result': { width: 500, height: 160 },
};
