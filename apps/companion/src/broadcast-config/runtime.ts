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
import { BroadcastConfigStore } from './store.js';
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
  let ready = false;
  const store = new BroadcastConfigStore({
    filePath: deps.path,
    createInitial: () => {
      if (!candidate) throw new Error('broadcast_migration_pending');
      return Promise.resolve(candidate);
    },
    // The legacy HUD facade cannot represent a third-party renderer yet.
    resolver: createBroadcastResolver({
      asset: (ref) => deps.resolve.asset(ref),
      scene: (value) => deps.resolve.scene(value),
      camera: (source) => deps.resolve.camera(source),
      hud: () => Promise.reject(new Error('capability_unsupported')),
    }),
    withReferenceGuard: (operation) => deps.references.run(operation),
    assertReferenceCommitAllowed: (previous, next) =>
      assertReferenceCommitAllowed(previous, next, (ref) => deps.isDeleting(ref)),
    withApplyGuard: (operation) => input.withApplyGuard(operation),
    verifyLegacyActive: (active) => deps.verifyActive(active),
    onApplied: async () => {
      ready = false;
      const results = await Promise.allSettled([
        Promise.resolve().then(() => hud.synchronizeFromPersistence(hudDocument())),
        Promise.resolve().then(() => music.synchronizeFromPersistence()),
        Promise.resolve().then(() => camera.synchronizeFromPersistence()),
      ]);
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') {
        status = { state: 'pending', reason: 'dependency_unavailable' };
        input.diagnostic(failed.reason);
        throw new Error('broadcast_owner_sync_failed', { cause: failed.reason });
      }
      ready = true;
      status = { state: 'ready' };
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
      if (deps.hudPath) await backupLegacyConfig(deps.hudPath, 16 * 1024 * 1024);
      await backupLegacyConfig(join(music.directory, 'state.json'), 512 * 1024);
      await backupLegacyConfig(join(camera.directory, 'presets.json'), 9 * 1024 * 1024);
      await backupLegacyConfig(join(camera.directory, 'settings.json'), 1024);
    }
    await store.load();
    if (existing) {
      await deps.verifyActive(store.snapshot.active);
      for (const ref of broadcastResourceReferences(store.snapshot))
        if (await deps.isDeleting(ref)) throw new Error('resource_deleting');
    }
    const hudPersistence = createHudConfigPersistence(store, (value, current) =>
      lockFor({ ...current.resolved, hud: value }),
    );
    const musicPersistence = createMusicConfigPersistence(
      store,
      music,
      (value, current) => lockFor({ ...current.resolved, music: value }),
      (ref) => deps.localTrackId(ref),
    );
    const cameraPersistence = createCameraConfigPersistence(store, deps.camera);
    if (existing) await hud.restorePersistence(hudPersistence);
    else await hud.adoptPersistence(hudPersistence);
    if (music.ready && !music.failure) await music.adoptPersistence(musicPersistence);
    else await music.loadWithPersistence(musicPersistence);
    if (camera.ready) await camera.adoptPersistence(cameraPersistence);
    else await camera.loadWithPersistence(cameraPersistence);
    ready = true;
    status = { state: 'ready' };
  }
  return {
    store,
    initialize,
    get ready() {
      return ready && !store.isApplying;
    },
    get status() {
      return store.isApplying
        ? { state: 'pending' as const, reason: 'owner_sync_pending' as const }
        : status;
    },
  };
}
