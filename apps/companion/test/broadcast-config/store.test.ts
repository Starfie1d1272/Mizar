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
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
  type ModuleRecord,
  type ProgramVisualConfigV1,
} from '@mizar/broadcast-config';
import { BroadcastConfigStore } from '../../src/broadcast-config/store.js';
import {
  addMissingBuiltinModules,
  createBuiltinModules,
} from '../../src/broadcast-config/builtin-modules.js';

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
  return { store, options, initial: store.snapshot };
}
describe('BroadcastConfigStore', () => {
  it('retains a failed legacy camera recovery and commits verified drafts once without applying them', async () => {
    const { options, initial } = await setup();
    const { emptyOrchestrationPreset } = await import('@mizar/protocol/orchestration');
    const preset = emptyOrchestrationPreset();
    const id = randomUUID();
    const pending = {
      catalog: { activePresetId: id, preset, presets: [{ id, preset }] },
      automaticEnabled: true,
      reason: 'camera_identity_unavailable' as const,
    };
    let available = false;
    const recoveryOptions = {
      ...options,
      filePath: pathJoin(dirname(options.filePath), 'recovery.json'),
      createInitial: () => Promise.resolve(initial),
      initialPendingLegacyCamera: () => pending,
      resolveModule: async (module: ModuleRecord) => {
        if (!available) throw new Error('camera_identity_unavailable');
        return { value: module.value as never, lock: { resources: [], tools: [] } };
      },
    };
    const store = new BroadcastConfigStore(recoveryOptions);
    await store.load();
    const convert = (value: typeof preset, automaticEnabled: boolean) =>
      Promise.resolve({
        format: 'mizar.camera-config' as const,
        version: 2 as const,
        name: value.name,
        maps: [],
        automaticEnabled,
      });
    await expect(store.restoreLegacyCamera(convert)).rejects.toThrow('camera_identity_unavailable');
    expect(store.pendingLegacyCamera).toEqual(pending);
    expect(store.snapshot.active).toEqual(initial.active);
    available = true;
    const restored = await store.restoreLegacyCamera(convert);
    expect(restored).toHaveLength(1);
    expect(store.snapshot.active).toEqual(initial.active);
    expect(store.pendingLegacyCamera).toBeUndefined();
    const reopened = new BroadcastConfigStore(recoveryOptions);
    await reopened.load();
    expect(reopened.snapshot.modules.filter((module) => module.kind === 'camera')).toHaveLength(1);
    await expect(reopened.restoreLegacyCamera(convert)).rejects.toThrow('pending_camera_missing');
  });
  it('claims unchanged legacy built-ins without changing the active output', () => {
    const document = fixture();
    const builtin = createBuiltinModules().find((item) => item.kind === 'hud')!;
    const oldId = randomUUID();
    const legacy = { ...structuredClone(builtin), id: oldId, revision: 'old' };
    document.modules.push(legacy);
    document.presets[0]!.bindings[0] = { kind: 'hud', mode: 'use', moduleId: oldId };
    document.active.sourceModuleIds = { hud: oldId, program: null, music: null, camera: null };
    document.active.sourceModuleRevisions = {
      hud: 'old',
      program: null,
      music: null,
      camera: null,
    };
    const resolved = structuredClone(document.active.resolved);
    expect(addMissingBuiltinModules(document)).toBe(true);
    expect(document.modules.some((item) => item.id === oldId)).toBe(false);
    expect(document.presets[0]!.bindings[0]).toEqual({
      kind: 'hud',
      mode: 'use',
      moduleId: builtin.id,
    });
    expect(document.active.sourceModuleIds.hud).toBe(builtin.id);
    expect(document.active.sourceModuleRevisions.hud).toBe(builtin.revision);
    expect(document.active.resolved).toEqual(resolved);
    expect(document.active.revision).toBe('active');
    expect(addMissingBuiltinModules(document)).toBe(false);
  });
  it('protects built-ins and refuses removal of active or referenced modules', async () => {
    const { store, initial } = await setup();
    const builtin = store.snapshot.modules.find(
      (item) => item.id === 'fb81f5a0-9e35-4ae5-8f15-000000000001',
    )!;
    await expect(store.deleteModule(builtin.id, builtin.revision)).rejects.toThrow(
      'builtin_immutable',
    );
    await expect(store.saveModule(builtin, builtin.revision)).rejects.toThrow('builtin_immutable');
    const bound = initial.modules[0]!;
    await expect(store.deleteModule(bound.id, bound.revision)).rejects.toThrow('module_active');
    const clone = await store.cloneModule(builtin.id, builtin.revision, '可编辑 HUD');
    expect(clone.id).not.toBe(builtin.id);
    await store.deleteModule(clone.id, clone.revision);
    expect(store.snapshot.modules.some((item) => item.id === clone.id)).toBe(false);
  });
  it('keeps an identical user copy after the one-time built-in normalization', async () => {
    const { store, options } = await setup();
    const builtin = store.snapshot.modules.find(
      (module) => module.kind === 'program' && module.name === 'Pulse',
    )!;
    const copy = await store.cloneModule(builtin.id, builtin.revision, builtin.name);
    const reopened = new BroadcastConfigStore(options);
    await reopened.load();
    expect(reopened.snapshot.modules.find((module) => module.id === copy.id)).toEqual(copy);
    await reopened.deleteModule(copy.id, copy.revision);
  });
  it('replaces a draft reference atomically when deleting a module', async () => {
    const { store, initial } = await setup();
    const builtin = store.snapshot.modules.find(
      (item) => item.id === 'fb81f5a0-9e35-4ae5-8f15-000000000001',
    )!;
    const copy = await store.cloneModule(builtin.id, builtin.revision, '草稿 HUD');
    const preset = structuredClone(initial.presets[0]!);
    preset.id = randomUUID();
    preset.bindings = preset.bindings.map((binding) =>
      binding.kind === 'hud' ? { kind: 'hud', mode: 'use', moduleId: copy.id } : binding,
    );
    await store.save({ preset, expectedPresetRevision: null, modules: [] });
    const current = store.snapshot.presets.find((item) => item.id === preset.id)!;
    const app = Fastify();
    registerBroadcastConfigRoutes(app, store, createLocalWebOriginPolicy());
    try {
      const references = await app.inject(`/local/v1/broadcast-modules/${copy.id}/references`);
      expect(references.statusCode).toBe(200);
      expect(references.json()).toEqual({
        moduleId: copy.id,
        revision: copy.revision,
        active: false,
        presets: [{ id: current.id, name: current.name, revision: current.revision }],
      });
      expect(
        (
          await app.inject({
            url: `/local/v1/broadcast-modules/${copy.id}/references`,
            headers: { origin: 'https://foreign.test' },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
    await expect(store.deleteModule(copy.id, copy.revision)).rejects.toThrow('module_referenced');
    await store.deleteModule(copy.id, copy.revision, {
      moduleId: builtin.id,
      expectedPresetRevisions: { [current.id]: current.revision },
    });
    expect(store.snapshot.presets.find((item) => item.id === preset.id)?.bindings).toContainEqual({
      kind: 'hud',
      mode: 'use',
      moduleId: builtin.id,
    });
    expect(store.snapshot.modules.some((item) => item.id === copy.id)).toBe(false);
  });
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
  it('retains receipt resources and can retry an apply after the selected module was deleted', async () => {
    const { options } = await setup();
    const ref = { id: 'local:test', version: '1', digest: 'a'.repeat(64) };
    let selected = '';
    const store = new BroadcastConfigStore({
      ...options,
      resolveModule: (module) =>
        Promise.resolve({
          value: module.value as never,
          lock: { resources: module.id === selected ? [ref] : [], tools: [] },
        }),
    });
    await store.load();
    const builtin = store.snapshot.modules.find(
      (item) => item.kind === 'program' && item.name === 'Pulse',
    )!;
    const copy = await store.cloneModule(builtin.id, builtin.revision, 'Copy');
    selected = copy.id;
    const request = {
      moduleId: copy.id,
      expectedRevision: copy.revision,
      expectedActiveRevision: store.snapshot.active.revision,
      requestId: randomUUID(),
    };
    const original = await store.applyModule(request);
    for (let index = 0; index < 2; index++)
      await store.applyModule({
        moduleId: builtin.id,
        expectedRevision: builtin.revision,
        expectedActiveRevision: store.snapshot.active.revision,
        requestId: randomUUID(),
      });
    await store.deleteModule(copy.id, copy.revision);
    expect(store.snapshot.active.lock.resources).not.toContainEqual(ref);
    expect(store.snapshot.previousActive?.lock.resources).not.toContainEqual(ref);
    expect(store.referencedResources()).toContainEqual(ref);
    expect(await store.applyModule(request)).toEqual(original);
    expect(store.snapshot.active.sourceModuleIds?.program).toBe(builtin.id);
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
    for (const [entryId, ids] of Object.entries(batch.moduleEntries))
      for (const module of batch.modules.filter((item) => ids.includes(item.id)))
        module.origin = { resource: batch.source, entryId };
    for (const [entryId, id] of Object.entries(batch.presetEntries))
      batch.presets.find((preset) => preset.id === id)!.origin = {
        resource: batch.source,
        entryId,
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
    await reopened.deletePreset(second.preset.id, second.preset.revision);
    await reopened.deleteModule(second.modules[0]!.id, second.modules[0]!.revision);
    const restarted = new BroadcastConfigStore(options);
    await restarted.load();
    const inspection = restarted.inspectImport(batch.source)!;
    expect(inspection.presets.second?.state).toBe('removed');
    expect(inspection.presets.first?.state).toBe('existing');
    expect(inspection.modules.hud).toContainEqual({
      id: second.modules[0]!.id,
      owner: 'second',
      state: 'removed',
    });
    expect(() => restarted.inspectImport({ ...batch.source, digest: 'b'.repeat(64) })).toThrow(
      'identity_conflict',
    );
    const retryFirst = clonePreset(initial, request, randomUUID);
    const retrySecond = clonePreset(initial, { ...request, name: 'Second' }, randomUUID);
    const retry = {
      ...batch,
      modules: [...retryFirst.modules, ...retrySecond.modules],
      presets: [retryFirst.preset, retrySecond.preset],
      moduleEntries: {
        hud: [retryFirst.modules[0]!.id, retrySecond.modules[0]!.id],
        program: [retryFirst.modules[1]!.id, retrySecond.modules[1]!.id],
      },
      presetEntries: { first: retryFirst.preset.id, second: retrySecond.preset.id },
    };
    for (const [entryId, ids] of Object.entries(retry.moduleEntries))
      for (const module of retry.modules.filter((item) => ids.includes(item.id)))
        module.origin = { resource: retry.source, entryId };
    for (const [entryId, id] of Object.entries(retry.presetEntries))
      retry.presets.find((preset) => preset.id === id)!.origin = {
        resource: retry.source,
        entryId,
      };
    const restored = await restarted.importBatch(retry);
    expect(restored.reused).toBe(false);
    expect(restored.mapping.presetEntries.first).toBe(first.preset.id);
    expect(restored.mapping.presetEntries.second).toBe(retrySecond.preset.id);
    expect(restored.mapping.moduleEntries.program).toContain(second.modules[1]!.id);
    expect(restored.mapping.moduleEntries.hud).toContain(retrySecond.modules[0]!.id);
    expect(restarted.snapshot.presets).toHaveLength(3);
    expect(
      restarted.snapshot.modules.filter((item) => item.id === first.modules[0]!.id),
    ).toHaveLength(1);
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
  it('only replenishes selected module entries and keeps edits to surviving entries', async () => {
    const { store, options } = await setup();
    const source = { id: 'local:package', version: '1', digest: 'a'.repeat(64) };
    const template = store.snapshot.modules.find((item) => item.kind === 'program')!;
    const batch = (entries: string[]) => {
      const modules = entries.map((entryId) => ({
        ...structuredClone(template),
        id: randomUUID(),
        revision: randomUUID(),
        name: entryId,
        origin: { resource: source, entryId },
      }));
      return {
        source,
        modules,
        presets: [],
        moduleEntries: Object.fromEntries(modules.map((module) => [module.name, [module.id]])),
        presetEntries: {},
      };
    };
    const first = await store.importBatch(batch(['first']));
    const second = await store.importBatch(batch(['second']));
    const firstId = first.mapping.moduleEntries.first![0]!;
    const firstModule = store.snapshot.modules.find((item) => item.id === firstId)!;
    await store.saveModule({ ...firstModule, name: 'Edited' }, firstModule.revision);
    const both = await store.importBatch(batch(['first', 'second']));
    expect(both.reused).toBe(true);
    expect(store.snapshot.modules.find((item) => item.id === firstId)?.name).toBe('Edited');
    const revised = store.snapshot.modules.find((item) => item.id === firstId)!;
    await store.deleteModule(firstId, revised.revision);
    const restarted = new BroadcastConfigStore(options);
    await restarted.load();
    const repeatSecond = await restarted.importBatch(batch(['second']));
    expect(repeatSecond.reused).toBe(true);
    expect(restarted.snapshot.modules.some((item) => item.id === firstId)).toBe(false);
    const firstAgain = await restarted.importBatch(batch(['first']));
    expect(firstAgain.mapping.moduleEntries.first![0]).not.toBe(firstId);
    expect(firstAgain.mapping.moduleEntries.second).toEqual(second.mapping.moduleEntries.second);
  });
  it('rejects a persisted import mapping that points at an unrelated live module', async () => {
    const { store, options } = await setup();
    const source = { id: 'local:package', version: '1', digest: 'a'.repeat(64) };
    const template = store.snapshot.modules.find((item) => item.kind === 'program')!;
    const module = {
      ...structuredClone(template),
      id: randomUUID(),
      revision: randomUUID(),
      origin: { resource: source, entryId: 'program' },
    };
    await store.importBatch({
      source,
      modules: [module],
      presets: [],
      moduleEntries: { program: [module.id] },
      presetEntries: {},
    });
    const envelope = JSON.parse(await readFile(options.filePath, 'utf8'));
    envelope.document.modules.find((item: { id: string }) => item.id === module.id).origin.entryId =
      'different';
    await writeFile(options.filePath, JSON.stringify(envelope));
    await expect(new BroadcastConfigStore(options).load()).rejects.toThrow(
      'broadcast_import_index_invalid',
    );
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
    expect(store.snapshot.presets[0]!.bindings.find((binding) => binding.kind === 'music')).toEqual(
      { kind: 'music', mode: 'off' },
    );
    expect(active.sourceModuleIds?.music).toBeTruthy();
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
  it('does not resurrect a camera draft deleted during legacy conversion', async () => {
    const { store } = await setup();
    const id = randomUUID();
    await store.updateFromLegacy({
      updateDraft(document) {
        document.modules.push({
          id,
          kind: 'camera',
          schemaVersion: 2,
          revision: 'camera-revision',
          name: 'Camera',
          origin: null,
          value: {
            format: 'mizar.camera-config',
            version: 2,
            name: 'Camera',
            maps: [],
            automaticEnabled: false,
          },
        });
      },
    });
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const converting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const persistence = createCameraConfigPersistence(store, {
      localPack: () => Promise.reject(new Error('unexpected')),
      localTrackId: () => Promise.reject(new Error('unexpected')),
      portable: async (preset, automaticEnabled) => {
        started();
        await waiting;
        return {
          format: 'mizar.camera-config',
          version: 2,
          name: preset.name,
          maps: [],
          automaticEnabled,
        };
      },
      lock: (_value, active) => Promise.resolve(active.lock),
    });
    const before = await persistence.read();
    const changed = structuredClone(before.catalog);
    changed.presets.find((item) => item.id === id)!.preset.name = 'Edited';
    const commit = persistence.commit(changed, false, before.catalog, false);
    await converting;
    const module = store.snapshot.modules.find((item) => item.id === id)!;
    await store.deleteModule(id, module.revision);
    release();
    await expect(commit).rejects.toThrow('revision_conflict');
    expect(store.snapshot.modules.some((item) => item.id === id)).toBe(false);
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
    await persistence.commit(view.catalog, true, view.catalog, false);
    expect(
      store.snapshot.presets[0]!.bindings.find((binding) => binding.kind === 'camera'),
    ).toEqual({ kind: 'camera', mode: 'use', moduleId: missingId });
    expect(store.snapshot.active.sourceModuleIds?.camera).toBe(activeId);
  });
  it('reports a committed synchronization failure and accepts the same request for recovery', async () => {
    const { options, initial } = await setup();
    let ready = true,
      attempts = 0;
    const store = new BroadcastConfigStore({
      ...options,
      onApplied: () => {
        ready = false;
        if (++attempts === 1) throw new Error('broadcast_owner_sync_failed');
        ready = true;
      },
    });
    await store.load();
    const app = Fastify();
    registerBroadcastConfigRoutes(
      app,
      store,
      createLocalWebOriginPolicy(),
      () => ready && !store.isApplying,
    );
    const payload = {
      presetId: initial.presets[0]!.id,
      expectedRevision: 'p1',
      expectedModuleRevisions: { hud: 'h1', program: 'p1' },
      expectedActiveRevision: 'active',
      requestId: randomUUID(),
    };
    try {
      const first = await app.inject({
        method: 'POST',
        url: '/operator/broadcast-presets/apply',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload,
      });
      expect(first.statusCode).toBe(503);
      expect(first.json()).toMatchObject({ error: { code: 'broadcast_owner_sync_failed' } });
      const retry = await app.inject({
        method: 'POST',
        url: '/operator/broadcast-presets/apply',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload,
      });
      expect(retry.statusCode).toBe(200);
      expect(ready).toBe(true);
      expect(attempts).toBe(2);
    } finally {
      await app.close();
    }
  });
});
