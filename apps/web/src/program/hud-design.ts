/** Local visual review choices; these do not change or activate a saved HUD preset. */
export const HUD_DESIGN_CHOICES = [
  { id: 'arena', label: 'A · 竞技场', description: '鲜明阵营色 · 切角轮廓 · 整卡血量' },
  { id: 'studio', label: 'B · 演播室', description: '紧凑直边 · 克制底板 · 战斗信息优先' },
  { id: 'current', label: '现有版本', description: '当前已启用的视觉样式' },
] as const;

export type HudDesign = (typeof HUD_DESIGN_CHOICES)[number]['id'];

export function parseHudDesign(value: string | null): HudDesign {
  return value === 'arena' || value === 'studio' ? value : 'current';
}
