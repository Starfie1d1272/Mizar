export const HUD_CONFIG_SCHEMA_VERSION = 1 as const;
/**
 * Resolved snapshots are an on-air compatibility boundary.  A future recipe
 * change must not reinterpret an already activated snapshot; incompatible
 * snapshot versions are rejected before 1.0; there is no legacy migration.
 */
export const HUD_RESOLVED_SNAPSHOT_SCHEMA_VERSION = 3 as const;
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
  'series-overview',
  'round-history',
  'objective',
  'round-result',
] as const;

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

export const HUD_RESIZE_POLICIES = ['none', 'square', 'scale', 'width-only'] as const;

export const HUD_PANEL_STYLES = ['solid', 'standard', 'light'] as const;

export const HUD_CORNER_STYLES = ['square', 'soft', 'rounded'] as const;

export const BUILTIN_PRESET_ID = 'builtin:mizar-default-preset' as const;
export const HUD_BROADCAST_STYLES = ['ewc', 'iem', 'perfectworld'] as const;
export const BUILTIN_PRESET_IDS = [
  BUILTIN_PRESET_ID,
  ...HUD_BROADCAST_STYLES.map((style) => `builtin:${style}-preset` as const),
] as const;
export const HUD_THEME_RECIPES = ['mizar-default', ...HUD_BROADCAST_STYLES] as const;
export const BUILTIN_LAYOUT_ID = 'builtin:mizar-default-layout' as const;
export const BUILTIN_THEME_ID = 'builtin:mizar-default-theme' as const;
