import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ActiveBroadcastSnapshot,
  AssetRef,
  BroadcastConfigDocument,
  ResourceRef,
} from '@mizar/broadcast-config';
import type { HudConfigStore } from '../hud-config/store.js';
import type { MusicStore } from '../music/store.js';
import type { OrchestrationStore } from '../orchestration/store.js';
import { backupLegacyConfig } from './legacy-backup.js';
import { prepareLegacyMigration } from './prepare-migration.js';
import { createBroadcastResolver, type BroadcastDependencyResolver } from './resolver.js';
import {
  assertReferenceCommitAllowed,
  broadcastResourceReferences,
  BroadcastReferenceQueue,
} from './reference-queue.js';
import { createHudConfigPersistence, hudDocumentFromBroadcast } from './hud-facade.js';
import { createMusicConfigPersistence } from './music-facade.js';
import { createCameraConfigPersistence, type CameraFacadeDependencies } from './camera-facade.js';
import { BroadcastConfigStore, type PendingLegacyCamera } from './store.js';
import type { BroadcastMigrationStatus } from './migration-status.js';

/** Providers share this queue with their final reference check and deletion mark. */
export interface BroadcastRuntimeDependencies {
  path: string;
  hudPath?: string | undefined;
  musicAutomaticEnabled: boolean;
  references: BroadcastReferenceQueue;
  isDeleting(ref: ResourceRef): Promise<boolean>;
  resolve: BroadcastDependencyResolver;
  camera: CameraFacadeDependencies;
  localTrackId(ref: AssetRef): Promise<string>;
  lockForActive(
    resolved: ActiveBroadcastSnapshot['resolved'],
  ): Promise<ActiveBroadcastSnapshot['lock']>;
  verifyActive(active: ActiveBroadcastSnapshot): Promise<void>;
}
export function createBroadcastRuntime(input: {
  hud: HudConfigStore;
  music: MusicStore;
  camera: OrchestrationStore;
  dependencies: BroadcastRuntimeDependencies;
  withApplyGuard<T>(operation: (canCommit: () => boolean) => Promise<T>): Promise<T>;
  diagnostic(error: unknown): void;
}) {
  const { hud, music, camera, dependencies: deps } = input;
  let status: BroadcastMigrationStatus = { state: 'pending', reason: 'owner_unavailable' };
  let candidate: BroadcastConfigDocument | undefined;
  let pendingLegacyCamera: PendingLegacyCamera | undefined;
  let ready = false;
  let syncError: Error | undefined;
  let cameraUnavailable = false;
  let programUnavailable = false;
  let cameraAvailable = () => true;
  async function verifyUnchanged(
    active: ActiveBroadcastSnapshot,
    skipProgram: boolean,
    skipCamera: boolean,
  ) {
    const resolved = {
      ...active.resolved,
      ...(skipCamera ? { camera: null } : {}),
      ...(skipProgram ? { program: { ...active.resolved.program, assets: {}, tokens: {} } } : {}),
    };
    const lock = await deps.lockForActive(resolved);
    await deps.verifyActive({ ...active, resolved, lock });
  }
  const readyStatus = (): BroadcastMigrationStatus =>
    programUnavailable
      ? { state: 'pending', reason: 'program_dependency_unavailable' }
      : store.pendingLegacyCamera || cameraUnavailable
        ? { state: 'pending', reason: 'camera_identity_unavailable' }
        : { state: 'ready' };
  const resolver = createBroadcastResolver({
    asset: (ref) => deps.resolve.asset(ref),
    ...(deps.resolve.image ? { image: (ref: AssetRef) => deps.resolve.image!(ref) } : {}),
    scene: (value) => deps.resolve.scene(value),
    camera: (source) => deps.resolve.camera(source),
    hud: () => Promise.reject(new Error('capability_unsupported')),
  });
  const store = new BroadcastConfigStore({
    filePath: deps.path,
    createInitial: () => {
      if (!candidate) throw new Error('broadcast_migration_pending');
      return Promise.resolve(candidate);
    },
    initialPendingLegacyCamera: () => pendingLegacyCamera,
    // The legacy HUD facade cannot represent a third-party renderer yet.
    resolver,
    resolveModule: (module) => resolver.resolveModule(module),
    withReferenceGuard: (operation) => deps.references.run(operation),
    assertReferenceCommitAllowed: (previous, next) =>
      assertReferenceCommitAllowed(previous, next, (ref) => deps.isDeleting(ref)),
    withApplyGuard: (operation) => input.withApplyGuard(operation),
    verifyLegacyActive: async (active, kind) => {
      if (kind === 'hud' || kind === 'program') await verifyUnchanged(active, kind === 'hud', true);
      else await deps.verifyActive(active);
    },
    validateHudDraft: (document) => {
      hudDocumentFromBroadcast(document);
    },
    onDraftChanged: async (kind) => {
      if (kind === 'hud') await hud.synchronizeFromPersistence(hudDocument());
    },
    onApplied: async (_active, _previous, kind) => {
      ready = false;
      const results = await Promise.allSettled([
        ...(!kind || kind === 'hud'
          ? [Promise.resolve().then(() => hud.synchronizeFromPersistence(hudDocument()))]
          : []),
        ...(!kind || kind === 'music'
          ? [Promise.resolve().then(() => music.synchronizeFromPersistence())]
          : []),
        ...(!kind || kind === 'camera'
          ? [Promise.resolve().then(() => camera.synchronizeFromPersistence())]
          : []),
      ]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') {
        status = { state: 'pending', reason: 'dependency_unavailable' };
        input.diagnostic(failed.reason);
        syncError = new Error('broadcast_owner_sync_failed', { cause: failed.reason });
        throw syncError;
      }
      if (!kind || kind === 'camera') cameraUnavailable = !cameraAvailable();
      try {
        await resolver.resolveModule({
          kind: 'program',
          value: store.snapshot.active.resolved.program,
        } as import('@mizar/broadcast-config').ModuleRecord<'program'>);
        programUnavailable = false;
      } catch {
        programUnavailable = true;
      }
      syncError = undefined;
      ready = true;
      status = readyStatus();
    },
  });
  function hudDocument() {
    return hudDocumentFromBroadcast(store.snapshot);
  }
  const lockFor = (resolved: ActiveBroadcastSnapshot['resolved']) => deps.lockForActive(resolved);
  async function initialize(): Promise<void> {
    await deps.references.run(initializeUnderReferenceGuard);
  }
  async function initializeUnderReferenceGuard(): Promise<void> {
    let existing = false;
    try {
      await lstat(deps.path);
      existing = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!existing) {
      if (!hud.canMigrate || !music.ready || music.failure || !camera.ready) return;
      const prepared = await prepareLegacyMigration({
        hud: hud.getState(),
        music,
        camera,
        musicAutomaticEnabled: deps.musicAutomaticEnabled,
        cameraConfig: (preset, enabled) => deps.camera.portable(preset, enabled),
        lock: lockFor,
      });
      if (prepared.state === 'pending') {
        status = prepared;
        return;
      }
      try {
        await deps.verifyActive(prepared.document.active);
        for (const ref of broadcastResourceReferences(prepared.document))
          if (await deps.isDeleting(ref)) throw new Error('resource_deleting');
      } catch (error) {
        status = { state: 'pending', reason: 'dependency_unavailable' };
        input.diagnostic(error);
        return;
      }
      candidate = prepared.document;
      pendingLegacyCamera = prepared.pendingLegacyCamera;
      if (deps.hudPath) await backupLegacyConfig(deps.hudPath, 16 * 1024 * 1024);
      await backupLegacyConfig(join(music.directory, 'state.json'), 512 * 1024);
      await backupLegacyConfig(join(camera.directory, 'presets.json'), 9 * 1024 * 1024);
      await backupLegacyConfig(join(camera.directory, 'settings.json'), 1024);
    }
    await store.load();
    if (existing) {
      const active = store.snapshot.active;
      try {
        await deps.verifyActive(active);
      } catch (error) {
        try {
          await resolver.resolveModule({
            kind: 'program',
            value: active.resolved.program,
          } as import('@mizar/broadcast-config').ModuleRecord<'program'>);
        } catch {
          programUnavailable = true;
        }
        if (active.resolved.camera) {
          try {
            await resolver.resolveModule({
              kind: 'camera',
              value: active.resolved.camera,
            } as import('@mizar/broadcast-config').ModuleRecord<'camera'>);
          } catch {
            cameraUnavailable = true;
          }
        }
        if (!programUnavailable && !cameraUnavailable) throw error;
        const captured = new Set(active.lock.resources.map((ref) => JSON.stringify(ref)));
        if (
          programUnavailable &&
          Object.values(active.resolved.program.assets).some(
            (ref) => !captured.has(JSON.stringify(ref.resource)),
          )
        )
          throw new Error('broadcast_config_invalid');
        await verifyUnchanged(active, programUnavailable, cameraUnavailable);
        input.diagnostic(error);
      }
      for (const ref of store.referencedResources())
        if (await deps.isDeleting(ref)) throw new Error('resource_deleting');
    }
    const hudPersistence = createHudConfigPersistence(store, async (value, current) => {
      const lock = await lockFor({
        ...current.resolved,
        hud: value,
        camera: null,
        program: { ...current.resolved.program, assets: {}, tokens: {} },
      });
      const refs = new Map(lock.resources.map((ref) => [JSON.stringify(ref), ref]));
      for (const ref of Object.values(current.resolved.program.assets))
        refs.set(JSON.stringify(ref.resource), ref.resource);
      for (const map of current.resolved.camera?.maps ?? [])
        if (map.openingSound)
          refs.set(
            JSON.stringify(map.openingSound.asset.resource),
            map.openingSound.asset.resource,
          );
      return { resources: [...refs.values()], tools: current.lock.tools };
    });
    const musicPersistence = createMusicConfigPersistence(
      store,
      music,
      (value, current) => lockFor({ ...current.resolved, music: value }),
      (ref) => deps.localTrackId(ref),
    );
    const cameraPersistence = createCameraConfigPersistence(store, deps.camera);
    cameraAvailable = () => cameraPersistence.available;
    if (existing) await hud.restorePersistence(hudPersistence);
    else await hud.adoptPersistence(hudPersistence);
    if (music.ready && !music.failure) await music.adoptPersistence(musicPersistence);
    else await music.loadWithPersistence(musicPersistence);
    if (camera.ready) await camera.adoptPersistence(cameraPersistence);
    else await camera.loadWithPersistence(cameraPersistence);
    cameraUnavailable ||= !cameraPersistence.available && !store.pendingLegacyCamera;
    ready = true;
    status = readyStatus();
  }
  return {
    store,
    initialize,
    async verifyCameraPack(map: string, pack: string): Promise<boolean> {
      if (!ready || store.isApplying) return false;
      const source = store.snapshot.active.resolved.camera?.maps.find(
        (item) => item.map === map,
      )?.source;
      if (!source) return false;
      try {
        return (await deps.camera.localPack(source)) === pack;
      } catch {
        return false;
      }
    },
    async waitForApply() {
      await store.waitForApply();
      if (syncError) throw syncError;
    },
    get ready() {
      return ready && !store.isApplying;
    },
    get status() {
      return store.isApplying
        ? { state: 'pending' as const, reason: 'owner_sync_pending' as const }
        : ready
          ? readyStatus()
          : status;
    },
    restoreLegacyCamera: () => store.restoreLegacyCamera(deps.camera.portable),
    get displayAvailable() {
      return !programUnavailable;
    },
    async moduleAvailability(module: import('@mizar/broadcast-config').ModuleRecord) {
      try {
        await resolver.resolveModule(module);
        return { state: 'ready' as const };
      } catch (error) {
        return {
          state: 'dependency_missing' as const,
          reason:
            error instanceof Error && error.message === 'capability_unsupported'
              ? 'capability_unsupported'
              : module.kind === 'program'
                ? 'program_dependency_unavailable'
                : module.kind === 'camera'
                  ? 'camera_identity_unavailable'
                  : 'dependency_unavailable',
        };
      }
    },
  };
}
