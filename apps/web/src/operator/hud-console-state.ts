import type { HudLayout, HudPreset, HudTheme } from '@mizar/hud-config';

export type HudWorkspace = 'preset' | 'layout' | 'theme';
export type HudResource = HudPreset | HudLayout | HudTheme;

export interface HudDraftDirtyState {
  readonly preset: boolean;
  readonly layout: boolean;
  readonly theme: boolean;
}

export interface HudSelectedResourceIds {
  readonly preset: string;
  readonly layout: string;
  readonly theme: string;
}

export function hudResourceNameError(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '名称不能为空。';
  if ([...trimmed].length > 80) return '名称最多 80 个 Unicode 字符。';
  return null;
}

export function hudResourceNavigationBlockReason(
  kind: HudWorkspace,
  nextResource: HudResource,
  selectedIds: HudSelectedResourceIds,
  dirty: HudDraftDirtyState,
): string | null {
  if (dirty[kind]) {
    return `当前 HUD ${kind === 'preset' ? '预设' : kind === 'layout' ? '布局' : '外观'} 有未保存草稿。`;
  }
  if (kind !== 'preset') return null;

  const nextPreset = nextResource as HudPreset;
  if (dirty.layout && nextPreset.layoutId !== selectedIds.layout) {
    return '当前 HUD 布局有未保存草稿；切换预设会覆盖它，请先保存或放弃布局改动。';
  }
  if (dirty.theme && nextPreset.themeId !== selectedIds.theme) {
    return '当前 HUD 外观有未保存草稿；切换预设会覆盖它，请先保存或放弃外观改动。';
  }
  return null;
}
