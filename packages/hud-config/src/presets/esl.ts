import { DEFAULT_THEME_RECIPE } from './default-theme.js';
import type { HudBroadcastStyleDefinition } from '../types.js';

/** Presentation adapted from the supplied overlay4 Vue reference, without its data adapters. */
export const ESL_STYLE = {
  style: 'esl',
  label: '类ESL',
  brandColor: '#0bf201',
  showTeamName: true,
  widgetDimensions: {
    'top-score-bar': { width: 440, height: 184 },
    'team-ct-rail': { width: 308, height: 444 },
    'team-t-rail': { width: 308, height: 444 },
    'focused-player': { width: 296, height: 316 },
    'series-strip': { width: 400, height: 28 },
    'round-history': { width: 720, height: 84 },
  },
  layout: {
    name: 'ESL 布局',
    widgets: {
      'top-score-bar': { visible: true, anchor: 'top-center', offsetX: 0, offsetY: 32 },
      'team-ct-rail': { visible: true, anchor: 'bottom-left', offsetX: 16, offsetY: -16 },
      'team-t-rail': { visible: true, anchor: 'bottom-right', offsetX: -16, offsetY: -16 },
      radar: {
        visible: true,
        anchor: 'top-left',
        offsetX: 24,
        offsetY: 64,
        size: { width: 400, height: 400 },
      },
      'series-strip': { visible: true, anchor: 'top-left', offsetX: 24, offsetY: 32 },
      'round-history': { visible: true, anchor: 'top-center', offsetX: 0, offsetY: 220 },
    },
  },
  recipe: {
    ...DEFAULT_THEME_RECIPE,
    id: 'esl',
    surfaces: {
      solid: { primary: '#202020', strong: '#101010', opacity: 0.98, borderOpacity: 0.28 },
      standard: { primary: '#202020', strong: '#101010', opacity: 0.9, borderOpacity: 0.16 },
      light: { primary: '#202020', strong: '#101010', opacity: 0.7, borderOpacity: 0.14 },
    },
  },
} satisfies HudBroadcastStyleDefinition;
