import { WIDGET_DIMENSIONS } from './widget-dimensions.js';
import { HUD_BROADCAST_STYLE_CATALOG } from './presets/catalog.js';
import { z } from 'zod';
import { HUD_WIDGET_IDS, HUD_BROADCAST_STYLES } from './constants.js';
import { DEFAULT_PLACEMENTS } from './geometry.js';
import { cloneJson, deepFreeze } from './json.js';
import { defineHudWidgetDescriptor } from './widget-descriptor.js';
import type {
  HudWidgetId,
  HudWidgetDescriptor,
  HudEditorControl,
  HudWidgetSettings,
} from './types.js';
const emptyWidgetSettingsSchema = z.object({}).strict();
export const HUD_WIDGET_LABELS: Record<HudWidgetId, string> = {
  'top-score-bar': '顶部比分条',
  'team-ct-rail': '左选手栏',
  'team-t-rail': '右选手栏',
  radar: '雷达',
  'focused-player': '当前观察选手',
  'series-strip': '系列赛信息',
  'series-overview': '冻结期地图详情',
  'round-history': '回合历史',
  objective: '目标状态',
  'round-result': '回合结果',
};

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
  showBombPrediction: z.boolean().default(true),
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
    showBombPrediction: 'C4 伤害预测',
    showMedia: '显示头像与观察位',
    showMetrics: '显示 K/A/D/ADR',
    showReserveAmmo: '显示备用弹药',
    showTeamLogo: '显示队标',
    showSeriesWins: '显示系列赛胜图',
    showAliveMatchup: '显示存活对比',
    showTimeout: '显示暂停附加信息',
    showObjectiveAuxiliary: '显示目标附加进度',
  };
  const styled = [
    'radar',
    'top-score-bar',
    'team-ct-rail',
    'team-t-rail',
    'focused-player',
    'series-strip',
    'round-history',
  ].includes(id);
  const variants = [
    ...(id === 'focused-player' ? ['default', 'minimal'] : ['default']),
    ...(styled ? HUD_BROADCAST_STYLES : []),
  ];
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
              id === 'focused-player' && path !== 'showReserveAmmo'
                ? variants.filter((variant) => variant !== 'minimal')
                : (id === 'top-score-bar' &&
                      ['showSeriesWins', 'showAliveMatchup'].includes(path)) ||
                    ((id === 'team-ct-rail' || id === 'team-t-rail') && path === 'showTeamName')
                  ? variants.filter((variant) => variant !== 'perfectworld')
                  : (id === 'focused-player' && path === 'showReserveAmmo') ||
                      ((id === 'team-ct-rail' || id === 'team-t-rail') &&
                        path === 'showTeamSummary')
                    ? variants.filter((variant) => variant !== 'esl')
                    : variants,
          },
  );
  const settingsSchemaByVariant: Record<string, (value: unknown) => Record<string, unknown>> = {
    default: (value) => schema.parse(value),
  };
  const defaultSettingsByVariant: Record<string, Record<string, unknown>> = { default: defaults };
  if (id === 'team-ct-rail' || id === 'team-t-rail') {
    defaultSettingsByVariant.esl = { ...defaultSettingsByVariant.esl, showTeamSummary: false };
  }
  if (id === 'focused-player') {
    settingsSchemaByVariant.minimal = (value) => minimalFocusedPlayerSettingsSchema.parse(value);
    defaultSettingsByVariant.minimal = minimalFocusedPlayerSettingsSchema.parse({});
  }
  const variantLabels: Record<string, string> = { default: '默认' };
  if (styled)
    for (const style of HUD_BROADCAST_STYLES) {
      settingsSchemaByVariant[style] = (value) => schema.parse(value);
      defaultSettingsByVariant[style] = cloneJson(defaults);
      variantLabels[style] = HUD_BROADCAST_STYLE_CATALOG.find(
        (item) => item.style === style,
      )!.label;
    }
  if (id === 'focused-player') {
    variantLabels.default = '标准信息';
    variantLabels.minimal = '精简信息';
    defaultSettingsByVariant.ewc = {
      ...defaultSettingsByVariant.ewc,
      showMetrics: false,
    };
    defaultSettingsByVariant.esl = {
      ...defaultSettingsByVariant.esl,
      showMetrics: false,
    };
    defaultSettingsByVariant.iem = {
      ...defaultSettingsByVariant.iem,
      showMetrics: false,
    };
  }
  if (id === 'team-ct-rail' || id === 'team-t-rail')
    defaultSettingsByVariant.perfectworld = {
      ...defaultSettingsByVariant.perfectworld,
      showTeamName: false,
    };
  if (styled && id === 'top-score-bar') {
    defaultSettingsByVariant.perfectworld = {
      ...defaultSettingsByVariant.perfectworld,
      showSeriesWins: false,
      showAliveMatchup: false,
    };
  }
  const dimensionsByVariant = Object.fromEntries(
    variants.map((variant) => [
      variant,
      HUD_BROADCAST_STYLE_CATALOG.find((style) => style.style === variant)?.widgetDimensions?.[
        id
      ] ?? WIDGET_DIMENSIONS[id],
    ]),
  );
  return {
    dimensionsByVariant,
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
        id === 'series-overview' ||
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
