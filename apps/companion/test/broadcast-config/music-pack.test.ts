import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import Fastify from 'fastify';
import { createLocalWebOriginPolicy } from '../../src/local-web/origin-policy.js';
import {
  registerBroadcastAssetRoutes,
  registerMusicPackRoutes,
} from '../../src/broadcast-config/music-pack-routes.js';
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
import { exportMusicPack, importMusicPack } from '../../src/broadcast-config/music-pack.js';
import { MusicPackResources } from '../../src/broadcast-config/music-pack-resources.js';
import {
  exportPresetPack,
  importPresetPack,
  inspectPresetPack,
} from '../../src/broadcast-config/preset-pack.js';
import { createProductionBroadcastDependencies } from '../../src/broadcast-config/production.js';

it('reads the exact package version when file IDs coincide', async () => {
  const root = await mkdtemp(join(tmpdir(), 'broadcast-image-identity-'));
  const resources = new MusicPackResources(root);
  const packageId = randomUUID();
  const first = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC',
    'base64',
  );
  const second = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64',
  );
  const pack = (version: string, bytes: Buffer) =>
    writePackArchive(
      Buffer.from(
        JSON.stringify({
          format: 'mizar.pack',
          formatVersion: 1,
          packageId,
          version,
          name: 'Images',
          author: '',
          modules: [],
          presets: [],
          dependencies: [],
          requirements: [],
          files: [
            {
              id: 'background',
              path: 'asset.png',
              mediaType: 'image/png',
              bytes: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
          ],
        }),
      ),
      new Map([['asset.png', bytes]]),
    );
  try {
    const one = await resources.install(await pack('1.0.0', first));
    const two = await resources.install(await pack('2.0.0', second));
    expect((await resources.readAsset({ resource: one, fileId: 'background' })).bytes).toEqual(
      first,
    );
    expect((await resources.readAsset({ resource: two, fileId: 'background' })).bytes).toEqual(
      second,
    );
    await expect(
      resources.readAsset({ resource: { ...one, digest: two.digest }, fileId: 'background' }),
    ).rejects.toThrow('resource_damaged');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
    const packageId = randomUUID();
    const zip = await exportMusicPack(music, resources, musicModule, {
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
      // The same endpoints accept each standalone module without creating a scheme.
      let liveChecked = false;
      for (const module of initial.modules) {
        const exportedModule = await app.inject({
          method: 'POST',
          url: '/operator/resource-library/export-pack',
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: {
            modules: [{ moduleId: module.id, expectedRevision: module.revision }],
            presets: [],
          },
        });
        expect(exportedModule.statusCode).toBe(200);
        const archive = await readPackArchive(exportedModule.rawPayload);
        expect(archive.manifest.modules.map((item) => item.module)).toEqual([module.kind]);
        expect(archive.manifest.presets).toHaveLength(0);
        if (module.kind === 'hud' && !liveChecked) {
          liveChecked = true;
          const manifest = structuredClone(archive.manifest);
          manifest.packageId = randomUUID();
          manifest.modules.push({ ...manifest.modules[0]!, entryId: 'future', module: 'future' });
          const mixed = await writePackArchive(
            Buffer.from(JSON.stringify(manifest)),
            archive.files,
          );
          const headers = {
            origin: 'http://127.0.0.1:3000',
            'content-type': 'application/x-mizarpack',
          };
          const checked = await app.inject({
            method: 'POST',
            url: '/operator/resource-library/check-pack',
            headers,
            payload: mixed,
          });
          expect(checked.statusCode).toBe(200);
          const address = await app.listen({ host: '127.0.0.1', port: 0 });
          const liveCheck = await fetch(`${address}/operator/resource-library/check-pack`, {
            method: 'POST',
            headers,
            body: new Blob([new Uint8Array(mixed)]),
          });
          expect(liveCheck.status).toBe(200);
          expect(((await liveCheck.json()) as { source: { digest: string } }).source.digest).toBe(
            checked.json().source.digest,
          );
          expect(checked.json().entries.map((entry: { status: string }) => entry.status)).toEqual([
            'ready',
            'unsupported',
          ]);
          const selection = JSON.stringify({ modules: ['module-1', 'future'], presets: [] });
          const query = new URLSearchParams({ selection, digest: checked.json().source.digest });
          const partial = await app.inject({
            method: 'POST',
            url: `/operator/resource-library/import-pack?${query}`,
            headers,
            payload: mixed,
          });
          expect(partial.statusCode).toBe(200);
          expect(partial.json().entries.map((entry: { result: string }) => entry.result)).toEqual([
            'imported',
            'unavailable',
          ]);
          const importedId = partial.json().mapping.moduleEntries['module-1'][0] as string;
          const imported = store.snapshot.modules.find((item) => item.id === importedId)!;
          await store.deleteModule(imported.id, imported.revision);
          const removed = await app.inject({
            method: 'POST',
            url: '/operator/resource-library/check-pack',
            headers,
            payload: mixed,
          });
          expect(removed.json().entries[0].status).toBe('removed');
          const restored = await app.inject({
            method: 'POST',
            url: `/operator/resource-library/import-pack?${query}`,
            headers,
            payload: mixed,
          });
          expect(restored.json().entries[0].result).toBe('imported');
          expect(restored.json().mapping.moduleEntries['module-1'][0]).not.toBe(importedId);
          query.set('digest', '0'.repeat(64));
          expect(
            (
              await app.inject({
                method: 'POST',
                url: `/operator/resource-library/import-pack?${query}`,
                headers,
                payload: mixed,
              })
            ).statusCode,
          ).toBe(400);
          expect(
            (
              await app.inject({
                method: 'POST',
                url: '/operator/resource-library/check-pack',
                headers,
                payload: Buffer.from('broken'),
              })
            ).statusCode,
          ).toBe(400);
        }
        const importedModule = await app.inject({
          method: 'POST',
          url: '/operator/resource-library/import-pack',
          headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/x-mizarpack' },
          payload: exportedModule.rawPayload,
        });
        expect(importedModule.statusCode).toBe(200);
        const result = importedModule.json();
        expect(result.reused).toBe(false);
        expect(
          store.snapshot.modules.find(
            (item) => item.id === result.mapping.moduleEntries['module-1'][0],
          )?.kind,
        ).toBe(module.kind);
        const repeatedModule = await app.inject({
          method: 'POST',
          url: '/operator/resource-library/import-pack',
          headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/x-mizarpack' },
          payload: exportedModule.rawPayload,
        });
        expect(repeatedModule.json()).toMatchObject({ mapping: result.mapping, reused: true });
      }
      const originalProgram = initial.modules.find((item) => item.kind === 'program')!;
      const copiedProgram = await store.cloneModule(
        originalProgram.id,
        originalProgram.revision,
        '不可分享图片',
      );
      if (copiedProgram.kind !== 'program') throw new Error('missing program');
      copiedProgram.value.assets['pulse.background'] = {
        resource: { id: 'external:test', version: '1', digest: '0'.repeat(64) },
        fileId: 'image',
      };
      const unsendable = await store.saveModule(copiedProgram, copiedProgram.revision);
      const failedExport = await app.inject({
        method: 'POST',
        url: '/operator/resource-library/export-pack',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: {
          modules: [{ moduleId: unsendable.id, expectedRevision: unsendable.revision }],
          presets: [],
        },
      });
      expect(failedExport.statusCode).toBe(422);
      expect(failedExport.json().entries).toEqual([
        { type: 'module', id: unsendable.id, reason: 'capability_unsupported' },
      ]);
      expect(store.snapshot.active).toEqual(before);
      const originalPreset = initial.presets[0]!;
      const moduleRevisions = Object.fromEntries(
        originalPreset.bindings.flatMap((binding) =>
          binding.mode === 'use'
            ? [
                [
                  binding.kind,
                  initial.modules.find((module) => module.id === binding.moduleId)!.revision,
                ],
              ]
            : [],
        ),
      );
      const presetExport = await app.inject({
        method: 'POST',
        url: '/operator/resource-library/export-preset-pack',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: {
          presetId: originalPreset.id,
          expectedRevision: originalPreset.revision,
          expectedModuleRevisions: moduleRevisions,
        },
      });
      expect(presetExport.statusCode).toBe(200);
      const presetImport = await app.inject({
        method: 'POST',
        url: '/operator/resource-library/import-preset-pack',
        headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/x-mizarpack' },
        payload: presetExport.rawPayload,
      });
      expect(presetImport.statusCode).toBe(200);
      const copyId = await store.clone({
        sourceId: originalPreset.id,
        expectedRevision: originalPreset.revision,
        expectedModuleRevisions: moduleRevisions,
        name: '第二套',
      });
      const copyDocument = store.snapshot;
      const copyPreset = copyDocument.presets.find((item) => item.id === copyId.presetId)!;
      const copyRevisions = Object.fromEntries(
        copyPreset.bindings.flatMap((binding) =>
          binding.mode === 'use'
            ? [
                [
                  binding.kind,
                  copyDocument.modules.find((module) => module.id === binding.moduleId)!.revision,
                ],
              ]
            : [],
        ),
      );
      const bundle = await app.inject({
        method: 'POST',
        url: '/operator/resource-library/export-pack',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: {
          modules: [],
          presets: [
            {
              presetId: originalPreset.id,
              expectedRevision: originalPreset.revision,
              expectedModuleRevisions: moduleRevisions,
            },
            {
              presetId: copyPreset.id,
              expectedRevision: copyPreset.revision,
              expectedModuleRevisions: copyRevisions,
            },
          ],
        },
      });
      const staleBundle = await app.inject({
        method: 'POST',
        url: '/operator/resource-library/export-preset-bundle',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: {
          presets: [
            {
              presetId: originalPreset.id,
              expectedRevision: 'stale',
              expectedModuleRevisions: moduleRevisions,
            },
            {
              presetId: copyPreset.id,
              expectedRevision: copyPreset.revision,
              expectedModuleRevisions: copyRevisions,
            },
          ],
        },
      });
      expect(staleBundle.statusCode).toBe(409);
      expect(bundle.statusCode).toBe(200);
      const bundleContents = await readPackArchive(bundle.rawPayload);
      expect(bundleContents.manifest.presets).toHaveLength(2);
      expect(
        bundleContents.manifest.files.filter((item) => item.mediaType === 'audio/wav'),
      ).toHaveLength(1);
      const bundleImport = await importPresetPack({ zip: bundle.rawPayload, store, resources });
      const firstId = bundleImport.mapping.presetEntries.main!,
        secondId = bundleImport.mapping.presetEntries['preset-2']!;
      const importedSchemes = store.snapshot.presets.filter(
        (item) => item.id === firstId || item.id === secondId,
      );
      expect(importedSchemes).toHaveLength(2);
      expect(importedSchemes[0]!.bindings.find((item) => item.kind === 'music')).not.toEqual(
        importedSchemes[1]!.bindings.find((item) => item.kind === 'music'),
      );
      expect(store.snapshot.active).toEqual(before);
    } finally {
      await app.close();
    }
    const reexported = await exportMusicPack(music, resources, imported, {
      packageId: randomUUID(),
      version: '1.0.0',
      name: '再次分享',
      author: '',
    });
    const secondImport = await importMusicPack({ zip: reexported, store, resources });
    const roundTrip = store.snapshot.modules.find(
      (item) => item.id === secondImport.mapping.moduleEntries.music![0],
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
    const imageSource = await resources.install(
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
      presetId: initial.presets[0]!.id,
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
    const invalidAnalysis = await inspectPresetPack({ zip: invalidZip, store });
    expect(invalidAnalysis.entries.find((entry) => entry.kind === 'camera')?.status).toBe(
      'unsupported',
    );
    expect(invalidAnalysis.entries.find((entry) => entry.type === 'preset')?.status).toBe(
      'dependency_missing',
    );
    expect(
      invalidAnalysis.entries.some((entry) => entry.kind === 'hud' && entry.status === 'ready'),
    ).toBe(true);
    expect(store.snapshot.active).toEqual(before);
    const sharedArchive = await readPackArchive(presetZip);
    expect(sharedArchive.manifest.presets).toHaveLength(2);
    expect(sharedArchive.manifest.modules).toHaveLength(4);
    const presetResult = await importPresetPack({
      zip: presetZip,
      store,
      resources,
      availability: async (module) => {
        if (module.kind === 'camera') throw new Error('camera_identity_unavailable');
      },
    });
    expect(presetResult.entries.find((entry) => entry.kind === 'camera')).toMatchObject({
      status: 'dependency_missing',
      result: 'imported',
    });
    expect(presetResult.entries.find((entry) => entry.type === 'preset')).toMatchObject({
      status: 'dependency_missing',
      result: 'imported',
    });
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
      presetId: importedPreset.id,
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
    const importedImage = importedProgram.value.assets['pulse.background']!;
    expect(importedImage.resource).toEqual(presetResult.mapping.source);
    expect((await resources.readAsset(importedImage)).bytes).toEqual(image);
    const freshPath = join(root, 'fresh-packages');
    await new MusicPackResources(freshPath).install(presetZip);
    const restartedResources = new MusicPackResources(freshPath);
    const assetApp = Fastify();
    registerBroadcastAssetRoutes(assetApp, restartedResources);
    try {
      const address = await assetApp.listen({ host: '127.0.0.1', port: 0 });
      const query = new URLSearchParams({
        resourceId: importedImage.resource.id,
        version: importedImage.resource.version,
        digest: importedImage.resource.digest,
        fileId: importedImage.fileId,
      });
      const response = await fetch(`${address}/local/v1/broadcast-assets?${query}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/png');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await response.arrayBuffer())).toEqual(image);
      query.set('digest', '0'.repeat(64));
      expect((await fetch(`${address}/local/v1/broadcast-assets?${query}`)).status).toBe(422);
      query.set('digest', importedImage.resource.digest);
      const filename = `${createHash('sha256')
        .update(JSON.stringify([importedImage.resource.id, importedImage.resource.version]))
        .digest('hex')}.mizarpack`;
      await writeFile(join(freshPath, filename), Buffer.from('damaged zip'));
      expect((await fetch(`${address}/local/v1/broadcast-assets?${query}`)).status).toBe(422);
    } finally {
      await assetApp.close();
    }
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
    const conflicting = await exportMusicPack(music, resources, musicModule, {
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
