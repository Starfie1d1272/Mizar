import { themeStyle } from './GameplayHud';
import { Fragment, type PointerEvent } from 'react';

import {
  HUD_WIDGET_REGISTRY,
  getBuiltinResolvedPreset,
  placementToBox,
  type HudResolvedPreset,
  type HudWidgetId,
} from '@mizar/hud-config';

import {
  getHudRendererEntry,
  HUD_RENDERER_REGISTRY,
  type HudRendererRegistry,
} from './hud-renderer-registry';

export interface HudEditorOverlayProps {
  readonly resolvedPreset: HudResolvedPreset;
  readonly mode?: 'layout' | 'preview';
  readonly selectedWidgetId: HudWidgetId | null;
  readonly onWidgetPointerDown?:
    ((widgetId: HudWidgetId, event: PointerEvent<HTMLButtonElement>) => void) | undefined;
  readonly onRadarResizePointerDown?:
    ((event: PointerEvent<HTMLButtonElement>) => void) | undefined;
  readonly rendererRegistry?: HudRendererRegistry;
  readonly interactive?: boolean;
}

/** Editor-only chrome. It is a sibling overlay and never enters the Program renderer. */
export function HudEditorOverlay({
  resolvedPreset,
  mode = 'layout',
  selectedWidgetId,
  onWidgetPointerDown,
  onRadarResizePointerDown,
  rendererRegistry = HUD_RENDERER_REGISTRY,
  interactive = true,
}: HudEditorOverlayProps) {
  return (
    <div
      style={themeStyle(getBuiltinResolvedPreset().theme)}
      aria-label="HUD 编辑辅助层"
      className="hud-editor-overlay"
      data-hud-editor-overlay="true"
    >
      {HUD_WIDGET_REGISTRY.map((descriptor) => {
        const placement = resolvedPreset.layout.widgets[descriptor.id];
        if (placement === undefined || !placement.visible) return null;
        const rendererEntry = getHudRendererEntry(descriptor.id, rendererRegistry);
        if (rendererEntry.renderer === null || mode === 'preview') return null;
        const box = placementToBox(descriptor.id, placement);
        const selected = selectedWidgetId === descriptor.id;
        return (
          <Fragment key={descriptor.id}>
            <button
              aria-label={`${descriptor.label}，可拖动`}
              aria-pressed={selected}
              className={`hud-editor-overlay__widget${selected ? ' is-selected' : ''} is-chrome`}
              data-hud-widget={descriptor.id}
              disabled={!interactive}
              onPointerDown={
                interactive ? (event) => onWidgetPointerDown?.(descriptor.id, event) : undefined
              }
              style={{
                height: `${box.height}px`,
                left: `${box.left}px`,
                top: `${box.top}px`,
                width: `${box.width}px`,
              }}
              type="button"
            ></button>
            {descriptor.id === 'radar' && selected ? (
              <button
                aria-label="调整雷达大小"
                className="hud-editor-overlay__resize-handle"
                disabled={!interactive}
                onPointerDown={onRadarResizePointerDown}
                style={{
                  left: `${box.left + box.width - 10}px`,
                  top: `${box.top + box.height - 10}px`,
                }}
                type="button"
              />
            ) : null}
          </Fragment>
        );
      })}
    </div>
  );
}
