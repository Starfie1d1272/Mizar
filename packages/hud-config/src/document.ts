import { HUD_CONFIG_SCHEMA_VERSION, BUILTIN_PRESET_ID } from './constants.js';
import { hudConfigDocumentSchema, hudThemeSchema } from './schemas.js';
import { parseHudLayout, parseHudPreset, parseHudResolvedPreset } from './validation.js';
import { getBuiltinLayouts, getBuiltinThemes } from './builtins.js';
import type { HudConfigDocument, HudLayout, HudTheme } from './types.js';
function assertUniqueCustomIds<T extends { readonly id: string }>(
  resources: readonly T[],
  kind: string,
): void {
  const ids = new Set<string>();
  for (const resource of resources) {
    if (resource.id.startsWith('builtin:'))
      throw new Error(`${kind} 自定义资源不得使用 builtin: ID`);
    if (ids.has(resource.id)) throw new Error(`${kind} 自定义资源 ID 不得重复：${resource.id}`);
    ids.add(resource.id);
  }
}

export function parseHudConfigDocument(value: unknown): HudConfigDocument {
  const parsed = hudConfigDocumentSchema.parse(value);
  assertUniqueCustomIds(parsed.customLayouts, '布局');
  assertUniqueCustomIds(parsed.customThemes, '外观');
  assertUniqueCustomIds(parsed.customPresets, '预设');
  const layouts = new Map<string, HudLayout>([
    ...getBuiltinLayouts().map((item) => [item.id, item] as const),
    ...parsed.customLayouts.map((item) => [item.id, parseHudLayout(item)] as const),
  ]);
  const themes = new Map<string, HudTheme>([
    ...getBuiltinThemes().map((item) => [item.id, item] as const),
    ...parsed.customThemes.map((item) => [item.id, hudThemeSchema.parse(item)] as const),
  ]);
  const presets = parsed.customPresets.map((item) => parseHudPreset(item));
  const presetIds = new Set(presets.map((item) => item.id));
  for (const preset of presets) {
    if (!layouts.has(preset.layoutId))
      throw new Error(`HudPreset 引用不存在的布局：${preset.layoutId}`);
    if (!themes.has(preset.themeId))
      throw new Error(`HudPreset 引用不存在的外观：${preset.themeId}`);
  }
  let activePreset = parsed.activePreset;
  if (parsed.activePreset.kind === 'custom') {
    if (!presetIds.has(parsed.activePreset.sourceId)) {
      throw new Error(`activePreset 引用不存在的预设：${parsed.activePreset.sourceId}`);
    }
    const snapshot = parseHudResolvedPreset(parsed.activePreset.snapshot);
    activePreset = { ...parsed.activePreset, snapshot };
    if (parsed.activePreset.sourceId !== snapshot.preset.id) {
      throw new Error('activePreset.sourceId 与 resolved snapshot 的 preset.id 不一致');
    }
  }
  return {
    ...parsed,
    activePreset,
    customPresets: presets,
    customLayouts: [...layouts.values()].filter((item) => !item.id.startsWith('builtin:')),
    customThemes: [...themes.values()].filter((item) => !item.id.startsWith('builtin:')),
  };
}

export function createDefaultHudConfigDocument(): HudConfigDocument {
  return {
    schemaVersion: HUD_CONFIG_SCHEMA_VERSION,
    customPresets: [],
    customLayouts: [],
    customThemes: [],
    activePreset: { kind: 'builtin', sourceId: BUILTIN_PRESET_ID },
  };
}
