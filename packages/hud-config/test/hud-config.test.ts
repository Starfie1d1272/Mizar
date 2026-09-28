import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  BUILTIN_LAYOUT_ID,
  BUILTIN_PRESET_ID,
  HUD_CANVAS_HEIGHT,
  HUD_CANVAS_WIDTH,
  HUD_GRID_SIZE,
  HUD_WIDGET_IDS,
  HUD_WIDGET_REGISTRY,
  switchHudWidgetVariant,
  focusedPlayerPresentationSettings,
  canonicalJson,
  changePlacementAnchor,
  createDefaultHudConfigDocument,
  defineHudWidgetDescriptor,
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
  it('provides a complete immutable-by-convention built-in registry', () => {
    const preset = getBuiltinPreset();
    const layout = getBuiltinLayout();

    expect(preset.id).toBe(BUILTIN_PRESET_ID);
    expect(layout.id).toBe(BUILTIN_LAYOUT_ID);
    expect(Object.keys(layout.widgets).sort()).toEqual([...HUD_WIDGET_IDS].sort());
    expect(layout.widgets.radar.size).toEqual({ width: 400, height: 400 });
    expect(placementToBox('top-score-bar', layout.widgets['top-score-bar'])).toMatchObject({
      left: 720,
      top: 36,
      width: 480,
      height: 152,
    });
    expect(placementToBox('series-strip', layout.widgets['series-strip'])).toMatchObject({
      left: 44,
      top: 36,
      width: 400,
      height: 72,
    });
    expect(placementToBox('team-ct-rail', layout.widgets['team-ct-rail'])).toMatchObject({
      left: 0,
      top: 524,
      width: 440,
      height: 478,
    });
    expect(placementToBox('team-t-rail', layout.widgets['team-t-rail'])).toMatchObject({
      left: 1480,
      top: 524,
      width: 440,
      height: 478,
    });
    expect(placementToBox('focused-player', layout.widgets['focused-player'])).toMatchObject({
      left: 780,
      top: 876,
      width: 360,
      height: 176,
    });
    expect(layout.widgets['round-history'].visible).toBe(false);
    expect(layout.widgets.objective.visible).toBe(false);
    expect(layout.widgets['round-result'].visible).toBe(false);
    expect(placementToBox('round-history', layout.widgets['round-history'])).toMatchObject({
      left: 680,
      top: 136,
      width: 560,
      height: 56,
    });
    expect(getHudWidgetDescriptor('top-score-bar').rendererAvailability).toBe('implemented');
    expect(getHudWidgetDescriptor('series-strip').rendererAvailability).toBe('implemented');
    expect(getHudWidgetDescriptor('round-history').rendererAvailability).toBe('implemented');
    expect(
      HUD_WIDGET_IDS.every((id) => {
        const box = placementToBox(id, layout.widgets[id]);
        return (
          box.left >= 0 &&
          box.top >= 0 &&
          box.left + box.width <= HUD_CANVAS_WIDTH &&
          box.top + box.height <= HUD_CANVAS_HEIGHT
        );
      }),
    ).toBe(true);

    const changed = getBuiltinLayout();
    changed.widgets.radar.offsetX = 100;
    expect(getBuiltinLayout().widgets.radar.offsetX).toBe(44);
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
      name: '测试外观',
      brandColor: '#ff00aa',
      panelStyle: 'light',
      cornerStyle: 'rounded',
    });

    expect(standard.semantic.colors.sideCt).toBe('#6aa8ff');
    expect(light.semantic.colors.sideT).toBe('#f2bd4f');
    expect(light.semantic.colors.stateDanger).toBe('#f06f6f');
    expect(light.semantic.colors.objectiveBomb).toBe('#f06f6f');
    expect(light.brandColor).toBe('#ff00aa');
    expect(light.semantic.surface.opacity).toBeLessThan(1);
    expect(light.semantic.radius.lg).toBeGreaterThan(0);

    const surfaceVariants = [
      ['solid', 0.98],
      ['standard', 0.88],
      ['light', 0.7],
    ] as const;
    for (const [panelStyle, opacity] of surfaceVariants) {
      expect(
        resolveHudTheme({ ...getBuiltinTheme(), id: `theme-${panelStyle}`, panelStyle }).semantic
          .surface.opacity,
      ).toBe(opacity);
    }

    const radiusVariants = [
      ['square', 0],
      ['soft', 8],
      ['rounded', 14],
    ] as const;
    for (const [cornerStyle, radius] of radiusVariants) {
      expect(
        resolveHudTheme({ ...getBuiltinTheme(), id: `theme-${cornerStyle}`, cornerStyle }).semantic
          .radius.md,
      ).toBe(radius);
    }
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
      '#f3f6fa',
    );
  });

  it('lets a future descriptor own a non-default variant while current widgets stay fail-closed', () => {
    const futureDescriptor = defineHudWidgetDescriptor({
      id: 'radar',
      label: '雷达',
      sourceOwner: 'radar',
      variantLabels: { default: '默认', compact: '紧凑' },
      defaultSettingsByVariant: { default: { showLabel: true }, compact: { density: 'tight' } },
      editorControls: [
        { path: 'showLabel', label: '显示标签', type: 'boolean', variants: ['default'] },
        {
          path: 'density',
          label: '密度',
          type: 'select',
          variants: ['compact'],
          options: [{ value: 'tight', label: '紧凑' }],
        },
      ],
      rendererAvailability: 'implemented',
      supportedVariants: ['default', 'compact'] as const,
      defaultVariant: 'compact',
      resizePolicy: 'square',
      defaultPlacement: getBuiltinLayout().widgets.radar,
      settingsSchemaByVariant: {
        default: (value: unknown) => z.object({ showLabel: z.boolean() }).strict().parse(value),
        compact: (value: unknown) =>
          z
            .object({ density: z.literal('tight') })
            .strict()
            .parse(value),
      },
    });

    expect(
      futureDescriptor.validateSettings({ variant: 'compact', settings: { density: 'tight' } }),
    ).toEqual({ variant: 'compact', settings: { density: 'tight' } });
    expect(
      futureDescriptor.validateSettings({ variant: 'default', settings: { showLabel: true } }),
    ).toEqual({ variant: 'default', settings: { showLabel: true } });
    expect(() =>
      futureDescriptor.validateSettings({ variant: 'compact', settings: { showLabel: true } }),
    ).toThrow();
    expect(() =>
      futureDescriptor.validateSettings({ variant: 'default', settings: { density: 'tight' } }),
    ).toThrow();
    expect(() =>
      getHudWidgetDescriptor('radar').validateSettings({ variant: 'compact', settings: {} }),
    ).toThrow();
    expect(() =>
      parseHudPreset({
        ...getBuiltinPreset(),
        widgets: {
          ...getBuiltinPreset().widgets,
          radar: { variant: 'compact', settings: {} },
        },
      }),
    ).toThrow();
    expect(() =>
      defineHudWidgetDescriptor({
        ...futureDescriptor,
        id: futureDescriptor.id,
        label: futureDescriptor.label,
        rendererAvailability: futureDescriptor.rendererAvailability,
        supportedVariants: futureDescriptor.supportedVariants,
        defaultVariant: 'missing',
        resizePolicy: futureDescriptor.resizePolicy,
        defaultPlacement: futureDescriptor.defaultPlacement,
        settingsSchemaByVariant: {
          default: (value: unknown) => z.object({ showLabel: z.boolean() }).strict().parse(value),
          compact: (value: unknown) =>
            z
              .object({ density: z.literal('tight') })
              .strict()
              .parse(value),
        },
      }),
    ).toThrow();
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
    expect(resized.size?.width).toBe(480);
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
  it('validates every declared default and control value, rejecting undeclared fields', () => {
    for (const descriptor of HUD_WIDGET_REGISTRY) {
      expect(Object.keys(descriptor.settingsSchemaByVariant).sort()).toEqual(
        [...descriptor.supportedVariants].sort(),
      );
      expect(Object.keys(descriptor.defaultSettingsByVariant).sort()).toEqual(
        [...descriptor.supportedVariants].sort(),
      );
      for (const variant of descriptor.supportedVariants) {
        const envelope = switchHudWidgetVariant(descriptor, variant);
        expect(envelope.settings).toEqual(descriptor.defaultSettingsByVariant[variant]);
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

  it('rejects inconsistent defaults and control metadata at declaration time', () => {
    const descriptor = getHudWidgetDescriptor('radar');
    expect(() =>
      defineHudWidgetDescriptor({ ...descriptor, defaultSettingsByVariant: {} }),
    ).toThrow();
    expect(() =>
      defineHudWidgetDescriptor({
        ...descriptor,
        defaultSettingsByVariant: { default: { zoomMode: 'invalid' } },
      }),
    ).toThrow();
    expect(() =>
      defineHudWidgetDescriptor({
        ...descriptor,
        editorControls: [
          { path: 'missing', label: '缺失', type: 'boolean', variants: ['default'] },
        ],
      }),
    ).toThrow();
    expect(() =>
      defineHudWidgetDescriptor({
        ...descriptor,
        editorControls: [{ ...descriptor.editorControls[0]!, variants: ['missing'] }],
      }),
    ).toThrow();
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
