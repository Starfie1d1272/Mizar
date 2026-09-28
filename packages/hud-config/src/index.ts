import { z } from 'zod';
import { canonicalJson } from './canonical-json.js';

import { resolveHudThemeRecipe } from './theme-recipe.js';
import { DEFAULT_PLACEMENTS, validatePlacementWithinCanvas } from './geometry.js';

export { canonicalJson } from './canonical-json.js';
export { HUD_THEME_RECIPE_REGISTRY } from './theme-recipe.js';
export {
  changePlacementAnchor,
  clampWidgetBox,
  getWidgetDimensions,
  moveWidgetPlacement,
  normalizeHudLayout,
  normalizeHudPlacement,
  placementFromBox,
  placementToBox,
  resizeRadarPlacement,
  snapToGrid,
  validatePlacementWithinCanvas,
} from './geometry.js';

export const HUD_CONFIG_SCHEMA_VERSION = 1 as const;
/**
 * Resolved snapshots are an on-air compatibility boundary.  A future recipe
 * change must not reinterpret an already activated snapshot; incompatible
 * snapshot versions are rejected before 1.0; there is no legacy migration.
 */
export const HUD_RESOLVED_SNAPSHOT_SCHEMA_VERSION = 2 as const;
export const HUD_CANVAS_WIDTH = 1920 as const;
export const HUD_CANVAS_HEIGHT = 1080 as const;
export const HUD_GRID_SIZE = 10 as const;

export const HUD_WIDGET_IDS = [
  'top-score-bar',
  'team-ct-rail',
  'team-t-rail',
  'radar',
  'focused-player',
  'series-strip',
  'round-history',
  'objective',
  'round-result',
] as const;
export type HudWidgetId = (typeof HUD_WIDGET_IDS)[number];

export const HUD_ANCHORS = [
  'top-left',
  'top-center',
  'top-right',
  'center-left',
  'center',
  'center-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
] as const;
export type HudAnchor = (typeof HUD_ANCHORS)[number];

export const HUD_RESIZE_POLICIES = ['none', 'square', 'scale', 'width-only'] as const;
export type HudResizePolicy = (typeof HUD_RESIZE_POLICIES)[number];

export const HUD_PANEL_STYLES = ['solid', 'standard', 'light'] as const;
export type HudPanelStyle = (typeof HUD_PANEL_STYLES)[number];

export const HUD_CORNER_STYLES = ['square', 'soft', 'rounded'] as const;
export type HudCornerStyle = (typeof HUD_CORNER_STYLES)[number];

export const BUILTIN_PRESET_ID = 'builtin:mizar-default-preset' as const;
export const BUILTIN_LAYOUT_ID = 'builtin:mizar-default-layout' as const;
export const BUILTIN_THEME_ID = 'builtin:mizar-default-theme' as const;

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
const emptyWidgetSettingsSchema = z.object({}).strict();

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

export interface HudSemanticColors {
  readonly textPrimary: string;
  readonly textMuted: string;
  readonly sideCt: string;
  readonly sideT: string;
  readonly stateDanger: string;
  readonly stateWarning: string;
  readonly stateSuccess: string;
  readonly stateUnknown: string;
  readonly objectiveBomb: string;
  readonly objectiveDefuse: string;
}

export interface HudSemanticSurface {
  readonly primary: string;
  readonly strong: string;
  readonly opacity: number;
  readonly borderOpacity: number;
}

export interface HudSemanticRadius {
  readonly sm: number;
  readonly md: number;
  readonly lg: number;
}

export interface HudResolvedTheme extends HudTheme {
  readonly semantic: {
    readonly colors: HudSemanticColors;
    readonly surface: HudSemanticSurface;
    readonly radius: HudSemanticRadius;
    readonly fontFamily: 'Inter';
  };
}

export interface HudThemeRecipe {
  readonly id: string;
  readonly colors: HudSemanticColors;
  readonly surfaces: Record<HudPanelStyle, HudSemanticSurface>;
  readonly radii: Record<HudCornerStyle, HudSemanticRadius>;
  readonly fontFamily: 'Inter';
}

export interface HudLayout extends z.infer<typeof hudLayoutSchema> {
  readonly widgets: Record<HudWidgetId, HudWidgetPlacement>;
}

export type HudWidgetPlacement = z.infer<typeof hudWidgetPlacementSchema>;
export type HudTheme = z.infer<typeof hudThemeSchema>;
export type HudWidgetSettings = z.infer<typeof hudWidgetSettingsSchema>;
export type HudPreset = Omit<z.infer<typeof hudPresetSchema>, 'widgets'> & {
  readonly widgets: Record<HudWidgetId, HudWidgetSettings>;
};

export interface HudResolvedPreset {
  readonly schemaVersion: typeof HUD_RESOLVED_SNAPSHOT_SCHEMA_VERSION;
  readonly preset: {
    readonly id: string;
    readonly name: string;
    readonly layoutId: string;
    readonly themeId: string;
  };
  readonly layout: HudLayout;
  readonly theme: HudResolvedTheme;
  readonly widgets: Record<HudWidgetId, HudWidgetSettings>;
}

export const hudResolvedThemeSchema = z
  .object({
    schemaVersion: z.literal(HUD_CONFIG_SCHEMA_VERSION),
    id: z.string().min(1),
    name: resourceNameSchema,
    brandColor: hexColorSchema,
    panelStyle: z.enum(HUD_PANEL_STYLES),
    cornerStyle: z.enum(HUD_CORNER_STYLES),
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
      sourceId: z.literal(BUILTIN_PRESET_ID),
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

export type HudConfigDocument = Omit<
  z.infer<typeof hudConfigDocumentSchema>,
  'customPresets' | 'customLayouts' | 'customThemes'
> & {
  readonly customPresets: HudPreset[];
  readonly customLayouts: HudLayout[];
  readonly customThemes: HudTheme[];
};
export type HudActivePresetReference = HudConfigDocument['activePreset'];

export type HudEditorControl = {
  readonly path: string;
  readonly label: string;
  readonly help?: string;
  readonly variants: readonly string[];
} & (
  | { readonly type: 'boolean' }
  | {
      readonly type: 'select';
      readonly options: readonly { readonly value: string; readonly label: string }[];
    }
);

export interface HudWidgetDescriptor {
  readonly id: HudWidgetId;
  readonly label: string;
  readonly rendererAvailability: 'implemented' | 'unimplemented';
  readonly supportedVariants: readonly [string, ...string[]];
  readonly defaultVariant: string;
  readonly variantLabels: Readonly<Record<string, string>>;
  readonly resizePolicy: HudResizePolicy;
  readonly defaultPlacement: HudWidgetPlacement;
  readonly sourceOwner: 'program' | 'radar' | null;
  readonly settingsSchemaByVariant: Readonly<
    Record<string, (value: unknown) => Record<string, unknown>>
  >;
  readonly defaultSettingsByVariant: Readonly<Record<string, Record<string, unknown>>>;
  readonly editorControls: readonly HudEditorControl[];
  /** Registry-owned parser for the complete persisted widget settings envelope. */
  readonly validateSettings: (value: unknown) => HudWidgetSettings;
}

export interface HudWidgetDescriptorDefinition extends Omit<
  HudWidgetDescriptor,
  'validateSettings'
> {
  /** Strict settings parser owned by each individual widget variant. */
  readonly settingsSchemaByVariant: Readonly<
    Record<string, (value: unknown) => Record<string, unknown>>
  >;
}

/**
 * Framework-neutral registry seam. Future widget Issues can register a real
 * renderer and controlled variants without changing the common settings
 * envelope or parser dispatch in this package.
 */
export function defineHudWidgetDescriptor(
  definition: HudWidgetDescriptorDefinition,
): HudWidgetDescriptor {
  const supportedVariants = new Set(definition.supportedVariants);
  if (supportedVariants.size !== definition.supportedVariants.length) {
    throw new Error(`组件 ${definition.id} 的 supportedVariants 不得重复`);
  }
  if (!definition.supportedVariants.includes(definition.defaultVariant)) {
    throw new Error(`组件 ${definition.id} 的 defaultVariant 必须属于 supportedVariants`);
  }
  const parserVariants = Object.keys(definition.settingsSchemaByVariant);
  if (
    parserVariants.length !== supportedVariants.size ||
    parserVariants.some((variant) => !supportedVariants.has(variant))
  ) {
    throw new Error(`组件 ${definition.id} 必须为每个 supported variant 提供独立 settings schema`);
  }
  const defaultVariants = Object.keys(definition.defaultSettingsByVariant);
  if (
    defaultVariants.length !== supportedVariants.size ||
    defaultVariants.some((variant) => !supportedVariants.has(variant))
  ) {
    throw new Error(`组件 ${definition.id} 的 defaults 与 variants 不一致`);
  }
  const labelVariants = Object.keys(definition.variantLabels);
  if (
    labelVariants.length !== supportedVariants.size ||
    labelVariants.some((variant) => !supportedVariants.has(variant))
  ) {
    throw new Error(`组件 ${definition.id} 的 variant labels 与 variants 不一致`);
  }
  for (const variant of definition.supportedVariants) {
    if (!definition.variantLabels[variant]?.trim()) throw new Error('Variant 缺少名称');
    const parser = definition.settingsSchemaByVariant[variant]!;
    const defaults = definition.defaultSettingsByVariant[variant]!;
    if (canonicalJson(parser(defaults)) !== canonicalJson(defaults))
      throw new Error('组件 defaults 必须完整');
    const paths = new Set<string>();
    for (const control of definition.editorControls) {
      if (
        control.variants.length === 0 ||
        control.variants.some((item) => !supportedVariants.has(item))
      )
        throw new Error('Control variant 无效');
      if (!control.variants.includes(variant)) continue;
      if (paths.has(control.path)) throw new Error('Control path 重复');
      paths.add(control.path);
      const defaultValue = defaults[control.path];
      if (
        control.type === 'boolean'
          ? typeof defaultValue !== 'boolean'
          : typeof defaultValue !== 'string'
      )
        throw new Error('Control 与 setting 类型不一致');
      const values: readonly (string | boolean)[] =
        control.type === 'boolean' ? [false, true] : control.options.map((option) => option.value);
      if (
        values.length === 0 ||
        new Set(values).size !== values.length ||
        !values.includes(defaultValue as string | boolean)
      )
        throw new Error('Control 缺少合法默认值');
      for (const value of values) parser({ ...defaults, [control.path]: value });
    }
  }
  return {
    ...definition,
    validateSettings: (value: unknown): HudWidgetSettings => {
      const parsed = hudWidgetSettingsSchema.parse(value);
      if (!definition.supportedVariants.includes(parsed.variant)) {
        throw new Error(`组件 ${definition.id} 不支持 variant：${parsed.variant}`);
      }
      const settingsSchema = definition.settingsSchemaByVariant[parsed.variant];
      if (settingsSchema === undefined) {
        throw new Error(`组件 ${definition.id} 缺少 variant settings schema：${parsed.variant}`);
      }
      return {
        variant: parsed.variant,
        settings: settingsSchema(parsed.settings),
      };
    },
  };
}

export interface HudWidgetBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export const HUD_WIDGET_LABELS: Record<HudWidgetId, string> = {
  'top-score-bar': '顶部比分条',
  'team-ct-rail': '左选手栏',
  'team-t-rail': '右选手栏',
  radar: '雷达',
  'focused-player': '当前观察选手',
  'series-strip': '系列赛信息',
  'round-history': '回合历史',
  objective: '目标状态',
  'round-result': '回合结果',
};

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

function completeWidgetRecord<T>(factory: (id: HudWidgetId) => T): Record<HudWidgetId, T> {
  return Object.fromEntries(HUD_WIDGET_IDS.map((id) => [id, factory(id)])) as Record<
    HudWidgetId,
    T
  >;
}

function hasExactWidgetKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === HUD_WIDGET_IDS.length && HUD_WIDGET_IDS.every((id) => keys.includes(id));
}

export function parseHudLayout(value: unknown): HudLayout {
  const parsed = hudLayoutSchema.parse(value);
  if (!hasExactWidgetKeys(parsed.widgets))
    throw new Error('HudLayout 必须完整包含第一版组件 Registry');
  for (const id of HUD_WIDGET_IDS) {
    const placement = parsed.widgets[id];
    if (placement === undefined) throw new Error(`HudLayout 缺少组件：${id}`);
    const descriptor = getHudWidgetDescriptor(id);
    if (descriptor.resizePolicy === 'none') {
      if (placement.scale !== undefined) throw new Error(`组件 ${id} 不允许持久化 scale`);
      if (placement.size !== undefined) throw new Error(`组件 ${id} 不允许调整尺寸`);
    } else if (descriptor.resizePolicy === 'square') {
      if (placement.scale !== undefined) throw new Error(`组件 ${id} 不允许持久化 scale`);
      if (placement.size === undefined)
        throw new Error(`${descriptor.label} 必须显式保存正方形尺寸`);
      if (placement.size.width !== placement.size.height) {
        throw new Error(`${descriptor.label} 只能使用正方形尺寸`);
      }
    } else {
      throw new Error(`第一版暂不支持组件 ${id} 的 ${descriptor.resizePolicy} 尺寸策略`);
    }
    validatePlacementWithinCanvas(id, placement);
  }
  return parsed;
}

export function parseHudPreset(value: unknown): HudPreset {
  const parsed = hudPresetSchema.parse(value);
  if (!hasExactWidgetKeys(parsed.widgets))
    throw new Error('HudPreset 必须完整包含第一版组件 Registry');
  const widgets = completeWidgetRecord((id) => {
    const settings = parsed.widgets[id];
    if (settings === undefined) throw new Error(`HudPreset 缺少组件设置：${id}`);
    return getHudWidgetDescriptor(id).validateSettings(settings);
  });
  return { ...parsed, widgets };
}

export function parseHudResolvedPreset(value: unknown): HudResolvedPreset {
  // Current-version frozen boundary. Reject old versions and incomplete settings;
  // never re-resolve through the current Theme recipe.
  const parsed = hudResolvedPresetSchema.parse(value);
  if (!hasExactWidgetKeys(parsed.widgets)) {
    throw new Error('HudResolvedPreset 必须完整包含第一版组件 Registry');
  }
  const layout = parseHudLayout(parsed.layout);
  if (parsed.preset.layoutId !== layout.id) {
    throw new Error('HudResolvedPreset 的 layoutId 与布局 ID 不一致');
  }
  if (parsed.preset.themeId !== parsed.theme.id) {
    throw new Error('HudResolvedPreset 的 themeId 与外观 ID 不一致');
  }
  const widgets = completeWidgetRecord((id) => {
    const settings = parsed.widgets[id];
    if (settings === undefined) throw new Error(`HudResolvedPreset 缺少组件设置：${id}`);
    const validated = getHudWidgetDescriptor(id).validateSettings(settings);
    if (canonicalJson(validated.settings) !== canonicalJson(settings.settings)) {
      throw new Error('Resolved settings 必须完整，不能按当前 defaults 归一化');
    }
    return validated;
  });
  return { ...parsed, layout, widgets };
}

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
    [BUILTIN_LAYOUT_ID, getBuiltinLayout()],
    ...parsed.customLayouts.map((item) => [item.id, parseHudLayout(item)] as const),
  ]);
  const themes = new Map<string, HudTheme>([
    [BUILTIN_THEME_ID, getBuiltinTheme()] as const,
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
    customLayouts: [...layouts.values()].filter((item) => item.id !== BUILTIN_LAYOUT_ID),
    customThemes: [...themes.values()].filter((item) => item.id !== BUILTIN_THEME_ID),
  };
}

export const radarWidgetSettingsSchema = z.strictObject({
  zoomMode: z.enum(['full-map', 'auto']).default('full-map'),
});

export const playerRailSettingsSchema = z.strictObject({
  showTeamName: z.boolean().default(true),
  showAvatar: z.boolean().default(true),
  showMoney: z.boolean().default(true),
  showLoadout: z.boolean().default(true),
  showUtility: z.boolean().default(true),
  showTeamSummary: z.boolean().default(true),
  deadInformation: z.enum(['stats', 'minimal']).default('stats'),
});
export type PlayerRailSettings = z.infer<typeof playerRailSettingsSchema>;
export const focusedPlayerSettingsSchema = z.strictObject({
  showMedia: z.boolean().default(true),
  showMetrics: z.boolean().default(true),
  showReserveAmmo: z.boolean().default(true),
});
export type FocusedPlayerSettings = z.infer<typeof focusedPlayerSettingsSchema>;
export const minimalFocusedPlayerSettingsSchema = z.strictObject({
  showReserveAmmo: z.boolean().default(false),
});

/** Variant fixes the information structure; settings only tune fields supported by that structure. */
export function focusedPlayerPresentationSettings(
  envelope: HudWidgetSettings,
): FocusedPlayerSettings {
  const validated = getHudWidgetDescriptor('focused-player').validateSettings(envelope);
  return validated.variant === 'minimal'
    ? {
        showMedia: false,
        showMetrics: false,
        ...minimalFocusedPlayerSettingsSchema.parse(validated.settings),
      }
    : focusedPlayerSettingsSchema.parse(validated.settings);
}
export const topScoreBarSettingsSchema = z.strictObject({
  showTeamLogo: z.boolean().default(true),
  showSeriesWins: z.boolean().default(true),
  showAliveMatchup: z.boolean().default(true),
  showTimeout: z.boolean().default(true),
  showObjectiveAuxiliary: z.boolean().default(true),
});
export type TopScoreBarSettings = z.infer<typeof topScoreBarSettingsSchema>;

function widgetContract(id: HudWidgetId) {
  const schema =
    id === 'radar'
      ? radarWidgetSettingsSchema
      : id === 'team-ct-rail' || id === 'team-t-rail'
        ? playerRailSettingsSchema
        : id === 'focused-player'
          ? focusedPlayerSettingsSchema
          : id === 'top-score-bar'
            ? topScoreBarSettingsSchema
            : emptyWidgetSettingsSchema;
  const labels: Record<string, string> = {
    showTeamName: '显示队名',
    showAvatar: '显示头像',
    showMoney: '显示经济',
    showLoadout: '显示武器与装备',
    showUtility: '显示道具',
    showTeamSummary: '显示队伍汇总',
    showMedia: '显示头像与观察位',
    showMetrics: '显示 K/A/D/ADR',
    showReserveAmmo: '显示备用弹药',
    showTeamLogo: '显示队标',
    showSeriesWins: '显示系列赛胜图',
    showAliveMatchup: '显示存活对比',
    showTimeout: '显示暂停附加信息',
    showObjectiveAuxiliary: '显示目标附加进度',
  };
  const variants = id === 'focused-player' ? ['default', 'minimal'] : ['default'];
  const defaults = schema.parse({});
  const editorControls: HudEditorControl[] = Object.keys(defaults).map((path) =>
    path === 'zoomMode'
      ? {
          path,
          label: '雷达视野',
          type: 'select',
          variants,
          options: [
            { value: 'full-map', label: '完整地图' },
            { value: 'auto', label: '自动聚焦存活选手' },
          ],
        }
      : path === 'deadInformation'
        ? {
            path,
            label: '死亡态信息',
            type: 'select',
            variants,
            options: [
              { value: 'stats', label: '统计信息' },
              { value: 'minimal', label: '仅身份与死亡状态' },
            ],
          }
        : {
            path,
            label: labels[path]!,
            type: 'boolean',
            variants:
              id === 'focused-player' && path !== 'showReserveAmmo' ? ['default'] : variants,
          },
  );
  const settingsSchemaByVariant: Record<string, (value: unknown) => Record<string, unknown>> = {
    default: (value) => schema.parse(value),
  };
  const defaultSettingsByVariant: Record<string, Record<string, unknown>> = { default: defaults };
  if (id === 'focused-player') {
    settingsSchemaByVariant.minimal = (value) => minimalFocusedPlayerSettingsSchema.parse(value);
    defaultSettingsByVariant.minimal = minimalFocusedPlayerSettingsSchema.parse({});
  }
  const variantLabels =
    id === 'focused-player'
      ? { default: '标准信息', minimal: '精简信息' }
      : { default: '默认' };
  return {
    supportedVariants: variants as [string, ...string[]],
    variantLabels,
    settingsSchemaByVariant,
    defaultSettingsByVariant,
    editorControls,
  };
}

/** Variant switching starts from the declared defaults; incompatible fields never carry over. */
export function switchHudWidgetVariant(
  descriptor: HudWidgetDescriptor,
  variant: string,
): HudWidgetSettings {
  return descriptor.validateSettings({
    variant,
    settings: cloneJson(descriptor.defaultSettingsByVariant[variant]),
  });
}

export const HUD_WIDGET_REGISTRY: readonly HudWidgetDescriptor[] = deepFreeze(
  HUD_WIDGET_IDS.map((id) => ({
    ...defineHudWidgetDescriptor({
      id,
      label: HUD_WIDGET_LABELS[id],
      rendererAvailability:
        id === 'radar' ||
        id === 'focused-player' ||
        id === 'top-score-bar' ||
        id === 'team-ct-rail' ||
        id === 'team-t-rail' ||
        id === 'series-strip' ||
        id === 'round-history'
          ? 'implemented'
          : 'unimplemented',
      defaultVariant: 'default' as const,
      resizePolicy: id === 'radar' ? ('square' as const) : ('none' as const),
      defaultPlacement: cloneJson(DEFAULT_PLACEMENTS[id]),
      sourceOwner:
        id === 'radar' ? 'radar' : id === 'objective' || id === 'round-result' ? null : 'program',
      ...widgetContract(id),
    }),
  })),
);

export function getHudWidgetDescriptor(id: HudWidgetId): HudWidgetDescriptor {
  const descriptor = HUD_WIDGET_REGISTRY.find((item) => item.id === id);
  if (descriptor === undefined) throw new Error(`未知 HUD 组件：${id}`);
  return descriptor;
}

export function getBuiltinLayout(): HudLayout {
  return cloneJson(BUILTIN_LAYOUT);
}

export function getBuiltinTheme(): HudTheme {
  return cloneJson(BUILTIN_THEME);
}

export function getBuiltinPreset(): HudPreset {
  return cloneJson(BUILTIN_PRESET);
}

export function getBuiltinResolvedPreset(): HudResolvedPreset {
  return resolveHudPreset(BUILTIN_PRESET, BUILTIN_LAYOUT, BUILTIN_THEME);
}

const BUILTIN_LAYOUT: HudLayout = deepFreeze({
  schemaVersion: HUD_CONFIG_SCHEMA_VERSION,
  id: BUILTIN_LAYOUT_ID,
  name: 'RivalHub 默认布局',
  widgets: completeWidgetRecord((id) => cloneJson(DEFAULT_PLACEMENTS[id])),
});

const BUILTIN_THEME: HudTheme = deepFreeze({
  schemaVersion: HUD_CONFIG_SCHEMA_VERSION,
  id: BUILTIN_THEME_ID,
  name: 'RivalHub 默认外观',
  brandColor: '#c8ef78',
  panelStyle: 'standard',
  cornerStyle: 'square',
});

const BUILTIN_PRESET: HudPreset = deepFreeze({
  schemaVersion: HUD_CONFIG_SCHEMA_VERSION,
  id: BUILTIN_PRESET_ID,
  name: 'RivalHub 默认预设',
  layoutId: BUILTIN_LAYOUT_ID,
  themeId: BUILTIN_THEME_ID,
  widgets: completeWidgetRecord((id) => {
    const descriptor = getHudWidgetDescriptor(id);
    return switchHudWidgetVariant(descriptor, descriptor.defaultVariant);
  }),
});

export function createDefaultHudConfigDocument(): HudConfigDocument {
  return {
    schemaVersion: HUD_CONFIG_SCHEMA_VERSION,
    customPresets: [],
    customLayouts: [],
    customThemes: [],
    activePreset: { kind: 'builtin', sourceId: BUILTIN_PRESET_ID },
  };
}

export function resolveHudTheme(theme: HudTheme): HudResolvedTheme {
  return resolveHudThemeRecipe(theme, BUILTIN_THEME_ID);
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
    layout: cloneJson(parsedLayout),
    theme: resolveHudTheme(parsedTheme),
    widgets: cloneJson(parsedPreset.widgets),
  };
}

export function resolveActiveHudPreset(document: HudConfigDocument): HudResolvedPreset {
  const parsed = parseHudConfigDocument(document);
  if (parsed.activePreset.kind === 'custom') return cloneJson(parsed.activePreset.snapshot);
  return getBuiltinResolvedPreset();
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
