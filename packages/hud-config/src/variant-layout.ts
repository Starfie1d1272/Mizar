import { WIDGET_DIMENSIONS } from './widget-dimensions.js';
import { HUD_WIDGET_IDS } from './constants.js';
import { getHudWidgetDescriptor } from './widget-registry.js';
import { getWidgetDimensions, normalizeHudPlacement } from './geometry.js';
import { completeWidgetRecord } from './json.js';
import type { HudLayout, HudPreset } from './types.js';

/** Preserve layout anchors/offsets, fit fixed variant envelopes, then keep them inside the canvas. */
export function resolveHudVariantLayout(
  layout: HudLayout,
  widgets: HudPreset['widgets'],
): HudLayout {
  return {
    ...layout,
    widgets: completeWidgetRecord((id) => {
      const placement = layout.widgets[id];
      const descriptor = getHudWidgetDescriptor(id);
      if (descriptor.resizePolicy !== 'none') return { ...placement };
      const dimensions = descriptor.dimensionsByVariant[widgets[id].variant]!;
      const current = getWidgetDimensions(id, placement);
      return current.width === dimensions.width && current.height === dimensions.height
        ? { ...placement }
        : normalizeHudPlacement(id, { ...placement, size: { ...dimensions } });
    }),
  };
}

/** Frozen snapshots must already carry the variant envelope; do not silently re-resolve them. */
export function validateHudVariantLayout(layout: HudLayout, widgets: HudPreset['widgets']): void {
  for (const id of HUD_WIDGET_IDS) {
    const descriptor = getHudWidgetDescriptor(id);
    if (descriptor.resizePolicy !== 'none') continue;
    const expected = descriptor.dimensionsByVariant[widgets[id].variant]!;
    const actual = getWidgetDimensions(id, layout.widgets[id]);
    // Same current-version saved snapshot: retain its exact envelope and all settings.
    const storedDefault =
      widgets[id].variant === 'default' &&
      actual.width === WIDGET_DIMENSIONS[id].width &&
      actual.height === WIDGET_DIMENSIONS[id].height;
    if (!storedDefault && (actual.width !== expected.width || actual.height !== expected.height))
      throw new Error(`组件 ${id} 的尺寸与 variant 不一致`);
  }
}
