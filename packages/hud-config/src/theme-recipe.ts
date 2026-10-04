import type {
  HudCornerStyle,
  HudPanelStyle,
  HudResolvedTheme,
  HudSemanticColors,
  HudSemanticRadius,
  HudSemanticSurface,
  HudTheme,
  HudThemeRecipe,
} from './index.js';

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

const DEFAULT_THEME_RECIPE: HudThemeRecipe = deepFreeze({
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

/** Code-owned recipes leave room for richer built-in themes without widening v1 user controls. */
export const HUD_THEME_RECIPE_REGISTRY: readonly HudThemeRecipe[] = deepFreeze([
  DEFAULT_THEME_RECIPE,
  {
    ...DEFAULT_THEME_RECIPE,
    id: 'ewc',
    colors: { ...DEFAULT_THEME_RECIPE.colors, sideCt: '#3864c3', sideT: '#b69117' },
  },
  {
    ...DEFAULT_THEME_RECIPE,
    id: 'iem',
    colors: { ...DEFAULT_THEME_RECIPE.colors, sideCt: '#203995', sideT: '#a9911c' },
    surfaces: {
      solid: { primary: '#071658', strong: '#02082c', opacity: 0.98, borderOpacity: 0.28 },
      standard: { primary: '#071658', strong: '#02082c', opacity: 0.88, borderOpacity: 0.16 },
      light: { primary: '#071658', strong: '#02082c', opacity: 0.7, borderOpacity: 0.14 },
    },
  },
  {
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
]);

export function resolveHudThemeRecipe(theme: HudTheme): HudResolvedTheme {
  const recipeId = theme.recipe;
  const recipe =
    HUD_THEME_RECIPE_REGISTRY.find((item) => item.id === recipeId) ?? DEFAULT_THEME_RECIPE;
  return {
    ...cloneJson(theme),
    semantic: {
      colors: cloneJson(recipe.colors),
      surface: cloneJson(recipe.surfaces[theme.panelStyle]),
      radius: cloneJson(recipe.radii[theme.cornerStyle]),
      fontFamily: recipe.fontFamily,
    },
  };
}
