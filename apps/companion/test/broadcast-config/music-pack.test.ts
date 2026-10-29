import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { createLocalWebOriginPolicy } from '../../src/local-web/origin-policy.js';
import { registerMusicPackRoutes } from '../../src/broadcast-config/music-pack-routes.js';
import { defaultMusicConfig } from '@mizar/protocol/music';
import { emptyOrchestrationPreset } from '@mizar/protocol/orchestration';
import { readPackArchive } from '@mizar/broadcast-pack';
import { HudConfigStore } from '../../src/hud-config/store.js';
import { MusicStore } from '../../src/music/store.js';
import { portableMusicConfig } from '../../src/broadcast-config/music-assets.js';
import { migrateLegacyBroadcast } from '../../src/broadcast-config/migrate.js';
import { BroadcastConfigStore } from '../../src/broadcast-config/store.js';
import { exportMusicPack, importMusicPack } from '../../src/broadcast-config/music-pack.js';
import { MusicPackResources } from '../../src/broadcast-config/music-pack-resources.js';
import { createProductionBroadcastDependencies } from '../../src/broadcast-config/production.js';

it('round trips real music owner configuration to independent drafts without activation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'music-pack-'));
  try {
    const music = new MusicStore(join(root, 'music'));
    await music.load();
    const track = await music.add('opening.wav', Buffer.from('RIFF0000WAVEtest'));
    const config = defaultMusicConfig();
    config.groups.waiting.tracks = [
      { ...track, entryId: randomUUID(), startMs: 0, endMs: 100, gain: 0.3 },
      { ...track, entryId: randomUUID(), startMs: 100, endMs: 200, gain: 0.8 },
    ];
    await music.configure(config);
    const id = randomUUID(),
      camera = emptyOrchestrationPreset();
    const initial = await migrateLegacyBroadcast({
      hud: new HudConfigStore().getState(),
      music: music.state.config,
      musicRevision: music.state.configRevision,
      camera: {
        activePresetId: id,
        presets: [{ id, preset: camera }],
        active: camera,
        automaticEnabled: false,
      },
      musicConfig: (value) => portableMusicConfig(music, value, true),
      cameraConfig: (value, automaticEnabled) =>
        Promise.resolve({
          format: 'mizar.camera-config',
          version: 2,
          name: value.name,
          automaticEnabled,
          maps: [],
        }),
      lock: () => Promise.resolve({ resources: [], tools: [] }),
    });
    const musicModule = initial.modules.find((item) => item.kind === 'music');
    if (!musicModule || musicModule.kind !== 'music') throw new Error('missing music');
    const store = new BroadcastConfigStore({
      filePath: join(root, 'config.json'),
      createInitial: () => Promise.resolve(initial),
      resolver: {
        resolve: () =>
          Promise.resolve({ resolved: initial.active.resolved, lock: initial.active.lock }),
      },
      withReferenceGuard: (operation) => operation(),
      assertReferenceCommitAllowed: () => Promise.resolve(),
      verifyLegacyActive: () => Promise.resolve(),
      withApplyGuard: (operation) => operation(() => true),
    });
    await store.load();
    const packageId = randomUUID();
    const zip = await exportMusicPack(music, musicModule, {
      packageId,
      version: '1.0.0',
      name: 'Music',
      author: 'Test',
    });
    const archive = await readPackArchive(zip);
    expect(archive.manifest.files).toHaveLength(2);
    const resources = new MusicPackResources(join(root, 'packages'));
    const blocked = join(root, 'blocked');
    await writeFile(blocked, 'not a directory');
    const before = store.snapshot.active;
    await expect(
      importMusicPack({ zip, store, resources: new MusicPackResources(join(blocked, 'packages')) }),
    ).rejects.toThrow();
    expect(store.snapshot).toEqual(initial);
    const first = await importMusicPack({ zip, store, resources });
    const second = await importMusicPack({ zip, store, resources });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.mapping).toEqual(first.mapping);
    expect(store.snapshot.active).toEqual(before);
    const imported = store.snapshot.modules.find(
      (item) => item.id === first.mapping.moduleEntries.music![0],
    );
    if (!imported || imported.kind !== 'music') throw new Error('missing imported module');
    expect(
      imported.value.groups.waiting.tracks.map((item) => [
        item.name,
        item.startMs,
        item.endMs,
        item.gain,
      ]),
    ).toEqual([
      ['opening.wav', 0, 100, 0.3],
      ['opening.wav', 100, 200, 0.8],
    ]);
    const app = Fastify();
    registerMusicPackRoutes(
      app,
      store,
      music,
      resources,
      createLocalWebOriginPolicy({ host: '127.0.0.1' }),
      () => true,
    );
    try {
      const payload = { moduleId: musicModule.id, expectedRevision: musicModule.revision };
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/operator/resource-library/export-music-pack',
            headers: { origin: 'https://untrusted.example' },
            payload,
          })
        ).statusCode,
      ).toBe(403);
      const exported = await app.inject({
        method: 'POST',
        url: '/operator/resource-library/export-music-pack',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload,
      });
      expect(exported.statusCode).toBe(200);
      const importedHttp = await app.inject({
        method: 'POST',
        url: '/operator/resource-library/import-music-pack',
        headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/x-mizarpack' },
        payload: exported.rawPayload,
      });
      expect(importedHttp.statusCode).toBe(200);
      expect(store.snapshot.active).toEqual(before);
    } finally {
      await app.close();
    }
    const ref = imported.value.groups.waiting.tracks[0]!.asset;
    const reopened = new MusicPackResources(join(root, 'packages'));
    expect((await reopened.read(ref)).bytes).toEqual(Buffer.from('RIFF0000WAVEtest'));
    expect(await reopened.materialize(ref, music)).toBe(track.id);
    const dependencies = createProductionBroadcastDependencies(
      root,
      music,
      () => Promise.reject(new Error('unexpected')),
      reopened,
    );
    await dependencies.resolve.asset(ref);
    expect(await dependencies.localTrackId(ref)).toBe(track.id);
    const resolved = { ...before.resolved, music: imported.value };
    const lock = await dependencies.lockForActive(resolved);
    await dependencies.verifyActive({ ...before, resolved, lock });
    const conflicting = await exportMusicPack(music, musicModule, {
      packageId,
      version: '1.0.0',
      name: 'Changed',
      author: 'Test',
    });
    await expect(importMusicPack({ zip: conflicting, store, resources })).rejects.toThrow(
      'identity_conflict',
    );
    expect((await reopened.read(ref)).bytes).toEqual(Buffer.from('RIFF0000WAVEtest'));
    const file = `${createHash('sha256')
      .update(JSON.stringify([ref.resource.id, ref.resource.version]))
      .digest('hex')}.mizarpack`;
    await writeFile(join(root, 'packages', file), 'corrupt');
    await expect(reopened.read(ref)).rejects.toThrow();
    expect(imported.value.groups.waiting.tracks[0]!.asset).toEqual(
      imported.value.groups.waiting.tracks[1]!.asset,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
