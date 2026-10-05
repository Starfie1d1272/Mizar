import { describe, expect, it } from 'vitest';
import {
  createHudPresetPack,
  getBuiltinLayout,
  getBuiltinLayouts,
  getBuiltinPresets,
  getBuiltinThemes,
  getBuiltinPreset,
  getBuiltinTheme,
  getHudWidgetDescriptor,
  instantiateHudPresetPack,
  parseHudPresetPack,
  readHudPresetPack,
  resolveHudPreset,
  parseHudResolvedPreset,
  placementToBox,
  switchHudWidgetVariant,
  HUD_PRESET_PACK_MAX_BYTES,
} from '../src/index.js';

function packFor(style = 'perfectworld') {
  const preset = getBuiltinPresets().find((item) => item.id === `builtin:${style}-preset`)!;
  return createHudPresetPack(
    preset,
    getBuiltinLayouts().find((item) => item.id === preset.layoutId)!,
    getBuiltinThemes().find((item) => item.id === preset.themeId)!,
  );
}

describe('portable HUD preset packs', () => {
  it.each(['mizar-default', 'ewc', 'iem', 'perfectworld', 'esl'])(
    'round trips %s with fresh resource identities and the same presentation',
    (style) => {
      const pack = readHudPresetPack(JSON.stringify(packFor(style), null, 2));
      let sequence = 0;
      const imported = instantiateHudPresetPack(pack, () => `import-${++sequence}`);
      expect(new Set([imported.preset.id, imported.layout.id, imported.theme.id]).size).toBe(3);
      expect(imported.preset.layoutId).toBe(imported.layout.id);
      expect(imported.preset.themeId).toBe(imported.theme.id);
      const resolved = resolveHudPreset(imported.preset, imported.layout, imported.theme);
      const original = resolveHudPreset(pack.preset, pack.layout, pack.theme);
      expect(resolved.widgets).toEqual(original.widgets);
      expect(resolved.layout.widgets).toEqual(original.layout.widgets);
      expect(resolved.theme.semantic).toEqual(original.theme.semantic);
      expect('activePreset' in pack).toBe(false);
    },
  );

  it('rejects unknown format, version, recipe, variant, fields, broken refs and unsafe geometry', () => {
    const pack = packFor();
    for (const value of [
      { ...pack, format: 'other' },
      { ...pack, formatVersion: 2 },
      { ...pack, activePreset: {} },
      { ...pack, theme: { ...pack.theme, recipe: 'external-css' } },
      { ...pack, preset: { ...pack.preset, themeId: 'missing' } },
      { ...pack, preset: { ...pack.preset, layoutId: 'missing' } },
      {
        ...pack,
        preset: {
          ...pack.preset,
          widgets: { ...pack.preset.widgets, radar: { variant: 'external-js', settings: {} } },
        },
      },
      {
        ...pack,
        layout: {
          ...pack.layout,
          widgets: {
            ...pack.layout.widgets,
            radar: { ...pack.layout.widgets.radar, size: { width: 400, height: 300 } },
          },
        },
      },
    ])
      expect(() => parseHudPresetPack(value)).toThrow();
    expect(() => readHudPresetPack('{ invalid JSON')).toThrow();
    expect(() => readHudPresetPack(' '.repeat(HUD_PRESET_PACK_MAX_BYTES + 1))).toThrow('256 KiB');
    expect(() => readHudPresetPack('中'.repeat(HUD_PRESET_PACK_MAX_BYTES / 3 + 1))).toThrow(
      '256 KiB',
    );
  });
});

describe('variant envelopes', () => {
  it('fits Shanghai components to a default layout, clamps edges and returns to default dimensions', () => {
    const preset = getBuiltinPreset();
    const layout = getBuiltinLayout();
    for (const id of ['top-score-bar', 'focused-player'] as const)
      preset.widgets[id] = switchHudWidgetVariant(getHudWidgetDescriptor(id), 'perfectworld');
    layout.widgets['top-score-bar'] = {
      visible: true,
      anchor: 'top-left',
      offsetX: 1440,
      offsetY: 928,
    };
    const resolved = resolveHudPreset(preset, layout, getBuiltinTheme());
    expect(placementToBox('top-score-bar', resolved.layout.widgets['top-score-bar'])).toEqual({
      left: 1120,
      top: 870,
      width: 800,
      height: 210,
    });
    expect(resolved.layout.widgets['focused-player'].size).toEqual({ width: 342, height: 192 });
    expect(parseHudResolvedPreset(resolved)).toEqual(resolved);
    const restored = resolveHudPreset(getBuiltinPreset(), resolved.layout, getBuiltinTheme());
    expect(placementToBox('top-score-bar', restored.layout.widgets['top-score-bar'])).toMatchObject(
      { width: 480, height: 152 },
    );
    expect(
      placementToBox('focused-player', restored.layout.widgets['focused-player']),
    ).toMatchObject({ width: 360, height: 176 });
    expect(layout.widgets['top-score-bar'].size).toBeUndefined();
  });

  it('rejects a frozen envelope that does not match its renderer variant', () => {
    const pack = packFor();
    const resolved = resolveHudPreset(pack.preset, pack.layout, pack.theme);
    expect(() =>
      parseHudResolvedPreset({
        ...resolved,
        layout: {
          ...resolved.layout,
          widgets: {
            ...resolved.layout.widgets,
            'top-score-bar': { ...resolved.layout.widgets['top-score-bar'], size: undefined },
          },
        },
      }),
    ).toThrow('尺寸与 variant 不一致');
  });

  it('exposes only controls rendered by the Shanghai information structure', () => {
    for (const [id, unsupported] of [
      ['top-score-bar', ['showSeriesWins', 'showAliveMatchup']],
      ['team-ct-rail', ['showTeamName']],
      ['team-t-rail', ['showTeamName']],
    ] as const) {
      const controls = getHudWidgetDescriptor(id).editorControls.filter((control) =>
        control.variants.includes('perfectworld'),
      );
      expect(controls.some((control) => new Set<string>(unsupported).has(control.path))).toBe(
        false,
      );
      expect(controls.length).toBeGreaterThan(0);
    }
  });
});
