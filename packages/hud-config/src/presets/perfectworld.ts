import { DEFAULT_THEME_RECIPE } from './default-theme.js';
import type { HudBroadcastStyleDefinition } from '../types.js';

export const PERFECTWORLD_STYLE = {
  style: 'perfectworld',
  label: '类 Perfect World',
  showTeamName: false,
  widgetDimensions: {
    'round-history': { width: 720, height: 84 },
    'top-score-bar': { width: 800, height: 210 },
    'focused-player': { width: 342, height: 192 },
  },
  recipe: {
    ...DEFAULT_THEME_RECIPE,
    id: 'perfectworld',
    colors: {
      ...DEFAULT_THEME_RECIPE.colors,
      sideCt: '#478af0',
      sideT: '#e6a91d',
      stateSuccess: '#5dde74',
      objectiveBomb: '#f34d83',
      objectiveDefuse: '#30c853',
    },
    surfaces: {
      solid: { primary: '#333335', strong: '#242426', opacity: 0.98, borderOpacity: 0.28 },
      standard: { primary: '#333335', strong: '#242426', opacity: 0.88, borderOpacity: 0.16 },
      light: { primary: '#333335', strong: '#242426', opacity: 0.7, borderOpacity: 0.14 },
    },
  },
  layout: {
    name: '上海布局',
    widgets: {
      'round-history': { visible: true, anchor: 'top-center', offsetX: 0, offsetY: 104 },
      'top-score-bar': {
        visible: true,
        anchor: 'top-center',
        offsetX: 0,
        offsetY: 6,
        size: { width: 800, height: 210 },
      },
      'team-ct-rail': { visible: true, anchor: 'top-left', offsetX: 20, offsetY: 492 },
      'team-t-rail': { visible: true, anchor: 'top-right', offsetX: -20, offsetY: 492 },
      'series-strip': { visible: true, anchor: 'top-left', offsetX: 6, offsetY: 6 },
      'series-overview': { visible: true, anchor: 'top-right', offsetX: -6, offsetY: 6 },
      radar: {
        visible: true,
        anchor: 'top-left',
        offsetX: 6,
        offsetY: 58,
        size: { width: 360, height: 360 },
      },
      'focused-player': {
        visible: true,
        anchor: 'bottom-center',
        offsetX: 0,
        offsetY: -20,
        size: { width: 342, height: 192 },
      },
    },
  },
} satisfies HudBroadcastStyleDefinition;
