import {
  createHudPresetPack,
  readHudPresetPack,
  HUD_PRESET_PACK_MAX_BYTES,
  type HudLayout,
  type HudPreset,
  type HudPresetPack,
  type HudTheme,
} from '@mizar/hud-config';

export async function readHudPresetFile(file: File): Promise<HudPresetPack> {
  if (file.size > HUD_PRESET_PACK_MAX_BYTES) throw new Error('预设文件不能超过 256 KiB。');
  try {
    return readHudPresetPack(await file.text());
  } catch {
    throw new Error('预设文件无效或版本不受支持，请检查 JSON、组件方案、外观与资源引用。');
  }
}

export function downloadHudPresetFile(preset: HudPreset, layout: HudLayout, theme: HudTheme): void {
  const pack = createHudPresetPack(preset, layout, theme);
  const blob = new Blob([JSON.stringify(pack, null, 2) + '\n'], { type: 'application/json' });
  if (blob.size > HUD_PRESET_PACK_MAX_BYTES) throw new Error('预设文件不能超过 256 KiB。');
  const filename = [...preset.name.trim()]
    .map((character) =>
      character.charCodeAt(0) < 32 || '/\\:*?"<>|'.includes(character) ? '_' : character,
    )
    .join('');
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = `${filename}.mizar-hud.json`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
