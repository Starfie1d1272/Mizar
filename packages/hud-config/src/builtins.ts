import { HUD_BROADCAST_STYLE_CATALOG } from './presets/catalog.js';
import {
  HUD_CONFIG_SCHEMA_VERSION,
  BUILTIN_LAYOUT_ID,
  BUILTIN_THEME_ID,
  BUILTIN_PRESET_ID,
} from './constants.js';
import { NATIVE_WIDGET_DIMENSIONS } from './widget-dimensions.js';
import { DEFAULT_PLACEMENTS } from './geometry.js';
import { cloneJson, deepFreeze, completeWidgetRecord } from './json.js';
import { getHudWidgetDescriptor, switchHudWidgetVariant } from './widget-registry.js';
import type { HudLayout, HudPreset, HudTheme } from './types.js';
export function getBuiltinLayout(): HudLayout {
  return cloneJson(BUILTIN_LAYOUT);
}

export function getBuiltinLayouts(): HudLayout[] {
  return [
    getBuiltinLayout(),
    ...HUD_BROADCAST_STYLE_CATALOG.flatMap(({ style, layout }) =>
      layout === undefined
        ? []
        : [
            {
              ...getBuiltinLayout(),
              id: `builtin:${style}-layout`,
              name: layout.name,
              widgets: { ...cloneJson(DEFAULT_PLACEMENTS), ...cloneJson(layout.widgets) },
            },
          ],
    ),
  ];
}

export function getBuiltinTheme(): HudTheme {
  return cloneJson(BUILTIN_THEME);
}

export function getBuiltinPreset(): HudPreset {
  return cloneJson(BUILTIN_PRESET);
}

export function getBuiltinPresets(): HudPreset[] {
  return [
    getBuiltinPreset(),
    ...HUD_BROADCAST_STYLE_CATALOG.map(({ style, label, layout, showTeamName }) => ({
      ...getBuiltinPreset(),
      id: `builtin:${style}-preset`,
      name: label,
      themeId: `builtin:${style}-theme`,
      layoutId: layout === undefined ? BUILTIN_LAYOUT_ID : `builtin:${style}-layout`,
      widgets: completeWidgetRecord((id) => {
        const descriptor = getHudWidgetDescriptor(id);
        const settings = switchHudWidgetVariant(
          descriptor,
          descriptor.supportedVariants.includes(style) ? style : descriptor.defaultVariant,
        );
        if (id === 'team-ct-rail' || id === 'team-t-rail') {
          settings.settings.showTeamName = showTeamName;
        }
        return settings;
      }),
    })),
  ];
}

export function getBuiltinThemes(): HudTheme[] {
  return [
    getBuiltinTheme(),
    ...HUD_BROADCAST_STYLE_CATALOG.map(({ style, label, brandColor }) => ({
      ...getBuiltinTheme(),
      id: `builtin:${style}-theme`,
      name: label,
      recipe: style,
      ...(brandColor === undefined ? {} : { brandColor }),
    })),
  ];
}

const BUILTIN_LAYOUT: HudLayout = deepFreeze({
  schemaVersion: HUD_CONFIG_SCHEMA_VERSION,
  id: BUILTIN_LAYOUT_ID,
  name: 'Mizar 默认布局',
  widgets: {
    ...completeWidgetRecord((id) => cloneJson(DEFAULT_PLACEMENTS[id])),
    'top-score-bar': {
      visible: true,
      anchor: 'top-center',
      offsetX: 0,
      offsetY: 24,
      size: NATIVE_WIDGET_DIMENSIONS['top-score-bar']!,
    },
    'team-ct-rail': { visible: true, anchor: 'top-left', offsetX: 20, offsetY: 492 },
    'team-t-rail': { visible: true, anchor: 'top-right', offsetX: -20, offsetY: 492 },
    'round-history': {
      visible: true,
      anchor: 'top-center',
      offsetX: 0,
      offsetY: 128,
      size: NATIVE_WIDGET_DIMENSIONS['round-history']!,
    },
    'focused-player': {
      visible: true,
      anchor: 'bottom-center',
      offsetX: 0,
      offsetY: -110,
      size: NATIVE_WIDGET_DIMENSIONS['focused-player']!,
    },
  },
});

const BUILTIN_THEME: HudTheme = deepFreeze({
  schemaVersion: HUD_CONFIG_SCHEMA_VERSION,
  id: BUILTIN_THEME_ID,
  name: 'Mizar 默认外观',
  recipe: 'mizar-default',
  brandColor: '#38bdf8',
  panelStyle: 'standard',
  cornerStyle: 'square',
});

const BUILTIN_PRESET: HudPreset = deepFreeze({
  schemaVersion: HUD_CONFIG_SCHEMA_VERSION,
  id: BUILTIN_PRESET_ID,
  name: 'Mizar 默认预设',
  layoutId: BUILTIN_LAYOUT_ID,
  themeId: BUILTIN_THEME_ID,
  widgets: completeWidgetRecord((id) => {
    const descriptor = getHudWidgetDescriptor(id);
    return switchHudWidgetVariant(descriptor, descriptor.defaultVariant);
  }),
});
