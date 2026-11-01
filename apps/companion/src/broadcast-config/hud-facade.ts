import {
  BUILTIN_PRESET_IDS,
  canonicalJson,
  parseHudConfigDocument,
  resolveActiveHudPreset,
  type HudConfigDocument,
  type HudLayout,
  type HudPreset,
  type HudTheme,
} from '@mizar/hud-config';
import { assertSupportedHudModule, isSupportedHudPauseVisual } from '@mizar/broadcast-config';
import type { ActiveBroadcastSnapshot, BroadcastConfigDocument } from '@mizar/broadcast-config';
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
    read: () => Promise.resolve(hudDocumentFromBroadcast(store.snapshot)),
    readDraft: (current) => {
      const applied = store.appliedSnapshot('hud');
      const document = store.snapshot;
      if (applied) document.active = applied;
      const result = hudDocumentFromBroadcast(document);
      // Applied selection belongs to the coordinator. Keep the local initial
      // fallback only while no consumer snapshot has ever been confirmed.
      return applied
        ? result
        : parseHudConfigDocument({ ...result, activePreset: current.activePreset });
    },
    readApplied: () => {
      const active = store.fallbackSnapshot('hud');
      if (!active) throw new Error('hud_persistence_unavailable');
      return Promise.resolve(hudDocumentFromBroadcast({ ...store.snapshot, active }));
    },
    async commit(candidate, previous, command) {
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
      if (command.kind === 'activate-preset') {
        if (target) assertSupportedHudModule(target);
        const selectedHud = activeChanged ? nextHud : oldHud;
        if (!isSupportedHudPauseVisual(selectedHud.overlays.pause.visual))
          throw new Error('capability_unsupported');
      }
      const lock = activeChanged ? await lockFor(nextHud, current.active) : current.active.lock;
      const committed = await store.applyHudEdit({
        candidate,
        previous,
        activeChanged,
        oldHud,
        nextHud,
        lock,
        moduleId: target?.id,
      });
      if (activeChanged) return () => store.recordConsumer('hud', committed.active, null);
    },
  };
}
