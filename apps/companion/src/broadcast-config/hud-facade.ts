import { randomUUID } from 'node:crypto';
import {
  BUILTIN_PRESET_IDS,
  canonicalJson,
  getBuiltinLayouts,
  getBuiltinPresets,
  getBuiltinThemes,
  parseHudConfigDocument,
  resolveActiveHudPreset,
  type HudConfigDocument,
  type HudLayout,
  type HudPreset,
  type HudTheme,
} from '@mizar/hud-config';
import type {
  ActiveBroadcastSnapshot,
  BroadcastConfigDocument,
  HudModule,
  ModuleRecord,
} from '@mizar/broadcast-config';
import type { HudConfigPersistence } from '../hud-config/store.js';
import type { BroadcastConfigStore } from './store.js';

/** Reconstruct the existing HUD editor view from the coordinator's native modules. */
export function hudDocumentFromBroadcast(document: BroadcastConfigDocument): HudConfigDocument {
  const layouts = new Map<string, HudLayout>();
  const themes = new Map<string, HudTheme>();
  const presets = new Map<string, HudPreset>();
  function add<T extends { id: string }>(items: Map<string, T>, value: T) {
    if (value.id.startsWith('builtin:')) return;
    const existing = items.get(value.id);
    if (existing && canonicalJson(existing) !== canonicalJson(value))
      throw new Error('hud_resource_conflict');
    items.set(value.id, structuredClone(value));
  }
  for (const layout of document.unboundHudResources?.layouts ?? []) add(layouts, layout);
  for (const theme of document.unboundHudResources?.themes ?? []) add(themes, theme);
  for (const module of document.modules)
    if (module.kind === 'hud' && 'preset' in module.value) {
      add(presets, module.value.preset);
      add(layouts, module.value.layout);
      add(themes, module.value.theme);
    }
  const hud = document.active.resolved.hud;
  if (hud.renderer !== 'native') throw new Error('hud_renderer_unsupported');
  const sourceId = hud.config.preset.id;
  const activePreset = BUILTIN_PRESET_IDS.includes(sourceId as (typeof BUILTIN_PRESET_IDS)[number])
    ? { kind: 'builtin' as const, sourceId }
    : { kind: 'custom' as const, sourceId, snapshot: hud.config };
  return parseHudConfigDocument({
    schemaVersion: 1,
    customPresets: [...presets.values()],
    customLayouts: [...layouts.values()],
    customThemes: [...themes.values()],
    activePreset,
  });
}

/** The supplied lock resolver must verify all references for the resulting active snapshot. */
export function createHudConfigPersistence(
  store: BroadcastConfigStore,
  lockFor: (
    hud: ActiveBroadcastSnapshot['resolved']['hud'],
    current: ActiveBroadcastSnapshot,
  ) => Promise<ActiveBroadcastSnapshot['lock']>,
): HudConfigPersistence {
  return {
    initialize: () => Promise.resolve(hudDocumentFromBroadcast(store.snapshot)),
    async commit(candidate, previous) {
      const current = store.snapshot;
      const activeChanged =
        canonicalJson(candidate.activePreset) !== canonicalJson(previous.activePreset);
      const oldHud = current.active.resolved.hud;
      if (oldHud.renderer !== 'native') throw new Error('hud_renderer_unsupported');
      const target = current.modules.find(
        (item) =>
          item.kind === 'hud' &&
          'preset' in item.value &&
          item.value.preset.id === candidate.activePreset.sourceId,
      );
      if (activeChanged && (!target || target.kind !== 'hud' || !('preset' in target.value)))
        throw new Error('hud_resource_missing');
      const targetValue = target?.kind === 'hud' && 'preset' in target.value ? target.value : null;
      const nextHud = {
        ...oldHud,
        config: resolveActiveHudPreset(candidate),
        overlays: targetValue?.overlays ?? oldHud.overlays,
        accent: targetValue?.accent ?? oldHud.accent,
      };
      const lock = activeChanged ? await lockFor(nextHud, current.active) : current.active.lock;
      await store.updateFromLegacy({
        updateDraft(document) {
          if (canonicalJson(hudDocumentFromBroadcast(document)) !== canonicalJson(previous))
            throw new Error('revision_conflict');
          const layouts = [...getBuiltinLayouts(), ...candidate.customLayouts];
          const themes = [...getBuiltinThemes(), ...candidate.customThemes];
          for (const preset of [...getBuiltinPresets(), ...candidate.customPresets]) {
            const layout = layouts.find((item) => item.id === preset.layoutId);
            const theme = themes.find((item) => item.id === preset.themeId);
            if (!layout || !theme) throw new Error('hud_resource_missing');
            const old = document.modules.find(
              (item) =>
                item.kind === 'hud' && 'preset' in item.value && item.value.preset.id === preset.id,
            ) as ModuleRecord<'hud'> | undefined;
            const template = old?.value ?? oldHud;
            if (!('preset' in template) && !('overlays' in template))
              throw new Error('hud_renderer_unsupported');
            const value: HudModule = {
              renderer: { kind: 'native', id: 'mizar.hud', apiVersion: 1 },
              preset: structuredClone(preset),
              layout: structuredClone(layout),
              theme: structuredClone(theme),
              overlays: structuredClone(template.overlays),
              accent: structuredClone(template.accent),
            };
            if (old) {
              old.name = preset.name;
              old.value = value;
            } else
              document.modules.push({
                id: randomUUID(),
                revision: randomUUID(),
                kind: 'hud',
                schemaVersion: 1,
                name: preset.name,
                value,
                origin: null,
              });
          }
          document.unboundHudResources = {
            layouts: candidate.customLayouts.filter(
              (item) => !candidate.customPresets.some((preset) => preset.layoutId === item.id),
            ),
            themes: candidate.customThemes.filter(
              (item) => !candidate.customPresets.some((preset) => preset.themeId === item.id),
            ),
          };
        },
        ...(activeChanged ? { active: { kind: 'hud' as const, value: nextHud, lock } } : {}),
      });
    },
  };
}
