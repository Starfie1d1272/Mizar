import { expect, it } from 'vitest';
import type { BroadcastConfigDocument } from '@mizar/broadcast-config';
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
    const document = presets.json() as BroadcastConfigDocument;
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
    expect(applied.json().moduleRevisions.music).toBe(revision);
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

it('leaves real legacy files in place when a camera source cannot yet be verified', async () => {
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
    expect((await app.inject('/local/v1/broadcast-display-config')).statusCode).toBe(503);
    expect(await readFile(join(camera.directory, 'presets.json'), 'utf8')).toBe(oldState);
    await expect(stat(join(root, 'broadcast-config.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
