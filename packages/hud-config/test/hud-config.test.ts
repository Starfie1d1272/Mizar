import { describe, expect, it } from 'vitest';

import {
  HUD_CANVAS_HEIGHT,
  HUD_CANVAS_WIDTH,
  HUD_GRID_SIZE,
  HUD_WIDGET_REGISTRY,
  switchHudWidgetVariant,
  focusedPlayerPresentationSettings,
  canonicalJson,
  changePlacementAnchor,
  createDefaultHudConfigDocument,
  getBuiltinLayout,
  getBuiltinPreset,
  getBuiltinResolvedPreset,
  getBuiltinTheme,
  getHudWidgetDescriptor,
  moveWidgetPlacement,
  parseHudConfigDocument,
  parseHudLayout,
  parseHudPreset,
  parseHudResolvedPreset,
  placementToBox,
  normalizeHudPlacement,
  resetLayoutDraft,
  resolveActiveHudPreset,
  resolveHudPreset,
  resolveHudTheme,
  resizeRadarPlacement,
  snapToGrid,
} from '../src/index.js';

describe('hud-config schema and framework contract', () => {
  it('reads already-saved default snapshots without changing geometry, theme or explicit metrics', () => {
    const saved = getBuiltinResolvedPreset();
    saved.layout.widgets['top-score-bar'] = {
      visible: true,
      anchor: 'top-center',
      offsetX: 0,
      offsetY: 36,
    };
    saved.layout.widgets['focused-player'] = {
      visible: true,
      anchor: 'bottom-center',
      offsetX: 0,
      offsetY: -28,
    };
    saved.layout.widgets['round-history'] = {
      visible: false,
      anchor: 'top-center',
      offsetX: 0,
      offsetY: 136,
    };
    saved.widgets['focused-player'].settings.showMetrics = true;
    saved.theme.brandColor = '#c8ef78';
    const before = JSON.stringify(saved);
    expect(parseHudResolvedPreset(saved)).toEqual(saved);
    expect(JSON.stringify(saved)).toBe(before);
    expect(placementToBox('top-score-bar', saved.layout.widgets['top-score-bar'])).toEqual({
      left: 720,
      top: 36,
      width: 480,
      height: 152,
    });
    expect(() =>
      parseHudResolvedPreset({
        ...saved,
        layout: {
          ...saved.layout,
          widgets: {
            ...saved.layout.widgets,
            'top-score-bar': {
              ...saved.layout.widgets['top-score-bar'],
              size: { width: 799, height: 152 },
            },
          },
        },
      }),
    ).toThrow();
  });

  it('round-trips a strict v1 document and rejects unknown fields', () => {
    const document = createDefaultHudConfigDocument();
    expect(parseHudConfigDocument(JSON.parse(JSON.stringify(document)))).toEqual(document);
    expect(() => parseHudConfigDocument({ ...document, futureField: true })).toThrow();
    expect(() =>
      parseHudConfigDocument({ ...document, customLayouts: [getBuiltinLayout()] }),
    ).toThrow();
    expect(() => parseHudResolvedPreset({ ...getBuiltinResolvedPreset(), widgets: {} })).toThrow();
    expect(
      parseHudResolvedPreset({
        ...getBuiltinResolvedPreset(),
        theme: {
          ...getBuiltinResolvedPreset().theme,
          semantic: {
            ...getBuiltinResolvedPreset().theme.semantic,
            colors: {
              ...getBuiltinResolvedPreset().theme.semantic.colors,
              textPrimary: '#ffffff',
            },
          },
        },
      }).theme.semantic.colors.textPrimary,
    ).toBe('#ffffff');
    expect(() =>
      parseHudResolvedPreset({
        ...getBuiltinResolvedPreset(),
        theme: {
          ...getBuiltinResolvedPreset().theme,
          semantic: {
            ...getBuiltinResolvedPreset().theme.semantic,
            surface: { ...getBuiltinResolvedPreset().theme.semantic.surface, opacity: 2 },
          },
        },
      }),
    ).toThrow();
    expect(() =>
      parseHudLayout({
        ...getBuiltinLayout(),
        widgets: {
          ...getBuiltinLayout().widgets,
          radar: { ...getBuiltinLayout().widgets.radar, width: 10 },
        },
      }),
    ).toThrow();
    expect(() =>
      parseHudLayout({
        ...getBuiltinLayout(),
        widgets: {
          ...getBuiltinLayout().widgets,
          objective: { ...getBuiltinLayout().widgets.objective, scale: 1.1 },
        },
      }),
    ).toThrow();
    expect(() =>
      parseHudLayout({
        ...getBuiltinLayout(),
        widgets: {
          ...getBuiltinLayout().widgets,
          radar: { ...getBuiltinLayout().widgets.radar, offsetX: 2_000 },
        },
      }),
    ).toThrow();
  });

  it('keeps gameplay semantic colours fixed while resolving user appearance controls', () => {
    const standard = resolveHudTheme(getBuiltinTheme());
    const light = resolveHudTheme({
      schemaVersion: 1,
      id: 'theme-1',
      recipe: 'mizar-default',
      name: '测试外观',
      brandColor: '#ff00aa',
      panelStyle: 'light',
      cornerStyle: 'rounded',
    });

    expect(standard.semantic.colors.sideCt).toBe('#2d7ff9');
    expect(light.semantic.colors.sideT).toBe('#f0b84b');
    expect(light.semantic.colors.stateDanger).toBe('#f16c6c');
    expect(light.semantic.colors.objectiveBomb).toBe('#f16c6c');
    expect(light.brandColor).toBe('#ff00aa');
    expect(light.semantic.surface.opacity).toBeLessThan(1);
    expect(light.semantic.radius.lg).toBeGreaterThan(0);
  });

  it('canonicalizes valid HEX values at the schema boundary', () => {
    const parsed = parseHudConfigDocument({
      ...createDefaultHudConfigDocument(),
      customThemes: [{ ...getBuiltinTheme(), id: 'theme-uppercase', brandColor: '#Aa66Ff' }],
    });
    expect(parsed.customThemes[0]?.brandColor).toBe('#aa66ff');
  });

  it('keeps a valid custom activation snapshot across a recipe change', () => {
    const layout = { ...getBuiltinLayout(), id: 'custom-layout', name: '现场布局' };
    const theme = { ...getBuiltinTheme(), id: 'custom-theme', name: '现场外观' };
    const preset = {
      ...getBuiltinPreset(),
      id: 'custom-preset',
      name: '现场预设',
      layoutId: layout.id,
      themeId: theme.id,
    };
    const activated = resolveHudPreset(preset, layout, theme);
    const oldOnAirSnapshot = {
      ...activated,
      theme: {
        ...activated.theme,
        semantic: {
          ...activated.theme.semantic,
          colors: { ...activated.theme.semantic.colors, textPrimary: '#ffffff' },
          surface: { ...activated.theme.semantic.surface, opacity: 0.61 },
        },
      },
    };
    const document = {
      ...createDefaultHudConfigDocument(),
      customLayouts: [layout],
      customThemes: [theme],
      customPresets: [preset],
      activePreset: { kind: 'custom' as const, sourceId: preset.id, snapshot: oldOnAirSnapshot },
    };

    const parsed = parseHudConfigDocument(document);
    expect(resolveActiveHudPreset(parsed).theme.semantic.colors.textPrimary).toBe('#ffffff');
    expect(resolveActiveHudPreset(parsed).theme.semantic.surface.opacity).toBe(0.61);
    expect(resolveHudPreset(preset, layout, theme).theme.semantic.colors.textPrimary).toBe(
      '#f4f8fd',
    );
  });

  it('resets a custom layout without changing its identity', () => {
    const custom = { ...getBuiltinLayout(), id: 'custom-layout', name: '现场布局' };
    custom.widgets.radar.offsetX = 111;
    const reset = resetLayoutDraft(custom);
    expect(reset.id).toBe('custom-layout');
    expect(reset.name).toBe('现场布局');
    expect(reset.widgets.radar.offsetX).toBe(44);
  });
});

describe('hud-config logical geometry', () => {
  it('uses logical pixels and clamps dragged boxes to the canvas', () => {
    const placement = getBuiltinLayout().widgets.radar;
    const moved = moveWidgetPlacement('radar', placement, -10_000, 10_000);
    const box = placementToBox('radar', moved);

    expect(box.left).toBe(0);
    expect(box.top + box.height).toBe(HUD_CANVAS_HEIGHT);
    expect(box.left + box.width).toBeLessThanOrEqual(HUD_CANVAS_WIDTH);
    expect(Math.abs(moved.offsetX % HUD_GRID_SIZE)).toBe(0);
  });

  it('allows only square radar resize and snaps to the 10px grid', () => {
    const resized = resizeRadarPlacement(getBuiltinLayout().widgets.radar, 77);
    expect(resized.size?.width).toBe(resized.size?.height);
    expect(resized.size?.width).toBe(450);
    expect(snapToGrid(24)).toBe(20);
    expect(() => resizeRadarPlacement(getBuiltinLayout().widgets['top-score-bar'], 20)).toThrow();
    expect(resizeRadarPlacement(getBuiltinLayout().widgets.radar, 10_000).size?.width).toBe(
      HUD_CANVAS_HEIGHT,
    );
    expect(resizeRadarPlacement(getBuiltinLayout().widgets.radar, -10_000).size?.width).toBe(
      HUD_GRID_SIZE,
    );
  });

  it('preserves the visual box when changing any anchor', () => {
    const placement = getBuiltinLayout().widgets['round-result'];
    const before = placementToBox('round-result', placement);
    const anchors = [
      'top-left',
      'top-center',
      'top-right',
      'center-left',
      'center',
      'center-right',
      'bottom-left',
      'bottom-center',
      'bottom-right',
    ] as const;
    for (const anchor of anchors) {
      expect(
        placementToBox('round-result', changePlacementAnchor('round-result', placement, anchor)),
      ).toEqual(before);
    }
  });

  it('canonicalizes object key order for stable revisions', () => {
    expect(canonicalJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  it('normalizes numeric edits to a canonical in-canvas placement', () => {
    const placement = getBuiltinLayout().widgets.radar;
    const normalized = normalizeHudPlacement('radar', {
      ...placement,
      offsetX: 1_000,
      offsetY: -1_000,
    });
    const box = placementToBox('radar', normalized);
    expect(box.left).toBe(1_000);
    expect(box.top).toBe(0);
    expect(box.left + box.width).toBeLessThanOrEqual(HUD_CANVAS_WIDTH);
    expect(box.top + box.height).toBeLessThanOrEqual(HUD_CANVAS_HEIGHT);
  });
});

describe('widget customization contract', () => {
  it.each(['ewc', 'iem'] as const)(
    'starts %s Focus without metrics and preserves an explicit saved opt-in',
    (style) => {
      const preset = getBuiltinResolvedPreset(`builtin:${style}-preset`);
      expect(focusedPlayerPresentationSettings(preset.widgets['focused-player'])).toMatchObject({
        showMetrics: false,
        showMedia: true,
        showReserveAmmo: true,
      });
      preset.widgets['focused-player'].settings.showMetrics = true;
      const restored = parseHudResolvedPreset(JSON.parse(JSON.stringify(preset)));
      expect(
        focusedPlayerPresentationSettings(restored.widgets['focused-player']).showMetrics,
      ).toBe(true);
      expect(
        focusedPlayerPresentationSettings(getBuiltinResolvedPreset().widgets['focused-player'])
          .showMetrics,
      ).toBe(false);
    },
  );

  it('validates every declared default and control value, rejecting undeclared fields', () => {
    for (const descriptor of HUD_WIDGET_REGISTRY) {
      for (const variant of descriptor.supportedVariants) {
        const envelope = switchHudWidgetVariant(descriptor, variant);
        expect(() =>
          descriptor.validateSettings({
            ...envelope,
            settings: { ...envelope.settings, arbitraryCss: 'invalid' },
          }),
        ).toThrow();
        for (const control of descriptor.editorControls.filter((control) =>
          control.variants.includes(variant),
        )) {
          const values =
            control.type === 'boolean'
              ? [false, true]
              : control.options.map((option) => option.value);
          for (const value of values)
            expect(
              descriptor.validateSettings({
                ...envelope,
                settings: { ...envelope.settings, [control.path]: value },
              }).settings[control.path],
            ).toBe(value);
          expect(() =>
            descriptor.validateSettings({
              ...envelope,
              settings: { ...envelope.settings, [control.path]: null },
            }),
          ).toThrow();
        }
      }
    }
  });

  it('fills declared authoring defaults but never fills incomplete resolved settings', () => {
    const preset = getBuiltinPreset();
    const descriptor = getHudWidgetDescriptor('focused-player');
    preset.widgets['focused-player'] = { variant: 'minimal', settings: {} };
    const parsed = parseHudPreset(preset);
    expect(parsed.widgets['focused-player'].settings).toEqual(
      descriptor.defaultSettingsByVariant.minimal,
    );
    const resolved = resolveHudPreset(parsed, getBuiltinLayout(), getBuiltinTheme());
    expect(parseHudResolvedPreset(JSON.parse(JSON.stringify(resolved)))).toEqual(resolved);
    expect(() =>
      parseHudResolvedPreset({
        ...resolved,
        widgets: { ...resolved.widgets, 'focused-player': { variant: 'minimal', settings: {} } },
      }),
    ).toThrow();
    expect(() => parseHudResolvedPreset({ ...resolved, schemaVersion: 1 })).toThrow();
    expect(() => switchHudWidgetVariant(descriptor, 'missing')).toThrow();
    expect(() =>
      descriptor.validateSettings({ variant: 'minimal', settings: { showMetrics: true } }),
    ).toThrow();
    expect(focusedPlayerPresentationSettings(parsed.widgets['focused-player'])).toEqual({
      showMedia: false,
      showMetrics: false,
      showReserveAmmo: false,
    });
  });

  it('preserves a frozen variant and settings when authoring changes', () => {
    const preset = { ...getBuiltinPreset(), id: 'custom-settings' };
    preset.widgets['focused-player'] = switchHudWidgetVariant(
      getHudWidgetDescriptor('focused-player'),
      'minimal',
    );
    const snapshot = resolveHudPreset(preset, getBuiltinLayout(), getBuiltinTheme());
    const changed = {
      ...preset,
      widgets: {
        ...preset.widgets,
        'focused-player': getBuiltinPreset().widgets['focused-player'],
      },
    };
    const document = parseHudConfigDocument({
      ...createDefaultHudConfigDocument(),
      customPresets: [changed],
      activePreset: { kind: 'custom', sourceId: preset.id, snapshot },
    });
    expect(resolveActiveHudPreset(document).widgets['focused-player']).toEqual(
      snapshot.widgets['focused-player'],
    );
    expect(document.customPresets[0]!.widgets['focused-player'].variant).toBe('default');
  });
});
