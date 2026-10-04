import { DEFAULT_THEME_RECIPE } from './default-theme.js';
import type { HudBroadcastStyleDefinition } from '../types.js';

export const EWC_STYLE = {
  style: 'ewc',
  label: '类 EWC',
  widgetDimensions: { 'round-history': { width: 720, height: 84 } },
  layout: {
    name: 'EWC 布局',
    widgets: {
      'round-history': { visible: true, anchor: 'top-center', offsetX: 0, offsetY: 132 },
    },
  },
  showTeamName: false,
  recipe: {
    ...DEFAULT_THEME_RECIPE,
    id: 'ewc',
    colors: { ...DEFAULT_THEME_RECIPE.colors, sideCt: '#3864c3', sideT: '#b69117' },
    // Keep the established EWC material independent of the evolving native default.
    surfaces: {
      solid: { primary: '#10151d', strong: '#080c12', opacity: 0.98, borderOpacity: 0.28 },
      standard: { primary: '#111923', strong: '#0b1119', opacity: 0.88, borderOpacity: 0.16 },
      light: { primary: '#17222d', strong: '#111a22', opacity: 0.7, borderOpacity: 0.14 },
    },
  },
} satisfies HudBroadcastStyleDefinition;
