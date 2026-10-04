import { cloneJson, deepFreeze } from './json.js';
import { DEFAULT_THEME_RECIPE } from './presets/default-theme.js';
import { HUD_BROADCAST_STYLE_CATALOG } from './presets/catalog.js';
import type { HudTheme, HudResolvedTheme, HudThemeRecipe } from './types.js';

export const HUD_THEME_RECIPE_REGISTRY: readonly HudThemeRecipe[] = deepFreeze([
  DEFAULT_THEME_RECIPE,
  ...HUD_BROADCAST_STYLE_CATALOG.map((style) => style.recipe),
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
