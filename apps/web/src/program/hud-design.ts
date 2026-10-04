import { HUD_BROADCAST_STYLES } from '@mizar/hud-config';

export type HudDesign = 'current' | (typeof HUD_BROADCAST_STYLES)[number];

/** Presentation comes from the saved widget variant, including custom presets. */
export function hudDesignForVariant(variant: string): HudDesign {
  return HUD_BROADCAST_STYLES.find((style) => style === variant) ?? 'current';
}
