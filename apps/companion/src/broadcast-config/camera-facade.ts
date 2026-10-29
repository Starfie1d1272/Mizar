import { canonicalJson } from '@mizar/hud-config';
import { orchestrationPresetSchema, type OrchestrationPreset } from '@mizar/protocol/orchestration';
import type {
  ActiveBroadcastSnapshot,
  AssetRef,
  CameraModuleV2,
  CameraSourceRef,
} from '@mizar/broadcast-config';
import type { CameraCatalog, CameraConfigPersistence } from '../orchestration/store.js';
import type { BroadcastConfigStore } from './store.js';

export interface CameraFacadeDependencies {
  /** Resolve and verify content against the session-pinned instance, returning its isolated pack name. */
  localPack(source: CameraSourceRef): Promise<string>;
  localTrackId(asset: AssetRef): Promise<string>;
  portable(preset: OrchestrationPreset, automaticEnabled: boolean): Promise<CameraModuleV2>;
  lock(
    value: CameraModuleV2,
    current: ActiveBroadcastSnapshot,
  ): Promise<ActiveBroadcastSnapshot['lock']>;
}
export function createCameraConfigPersistence(
  store: BroadcastConfigStore,
  dependencies: CameraFacadeDependencies,
): CameraConfigPersistence {
  async function toLocal(value: CameraModuleV2): Promise<OrchestrationPreset> {
    return orchestrationPresetSchema.parse({
      format: 'mizar.orchestration',
      version: 1,
      name: value.name,
      maps: await Promise.all(
        value.maps.map(async ({ source, openingSound, ...map }) => {
          let sound = null;
          if (openingSound) {
            const { asset, ...track } = openingSound;
            sound = { ...track, id: await dependencies.localTrackId(asset) };
          }
          return { ...map, pack: await dependencies.localPack(source), openingSound: sound };
        }),
      ),
    });
  }
  async function read() {
    const document = store.snapshot;
    const active = document.active.resolved.camera;
    const source = document.presets.find((item) => item.id === document.active.sourcePreset?.id);
    const binding = source?.bindings.find((item) => item.kind === 'camera');
    if (!active || binding?.mode !== 'use') throw new Error('camera_active_unavailable');
    const modules = document.modules.filter((item) => item.kind === 'camera');
    if (!modules.some((item) => item.id === binding.moduleId))
      throw new Error('camera_active_unavailable');
    const catalog: CameraCatalog = {
      activePresetId: binding.moduleId,
      preset: await toLocal(active),
      presets: await Promise.all(
        modules.map(async (item) => ({ id: item.id, preset: await toLocal(item.value) })),
      ),
    };
    return { catalog, automaticEnabled: active.automaticEnabled };
  }
  return {
    initialize: () => read(),
    read,
    async commit(catalog, automaticEnabled, previous, previousAutomaticEnabled) {
      const beforeDocument = store.snapshot;
      const before = beforeDocument.active;
      const current = await read();
      if (
        canonicalJson(current.catalog) !== canonicalJson(previous) ||
        current.automaticEnabled !== previousAutomaticEnabled
      )
        throw new Error('revision_conflict');
      const drafts = await Promise.all(
        catalog.presets.map(async (item) => {
          const existing = beforeDocument.modules.find((module) => module.id === item.id);
          if (existing && existing.kind !== 'camera') throw new Error('revision_conflict');
          const policy =
            item.id === catalog.activePresetId && automaticEnabled !== previousAutomaticEnabled
              ? automaticEnabled
              : existing?.kind === 'camera'
                ? existing.value.automaticEnabled
                : automaticEnabled;
          return { id: item.id, value: await dependencies.portable(item.preset, policy) };
        }),
      );
      const activeChanged =
        canonicalJson(catalog.preset) !== canonicalJson(previous.preset) ||
        catalog.activePresetId !== previous.activePresetId ||
        automaticEnabled !== previousAutomaticEnabled;
      const value = activeChanged
        ? await dependencies.portable(catalog.preset, automaticEnabled)
        : null;
      const lock = value ? await dependencies.lock(value, before) : before.lock;
      await store.updateFromLegacy({
        updateDraft(document) {
          if (document.active.revision !== before.revision) throw new Error('revision_conflict');
          for (const draft of drafts) {
            const module = document.modules.find((item) => item.id === draft.id);
            if (module && module.kind !== 'camera') throw new Error('revision_conflict');
            if (module?.kind === 'camera') {
              module.value = draft.value;
              module.name = draft.value.name;
            } else
              document.modules.push({
                id: draft.id,
                kind: 'camera',
                schemaVersion: 2,
                revision: draft.id,
                name: draft.value.name,
                value: draft.value,
                origin: null,
              });
          }
          if (activeChanged) {
            const source = document.presets.find((item) => item.id === before.sourcePreset?.id);
            if (!source) throw new Error('camera_active_unavailable');
            source.bindings = source.bindings.map((binding) =>
              binding.kind === 'camera'
                ? { kind: 'camera', mode: 'use', moduleId: catalog.activePresetId }
                : binding,
            );
          }
        },
        ...(value ? { active: { kind: 'camera' as const, value, lock } } : {}),
      });
      return read();
    },
  };
}
