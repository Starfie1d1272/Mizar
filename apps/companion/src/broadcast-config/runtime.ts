import { lstat, readFile } from 'node:fs/promises';
import { BUILTIN_MODULE_IDS, BUILTIN_REVISION } from './builtin-modules.js';
import { portableMusicConfig } from './music-assets.js';
import { join } from 'node:path';
import { MUSIC_GROUPS } from '@mizar/protocol/music';
import type {
  ActiveBroadcastSnapshot,
  AssetRef,
  BroadcastConfigDocument,
  ResourceRef,
} from '@mizar/broadcast-config';
import { sameEffectiveModule } from '@mizar/broadcast-config';
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
  canApplyCamera?(): boolean;
  diagnostic(error: unknown): void;
  builtinMusicPack?: string | undefined;
}) {
  const { hud, music, camera, dependencies: deps } = input;
  let status: BroadcastMigrationStatus = { state: 'pending', reason: 'owner_unavailable' };
  let candidate: BroadcastConfigDocument | undefined;
  let pendingLegacyCamera: PendingLegacyCamera | undefined;
  let ready = false;
  let builtinMusicAvailable = false;
  let cameraUnavailable = false;
  let programUnavailable = false;
  let musicUnavailable = false;
  let cameraAvailable = () => true;
  function canSynchronizeCamera(active: ActiveBroadcastSnapshot): boolean {
    if (store.snapshot.active.revision !== active.revision) return false;
    const applied = store.appliedSnapshot('camera');
    const changed =
      !applied || !sameEffectiveModule('camera', applied.resolved.camera, active.resolved.camera);
    return !changed || !input.canApplyCamera || input.canApplyCamera();
  }
  async function verifyUnchanged(
    active: ActiveBroadcastSnapshot,
    skipProgram: boolean,
    skipCamera: boolean,
    skipMusic = false,
  ) {
    const resolved = {
      ...active.resolved,
      ...(skipCamera ? { camera: null } : {}),
      ...(skipMusic ? { music: null } : {}),
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
    canApplyModule: (kind, value) => {
      if (kind !== 'camera') return true;
      const applied = store.appliedSnapshot('camera');
      return (
        Boolean(
          applied &&
          sameEffectiveModule(
            'camera',
            applied.resolved.camera,
            value as ActiveBroadcastSnapshot['resolved']['camera'],
          ),
        ) ||
        !input.canApplyCamera ||
        input.canApplyCamera()
      );
    },
    canChangeCamera: () => input.canApplyCamera?.() ?? true,
    withReferenceGuard: (operation) => deps.references.run(operation),
    assertReferenceCommitAllowed: (previous, next) =>
      assertReferenceCommitAllowed(previous, next, (ref) => deps.isDeleting(ref)),
    withApplyGuard: (operation) => input.withApplyGuard(operation),
    verifyLegacyActive: async (active, kind) => {
      if (!kind) return deps.verifyActive(active);
      await verifyUnchanged(active, kind !== 'program', kind !== 'camera', kind !== 'music');
    },
    validateHudDraft: (document) => {
      hudDocumentFromBroadcast(document);
    },
    onApplied: async (active, _previous, kind, failed = []) => {
      const current = (item: 'hud' | 'music' | 'camera') => () =>
        store.snapshot.active.moduleRevisions[item] === active.moduleRevisions[item];
      const operations = {
        hud: () => hud.synchronizeFromPersistence(hudDocument(), current('hud')),
        music: () => music.synchronizeFromPersistence(current('music')),
        camera: () => camera.synchronizeFromPersistence(() => canSynchronizeCamera(active)),
        program: async () => {
          await resolver.resolveModule({
            kind: 'program',
            value: active.resolved.program,
          } as import('@mizar/broadcast-config').ModuleRecord<'program'>);
        },
      };
      const kinds = (['hud', 'music', 'camera', 'program'] as const).filter(
        (item) => (!kind || kind === item) && !failed.includes(item),
      );
      let failure: unknown;
      for (const item of kinds) {
        const current = store.consumerStatus[item];
        if (
          item !== 'camera' &&
          current?.applied === active.moduleRevisions[item] &&
          !current.error
        )
          continue;
        try {
          await operations[item]();
          if (item === 'program') programUnavailable = false;
          if (item === 'camera') cameraUnavailable = false;
          await store.recordConsumer(item, active, null);
        } catch (error) {
          if (item === 'program') programUnavailable = true;
          if (item === 'camera') cameraUnavailable = true;
          failure ??= error;
          input.diagnostic(error);
          try {
            await store.recordConsumer(
              item,
              active,
              item === 'camera' && input.canApplyCamera && !input.canApplyCamera()
                ? 'camera_busy'
                : 'dependency_unavailable',
            );
          } catch (recordError) {
            input.diagnostic(recordError);
          }
        }
      }
      if (!kind || kind === 'camera') cameraUnavailable = !cameraAvailable();
      status = readyStatus();
      if (failure) throw new Error('broadcast_owner_sync_failed', { cause: failure });
    },
  });
  function hudDocument() {
    return hudDocumentFromBroadcast(store.snapshot);
  }
  async function lockForEdit<K extends 'hud' | 'music' | 'camera'>(
    kind: K,
    value: ActiveBroadcastSnapshot['resolved'][K],
    current: ActiveBroadcastSnapshot,
  ): Promise<ActiveBroadcastSnapshot['lock']> {
    const resolved = {
      ...current.resolved,
      hud:
        kind === 'hud'
          ? (value as ActiveBroadcastSnapshot['resolved']['hud'])
          : current.resolved.hud,
      music: kind === 'music' ? (value as ActiveBroadcastSnapshot['resolved']['music']) : null,
      camera: kind === 'camera' ? (value as ActiveBroadcastSnapshot['resolved']['camera']) : null,
      program: { ...current.resolved.program, assets: {}, tokens: {} },
    };
    const lock = await deps.lockForActive(resolved);
    const refs = new Map(lock.resources.map((ref) => [JSON.stringify(ref), ref]));
    const add = (ref: ResourceRef) => refs.set(JSON.stringify(ref), ref);
    for (const scene of Object.values(current.resolved.program.scenes))
      if (scene.kind === 'declarative') add(scene.resource);
    for (const ref of Object.values(current.resolved.program.assets)) add(ref.resource);
    if (kind !== 'music' && current.resolved.music)
      for (const group of MUSIC_GROUPS)
        for (const track of current.resolved.music.groups[group].tracks) add(track.asset.resource);
    if (kind !== 'camera' && current.resolved.camera)
      for (const map of current.resolved.camera.maps)
        if (map.openingSound) add(map.openingSound.asset.resource);
    return {
      resources: [...refs.values()],
      tools: kind === 'camera' ? lock.tools : current.lock.tools,
    };
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
      await music.prepareRuntimeMigration();
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
        if (active.resolved.music) {
          try {
            await resolver.resolveModule({
              kind: 'music',
              value: active.resolved.music,
            } as import('@mizar/broadcast-config').ModuleRecord<'music'>);
          } catch {
            musicUnavailable = true;
          }
        }
        if (!programUnavailable && !cameraUnavailable && !musicUnavailable) throw error;
        const captured = new Set(active.lock.resources.map((ref) => JSON.stringify(ref)));
        if (
          programUnavailable &&
          Object.values(active.resolved.program.assets).some(
            (ref) => !captured.has(JSON.stringify(ref.resource)),
          )
        )
          throw new Error('broadcast_config_invalid', { cause: error });
        await verifyUnchanged(active, programUnavailable, cameraUnavailable, musicUnavailable);
        input.diagnostic(error);
      }
      for (const ref of store.referencedResources())
        if (await deps.isDeleting(ref)) throw new Error('resource_deleting');
    }
    const hudPersistence = createHudConfigPersistence(store, (value, current) =>
      lockForEdit('hud', value, current),
    );
    const musicPersistence = createMusicConfigPersistence(
      store,
      music,
      (value, current) => lockForEdit('music', value, current),
      (ref) => deps.localTrackId(ref),
    );
    const cameraPersistence = createCameraConfigPersistence(store, {
      ...deps.camera,
      lock: (value, current) => lockForEdit('camera', value, current),
    });
    cameraAvailable = () => cameraPersistence.available;
    let hudUnavailable = false;
    let hudRestored = false;
    try {
      if (existing) await hud.restorePersistence(hudPersistence);
      else await hud.adoptPersistence(hudPersistence);
    } catch (error) {
      hudUnavailable = true;
      input.diagnostic(error);
      try {
        await hud.restoreAppliedFromPersistence();
        hudRestored = true;
      } catch (restoreError) {
        input.diagnostic(restoreError);
      }
    }
    let musicRestored = false;
    try {
      if (music.ready && !music.failure) await music.adoptPersistence(musicPersistence);
      else await music.loadWithPersistence(musicPersistence);
      musicUnavailable = false;
    } catch (error) {
      musicUnavailable = true;
      input.diagnostic(error);
      try {
        await music.restoreAppliedFromPersistence();
        musicRestored = true;
      } catch (restoreError) {
        input.diagnostic(restoreError);
      }
    }
    let cameraRestored = false;
    try {
      if (camera.ready) await camera.adoptPersistence(cameraPersistence);
      else await camera.loadWithPersistence(cameraPersistence);
      cameraUnavailable = false;
    } catch (error) {
      cameraUnavailable = true;
      input.diagnostic(error);
      try {
        await camera.restoreAppliedFromPersistence();
        cameraRestored = true;
      } catch (restoreError) {
        input.diagnostic(restoreError);
      }
    }
    const initialActive = store.snapshot.active;
    const previousStatus = store.consumerStatus;
    const startupError = (kind: 'hud' | 'music' | 'camera' | 'program', unavailable: boolean) =>
      unavailable ||
      (previousStatus[kind]?.error &&
        previousStatus[kind]?.desired !== initialActive.moduleRevisions[kind])
        ? 'dependency_unavailable'
        : null;
    let programRestored = false;
    if (programUnavailable) {
      const previous = store.fallbackSnapshot('program');
      if (previous) {
        try {
          await resolver.resolveModule({
            kind: 'program',
            value: previous.resolved.program,
          } as import('@mizar/broadcast-config').ModuleRecord<'program'>);
          programRestored = true;
        } catch (error) {
          input.diagnostic(error);
        }
      }
    }
    await store.recordConsumer(
      'hud',
      initialActive,
      startupError('hud', hudUnavailable),
      hudUnavailable && !hudRestored,
      hudRestored,
    );
    await store.recordConsumer(
      'music',
      initialActive,
      startupError('music', musicUnavailable),
      musicUnavailable && !musicRestored,
      musicRestored,
    );
    await store.recordConsumer(
      'camera',
      initialActive,
      startupError('camera', cameraUnavailable),
      cameraUnavailable && !cameraRestored,
      cameraRestored,
    );
    await store.recordConsumer(
      'program',
      initialActive,
      startupError('program', programUnavailable),
      programUnavailable && !programRestored,
      programRestored,
    );
    if (input.builtinMusicPack) {
      try {
        const config = await music.prepareImport(await readFile(input.builtinMusicPack));
        const value = await portableMusicConfig(music, config, true);
        await store.addBuiltinMusic({
          id: BUILTIN_MODULE_IDS.music,
          revision: BUILTIN_REVISION,
          kind: 'music',
          schemaVersion: 1,
          name: '内置节目音乐',
          origin: null,
          value,
        });
        builtinMusicAvailable = true;
      } catch (error) {
        input.diagnostic(error);
      }
    }
    ready = true;
    status = readyStatus();
  }
  return {
    store,
    initialize,
    async verifyCameraPack(map: string, pack: string): Promise<boolean> {
      if (!ready) return false;
      const source = store
        .appliedSnapshot('camera')
        ?.resolved.camera?.maps.find((item) => item.map === map)?.source;
      if (!source) return false;
      try {
        return (await deps.camera.localPack(source)) === pack;
      } catch {
        return false;
      }
    },
    async waitForApply() {
      await store.waitForApply();
    },
    async reconcileCameraSelection(): Promise<boolean> {
      const current = store.snapshot.active;
      const state = store.consumerStatus.camera;
      if (state?.error && state.desired !== current.moduleRevisions.camera) return false;
      try {
        await camera.synchronizeFromPersistence(() => canSynchronizeCamera(current));
        await store.recordConsumer('camera', current, null);
      } catch (error) {
        cameraUnavailable = true;
        input.diagnostic(error);
        return false;
      }
      cameraUnavailable = !cameraAvailable() && !store.pendingLegacyCamera;
      return cameraAvailable();
    },
    get ready() {
      return ready;
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
    get builtinMusicAvailable() {
      return builtinMusicAvailable;
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
