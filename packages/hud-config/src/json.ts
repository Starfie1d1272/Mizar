import { HUD_WIDGET_IDS } from './constants.js';
import type { HudWidgetId } from './types.js';
export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

export function completeWidgetRecord<T>(factory: (id: HudWidgetId) => T): Record<HudWidgetId, T> {
  return Object.fromEntries(HUD_WIDGET_IDS.map((id) => [id, factory(id)])) as Record<
    HudWidgetId,
    T
  >;
}

export function hasExactWidgetKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === HUD_WIDGET_IDS.length && HUD_WIDGET_IDS.every((id) => keys.includes(id));
}
