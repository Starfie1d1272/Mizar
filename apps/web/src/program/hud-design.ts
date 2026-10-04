/** Local visual review choices; these do not change or activate a saved HUD preset. */
export const HUD_DESIGN_CHOICES = [
  { id: 'arena', label: 'A · 竞技场' },
  { id: 'studio', label: 'B · 演播室' },
  { id: 'current', label: '现有版本' },
] as const;

export type HudDesign = (typeof HUD_DESIGN_CHOICES)[number]['id'];

export function parseHudDesign(value: string | null): HudDesign {
  return value === 'arena' || value === 'studio' ? value : 'current';
}
