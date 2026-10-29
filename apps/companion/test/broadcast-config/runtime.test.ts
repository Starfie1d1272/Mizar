import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { HudConfigStore } from '../../src/hud-config/store.js';
import { MusicStore } from '../../src/music/store.js';
import { OrchestrationStore } from '../../src/orchestration/store.js';
import { BroadcastReferenceQueue } from '../../src/broadcast-config/reference-queue.js';
import { createBroadcastRuntime } from '../../src/broadcast-config/runtime.js';

it('leaves legacy owners and files intact if camera source verification cannot finish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'broadcast-runtime-pending-'));
  try {
    const hud = new HudConfigStore();
    await hud.load();
    const music = new MusicStore(join(root, 'music'));
    await music.load();
    const camera = new OrchestrationStore(join(root, 'camera'));
    await camera.load();
    await camera.save({
      format: 'mizar.orchestration',
      version: 1,
      name: 'Current',
      maps: [{ map: 'de_mirage', pack: 'Mizar_test' }],
    });
    const legacy = await readFile(join(camera.directory, 'presets.json'), 'utf8');
    const path = join(root, 'broadcast.json');
    const runtime = createBroadcastRuntime({
      hud,
      music,
      camera,
      withApplyGuard: (operation) => operation(() => true),
      diagnostic: () => {},
      dependencies: {
        path,
        musicAutomaticEnabled: true,
        references: new BroadcastReferenceQueue(),
        isDeleting: () => Promise.resolve(false),
        resolve: {
          asset: () => Promise.resolve(),
          hud: () => Promise.resolve(),
          scene: () => Promise.resolve(),
          camera: () => Promise.reject(new Error('unverified')),
        },
        camera: {
          localPack: () => Promise.reject(new Error('unverified')),
          localTrackId: () => Promise.reject(new Error('unverified')),
          portable: () => Promise.reject(new Error('unverified')),
          lock: (_value, active) => Promise.resolve(active.lock),
        },
        localTrackId: () => Promise.reject(new Error('unverified')),
        lockForActive: () => Promise.resolve({ resources: [], tools: [] }),
        verifyActive: () => Promise.resolve(),
      },
    });
    await runtime.initialize();
    expect(runtime.status).toEqual({ state: 'pending', reason: 'dependency_unavailable' });
    expect(runtime.ready).toBe(false);
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(camera.directory, 'presets.json'), 'utf8')).toBe(legacy);
    await camera.saveAutomaticEnabled(true);
    expect(camera.automaticEnabled).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
