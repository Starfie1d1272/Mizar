import { DEFAULT_THEME_RECIPE, REFERENCE_THEME_COLORS } from './default-theme.js';
import type { HudBroadcastStyleDefinition } from '../types.js';

export const IEM_STYLE = {
  style: 'iem',
  label: '类 IEM',
  widgetDimensions: { 'round-history': { width: 720, height: 84 } },
  layout: {
    name: 'IEM 布局',
    widgets: {
      'round-history': { visible: true, anchor: 'top-center', offsetX: 0, offsetY: 132 },
    },
  },
  showTeamName: true,
  recipe: {
    ...DEFAULT_THEME_RECIPE,
    id: 'iem',
    colors: { ...REFERENCE_THEME_COLORS, sideCt: '#203995', sideT: '#a9911c' },
    surfaces: {
      solid: { primary: '#071658', strong: '#02082c', opacity: 0.98, borderOpacity: 0.28 },
      standard: { primary: '#071658', strong: '#02082c', opacity: 0.88, borderOpacity: 0.16 },
      light: { primary: '#071658', strong: '#02082c', opacity: 0.7, borderOpacity: 0.14 },
    },
  },
} satisfies HudBroadcastStyleDefinition;
