import {
  getBuiltinLayouts,
  getBuiltinPresets,
  getBuiltinThemes,
  topScoreBarSettingsSchema,
  type HudLayout,
  type HudWidgetSettings,
} from '@mizar/hud-config';
import type {
  BroadcastConfigDocument,
  HudModule,
  ModuleRecord,
  ProgramVisualConfigV1,
} from '@mizar/broadcast-config';

/** Stable identities are reserved for the application-provided modules. */
export const BUILTIN_MODULE_IDS = {
  'builtin:mizar-default-preset': 'fb81f5a0-9e35-4ae5-8f15-000000000001',
  'builtin:ewc-preset': 'fb81f5a0-9e35-4ae5-8f15-000000000002',
  'builtin:iem-preset': 'fb81f5a0-9e35-4ae5-8f15-000000000003',
  'builtin:perfectworld-preset': 'fb81f5a0-9e35-4ae5-8f15-000000000004',
  'builtin:esl-preset': 'fb81f5a0-9e35-4ae5-8f15-000000000005',
  pulse: 'fb81f5a0-9e35-4ae5-8f15-000000000006',
} as const;
const BUILTIN_REVISION = 'fb81f5a0-9e35-4ae5-8f15-000000000007';
const ids = new Set<string>(Object.values(BUILTIN_MODULE_IDS));
export function isBuiltinModuleId(id: string): boolean {
  return ids.has(id);
}

/** Preserve the old pause and chat rules until the user selects fixed placement. */
export function legacyOverlays(
  layout: HudLayout,
  widgets: Record<string, HudWidgetSettings>,
): Extract<HudModule, { preset: unknown }>['overlays'] {
  return {
    pause: {
      enabled:
        layout.widgets['top-score-bar'].visible &&
        topScoreBarSettingsSchema.parse(widgets['top-score-bar']!.settings).showTimeout,
      visual: 'legacy',
    },
    chat: { enabled: layout.widgets['team-t-rail'].visible, placement: 'auto' },
  };
}

export function createBuiltinModules(): ModuleRecord[] {
  const layouts = getBuiltinLayouts();
  const themes = getBuiltinThemes();
  const hud: ModuleRecord<'hud'>[] = getBuiltinPresets().map((preset) => {
    const id = BUILTIN_MODULE_IDS[preset.id as keyof typeof BUILTIN_MODULE_IDS];
    const layout = layouts.find((item) => item.id === preset.layoutId);
    const theme = themes.find((item) => item.id === preset.themeId);
    if (!id || !layout || !theme) throw new Error('hud_resource_missing');
    return {
      id,
      revision: BUILTIN_REVISION,
      kind: 'hud',
      schemaVersion: 1,
      name: preset.name,
      origin: null,
      value: {
        renderer: { kind: 'native', id: 'mizar.hud', apiVersion: 1 },
        preset,
        layout: structuredClone(layout),
        theme: structuredClone(theme),
        overlays: legacyOverlays(layout, preset.widgets),
        accent: { source: 'fixed', value: theme.brandColor },
      },
    };
  });
  const visual = { kind: 'builtin', id: 'pulse', apiVersion: 1 } as const;
  const value: ProgramVisualConfigV1 = {
    scenes: {
      waiting: visual,
      matchup: visual,
      bp: visual,
      halftime: visual,
      map_result: visual,
      intermap: visual,
      match_result: visual,
    },
    tokens: {},
    assets: {},
  };
  return [
    ...hud,
    {
      id: BUILTIN_MODULE_IDS.pulse,
      revision: BUILTIN_REVISION,
      kind: 'program',
      schemaVersion: 1,
      name: 'Pulse',
      value,
      origin: null,
    },
  ];
}

/** Append missing built-ins without modifying existing records or active snapshots. */
export function addMissingBuiltinModules(document: BroadcastConfigDocument): boolean {
  const present = new Set(document.modules.map((item) => item.id));
  const missing = createBuiltinModules().filter((item) => !present.has(item.id));
  document.modules.push(...missing);
  return missing.length > 0;
}
