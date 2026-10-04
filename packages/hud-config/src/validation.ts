import { validateHudVariantLayout } from './variant-layout.js';
import { HUD_WIDGET_IDS } from './constants.js';
import { hudLayoutSchema, hudPresetSchema, hudResolvedPresetSchema } from './schemas.js';
import { hasExactWidgetKeys, completeWidgetRecord } from './json.js';
import { canonicalJson } from './canonical-json.js';
import { getHudWidgetDescriptor } from './widget-registry.js';
import { validatePlacementWithinCanvas } from './geometry.js';
import type { HudLayout, HudPreset, HudResolvedPreset } from './types.js';
export function parseHudLayout(value: unknown): HudLayout {
  const parsed = hudLayoutSchema.parse(value);
  if (!hasExactWidgetKeys(parsed.widgets))
    throw new Error('HudLayout 必须完整包含第一版组件 Registry');
  for (const id of HUD_WIDGET_IDS) {
    const placement = parsed.widgets[id];
    if (placement === undefined) throw new Error(`HudLayout 缺少组件：${id}`);
    const descriptor = getHudWidgetDescriptor(id);
    const size = placement.size;
    if (descriptor.resizePolicy === 'none') {
      if (placement.scale !== undefined) throw new Error(`组件 ${id} 不允许持久化 scale`);
      if (
        size !== undefined &&
        !Object.values(descriptor.dimensionsByVariant).some(
          (dimensions) => dimensions.width === size.width && dimensions.height === size.height,
        )
      )
        throw new Error(`组件 ${id} 不允许调整尺寸`);
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
  validateHudVariantLayout(layout, widgets);
  return { ...parsed, layout, widgets };
}
