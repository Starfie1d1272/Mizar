import { z } from 'zod';
import { hudLayoutSchema, hudPresetSchema, hudThemeSchema } from './schemas.js';
import { parseHudLayout, parseHudPreset } from './validation.js';
import { resolveHudVariantLayout } from './variant-layout.js';
import type { HudLayout, HudPreset, HudTheme } from './types.js';

export const HUD_PRESET_PACK_FORMAT = 'mizar-hud-preset' as const;
export const HUD_PRESET_PACK_VERSION = 1 as const;
export const HUD_PRESET_PACK_MAX_BYTES = 256 * 1024;

const hudPresetPackSchema = z.strictObject({
  format: z.literal(HUD_PRESET_PACK_FORMAT),
  formatVersion: z.literal(HUD_PRESET_PACK_VERSION),
  preset: hudPresetSchema,
  layout: hudLayoutSchema,
  theme: hudThemeSchema,
});

/** Portable authoring resources; activation snapshots and gameplay data are never included. */
export interface HudPresetPack {
  readonly format: typeof HUD_PRESET_PACK_FORMAT;
  readonly formatVersion: typeof HUD_PRESET_PACK_VERSION;
  readonly preset: HudPreset;
  readonly layout: HudLayout;
  readonly theme: HudTheme;
}

export function parseHudPresetPack(value: unknown): HudPresetPack {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > HUD_PRESET_PACK_MAX_BYTES) {
    throw new Error('预设文件不能超过 256 KiB');
  }
  const parsed = hudPresetPackSchema.parse(value);
  const preset = parseHudPreset(parsed.preset);
  const layout = parseHudLayout(parsed.layout);
  if (preset.layoutId !== layout.id || preset.themeId !== parsed.theme.id) {
    throw new Error('预设文件中的布局或外观引用不一致');
  }
  return { ...parsed, preset, layout: resolveHudVariantLayout(layout, preset.widgets) };
}

export function createHudPresetPack(
  preset: HudPreset,
  layout: HudLayout,
  theme: HudTheme,
): HudPresetPack {
  return parseHudPresetPack({
    format: HUD_PRESET_PACK_FORMAT,
    formatVersion: HUD_PRESET_PACK_VERSION,
    preset,
    layout,
    theme,
  });
}

export function readHudPresetPack(text: string): HudPresetPack {
  if (new TextEncoder().encode(text).byteLength > HUD_PRESET_PACK_MAX_BYTES) {
    throw new Error('预设文件不能超过 256 KiB');
  }
  return parseHudPresetPack(JSON.parse(text) as unknown);
}

export function instantiateHudPresetPack(
  value: unknown,
  createId: () => string,
): { readonly preset: HudPreset; readonly layout: HudLayout; readonly theme: HudTheme } {
  const pack = parseHudPresetPack(value);
  const layout = { ...pack.layout, id: createId(), name: pack.layout.name.trim() };
  const theme = { ...pack.theme, id: createId(), name: pack.theme.name.trim() };
  const preset = {
    ...pack.preset,
    id: createId(),
    name: pack.preset.name.trim(),
    layoutId: layout.id,
    themeId: theme.id,
  };
  return { preset, layout, theme };
}
