import { expect, it } from 'vitest';
import type { BroadcastConfigDocument, ModuleRecord } from '@mizar/broadcast-config';
import { buildApp } from '../../src/app.js';

it('reports pending migration without exposing or changing legacy settings', async () => {
  const app = buildApp();
  try {
    const response = await app.inject('/local/v1/broadcast-config/migration');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ state: 'pending', reason: 'owner_unavailable' });
    const forbidden = await app.inject({
      url: '/local/v1/broadcast-config/migration',
      headers: { origin: 'https://foreign.test' },
    });
    expect(forbidden.statusCode).toBe(403);
  } finally {
    await app.close();
  }
});

it('boots the coordinator with verified owners and exposes only display configuration', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { getBuiltinTheme } = await import('@mizar/hud-config');
  const { HudConfigStore } = await import('../../src/hud-config/store.js');
  const { BroadcastReferenceQueue } = await import('../../src/broadcast-config/reference-queue.js');
  const root = await mkdtemp(join(tmpdir(), 'broadcast-runtime-'));
  const hud = new HudConfigStore();
  await hud.load();
  const options: NonNullable<Parameters<typeof buildApp>[0]> = {
    obsConfigPath: join(root, 'obs.json'),
    hudConfigStore: hud,
    broadcastConfig: {
      path: join(root, 'broadcast.json'),
      musicAutomaticEnabled: true,
      references: new BroadcastReferenceQueue(),
      isDeleting: () => Promise.resolve(false),
      resolve: {
        asset: () => Promise.resolve(),
        hud: () => Promise.resolve(),
        scene: () => Promise.resolve(),
        camera: () => Promise.reject(new Error('unexpected')),
      },
      camera: {
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
      },
      localTrackId: () => Promise.reject(new Error('unexpected')),
      lockForActive: () => Promise.resolve({ resources: [], tools: [] }),
      verifyActive: () => Promise.resolve(),
    },
  };
  const app = buildApp(options);
  try {
    const status = await app.inject('/local/v1/broadcast-config/migration');
    expect(status.json()).toEqual({ state: 'ready' });
    const display = await app.inject('/local/v1/broadcast-display-config');
    expect(display.statusCode).toBe(200);
    expect(Object.keys(display.json()).sort()).toEqual(['activeRevision', 'hud', 'program']);
    const presets = await app.inject('/local/v1/broadcast-presets');
    expect(presets.statusCode).toBe(200);
    const saved = await app.inject({
      method: 'POST',
      url: '/operator/hud-config',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {
        kind: 'save-as',
        resource: 'theme',
        value: getBuiltinTheme(),
        expectedEditorRevision: hud.getState().editorRevision,
      },
    });
    expect(saved.statusCode).toBe(200);
    const after = await app.inject('/local/v1/broadcast-presets');
    expect(after.json()).toMatchObject({
      unboundHudResources: { themes: [expect.objectContaining({ name: getBuiltinTheme().name })] },
    });
    await app.close();
    const restoredHud = new HudConfigStore();
    await restoredHud.load();
    const restored = buildApp({ ...options, hudConfigStore: restoredHud });
    try {
      const resumed = await restored.inject('/local/v1/broadcast-config/migration');
      expect(resumed.json()).toEqual({ state: 'ready' });
      expect(restoredHud.getState().document.customThemes).toHaveLength(1);
    } finally {
      await restored.close();
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('boots built-in providers without custom injection when legacy dependencies are available', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { HudConfigStore } = await import('../../src/hud-config/store.js');
  const root = await mkdtemp(join(tmpdir(), 'broadcast-builtins-'));
  const hud = new HudConfigStore();
  await hud.load();
  const app = buildApp({ obsConfigPath: join(root, 'obs.json'), hudConfigStore: hud });
  try {
    const status = await app.inject('/local/v1/broadcast-config/migration');
    expect(status.json()).toEqual({ state: 'ready' });
    const display = await app.inject('/local/v1/broadcast-display-config');
    expect(display.statusCode).toBe(200);
    expect(display.json()).toMatchObject({
      hud: {
        renderer: 'native',
        overlays: { chat: { placement: 'auto' }, pause: { visual: 'legacy' } },
        accent: { source: 'fixed' },
      },
    });
    const modules = (await app.inject('/local/v1/broadcast-modules')).json<{
      modules: Array<{ module: { id: string; kind: string; revision: string }; builtin: boolean }>;
    }>().modules;
    expect(modules.filter((item) => item.builtin && item.module.kind === 'hud')).toHaveLength(5);
    expect(modules.filter((item) => item.builtin && item.module.kind === 'program')).toHaveLength(
      1,
    );
    const original = modules.find((item) => item.builtin && item.module.kind === 'hud')!.module;
    const post = (action: string, payload: object) =>
      app.inject({
        method: 'POST',
        url: `/operator/broadcast-modules/${action}`,
        headers: { origin: 'http://127.0.0.1:3000' },
        payload,
      });
    expect(
      (await post('delete', { moduleId: original.id, expectedRevision: original.revision }))
        .statusCode,
    ).toBe(409);
    const cloned = await post('clone', {
      moduleId: original.id,
      expectedRevision: original.revision,
      name: '我的 HUD',
    });
    expect(cloned.statusCode).toBe(200);
    const copy = cloned.json<{ id: string; revision: string }>();
    const otherResponse = await post('clone', {
      moduleId: original.id,
      expectedRevision: original.revision,
      name: '另一 HUD',
    });
    const other = otherResponse.json<ModuleRecord>();
    const drafts = (
      await app.inject('/local/v1/broadcast-presets')
    ).json<BroadcastConfigDocument>();
    const first = drafts.modules.find((module) => module.id === copy.id)!;
    if (
      first.kind !== 'hud' ||
      !('preset' in first.value) ||
      other.kind !== 'hud' ||
      !('preset' in other.value)
    )
      throw new Error('expected native HUD');
    other.value.layout.id = first.value.layout.id;
    other.value.preset.layoutId = first.value.layout.id;
    other.value.layout.widgets.radar.offsetX += 1;
    expect(
      (await post('save', { value: other, expectedRevision: other.revision })).statusCode,
    ).toBe(409);
    const unchanged = (
      await app.inject('/local/v1/broadcast-presets')
    ).json<BroadcastConfigDocument>();
    expect(unchanged.modules.find((item) => item.id === other.id)?.revision).toBe(other.revision);
    expect(
      (await post('delete', { moduleId: other.id, expectedRevision: other.revision })).statusCode,
    ).toBe(200);
    const before = (await app.inject('/local/v1/broadcast-presets')).json<BroadcastConfigDocument>()
      .active;
    const { randomUUID } = await import('node:crypto');
    const applied = await post('apply', {
      moduleId: copy.id,
      expectedRevision: copy.revision,
      expectedActiveRevision: before.revision,
      requestId: randomUUID(),
    });
    expect(applied.statusCode).toBe(200);
    const active = applied.json<BroadcastConfigDocument['active']>();
    expect(active.sourceModuleIds?.hud).toBe(copy.id);
    expect(active.moduleRevisions.music).toBe(before.moduleRevisions.music);
    expect(active.moduleRevisions.camera).toBe(before.moduleRevisions.camera);
    expect(
      (await post('delete', { moduleId: copy.id, expectedRevision: copy.revision })).statusCode,
    ).toBe(409);
    expect(
      (
        await post('apply', {
          moduleId: original.id,
          expectedRevision: original.revision,
          expectedActiveRevision: active.revision,
          requestId: randomUUID(),
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await post('delete', { moduleId: copy.id, expectedRevision: copy.revision })).statusCode,
    ).toBe(200);
    expect(hud.getState().document.customPresets).toHaveLength(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves the existing music owner state during built-in production migration', async () => {
  const { randomUUID } = await import('node:crypto');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { HudConfigStore } = await import('../../src/hud-config/store.js');
  const { MusicStore } = await import('../../src/music/store.js');
  const { musicWav } = await import('../music-fixtures.js');
  const root = await mkdtemp(join(tmpdir(), 'broadcast-real-music-'));
  const music = new MusicStore(join(root, 'music'));
  await music.load();
  const track = await music.add('sample.wav', musicWav());
  const config = structuredClone(music.state.config);
  config.groups.waiting.tracks = [track];
  await music.configure(config);
  await music.update((state) => {
    state.master = 0.3;
    state.muted = true;
  });
  const revision = music.state.configRevision;
  const oldState = await readFile(join(root, 'music', 'state.json'), 'utf8');
  const hud = new HudConfigStore();
  await hud.load();
  const app = buildApp({ obsConfigPath: join(root, 'obs.json'), hudConfigStore: hud });
  try {
    expect((await app.inject('/local/v1/broadcast-config/migration')).json()).toEqual({
      state: 'ready',
    });
    const presets = await app.inject('/local/v1/broadcast-presets');
    expect(presets.json()).toMatchObject({
      active: {
        moduleRevisions: { music: revision },
        resolved: { music: { groups: { waiting: { tracks: [{ name: 'sample.wav' }] } } } },
      },
    });
    const document = presets.json<BroadcastConfigDocument>();
    const preset = document.presets[0]!;
    const expectedModuleRevisions = Object.fromEntries(
      preset.bindings.flatMap((binding) => {
        if (binding.mode === 'off') return [];
        const module = document.modules.find((item) => item.id === binding.moduleId)!;
        return [[binding.kind, module.revision]];
      }),
    );
    const applied = await app.inject({
      method: 'POST',
      url: '/operator/broadcast-presets/apply',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {
        presetId: preset.id,
        expectedRevision: preset.revision,
        expectedModuleRevisions,
        expectedActiveRevision: document.active.revision,
        requestId: randomUUID(),
      },
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json<{ moduleRevisions: { music: string } }>().moduleRevisions.music).toBe(
      revision,
    );
    expect((await app.inject('/local/v1/broadcast-config/migration')).json()).toEqual({
      state: 'ready',
    });
    expect(await readFile(join(root, 'music', 'state.json'), 'utf8')).toBe(oldState);
    const runtime = JSON.parse(
      await readFile(join(root, 'music', 'runtime.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(runtime).toMatchObject({ master: 0.3, muted: true });
    expect(runtime).not.toHaveProperty('config');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves legacy camera data while allowing HUD use when its source is unavailable', async () => {
  const { mkdtemp, readFile, rm, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { HudConfigStore } = await import('../../src/hud-config/store.js');
  const { OrchestrationStore } = await import('../../src/orchestration/store.js');
  const root = await mkdtemp(join(tmpdir(), 'broadcast-real-camera-'));
  const camera = new OrchestrationStore(join(root, 'orchestration'));
  await camera.load();
  await camera.save({
    format: 'mizar.orchestration',
    version: 1,
    name: 'Current',
    maps: [{ map: 'de_mirage', pack: 'Mizar_test' }],
  });
  const oldState = await readFile(join(camera.directory, 'presets.json'), 'utf8');
  const hud = new HudConfigStore();
  await hud.load();
  const app = buildApp({ obsConfigPath: join(root, 'obs.json'), hudConfigStore: hud });
  try {
    expect((await app.inject('/local/v1/broadcast-config/migration')).json()).toEqual({
      state: 'pending',
      reason: 'camera_identity_unavailable',
    });
    expect((await app.inject('/local/v1/broadcast-display-config')).statusCode).toBe(200);
    expect(await readFile(join(camera.directory, 'presets.json'), 'utf8')).toBe(oldState);
    expect((await stat(join(root, 'broadcast-config.json'))).isFile()).toBe(true);
    const pending = (await app.inject('/local/v1/broadcast-config/pending-camera')).json();
    expect(pending.pending.catalog.preset.maps[0]).toMatchObject({
      map: 'de_mirage',
      pack: 'Mizar_test',
    });
    const modules = (await app.inject('/local/v1/broadcast-modules')).json<{
      modules: Array<{ module: ModuleRecord }>;
    }>().modules;
    const hudModule = modules.find(({ module }) => module.kind === 'hud')!.module;
    const document = (
      await app.inject('/local/v1/broadcast-presets')
    ).json<BroadcastConfigDocument>();
    expect(document.active.resolved.camera).toBeNull();
    const { randomUUID } = await import('node:crypto');
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    expect((await fetch(`${address}/local/v1/broadcast-modules`)).status).toBe(200);
    const applied = await fetch(`${address}/operator/broadcast-modules/apply`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
      body: JSON.stringify({
        moduleId: hudModule.id,
        expectedRevision: hudModule.revision,
        expectedActiveRevision: document.active.revision,
        requestId: randomUUID(),
      }),
    });
    expect(applied.status).toBe(200);
    const recovery = await fetch(`${address}/operator/broadcast-config/pending-camera/restore`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(recovery.status).toBe(503);
    await app.close();
    const resumedHud = new HudConfigStore();
    await resumedHud.load();
    const resumed = buildApp({ obsConfigPath: join(root, 'obs.json'), hudConfigStore: resumedHud });
    try {
      const resumedAddress = await resumed.listen({ host: '127.0.0.1', port: 0 });
      expect((await fetch(`${resumedAddress}/local/v1/broadcast-modules`)).status).toBe(200);
      const restored = (await (
        await fetch(`${resumedAddress}/local/v1/broadcast-config/pending-camera`)
      ).json()) as { pending: { catalog: { preset: { maps: Array<{ pack: string }> } } } };
      expect(restored.pending.catalog.preset.maps[0]!.pack).toBe('Mizar_test');
    } finally {
      await resumed.close();
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('keeps an existing active camera snapshot when MulNX disappears and still applies a HUD', async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');
  const { HudConfigStore } = await import('../../src/hud-config/store.js');
  const root = await mkdtemp(join(tmpdir(), 'broadcast-missing-tool-'));
  const makeApp = async () => {
    const hud = new HudConfigStore();
    await hud.load();
    return buildApp({ obsConfigPath: join(root, 'obs.json'), hudConfigStore: hud });
  };
  const initial = await makeApp();
  try {
    expect((await initial.inject('/local/v1/broadcast-modules')).statusCode).toBe(200);
  } finally {
    await initial.close();
  }
  const path = join(root, 'broadcast-config.json');
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  const id = randomUUID();
  const release = {
    repository: 'Co1Swet/MulNX_CS2',
    releaseId: 1,
    assetId: 2,
    tag: 'v1',
    archiveSha256: 'b'.repeat(64),
  };
  const tool = { kind: 'upstream', release };
  const source = {
    sourceName: 'missing',
    treeSha256: 'a'.repeat(64),
    converterVersion: 1,
    acquisition: tool,
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
  const value = {
    format: 'mizar.camera-config',
    version: 2,
    name: 'Camera',
    automaticEnabled: true,
    maps: [map],
  };
  const module = {
    id,
    revision: randomUUID(),
    kind: 'camera',
    schemaVersion: 2,
    name: 'Camera',
    value,
    origin: null,
  };
  envelope.document.modules.push(module);
  envelope.document.presets[0].bindings = envelope.document.presets[0].bindings.map(
    (binding: { kind: string }) =>
      binding.kind === 'camera' ? { kind: 'camera', mode: 'use', moduleId: id } : binding,
  );
  envelope.document.active.resolved.camera = value;
  envelope.document.active.sourceModuleIds.camera = id;
  envelope.document.active.sourceModuleRevisions.camera = module.revision;
  envelope.document.active.lock.tools = [tool];
  await writeFile(path, JSON.stringify(envelope));
  const app = await makeApp();
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const list = await fetch(`${address}/local/v1/broadcast-modules`);
    expect(list.status).toBe(200);
    const data = (await list.json()) as { modules: Array<{ module: ModuleRecord }> };
    const hud = data.modules.find((entry) => entry.module.kind === 'hud')!.module;
    const document = (await (
      await fetch(`${address}/local/v1/broadcast-presets`)
    ).json()) as BroadcastConfigDocument;
    expect(document.active.resolved.camera).toEqual(value);
    const response = await fetch(`${address}/operator/broadcast-modules/apply`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
      body: JSON.stringify({
        moduleId: hud.id,
        expectedRevision: hud.revision,
        expectedActiveRevision: document.active.revision,
        requestId: randomUUID(),
      }),
    });
    expect(response.status).toBe(200);
    const applied = (await response.json()) as BroadcastConfigDocument['active'];
    expect(applied.resolved.camera).toEqual(value);
    expect(applied.lock.tools).toEqual([tool]);
    expect((await fetch(`${address}/local/v1/broadcast-config/migration`)).status).toBe(200);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('rejects unknown image slots and keeps the service usable after the active image is damaged', async () => {
  const { mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash, randomUUID } = await import('node:crypto');
  const { HudConfigStore } = await import('../../src/hud-config/store.js');
  const { BroadcastReferenceQueue } = await import('../../src/broadcast-config/reference-queue.js');
  const root = await mkdtemp(join(tmpdir(), 'broadcast-scene-asset-'));
  const path = join(root, 'image.png');
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC',
    'base64',
  );
  await writeFile(path, bytes);
  const ref = {
    resource: { id: 'local:mizar-pack:' + randomUUID(), version: '1.0.0', digest: 'a'.repeat(64) },
    fileId: 'image',
  };
  const verifyImage = async (value: typeof ref) => {
    if (
      JSON.stringify(value) !== JSON.stringify(ref) ||
      createHash('sha256')
        .update(await readFile(path))
        .digest('hex') !== createHash('sha256').update(bytes).digest('hex')
    )
      throw new Error('resource_damaged');
  };
  const makeApp = async () => {
    const hud = new HudConfigStore();
    await hud.load();
    const lockForActive = async (resolved: BroadcastConfigDocument['active']['resolved']) => {
      for (const image of Object.values(resolved.program.assets)) await verifyImage(image);
      return {
        resources: Object.values(resolved.program.assets).map((image) => image.resource),
        tools: [],
      };
    };
    return buildApp({
      obsConfigPath: join(root, 'obs.json'),
      hudConfigStore: hud,
      broadcastConfig: {
        path: join(root, 'broadcast.json'),
        musicAutomaticEnabled: true,
        references: new BroadcastReferenceQueue(),
        isDeleting: () => Promise.resolve(false),
        resolve: {
          asset: verifyImage,
          image: verifyImage,
          hud: () => Promise.reject(new Error('unsupported')),
          scene: () => Promise.resolve(),
          camera: () => Promise.reject(new Error('unexpected')),
        },
        camera: {
          localPack: () => Promise.reject(new Error('unexpected')),
          localTrackId: () => Promise.reject(new Error('unexpected')),
          portable: (preset, automaticEnabled) =>
            Promise.resolve({
              format: 'mizar.camera-config',
              version: 2,
              name: preset.name,
              automaticEnabled,
              maps: [],
            }),
          lock: (_value, active) => Promise.resolve(active.lock),
        },
        localTrackId: () => Promise.reject(new Error('unexpected')),
        lockForActive,
        verifyActive: async (active) => {
          const expected = await lockForActive(active.resolved);
          if (JSON.stringify(expected) !== JSON.stringify(active.lock))
            throw new Error('dependency_missing');
        },
      },
    });
  };
  const post = (base: string, action: string, payload: unknown) =>
    fetch(`${base}/operator/broadcast-modules/${action}`, {
      method: 'POST',
      headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const first = await makeApp();
  try {
    const base = await first.listen({ host: '127.0.0.1', port: 0 });
    const list = (await (await fetch(`${base}/local/v1/broadcast-modules`)).json()) as {
      modules: Array<{ module: ModuleRecord }>;
    };
    const builtin = list.modules.find(({ module }) => module.kind === 'program')!.module;
    const copy = (await (
      await post(base, 'clone', {
        moduleId: builtin.id,
        expectedRevision: builtin.revision,
        name: 'Scene',
      })
    ).json()) as ModuleRecord;
    if (copy.kind !== 'program') throw new Error('expected program');
    copy.value.assets = { 'wrong.slot': ref };
    let saved = (await (
      await post(base, 'save', { value: copy, expectedRevision: copy.revision })
    ).json()) as ModuleRecord;
    let document = (await (
      await fetch(`${base}/local/v1/broadcast-presets`)
    ).json()) as BroadcastConfigDocument;
    const invalid = await post(base, 'apply', {
      moduleId: saved.id,
      expectedRevision: saved.revision,
      expectedActiveRevision: document.active.revision,
      requestId: randomUUID(),
    });
    expect(invalid.status).toBe(422);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe(
      'capability_unsupported',
    );
    if (saved.kind !== 'program') throw new Error('expected program');
    saved.value.assets = { 'pulse.background': ref };
    const hex = (value: string) => `#${value}`;
    saved.value.tokens = {
      'pulse.white': hex('112233'),
      'pulse.blue': hex('12345678'),
      'pulse.gold': hex('aabbcc'),
      'pulse.muted': hex('012345'),
      'pulse.canvas': hex('234567'),
      'pulse.shell': hex('abcdef80'),
    };
    saved = (await (
      await post(base, 'save', { value: saved, expectedRevision: saved.revision })
    ).json()) as ModuleRecord;
    document = (await (
      await fetch(`${base}/local/v1/broadcast-presets`)
    ).json()) as BroadcastConfigDocument;
    expect(
      (
        await post(base, 'apply', {
          moduleId: saved.id,
          expectedRevision: saved.revision,
          expectedActiveRevision: document.active.revision,
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(200);
  } finally {
    await first.close();
  }
  await writeFile(path, 'damaged');
  const second = await makeApp();
  try {
    const base = await second.listen({ host: '127.0.0.1', port: 0 });
    const list = (await (await fetch(`${base}/local/v1/broadcast-modules`)).json()) as {
      modules: Array<{ module: ModuleRecord; availability: { state: string } }>;
    };
    const scene = list.modules.find(
      ({ module }) => module.kind === 'program' && module.name === 'Scene',
    )!;
    expect(scene.availability.state).toBe('dependency_missing');
    const display = await fetch(`${base}/local/v1/broadcast-display-config`);
    expect(display.status).toBe(200);
    expect(display.headers.get('x-mizar-program-status')).toBe('dependency_missing');
    const before = (await (
      await fetch(`${base}/local/v1/broadcast-presets`)
    ).json()) as BroadcastConfigDocument;
    expect(before.active.resolved.program.assets['pulse.background']).toEqual(ref);
    expect(before.active.resolved.program.tokens['pulse.white']).toBe(`#${'112233'}`);
    expect(before.active.lock.resources).toContainEqual(ref.resource);
    const hud = list.modules.find(({ module }) => module.kind === 'hud')!.module;
    expect(
      (
        await post(base, 'apply', {
          moduleId: hud.id,
          expectedRevision: hud.revision,
          expectedActiveRevision: before.active.revision,
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(200);
    const after = (await (
      await fetch(`${base}/local/v1/broadcast-presets`)
    ).json()) as BroadcastConfigDocument;
    expect(after.active.resolved.program.assets['pulse.background']).toEqual(ref);
    expect(after.active.resolved.program.tokens).toEqual(before.active.resolved.program.tokens);
    expect(after.active.lock.resources).toContainEqual(ref.resource);
    await writeFile(path, bytes);
    expect(
      (
        await post(base, 'apply', {
          moduleId: scene.module.id,
          expectedRevision: scene.module.revision,
          expectedActiveRevision: after.active.revision,
          requestId: randomUUID(),
        })
      ).status,
    ).toBe(200);
    const repairedDisplay = await fetch(`${base}/local/v1/broadcast-display-config`);
    expect(repairedDisplay.status).toBe(200);
    expect(repairedDisplay.headers.get('x-mizar-program-status')).toBeNull();
  } finally {
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
});
