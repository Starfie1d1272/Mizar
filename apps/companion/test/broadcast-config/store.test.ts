import { OrchestrationStore } from '../../src/orchestration/store.js';
import { createCameraConfigPersistence } from '../../src/broadcast-config/camera-facade.js';
import { dirname, join as pathJoin } from 'node:path';
import { MusicStore } from '../../src/music/store.js';
import { createMusicConfigPersistence } from '../../src/broadcast-config/music-facade.js';
import { HudConfigStore } from '../../src/hud-config/store.js';
import { createHudConfigPersistence } from '../../src/broadcast-config/hud-facade.js';
import Fastify from 'fastify';
import { createLocalWebOriginPolicy } from '../../src/local-web/origin-policy.js';
import { registerBroadcastConfigRoutes } from '../../src/broadcast-config/routes.js';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getBuiltinLayout,
  getBuiltinPreset,
  getBuiltinResolvedPreset,
  getBuiltinTheme,
} from '@mizar/hud-config';
import {
  clonePreset,
  type BroadcastConfigDocument,
  type ProgramVisualConfigV1,
} from '@mizar/broadcast-config';
import { BroadcastConfigStore } from '../../src/broadcast-config/store.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
function fixture(): BroadcastConfigDocument {
  const hudId = randomUUID(),
    programId = randomUUID(),
    presetId = randomUUID();
  const layout = getBuiltinLayout();
  const visual = { kind: 'builtin', id: 'pulse', apiVersion: 1 } as const;
  const program: ProgramVisualConfigV1 = {
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
  return {
    schemaVersion: 1,
    modules: [
      {
        id: hudId,
        revision: 'h1',
        schemaVersion: 1,
        name: 'HUD',
        kind: 'hud',
        origin: null,
        value: {
          renderer: { kind: 'native', id: 'mizar.hud', apiVersion: 1 },
          preset: getBuiltinPreset(),
          layout,
          theme: getBuiltinTheme(),
          overlays: {
            pause: { enabled: true, visual: 'default' },
            chat: { enabled: true, placement: Object.values(layout.widgets)[0]! },
          },
          accent: { source: 'event', fallback: getBuiltinTheme().brandColor },
        },
      },
      {
        id: programId,
        revision: 'p1',
        schemaVersion: 1,
        name: 'Program',
        kind: 'program',
        origin: null,
        value: program,
      },
    ],
    presets: [
      {
        schemaVersion: 1,
        id: presetId,
        revision: 'p1',
        name: 'Live',
        origin: null,
        opaqueModules: [],
        bindings: [
          { kind: 'hud', mode: 'use', moduleId: hudId },
          { kind: 'program', mode: 'use', moduleId: programId },
          { kind: 'music', mode: 'off' },
          { kind: 'camera', mode: 'off' },
        ],
      },
    ],
    active: {
      schemaVersion: 1,
      revision: 'active',
      sourcePreset: { id: presetId, revision: 'p1' },
      adjusted: false,
      moduleRevisions: { hud: 'h', program: 'p', music: 'm', camera: 'c' },
      resolved: {
        hud: {
          renderer: 'native',
          config: getBuiltinResolvedPreset(),
          overlays: {
            pause: { enabled: true, visual: 'default' },
            chat: { enabled: true, placement: Object.values(layout.widgets)[0]! },
          },
          accent: { source: 'event', fallback: getBuiltinTheme().brandColor },
        },
        program,
        music: null,
        camera: null,
      },
      lock: { resources: [], tools: [] },
    },
    previousActive: null,
  };
}
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'broadcast-config-'));
  directories.push(directory);
  const initial = fixture();
  const options = {
    filePath: join(directory, 'config.json'),
    createInitial: () => Promise.resolve(initial),
    resolver: {
      resolve: () =>
        Promise.resolve({ resolved: initial.active.resolved, lock: initial.active.lock }),
    },
    withReferenceGuard: <T>(operation: () => Promise<T>) => operation(),
    assertReferenceCommitAllowed: () => Promise.resolve(),
    verifyLegacyActive: () => Promise.resolve(),
    withApplyGuard: <T>(operation: (canCommit: () => boolean) => Promise<T>) =>
      operation(() => true),
  };
  const store = new BroadcastConfigStore(options);
  await store.load();
  return { store, options, initial };
}
describe('BroadcastConfigStore', () => {
  it('commits an apply once and recovers its receipt after restart', async () => {
    const { store, options, initial } = await setup();
    const request = {
      presetId: initial.presets[0]!.id,
      expectedRevision: 'p1',
      expectedModuleRevisions: { hud: 'h1', program: 'p1' },
      expectedActiveRevision: 'active',
      requestId: randomUUID(),
    };
    const active = await store.apply(request);
    expect(active.moduleRevisions).toEqual(initial.active.moduleRevisions);
    const reopened = new BroadcastConfigStore(options);
    await reopened.load();
    expect(await reopened.apply(request)).toEqual(active);
    await expect(reopened.apply({ ...request, expectedRevision: 'other' })).rejects.toThrow(
      'request_conflict',
    );
    expect(reopened.snapshot.previousActive).toEqual(initial.active);
  });
  it('does not publish a draft when validation fails', async () => {
    const { store, initial } = await setup();
    const preset = { ...initial.presets[0]!, bindings: initial.presets[0]!.bindings.slice(0, 3) };
    await expect(
      store.save({ preset, expectedPresetRevision: 'p1', modules: [] }),
    ).rejects.toThrow();
    expect(store.snapshot).toEqual(initial);
  });
  it('allows read-only preview without publishing it and rejects foreign write origins', async () => {
    const { store, initial } = await setup();
    const app = Fastify();
    registerBroadcastConfigRoutes(app, store, createLocalWebOriginPolicy());
    const request = {
      presetId: initial.presets[0]!.id,
      expectedRevision: 'p1',
      expectedModuleRevisions: { hud: 'h1', program: 'p1' },
      expectedActiveRevision: 'active',
      requestId: randomUUID(),
    };
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/operator/broadcast-presets/apply',
        headers: { origin: 'https://foreign.test' },
        payload: request,
      });
      expect(denied.statusCode).toBe(403);
      const privateRead = await app.inject({
        url: '/local/v1/broadcast-presets',
        headers: { origin: 'https://foreign.test' },
      });
      expect(privateRead.statusCode).toBe(403);
      const display = await app.inject('/local/v1/broadcast-display-config');
      expect(display.statusCode).toBe(200);
      expect(Object.keys(display.json()).sort()).toEqual(['activeRevision', 'hud', 'program']);
      expect(display.json()).toMatchObject({ activeRevision: initial.active.revision });

      const preview = await app.inject({
        method: 'POST',
        url: '/operator/broadcast-presets/preview',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: request,
      });
      expect(preview.statusCode).toBe(200);
      expect(store.snapshot.active.revision).toBe('active');
    } finally {
      await app.close();
    }
  });
  it('does not publish when readiness changes before the atomic rename', async () => {
    const { options, initial } = await setup();
    const store = new BroadcastConfigStore({
      ...options,
      withApplyGuard: (operation) => operation(() => false),
    });
    await store.load();
    const request = {
      presetId: initial.presets[0]!.id,
      expectedRevision: 'p1',
      expectedModuleRevisions: { hud: 'h1', program: 'p1' },
      expectedActiveRevision: 'active',
      requestId: randomUUID(),
    };
    await expect(store.apply(request)).rejects.toThrow('production_busy');
    expect(store.snapshot.active.revision).toBe('active');
    const reopened = new BroadcastConfigStore(options);
    await reopened.load();
    expect(reopened.snapshot.active.revision).toBe('active');
  });
  it('imports multiple independent presets atomically and reuses the persisted mapping', async () => {
    const { store, options, initial } = await setup();
    const request = {
      sourceId: initial.presets[0]!.id,
      expectedRevision: 'p1',
      expectedModuleRevisions: { hud: 'h1', program: 'p1' },
      name: 'Imported',
    };
    const first = clonePreset(initial, request, randomUUID);
    const second = clonePreset(initial, { ...request, name: 'Second' }, randomUUID);
    const batch = {
      source: { id: 'local:package', version: '1', digest: 'a'.repeat(64) },
      modules: [...first.modules, ...second.modules],
      presets: [first.preset, second.preset],
      moduleEntries: {
        hud: [first.modules[0]!.id, second.modules[0]!.id],
        program: [first.modules[1]!.id, second.modules[1]!.id],
      },
      presetEntries: { first: first.preset.id, second: second.preset.id },
    };
    const result = await store.importBatch(batch);
    expect(result.reused).toBe(false);
    expect(store.snapshot.active).toEqual(initial.active);
    const reopened = new BroadcastConfigStore(options);
    await reopened.load();
    expect(await reopened.importBatch(batch)).toEqual({ mapping: result.mapping, reused: true });
    await expect(
      reopened.importBatch({ ...batch, source: { ...batch.source, digest: 'b'.repeat(64) } }),
    ).rejects.toThrow('identity_conflict');
    expect(reopened.snapshot.presets).toHaveLength(3);
  });
  it('rejects shared editable modules across imported presets without publishing either', async () => {
    const { store, initial } = await setup();
    const copy = clonePreset(
      initial,
      {
        sourceId: initial.presets[0]!.id,
        expectedRevision: 'p1',
        expectedModuleRevisions: { hud: 'h1', program: 'p1' },
        name: 'Imported',
      },
      randomUUID,
    );
    const second = { ...structuredClone(copy.preset), id: randomUUID(), revision: randomUUID() };
    const batch = {
      source: { id: 'local:package', version: '1', digest: 'a'.repeat(64) },
      modules: copy.modules,
      presets: [copy.preset, second],
      moduleEntries: { hud: [copy.modules[0]!.id], program: [copy.modules[1]!.id] },
      presetEntries: { first: copy.preset.id, second: second.id },
    };
    await expect(store.importBatch(batch)).rejects.toThrow('invalid_import_mapping');
    expect(store.snapshot).toEqual(initial);
  });
  it('enforces the size limit on the formatted bytes before initialization and save', async () => {
    const { store, options, initial } = await setup();
    const large = structuredClone(initial);
    const program = large.modules.find((module) => module.kind === 'program');
    if (!program || program.kind !== 'program') throw new Error('program missing');
    program.value = {
      ...program.value,
      tokens: Object.fromEntries(
        Array.from({ length: 100_000 }, (_, index) => [`k${index}`, 'x'.repeat(150)]),
      ),
    };
    const envelope = { version: 1, document: large, receipts: {} };
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThanOrEqual(16 * 1024 * 1024);
    expect(Buffer.byteLength(`${JSON.stringify(envelope, null, 2)}\n`)).toBeGreaterThan(
      16 * 1024 * 1024,
    );
    const newStore = new BroadcastConfigStore({
      ...options,
      filePath: `${options.filePath}.large`,
      createInitial: () => Promise.resolve(large),
    });
    await expect(newStore.load()).rejects.toThrow('broadcast_config_too_large');
    await expect(
      store.save({
        preset: initial.presets[0]!,
        expectedPresetRevision: 'p1',
        modules: [{ value: program, expectedRevision: 'p1' }],
      }),
    ).rejects.toThrow('broadcast_config_too_large');
    const reopened = new BroadcastConfigStore(options);
    await reopened.load();
    expect(reopened.snapshot).toEqual(initial);
  });
  it('commits a legacy HUD action without revising unrelated active modules', async () => {
    const { store, initial } = await setup();
    const hud = initial.active.resolved.hud;
    if (hud.renderer !== 'native') throw new Error('unexpected HUD');
    const changed = structuredClone(hud);
    changed.overlays.pause.enabled = false;
    const result = await store.updateFromLegacy({
      updateDraft: (document) => {
        document.modules[0]!.name = 'Edited';
      },
      active: { kind: 'hud', value: changed, lock: initial.active.lock },
    });
    expect(result.active.adjusted).toBe(true);
    expect(result.active.moduleRevisions.hud).not.toBe(initial.active.moduleRevisions.hud);
    expect(result.active.moduleRevisions.music).toBe(initial.active.moduleRevisions.music);
    expect(result.active.moduleRevisions.camera).toBe(initial.active.moduleRevisions.camera);
    expect(result.previousActive).toEqual(initial.active);
    expect(result.modules[0]!.revision).not.toBe(initial.modules[0]!.revision);
  });
  it('delegates legacy HUD draft writes to the unified document and restores them', async () => {
    const { store, options, initial } = await setup();
    const hud = new HudConfigStore();
    await hud.load();
    await hud.adoptPersistence(
      createHudConfigPersistence(store, (_hud, active) => Promise.resolve(active.lock)),
    );
    const saved = await hud.saveAs('theme', getBuiltinTheme(), hud.getState().editorRevision);
    expect(store.snapshot.unboundHudResources?.themes).toEqual(saved.document.customThemes);
    expect(store.snapshot.active).toEqual(initial.active);
    const reopened = new BroadcastConfigStore(options);
    await reopened.load();
    const nextHud = new HudConfigStore();
    await nextHud.load();
    await nextHud.adoptPersistence(
      createHudConfigPersistence(reopened, (_hud, active) => Promise.resolve(active.lock)),
    );
    expect(nextHud.getState().document).toEqual(saved.document);
  });
  it('routes a legacy music configuration write through the active coordinator', async () => {
    const { store, options, initial } = await setup();
    const music = new MusicStore(pathJoin(dirname(options.filePath), 'music'));
    await music.load();
    await music.adoptPersistence(
      createMusicConfigPersistence(store, music, (_value, active) => Promise.resolve(active.lock)),
    );
    await music.update((state) => {
      state.config.groups.waiting.volume = 0.2;
    });
    const active = store.snapshot.active;
    expect(active.resolved.music?.groups.waiting.volume).toBe(0.2);
    expect(active.resolved.music?.automaticEnabled).toBe(false);
    expect(active.moduleRevisions.hud).toBe(initial.active.moduleRevisions.hud);
    expect(active.moduleRevisions.camera).toBe(initial.active.moduleRevisions.camera);
    expect(active.adjusted).toBe(true);
  });
  it('delegates camera drafts and automatic strategy without touching other active modules', async () => {
    const { store, options } = await setup();
    const id = randomUUID();
    const value = {
      format: 'mizar.camera-config' as const,
      version: 2 as const,
      name: 'Camera',
      maps: [],
      automaticEnabled: false,
    };
    await store.updateFromLegacy({
      updateDraft(document) {
        document.modules.push({
          id,
          kind: 'camera',
          schemaVersion: 2,
          revision: randomUUID(),
          name: 'Camera',
          value,
          origin: null,
        });
        document.presets[0]!.bindings = document.presets[0]!.bindings.map((binding) =>
          binding.kind === 'camera' ? { kind: 'camera', mode: 'use', moduleId: id } : binding,
        );
      },
      active: { kind: 'camera', value, lock: store.snapshot.active.lock },
    });
    const before = store.snapshot.active;
    const camera = new OrchestrationStore(pathJoin(dirname(options.filePath), 'camera'));
    await camera.load();
    const persistence = createCameraConfigPersistence(store, {
      localPack: () => Promise.reject(new Error('unexpected')),
      localTrackId: () => Promise.reject(new Error('unexpected')),
      portable: (preset, automaticEnabled) =>
        Promise.resolve({
          format: 'mizar.camera-config',
          version: 2,
          name: preset.name,
          maps: [],
          automaticEnabled,
        }),
      lock: (_value, active) => Promise.resolve(active.lock),
    });
    await camera.adoptPersistence(persistence);
    const draftId = await camera.createPreset();
    await camera.savePreset(draftId, { ...camera.preset, name: 'Draft' });
    expect(store.snapshot.active).toEqual(before);
    await camera.saveAutomaticEnabled(true);
    expect(store.snapshot.active.resolved.camera?.automaticEnabled).toBe(true);
    expect(store.snapshot.active.moduleRevisions.music).toBe(before.moduleRevisions.music);
    expect(store.snapshot.active.moduleRevisions.hud).toBe(before.moduleRevisions.hud);
    const cameraRevision = camera.revision;
    const currentHud = store.snapshot.active.resolved.hud;
    if (currentHud.renderer !== 'native') throw new Error('unexpected HUD');
    const changedHud = structuredClone(currentHud);
    changedHud.overlays.pause.enabled = false;
    await store.updateFromLegacy({
      updateDraft: () => {},
      active: { kind: 'hud', value: changedHud, lock: store.snapshot.active.lock },
    });
    await camera.synchronizeFromPersistence();
    expect(camera.revision).toBe(cameraRevision);
  });
  it('keeps camera explicitly off until a legacy operator activates a real draft', async () => {
    const { store, options, initial } = await setup();
    const camera = new OrchestrationStore(pathJoin(dirname(options.filePath), 'camera-off'));
    await camera.load();
    const persistence = createCameraConfigPersistence(store, {
      localPack: () => Promise.reject(new Error('unexpected')),
      localTrackId: () => Promise.reject(new Error('unexpected')),
      portable: (preset, automaticEnabled) =>
        Promise.resolve({
          format: 'mizar.camera-config',
          version: 2,
          name: preset.name,
          maps: [],
          automaticEnabled,
        }),
      lock: (_value, active) => Promise.resolve(active.lock),
    });
    await camera.adoptPersistence(persistence);
    expect(camera.automaticEnabled).toBe(false);
    expect(store.snapshot.active).toEqual(initial.active);
    const id = await camera.createPreset();
    expect(store.snapshot.active.resolved.camera).toBeNull();
    await camera.activatePreset(id, () => Promise.resolve());
    expect(store.snapshot.active.resolved.camera).not.toBeNull();
    expect(store.snapshot.active.resolved.camera?.automaticEnabled).toBe(false);
  });
  it('waits for owners after releasing the coordinator queue and retries synchronization after failure', async () => {
    const { options, initial } = await setup();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const store = new BroadcastConfigStore({
      ...options,
      onApplied: async () => {
        attempts++;
        entered();
        await gate;
        await store.save({
          preset: store.snapshot.presets[0]!,
          expectedPresetRevision: 'p1',
          modules: [],
        });
        if (attempts === 1) throw new Error('sync_failed');
      },
    });
    await store.load();
    const request = {
      presetId: initial.presets[0]!.id,
      expectedRevision: 'p1',
      expectedModuleRevisions: { hud: 'h1', program: 'p1' },
      expectedActiveRevision: 'active',
      requestId: randomUUID(),
    };
    let finished = false;
    const applying = store.apply(request).finally(() => {
      finished = true;
    });
    await started;
    expect(finished).toBe(false);
    expect(store.isApplying).toBe(true);
    release();
    await expect(applying).rejects.toThrow('sync_failed');
    expect(store.isApplying).toBe(false);
    const committed = store.snapshot.active.revision;
    expect(committed).not.toBe('active');
    expect((await store.apply(request)).revision).toBe(committed);
    expect(attempts).toBe(2);
  });
  it('keeps active camera identity when its preset is rebound and another draft is unavailable', async () => {
    const { store } = await setup();
    const activeId = randomUUID(),
      missingId = randomUUID();
    const active = {
      format: 'mizar.camera-config' as const,
      version: 2 as const,
      name: 'Active',
      maps: [],
      automaticEnabled: false,
    };
    const source = {
      sourceName: 'missing',
      treeSha256: 'a'.repeat(64),
      converterVersion: 1 as const,
      acquisition: {
        kind: 'upstream' as const,
        release: {
          repository: 'Co1Swet/MulNX_CS2' as const,
          releaseId: 1,
          assetId: 2,
          tag: 'v1',
          archiveSha256: 'b'.repeat(64),
        },
      },
    };
    const map = {
      map: 'de_mirage',
      source,
      opening: null,
      openingSound: null,
      rounds: [],
      pauseCandidates: { tactical: [], technical: [] },
      stages: {
        warmup: null,
        tactical: null,
        technical: null,
        halftime: null,
        mapVictory: null,
        matchVictory: null,
      },
    };
    await store.updateFromLegacy({
      updateDraft(document) {
        document.modules.push(
          {
            id: activeId,
            kind: 'camera',
            schemaVersion: 2,
            revision: randomUUID(),
            name: 'Active',
            value: active,
            origin: null,
          },
          {
            id: missingId,
            kind: 'camera',
            schemaVersion: 2,
            revision: randomUUID(),
            name: 'Missing',
            value: { ...active, name: 'Missing', maps: [map] },
            origin: null,
          },
        );
        document.presets[0]!.bindings = document.presets[0]!.bindings.map((binding) =>
          binding.kind === 'camera' ? { kind: 'camera', mode: 'use', moduleId: activeId } : binding,
        );
      },
      active: {
        kind: 'camera',
        value: active,
        lock: store.snapshot.active.lock,
        moduleId: activeId,
      },
    });
    await store.updateFromLegacy({
      updateDraft(document) {
        document.presets[0]!.bindings = document.presets[0]!.bindings.map((binding) =>
          binding.kind === 'camera'
            ? { kind: 'camera', mode: 'use', moduleId: missingId }
            : binding,
        );
      },
    });
    let resolveCalls = 0;
    const persistence = createCameraConfigPersistence(store, {
      localPack: () => {
        resolveCalls++;
        return Promise.reject(new Error('dependency_missing'));
      },
      localTrackId: () => Promise.reject(new Error('unexpected')),
      portable: (preset, automaticEnabled) =>
        Promise.resolve({
          format: 'mizar.camera-config',
          version: 2,
          name: preset.name,
          maps: [],
          automaticEnabled,
        }),
      lock: (_value, current) => Promise.resolve(current.lock),
    });
    const view = await persistence.read();
    expect(resolveCalls).toBe(0);
    expect(view.catalog.activePresetId).toBe(activeId);
    expect(view.catalog.preset.name).toBe('Active');
    expect(view.catalog.presets.some((preset) => preset.id === missingId)).toBe(false);
    expect(store.snapshot.modules.some((module) => module.id === missingId)).toBe(true);
  });
});
