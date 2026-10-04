import { WIDGET_DIMENSIONS } from './widget-dimensions.js';
import { cloneJson } from './json.js';
import { HUD_CANVAS_HEIGHT, HUD_CANVAS_WIDTH, HUD_GRID_SIZE, HUD_WIDGET_IDS } from './constants.js';
import type {
  HudAnchor,
  HudWidgetBox,
  HudWidgetId,
  HudWidgetPlacement,
  HudLayout,
} from './types.js';

export const DEFAULT_PLACEMENTS: Record<HudWidgetId, HudWidgetPlacement> = {
  'top-score-bar': { visible: true, anchor: 'top-center', offsetX: 0, offsetY: 36 },
  'team-ct-rail': { visible: true, anchor: 'top-left', offsetX: 0, offsetY: 524 },
  'team-t-rail': { visible: true, anchor: 'top-right', offsetX: 0, offsetY: 524 },
  radar: {
    visible: true,
    anchor: 'top-left',
    offsetX: 44,
    offsetY: 116,
    size: { width: 400, height: 400 },
  },
  'focused-player': { visible: true, anchor: 'bottom-center', offsetX: 0, offsetY: -28 },
  'series-strip': { visible: true, anchor: 'top-left', offsetX: 44, offsetY: 36 },
  'series-overview': { visible: false, anchor: 'top-right', offsetX: -6, offsetY: 6 },
  'round-history': { visible: false, anchor: 'top-center', offsetX: 0, offsetY: 136 },
  objective: { visible: false, anchor: 'top-right', offsetX: -28, offsetY: 28 },
  'round-result': { visible: false, anchor: 'center', offsetX: 0, offsetY: 210 },
};

export function getWidgetDimensions(
  id: HudWidgetId,
  placement: HudWidgetPlacement = DEFAULT_PLACEMENTS[id],
): { readonly width: number; readonly height: number } {
  if (placement.size !== undefined) {
    return { width: placement.size.width, height: placement.size.height };
  }
  return WIDGET_DIMENSIONS[id];
}

function anchorPoint(anchor: HudAnchor): { readonly x: number; readonly y: number } {
  return {
    'top-left': { x: 0, y: 0 },
    'top-center': { x: HUD_CANVAS_WIDTH / 2, y: 0 },
    'top-right': { x: HUD_CANVAS_WIDTH, y: 0 },
    'center-left': { x: 0, y: HUD_CANVAS_HEIGHT / 2 },
    center: { x: HUD_CANVAS_WIDTH / 2, y: HUD_CANVAS_HEIGHT / 2 },
    'center-right': { x: HUD_CANVAS_WIDTH, y: HUD_CANVAS_HEIGHT / 2 },
    'bottom-left': { x: 0, y: HUD_CANVAS_HEIGHT },
    'bottom-center': { x: HUD_CANVAS_WIDTH / 2, y: HUD_CANVAS_HEIGHT },
    'bottom-right': { x: HUD_CANVAS_WIDTH, y: HUD_CANVAS_HEIGHT },
  }[anchor];
}

function anchorAlignment(anchor: HudAnchor): { readonly x: number; readonly y: number } {
  return {
    'top-left': { x: 0, y: 0 },
    'top-center': { x: 0.5, y: 0 },
    'top-right': { x: 1, y: 0 },
    'center-left': { x: 0, y: 0.5 },
    center: { x: 0.5, y: 0.5 },
    'center-right': { x: 1, y: 0.5 },
    'bottom-left': { x: 0, y: 1 },
    'bottom-center': { x: 0.5, y: 1 },
    'bottom-right': { x: 1, y: 1 },
  }[anchor];
}

function placementToUnclampedBox(id: HudWidgetId, placement: HudWidgetPlacement): HudWidgetBox {
  const dimensions = getWidgetDimensions(id, placement);
  const point = anchorPoint(placement.anchor);
  const alignment = anchorAlignment(placement.anchor);
  return {
    left: point.x + placement.offsetX - dimensions.width * alignment.x,
    top: point.y + placement.offsetY - dimensions.height * alignment.y,
    width: dimensions.width,
    height: dimensions.height,
  };
}

export function placementToBox(id: HudWidgetId, placement: HudWidgetPlacement): HudWidgetBox {
  return clampWidgetBox(placementToUnclampedBox(id, placement));
}

export function validatePlacementWithinCanvas(
  id: HudWidgetId,
  placement: HudWidgetPlacement,
): HudWidgetBox {
  const box = placementToUnclampedBox(id, placement);
  const clamped = clampWidgetBox(box);
  if (
    box.left !== clamped.left ||
    box.top !== clamped.top ||
    box.width !== clamped.width ||
    box.height !== clamped.height
  ) {
    throw new Error(`组件 ${id} 的位置或尺寸超出 1920 × 1080 画布边界`);
  }
  return box;
}

function offsetForBox(
  anchor: HudAnchor,
  box: HudWidgetBox,
): { readonly offsetX: number; readonly offsetY: number } {
  const point = anchorPoint(anchor);
  const alignment = anchorAlignment(anchor);
  return {
    offsetX: box.left + box.width * alignment.x - point.x,
    offsetY: box.top + box.height * alignment.y - point.y,
  };
}

export function clampWidgetBox(box: HudWidgetBox): HudWidgetBox {
  const width = Math.min(box.width, HUD_CANVAS_WIDTH);
  const height = Math.min(box.height, HUD_CANVAS_HEIGHT);
  return {
    left: Math.max(0, Math.min(box.left, HUD_CANVAS_WIDTH - width)),
    top: Math.max(0, Math.min(box.top, HUD_CANVAS_HEIGHT - height)),
    width,
    height,
  };
}

export function placementFromBox(
  id: HudWidgetId,
  base: HudWidgetPlacement,
  box: HudWidgetBox,
): HudWidgetPlacement {
  const clamped = clampWidgetBox(box);
  const offsets = offsetForBox(base.anchor, clamped);
  return {
    ...base,
    offsetX: offsets.offsetX,
    offsetY: offsets.offsetY,
    ...(id === 'radar' && base.size !== undefined
      ? { size: { width: clamped.width, height: clamped.height } }
      : {}),
  };
}

export function changePlacementAnchor(
  id: HudWidgetId,
  placement: HudWidgetPlacement,
  anchor: HudAnchor,
): HudWidgetPlacement {
  return placementFromBox(id, { ...placement, anchor }, placementToBox(id, placement));
}

export function normalizeHudPlacement(
  id: HudWidgetId,
  placement: HudWidgetPlacement,
): HudWidgetPlacement {
  return placementFromBox(id, placement, placementToBox(id, placement));
}

export function normalizeHudLayout(layout: HudLayout): HudLayout {
  return {
    ...cloneJson(layout),
    widgets: Object.fromEntries(
      HUD_WIDGET_IDS.map((id) => [id, normalizeHudPlacement(id, layout.widgets[id])]),
    ) as Record<HudWidgetId, HudWidgetPlacement>,
  };
}

export function snapToGrid(value: number, grid = HUD_GRID_SIZE): number {
  return Math.round(value / grid) * grid;
}

export function moveWidgetPlacement(
  id: HudWidgetId,
  placement: HudWidgetPlacement,
  deltaX: number,
  deltaY: number,
  snap = true,
): HudWidgetPlacement {
  const box = placementToBox(id, placement);
  const moved = {
    ...box,
    left: snap ? snapToGrid(box.left + deltaX) : box.left + deltaX,
    top: snap ? snapToGrid(box.top + deltaY) : box.top + deltaY,
  };
  return placementFromBox(id, placement, moved);
}

export function resizeRadarPlacement(
  placement: HudWidgetPlacement,
  delta: number,
  snap = true,
): HudWidgetPlacement {
  if (placement.size === undefined) throw new Error('Radar placement 缺少 square size');
  const current = placementToBox('radar', placement);
  const nextSize = current.width + delta;
  const size = Math.max(
    snap ? HUD_GRID_SIZE : 1,
    Math.min(HUD_CANVAS_WIDTH, HUD_CANVAS_HEIGHT, snap ? snapToGrid(nextSize) : nextSize),
  );
  return placementFromBox('radar', placement, { ...current, width: size, height: size });
}
