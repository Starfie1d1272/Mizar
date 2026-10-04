import { deepFreeze } from '../json.js';
import type {
  HudThemeRecipe,
  HudSemanticColors,
  HudPanelStyle,
  HudSemanticSurface,
  HudCornerStyle,
  HudSemanticRadius,
} from '../types.js';

export const DEFAULT_THEME_RECIPE: HudThemeRecipe = deepFreeze({
  id: 'mizar-default',
  colors: {
    textPrimary: '#f3f6fa',
    textMuted: '#aab4c0',
    sideCt: '#6aa8ff',
    sideT: '#f2bd4f',
    stateDanger: '#f06f6f',
    stateWarning: '#f3bd68',
    stateSuccess: '#c8ef78',
    stateUnknown: '#8d9aaa',
    objectiveBomb: '#f06f6f',
    objectiveDefuse: '#83d8e8',
  } satisfies HudSemanticColors,
  surfaces: {
    solid: { primary: '#10151d', strong: '#080c12', opacity: 0.98, borderOpacity: 0.28 },
    standard: { primary: '#111923', strong: '#0b1119', opacity: 0.88, borderOpacity: 0.16 },
    light: { primary: '#17222d', strong: '#111a22', opacity: 0.7, borderOpacity: 0.14 },
  } satisfies Record<HudPanelStyle, HudSemanticSurface>,
  radii: {
    square: { sm: 0, md: 0, lg: 0 },
    soft: { sm: 4, md: 8, lg: 12 },
    rounded: { sm: 8, md: 14, lg: 22 },
  } satisfies Record<HudCornerStyle, HudSemanticRadius>,
  fontFamily: 'Inter',
});
