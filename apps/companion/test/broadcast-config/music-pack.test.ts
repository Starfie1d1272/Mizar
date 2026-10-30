import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { createLocalWebOriginPolicy } from '../../src/local-web/origin-policy.js';
import { registerMusicPackRoutes } from '../../src/broadcast-config/music-pack-routes.js';
import { defaultMusicConfig } from '@mizar/protocol/music';
import { cameraMapSchema, emptyOrchestrationPreset } from '@mizar/protocol/orchestration';
import { readPackArchive, writePackArchive } from '@mizar/broadcast-pack';
import { HudConfigStore } from '../../src/hud-config/store.js';
import { MusicStore } from '../../src/music/store.js';
import {
  portableMusicConfig,
  portableMusicTrack,
} from '../../src/broadcast-config/music-assets.js';
import { migrateLegacyBroadcast } from '../../src/broadcast-config/migrate.js';
import { BroadcastConfigStore } from '../../src/broadcast-config/store.js';
import type { ModuleRecord } from '@mizar/broadcast-config';
import { MusicPackResources } from '../../src/broadcast-config/music-pack-resources.js';
import {
  exportPresetPack,
  importPresetPack,
  inspectPresetPack,
} from '../../src/broadcast-config/preset-pack.js';
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
    const resources = new MusicPackResources(join(root, 'packages'));
    const historic = structuredClone(store.snapshot);
    const historicHud = historic.modules.find((module) => module.kind === 'hud');
    if (!historicHud || historicHud.kind !== 'hud' || !('preset' in historicHud.value))
      throw new Error('missing native HUD');
    historicHud.value.overlays.pause.visual = 'future-unsupported';
    const futureHudZip = await exportPresetPack({
      document: historic,
      moduleIds: [historicHud.id],
      music,
      resources,
      metadata: { packageId: randomUUID(), version: '1.0.0', name: 'Future HUD', author: 'Test' },
    });
    const inspectedFutureHud = await inspectPresetPack({ zip: futureHudZip, store });
    expect(inspectedFutureHud.entries[0]).toMatchObject({
      status: 'unsupported',
      reason: 'capability_unsupported',
    });
    const beforeInvalidImport = store.snapshot;
    await expect(importPresetPack({ zip: futureHudZip, store, resources })).rejects.toThrow(
      'capability_unsupported',
    );
    expect(store.snapshot).toEqual(beforeInvalidImport);
    expect(store.inspectImport(inspectedFutureHud.source)).toBeNull();
    const exportMusic = (
      module: ModuleRecord,
      metadata: { packageId: string; version: string; name: string; author: string },
    ) =>
      exportPresetPack({
        document: store.snapshot,
        moduleIds: [module.id],
        music,
        resources,
        metadata,
      });
    const packageId = randomUUID();
    const zip = await exportMusic(musicModule, {
      packageId,
      version: '1.0.0',
      name: 'Music',
      author: 'Test',
    });
    const archive = await readPackArchive(zip);
    expect(archive.manifest.files).toHaveLength(2);
    const blocked = join(root, 'blocked');
    await writeFile(blocked, 'not a directory');
    const before = store.snapshot.active;
    await expect(
      importPresetPack({
        zip,
        store,
        resources: new MusicPackResources(join(blocked, 'packages')),
      }),
    ).rejects.toThrow();
    expect(store.snapshot).toEqual(initial);
    const first = await importPresetPack({ zip, store, resources });
    const second = await importPresetPack({ zip, store, resources });
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(second.mapping).toEqual(first.mapping);
    expect(store.snapshot.active).toEqual(before);
    const imported = store.snapshot.modules.find(
      (item) => item.id === first.mapping.moduleEntries['module-1']![0],
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
      const payload = {
        modules: [{ moduleId: musicModule.id, expectedRevision: musicModule.revision }],
        presets: [],
      };
      const forbidden = await app.inject({
        method: 'POST',
        url: '/operator/resource-library/export-pack',
        headers: { origin: 'https://untrusted.example' },
        payload,
      });
      expect(forbidden.statusCode).toBe(403);
      const exported = await app.inject({
        method: 'POST',
        url: '/operator/resource-library/export-pack',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload,
      });
      expect(exported.statusCode).toBe(200);
      const result = await app.inject({
        method: 'POST',
        url: '/operator/resource-library/import-pack',
        headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/x-mizarpack' },
        payload: exported.rawPayload,
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().entries[0].targetId).toBe(
        result.json().mapping.moduleEntries['module-1'][0],
      );
    } finally {
      await app.close();
    }
    const reexported = await exportMusic(imported, {
      packageId: randomUUID(),
      version: '1.0.0',
      name: '再次分享',
      author: '',
    });
    const secondImport = await importPresetPack({ zip: reexported, store, resources });
    const roundTrip = store.snapshot.modules.find(
      (item) => item.id === secondImport.mapping.moduleEntries['module-1']![0],
    );
    if (!roundTrip || roundTrip.kind !== 'music') throw new Error('missing round-trip module');
    expect(
      roundTrip.value.groups.waiting.tracks.map(({ name, startMs, endMs, gain }) => [
        name,
        startMs,
        endMs,
        gain,
      ]),
    ).toEqual([
      ['opening.wav', 0, 100, 0.3],
      ['opening.wav', 100, 200, 0.8],
    ]);
    expect(roundTrip.value.groups.waiting.tracks[0]!.asset).toEqual(
      roundTrip.value.groups.waiting.tracks[1]!.asset,
    );
    const schemeDocument = structuredClone(initial);
    const programModule = schemeDocument.modules.find((item) => item.kind === 'program');
    if (!programModule || programModule.kind !== 'program') throw new Error('missing program');
    const image = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC',
      'base64',
    );
    const imagePath = 'assets/background.png';
    const imageSource = await resources.installAndCommit(
      await writePackArchive(
        Buffer.from(
          JSON.stringify({
            format: 'mizar.pack',
            formatVersion: 1,
            packageId: randomUUID(),
            version: '1.0.0',
            name: 'Image',
            author: '',
            modules: [],
            presets: [],
            dependencies: [],
            requirements: [],
            files: [
              {
                id: 'background',
                path: imagePath,
                mediaType: 'image/png',
                bytes: image.length,
                sha256: createHash('sha256').update(image).digest('hex'),
              },
            ],
          }),
        ),
        new Map([[imagePath, image]]),
      ),
      async (ref) => ref,
    );
    programModule.value.assets['pulse.background'] = {
      resource: imageSource,
      fileId: 'background',
    };
    const opening = await music.add('camera.wav', Buffer.from('RIFF1111WAVEcamera'));
    const cameraModule = schemeDocument.modules.find((item) => item.kind === 'camera');
    if (!cameraModule || cameraModule.kind !== 'camera') throw new Error('missing camera');
    const {
      pack: _pack,
      openingSound: _sound,
      ...map
    } = cameraMapSchema.parse({
      map: 'de_mirage',
      pack: 'local-only',
      opening: { macro: 'intro', maxMs: 6000 },
    });
    void _pack;
    void _sound;
    const source = {
      sourceName: 'Original',
      treeSha256: 'c'.repeat(64),
      converterVersion: 1 as const,
      acquisition: {
        kind: 'upstream' as const,
        release: {
          repository: 'Co1Swet/MulNX_CS2' as const,
          releaseId: 42,
          assetId: 73,
          tag: 'Beta15',
          archiveSha256: 'd'.repeat(64),
        },
      },
    };
    cameraModule.value.maps = [
      { ...map, source, openingSound: await portableMusicTrack(music, opening) },
    ];
    const sharedPreset = {
      ...structuredClone(schemeDocument.presets[0]!),
      id: randomUUID(),
      revision: randomUUID(),
      name: '共享素材方案',
    };
    schemeDocument.presets.push(sharedPreset);
    const presetZip = await exportPresetPack({
      document: schemeDocument,
      presetIds: [initial.presets[0]!.id, sharedPreset.id],
      music,
      resources,
      metadata: { packageId: randomUUID(), version: '1.0.0', name: '完整方案', author: '' },
    });
    const presetArchive = await readPackArchive(presetZip);
    expect(presetArchive.manifest.dependencies).toContainEqual({
      alias: expect.any(String),
      resource: { id: 'upstream:mulnx:42:73', version: 'Beta15', digest: 'd'.repeat(64) },
      delivery: { kind: 'external' },
    });
    expect(
      presetArchive.manifest.files.filter((file) => file.mediaType.startsWith('audio/')),
    ).toHaveLength(2);
    const invalidManifest = structuredClone(presetArchive.manifest);
    const toolDependency = invalidManifest.dependencies.find((item) =>
      item.resource.id.startsWith('upstream:mulnx:'),
    );
    if (!toolDependency) throw new Error('missing tool dependency');
    toolDependency.resource.id = 'upstream:mulnx:42:0';
    const invalidZip = await writePackArchive(
      Buffer.from(JSON.stringify(invalidManifest)),
      presetArchive.files,
    );
    const invalid = await inspectPresetPack({ zip: invalidZip, store });
    expect(invalid.entries.find((entry) => entry.kind === 'camera')?.status).toBe('unsupported');
    expect(invalid.entries.some((entry) => entry.kind === 'hud' && entry.status === 'ready')).toBe(
      true,
    );
    expect(store.snapshot.active).toEqual(before);
    const sharedArchive = await readPackArchive(presetZip);
    expect(sharedArchive.manifest.presets).toHaveLength(2);
    expect(sharedArchive.manifest.modules).toHaveLength(4);
    const presetResult = await importPresetPack({ zip: presetZip, store, resources });
    expect(Object.values(presetResult.mapping.moduleEntries).every((ids) => ids.length === 2)).toBe(
      true,
    );
    const repeated = await importPresetPack({ zip: presetZip, store, resources });
    expect(repeated.reused).toBe(true);
    expect(repeated.mapping).toEqual(presetResult.mapping);
    const importedPreset = store.snapshot.presets.find(
      (item) => item.id === presetResult.mapping.presetEntries.main,
    )!;
    expect(importedPreset.bindings).toHaveLength(4);
    const cameraBinding = importedPreset.bindings.find((item) => item.kind === 'camera');
    if (!cameraBinding || cameraBinding.mode !== 'use') throw new Error('missing camera binding');
    const importedCamera = store.snapshot.modules.find(
      (item) => item.id === cameraBinding.moduleId,
    );
    if (!importedCamera || importedCamera.kind !== 'camera')
      throw new Error('missing camera module');
    expect(importedCamera.value.maps[0]!.source).toEqual(source);
    const sound = importedCamera.value.maps[0]!.openingSound;
    if (!sound) throw new Error('missing opening sound');
    expect((await resources.read(sound.asset)).bytes).toEqual(Buffer.from('RIFF1111WAVEcamera'));
    const reshared = await exportPresetPack({
      document: store.snapshot,
      presetIds: [importedPreset.id],
      music,
      resources,
      metadata: { packageId: randomUUID(), version: '1.0.0', name: '再次分享方案', author: '' },
    });
    const resharedResult = await importPresetPack({ zip: reshared, store, resources });
    const resharedPreset = store.snapshot.presets.find(
      (item) => item.id === resharedResult.mapping.presetEntries.main,
    )!;
    const resharedBinding = resharedPreset.bindings.find((item) => item.kind === 'camera');
    if (!resharedBinding || resharedBinding.mode !== 'use')
      throw new Error('missing camera binding');
    const resharedCamera = store.snapshot.modules.find(
      (item) => item.id === resharedBinding.moduleId,
    );
    if (!resharedCamera || resharedCamera.kind !== 'camera')
      throw new Error('missing reshared camera');
    expect(resharedCamera.value.maps[0]!.source).toEqual(source);
    expect((await resources.read(resharedCamera.value.maps[0]!.openingSound!.asset)).bytes).toEqual(
      Buffer.from('RIFF1111WAVEcamera'),
    );
    const programBinding = importedPreset.bindings.find((item) => item.kind === 'program');
    if (!programBinding || programBinding.mode !== 'use')
      throw new Error('missing program binding');
    const importedProgram = store.snapshot.modules.find(
      (item) => item.id === programBinding.moduleId,
    );
    if (!importedProgram || importedProgram.kind !== 'program')
      throw new Error('missing program module');
    expect(
      (await resources.readAsset(importedProgram.value.assets['pulse.background']!)).bytes,
    ).toEqual(image);
    const filename = `${createHash('sha256')
      .update(JSON.stringify([presetResult.mapping.source.id, presetResult.mapping.source.version]))
      .digest('hex')}.mizarpack`;
    await writeFile(join(root, 'packages', filename), Buffer.from('damaged'));
    const programEntry = sharedArchive.manifest.modules.find(
      (entry) => entry.module === 'program',
    )!.entryId;
    const repaired = await importPresetPack({
      zip: presetZip,
      store,
      resources,
      selection: { modules: [programEntry], presets: [] },
    });
    expect(repaired.reused).toBe(true);
    expect(
      store.snapshot.modules.filter((module) => module.id === importedProgram.id),
    ).toHaveLength(1);
    expect(
      (await resources.readAsset(importedProgram.value.assets['pulse.background']!)).bytes,
    ).toEqual(image);
    const importedMusicId = importedPreset.bindings.find((item) => item.kind === 'music');
    if (!importedMusicId || importedMusicId.mode !== 'use') throw new Error('missing preset music');
    const presetMusic = store.snapshot.modules.find((item) => item.id === importedMusicId.moduleId);
    if (!presetMusic || presetMusic.kind !== 'music')
      throw new Error('missing preset music module');
    expect(presetMusic.id).not.toBe(musicModule.id);
    expect(
      presetMusic.value.groups.waiting.tracks.map((item) => [item.startMs, item.endMs, item.gain]),
    ).toEqual([
      [0, 100, 0.3],
      [100, 200, 0.8],
    ]);
    expect(store.snapshot.active).toEqual(before);
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
    const conflicting = await exportMusic(musicModule, {
      packageId,
      version: '1.0.0',
      name: 'Changed',
      author: 'Test',
    });
    await expect(importPresetPack({ zip: conflicting, store, resources })).rejects.toThrow(
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
