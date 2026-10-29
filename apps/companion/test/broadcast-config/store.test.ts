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
import { type BroadcastConfigDocument, type ProgramVisualConfigV1 } from '@mizar/broadcast-config';
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
      sourcePreset: null,
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
});
