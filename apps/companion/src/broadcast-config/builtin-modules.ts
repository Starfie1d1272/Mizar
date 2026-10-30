import {
  canonicalJson,
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

/** Claim unchanged legacy built-ins before adding any missing identities. */
export function addMissingBuiltinModules(
  document: BroadcastConfigDocument,
  claimLegacy = true,
): boolean {
  const present = new Set(document.modules.map((item) => item.id));
  let changed = false;
  for (const registered of createBuiltinModules()) {
    const builtin = document.modules.find((item) => item.id === registered.id) ?? registered;
    const legacyItems = claimLegacy
      ? document.modules.filter(
          (item) =>
            !isBuiltinModuleId(item.id) &&
            item.origin === null &&
            item.kind === builtin.kind &&
            item.name === builtin.name &&
            item.schemaVersion === builtin.schemaVersion &&
            canonicalJson(item.value) === canonicalJson(builtin.value),
        )
      : [];
    // Multiple identical records are ambiguous; preserve them rather than deleting copies.
    for (const legacy of legacyItems.length === 1 ? legacyItems : []) {
      for (const preset of document.presets)
        for (const binding of preset.bindings)
          if (binding.mode === 'use' && binding.moduleId === legacy.id)
            binding.moduleId = builtin.id;
      for (const snapshot of [document.active, document.previousActive]) {
        if (snapshot?.sourceModuleIds?.[builtin.kind] === legacy.id) {
          snapshot.sourceModuleIds[builtin.kind] = builtin.id;
          if (snapshot.sourceModuleRevisions?.[builtin.kind] === legacy.revision)
            snapshot.sourceModuleRevisions[builtin.kind] = builtin.revision;
        }
      }
      document.modules.splice(document.modules.indexOf(legacy), 1);
      changed = true;
    }
    if (!present.has(builtin.id)) {
      document.modules.push(builtin);
      present.add(builtin.id);
      changed = true;
    }
  }
  return changed;
}
