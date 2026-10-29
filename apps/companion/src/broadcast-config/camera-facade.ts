import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '@mizar/hud-config';
import {
  emptyOrchestrationPreset,
  orchestrationPresetSchema,
  type OrchestrationPreset,
} from '@mizar/protocol/orchestration';
import type {
  ActiveBroadcastSnapshot,
  AssetRef,
  CameraModuleV2,
  CameraSourceRef,
} from '@mizar/broadcast-config';
import type { CameraCatalog, CameraConfigPersistence } from '../orchestration/store.js';
import type { BroadcastConfigStore } from './store.js';

export interface CameraFacadeDependencies {
  /** Resolve verified content to an isolated pack; execution separately pins the session instance. */
  localPack(source: CameraSourceRef): Promise<string>;
  localTrackId(asset: AssetRef): Promise<string>;
  portable(preset: OrchestrationPreset, automaticEnabled: boolean): Promise<CameraModuleV2>;
  lock(
    value: CameraModuleV2 | null,
    current: ActiveBroadcastSnapshot,
  ): Promise<ActiveBroadcastSnapshot['lock']>;
}
const disabledId = '00000000-0000-4000-8000-000000000000';
const disabledPreset = { ...emptyOrchestrationPreset(), name: '已关闭' };
function virtualActiveId(value: CameraModuleV2): string {
  const digest = createHash('sha256').update(canonicalJson(value)).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
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
    const modules = document.modules.filter((item) => item.kind === 'camera');
    if (modules.some((item) => item.id === disabledId)) throw new Error('camera_preset_reserved');
    // Resolve only the active snapshot. Legacy draft rows reuse already resolved identities;
    // drafts needing other dependencies remain in the coordinator for the new editor.
    const activePreset = active ? await toLocal(active) : null;
    const packs = new Map<string, string>();
    const tracks = new Map<string, string>();
    if (active && activePreset)
      for (let index = 0; index < active.maps.length; index++) {
        const map = active.maps[index]!;
        const local = activePreset.maps[index]!;
        packs.set(`${map.source.treeSha256}:${map.source.converterVersion}`, local.pack);
        if (map.openingSound && local.openingSound)
          tracks.set(canonicalJson(map.openingSound.asset), local.openingSound.id);
      }
    const presets: CameraCatalog['presets'] = [];
    for (const module of modules) {
      const maps: OrchestrationPreset['maps'] = [];
      let available = true;
      for (const { source, openingSound, ...map } of module.value.maps) {
        const pack = packs.get(`${source.treeSha256}:${source.converterVersion}`);
        const trackId = openingSound ? tracks.get(canonicalJson(openingSound.asset)) : null;
        if (!pack || (openingSound && !trackId)) {
          available = false;
          break;
        }
        const sound =
          openingSound && trackId
            ? {
                id: trackId,
                entryId: openingSound.entryId,
                name: openingSound.name,
                startMs: openingSound.startMs,
                endMs: openingSound.endMs,
                ...(openingSound.gain === undefined ? {} : { gain: openingSound.gain }),
              }
            : null;
        maps.push({ ...map, pack, openingSound: sound });
      }
      if (available)
        presets.push({
          id: module.id,
          preset: orchestrationPresetSchema.parse({
            format: 'mizar.orchestration',
            version: 1,
            name: module.value.name,
            maps,
          }),
        });
    }
    if (!active || !activePreset) {
      return {
        catalog: {
          activePresetId: disabledId,
          preset: disabledPreset,
          presets: [...presets, { id: disabledId, preset: disabledPreset }],
        },
        automaticEnabled: false,
        revision: document.active.moduleRevisions.camera,
      };
    }
    const capturedId = document.active.sourceModuleIds?.camera;
    const visibleId =
      capturedId && presets.some((item) => item.id === capturedId) ? capturedId : null;
    const activeId = visibleId ?? virtualActiveId(active);
    if (!visibleId) {
      if (modules.some((item) => item.id === activeId)) throw new Error('camera_preset_reserved');
      presets.push({ id: activeId, preset: activePreset });
    }
    const catalog: CameraCatalog = { activePresetId: activeId, preset: activePreset, presets };
    return {
      catalog,
      automaticEnabled: active.automaticEnabled,
      revision: document.active.moduleRevisions.camera,
    };
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
      const virtualId =
        before.resolved.camera &&
        !beforeDocument.modules.some((item) => item.id === current.catalog.activePresetId)
          ? current.catalog.activePresetId
          : null;
      const virtual = virtualId ? catalog.presets.find((item) => item.id === virtualId) : undefined;
      if (virtual && canonicalJson(virtual.preset) !== canonicalJson(current.catalog.preset))
        throw new Error('camera_preset_reserved');
      if (
        virtualId &&
        catalog.activePresetId === virtualId &&
        canonicalJson(catalog.preset) !== canonicalJson(current.catalog.preset)
      )
        throw new Error('camera_preset_reserved');
      const disabled = catalog.presets.find((item) => item.id === disabledId);
      if (disabled && canonicalJson(disabled.preset) !== canonicalJson(disabledPreset))
        throw new Error('camera_preset_reserved');
      if (
        catalog.activePresetId === disabledId &&
        (automaticEnabled || canonicalJson(catalog.preset) !== canonicalJson(disabledPreset))
      )
        throw new Error('camera_preset_reserved');
      const drafts = await Promise.all(
        catalog.presets
          .filter((item) => item.id !== disabledId && item.id !== virtualId)
          .map(async (item) => {
            const prior = previous.presets.find((entry) => entry.id === item.id);
            if (
              prior &&
              canonicalJson(prior.preset) === canonicalJson(item.preset) &&
              !(item.id === catalog.activePresetId && automaticEnabled !== previousAutomaticEnabled)
            )
              return null;
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
      const changedDrafts = drafts.filter((item) => item !== null);
      const activeChanged =
        canonicalJson(catalog.preset) !== canonicalJson(previous.preset) ||
        catalog.activePresetId !== previous.activePresetId ||
        automaticEnabled !== previousAutomaticEnabled;
      const value =
        activeChanged && catalog.activePresetId !== disabledId
          ? await dependencies.portable(catalog.preset, automaticEnabled)
          : null;
      const lock = activeChanged ? await dependencies.lock(value, before) : before.lock;
      const committedId =
        activeChanged && virtualId && catalog.activePresetId === virtualId
          ? randomUUID()
          : catalog.activePresetId;
      if (value && committedId !== catalog.activePresetId)
        changedDrafts.push({ id: committedId, value });
      await store.updateFromLegacy({
        updateDraft(document) {
          if (document.active.revision !== before.revision) throw new Error('revision_conflict');
          for (const draft of changedDrafts) {
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
                ? catalog.activePresetId === disabledId
                  ? { kind: 'camera', mode: 'off' }
                  : { kind: 'camera', mode: 'use', moduleId: committedId }
                : binding,
            );
          }
        },
        ...(activeChanged
          ? {
              active: {
                kind: 'camera' as const,
                value,
                lock,
                moduleId: committedId === disabledId ? null : committedId,
              },
            }
          : {}),
      });
      return read();
    },
  };
}
