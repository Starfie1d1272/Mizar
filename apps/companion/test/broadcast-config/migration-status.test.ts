import { expect, it } from 'vitest';
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
