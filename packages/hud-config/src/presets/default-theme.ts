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
    textPrimary: '#f4f8fd',
    textMuted: '#9aa8b7',
    sideCt: '#2d7ff9',
    sideT: '#f0b84b',
    stateDanger: '#f16c6c',
    stateWarning: '#f0b84b',
    stateSuccess: '#c8ef78',
    stateUnknown: '#8d9aaa',
    objectiveBomb: '#f16c6c',
    objectiveDefuse: '#83d8e8',
  } satisfies HudSemanticColors,
  surfaces: {
    solid: { primary: '#1b2531', strong: '#141b24', opacity: 0.98, borderOpacity: 0.28 },
    standard: { primary: '#1b2531', strong: '#141b24', opacity: 0.88, borderOpacity: 0.16 },
    light: { primary: '#1b2531', strong: '#141b24', opacity: 0.7, borderOpacity: 0.14 },
  } satisfies Record<HudPanelStyle, HudSemanticSurface>,
  radii: {
    square: { sm: 0, md: 0, lg: 0 },
    soft: { sm: 4, md: 8, lg: 12 },
    rounded: { sm: 8, md: 14, lg: 22 },
  } satisfies Record<HudCornerStyle, HudSemanticRadius>,
  fontFamily: 'Inter',
});

// Freeze reference text/state colours: changing the native recipe must not recolour tournament presets.
export const REFERENCE_THEME_COLORS = deepFreeze({
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
} satisfies HudSemanticColors);
