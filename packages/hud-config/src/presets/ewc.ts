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
  },
} satisfies HudBroadcastStyleDefinition;
