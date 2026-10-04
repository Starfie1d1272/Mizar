import { resolveHudVariantLayout } from './variant-layout.js';
import { HUD_RESOLVED_SNAPSHOT_SCHEMA_VERSION, BUILTIN_PRESET_ID } from './constants.js';
import { hudThemeSchema } from './schemas.js';
import { parseHudLayout, parseHudPreset } from './validation.js';
import { parseHudConfigDocument } from './document.js';
import {
  getBuiltinLayouts,
  getBuiltinThemes,
  getBuiltinPresets,
  getBuiltinLayout,
  getBuiltinTheme,
  getBuiltinPreset,
} from './builtins.js';
import { cloneJson } from './json.js';
import { resolveHudThemeRecipe } from './theme-recipe.js';
import type {
  HudConfigDocument,
  HudLayout,
  HudPreset,
  HudTheme,
  HudResolvedTheme,
  HudResolvedPreset,
} from './types.js';
export function resolveHudTheme(theme: HudTheme): HudResolvedTheme {
  return resolveHudThemeRecipe(theme);
}

export function resolveHudPreset(
  preset: HudPreset,
  layout: HudLayout,
  theme: HudTheme,
): HudResolvedPreset {
  const parsedLayout = parseHudLayout(layout);
  const parsedPreset = parseHudPreset(preset);
  const parsedTheme = hudThemeSchema.parse(theme);
  if (parsedPreset.layoutId !== parsedLayout.id)
    throw new Error('HudPreset 与 HudLayout 引用不一致');
  if (parsedPreset.themeId !== parsedTheme.id) throw new Error('HudPreset 与 HudTheme 引用不一致');
  return {
    schemaVersion: HUD_RESOLVED_SNAPSHOT_SCHEMA_VERSION,
    preset: {
      id: parsedPreset.id,
      name: parsedPreset.name.trim(),
      layoutId: parsedPreset.layoutId,
      themeId: parsedPreset.themeId,
    },
    layout: cloneJson(resolveHudVariantLayout(parsedLayout, parsedPreset.widgets)),
    theme: resolveHudTheme(parsedTheme),
    widgets: cloneJson(parsedPreset.widgets),
  };
}

export function resolveActiveHudPreset(document: HudConfigDocument): HudResolvedPreset {
  const parsed = parseHudConfigDocument(document);
  if (parsed.activePreset.kind === 'custom') return cloneJson(parsed.activePreset.snapshot);
  return getBuiltinResolvedPreset(parsed.activePreset.sourceId);
}

export function resetLayoutDraft(draft: HudLayout): HudLayout {
  return {
    ...getBuiltinLayout(),
    id: draft.id,
    name: draft.name,
  };
}

export function resetThemeDraft(draft: HudTheme): HudTheme {
  return {
    ...getBuiltinTheme(),
    id: draft.id,
    name: draft.name,
  };
}

export function resetPresetDraft(draft: HudPreset): HudPreset {
  return {
    ...getBuiltinPreset(),
    id: draft.id,
    name: draft.name,
  };
}

export function createCustomResourceId(): string {
  return crypto.randomUUID();
}

export function getBuiltinResolvedPreset(id: string = BUILTIN_PRESET_ID): HudResolvedPreset {
  const preset = getBuiltinPresets().find((item) => item.id === id);
  if (preset === undefined) throw new Error(`未知内置 HUD 预设：${id}`);
  const theme = getBuiltinThemes().find((item) => item.id === preset.themeId)!;
  return resolveHudPreset(
    preset,
    getBuiltinLayouts().find((layout) => layout.id === preset.layoutId)!,
    theme,
  );
}
