import { z } from 'zod';
import {
  HUD_ANCHORS,
  HUD_CONFIG_SCHEMA_VERSION,
  HUD_RESOLVED_SNAPSHOT_SCHEMA_VERSION,
  HUD_PANEL_STYLES,
  HUD_CORNER_STYLES,
  HUD_THEME_RECIPES,
  BUILTIN_PRESET_IDS,
} from './constants.js';
const finiteNumber = z.number().refine(Number.isFinite, '必须是有限数字');
const resourceNameSchema = z
  .string()
  .refine((value) => value.trim().length > 0, '名称不能为空')
  .refine((value) => [...value.trim()].length <= 80, '名称最多 80 个 Unicode 字符');
const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, '必须是 #RRGGBB 格式')
  .transform((value) => value.toLowerCase());
const unitIntervalSchema = finiteNumber
  .refine((value) => value >= 0, '透明度不能小于 0')
  .refine((value) => value <= 1, '透明度不能大于 1');
const radiusSchema = finiteNumber
  .refine((value) => value >= 0, '圆角不能小于 0')
  .refine((value) => value <= 128, '圆角超出支持范围');

export const hudWidgetPlacementSchema = z
  .object({
    visible: z.boolean(),
    anchor: z.enum(HUD_ANCHORS),
    offsetX: finiteNumber,
    offsetY: finiteNumber,
    size: z
      .object({
        width: finiteNumber.refine((value) => value > 0, '宽度必须大于 0'),
        height: finiteNumber.refine((value) => value > 0, '高度必须大于 0'),
      })
      .strict()
      .optional(),
    scale: finiteNumber.refine((value) => value > 0, '缩放必须大于 0').optional(),
  })
  .strict();

export const hudLayoutSchema = z
  .object({
    schemaVersion: z.literal(HUD_CONFIG_SCHEMA_VERSION),
    id: z.string().min(1),
    name: resourceNameSchema,
    widgets: z.record(z.string(), hudWidgetPlacementSchema),
  })
  .strict();

export const hudThemeSchema = z
  .object({
    schemaVersion: z.literal(HUD_CONFIG_SCHEMA_VERSION),
    id: z.string().min(1),
    name: resourceNameSchema,
    brandColor: hexColorSchema,
    panelStyle: z.enum(HUD_PANEL_STYLES),
    cornerStyle: z.enum(HUD_CORNER_STYLES),
    recipe: z.enum(HUD_THEME_RECIPES).default('mizar-default'),
  })
  .strict();

/** The outer envelope is intentionally future-neutral; descriptors own strict settings parsing. */
export const hudWidgetSettingsSchema = z
  .object({
    variant: z.string().trim().min(1, '组件 variant 不能为空'),
    settings: z.record(z.string(), z.unknown()),
  })
  .strict();

const widgetSettingsRecordSchema = z.record(z.string(), hudWidgetSettingsSchema);

export const hudPresetSchema = z
  .object({
    schemaVersion: z.literal(HUD_CONFIG_SCHEMA_VERSION),
    id: z.string().min(1),
    name: resourceNameSchema,
    layoutId: z.string().min(1),
    themeId: z.string().min(1),
    widgets: widgetSettingsRecordSchema,
  })
  .strict();

export const hudResolvedThemeSchema = z
  .object({
    schemaVersion: z.literal(HUD_CONFIG_SCHEMA_VERSION),
    id: z.string().min(1),
    name: resourceNameSchema,
    brandColor: hexColorSchema,
    panelStyle: z.enum(HUD_PANEL_STYLES),
    cornerStyle: z.enum(HUD_CORNER_STYLES),
    recipe: z.enum(HUD_THEME_RECIPES),
    semantic: z
      .object({
        colors: z
          .object({
            textPrimary: hexColorSchema,
            textMuted: hexColorSchema,
            sideCt: hexColorSchema,
            sideT: hexColorSchema,
            stateDanger: hexColorSchema,
            stateWarning: hexColorSchema,
            stateSuccess: hexColorSchema,
            stateUnknown: hexColorSchema,
            objectiveBomb: hexColorSchema,
            objectiveDefuse: hexColorSchema,
          })
          .strict(),
        surface: z
          .object({
            primary: hexColorSchema,
            strong: hexColorSchema,
            opacity: unitIntervalSchema,
            borderOpacity: unitIntervalSchema,
          })
          .strict(),
        radius: z.object({ sm: radiusSchema, md: radiusSchema, lg: radiusSchema }).strict(),
        fontFamily: z.literal('Inter'),
      })
      .strict(),
  })
  .strict();

export const hudResolvedPresetSchema = z
  .object({
    schemaVersion: z.literal(HUD_RESOLVED_SNAPSHOT_SCHEMA_VERSION),
    preset: z
      .object({
        id: z.string().min(1),
        name: resourceNameSchema,
        layoutId: z.string().min(1),
        themeId: z.string().min(1),
      })
      .strict(),
    layout: hudLayoutSchema,
    theme: hudResolvedThemeSchema,
    widgets: widgetSettingsRecordSchema,
  })
  .strict();

const activePresetReferenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('builtin'),
      sourceId: z.enum(BUILTIN_PRESET_IDS),
    })
    .strict(),
  z
    .object({
      kind: z.literal('custom'),
      sourceId: z.string().min(1),
      snapshot: hudResolvedPresetSchema,
    })
    .strict(),
]);

export const hudConfigDocumentSchema = z
  .object({
    schemaVersion: z.literal(HUD_CONFIG_SCHEMA_VERSION),
    customPresets: z.array(hudPresetSchema),
    customLayouts: z.array(hudLayoutSchema),
    customThemes: z.array(hudThemeSchema),
    activePreset: activePresetReferenceSchema,
  })
  .strict();
