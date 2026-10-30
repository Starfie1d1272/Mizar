import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ source: 'source' }));
const release = {
  id: 1,
  assetId: 2,
  tag: 'BetaFixture',
  publishedAt: '2026-10-23',
  url: 'https://github.com/Co1Swet/MulNX_CS2/releases/download/BetaFixture/MulNX.7z',
  size: 1,
  sha256: 'a'.repeat(64),
};
vi.mock('../src/orchestration/tool-release.js', () => ({
  SEVEN_ZIP: { sha256: 'extractor' },
  latestMulnxRelease: () => Promise.resolve(release),
  fileSha256: (path: string) =>
    Promise.resolve(path.endsWith('7zr.exe') ? 'extractor' : release.sha256),
  downloadVerified: async (_url: string, path: string) => writeFile(path, 'x'),
  upstreamNotice: () => Promise.resolve('notice'),
  extractMulnx: async (_extractor: string, _archive: string, destination: string) => {
    const root = join(destination, 'MulNX');
    await mkdir(join(root, 'Config'), { recursive: true });
    await mkdir(join(root, 'CS2Injector/CS2BootLoader/Config'), { recursive: true });
    await mkdir(join(root, 'CS2OBTool/CameraSystem/CamPacks'), { recursive: true });
    await mkdir(join(root, 'CS2OBTool/CameraSystem/CamPacks/Source/CamMacros'), {
      recursive: true,
    });
    await mkdir(join(root, 'CS2OBTool/CameraSystem/CamPacks/Source/Campaths'));
    await writeFile(
      join(root, 'CS2OBTool/CameraSystem/CamPacks/Source/Source.yaml'),
      fixture.source,
    );
    await writeFile(join(root, 'Config/CS2OBTool_Refl.yaml'), 'UISystem.ifDrawMid: true\n');
    await writeFile(
      join(root, 'Config/CS2Injector_Refl.yaml'),
      'CS2HelperController.injectReshade: true\n',
    );
    await writeFile(join(root, 'CS2Injector/CS2Injector.exe'), 'fixture');
    await writeFile(
      join(root, 'CS2Injector/CS2BootLoader/Config/auto.yaml'),
      'autoLaunch: false\n',
    );
    await writeFile(
      join(root, 'CS2Injector/CS2BootLoader/Config/config.yaml'),
      'path: old\nlaunchOptions: -novid\n',
    );
    return { root };
  },
}));
import { MulnxTool } from '../src/orchestration/tool.js';
import { buildApp } from '../src/app.js';
import { CameraConfigResolver } from '../src/broadcast-config/camera.js';
import { MusicStore } from '../src/music/store.js';
import { OrchestrationStore } from '../src/orchestration/store.js';
import { HudConfigStore } from '../src/hud-config/store.js';
import { createProductionBroadcastDependencies } from '../src/broadcast-config/production.js';
import { prepareLegacyMigration } from '../src/broadcast-config/prepare-migration.js';
import { BroadcastConfigStore } from '../src/broadcast-config/store.js';
import { MusicPackResources } from '../src/broadcast-config/music-pack-resources.js';
import { exportPresetPack, importPresetPack } from '../src/broadcast-config/preset-pack.js';
import { randomUUID } from 'node:crypto';
import { orchestrationPresetSchema } from '@mizar/protocol/orchestration';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('prepares without selecting and publishes a configured instance only after selection succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-mulnx-stages-'));
  roots.push(root);
  const bundle = join(root, 'bundle');
  const data = join(root, 'mulnx');
  await mkdir(bundle);
  await writeFile(join(bundle, '7zr.exe'), 'fixture');
  await writeFile(
    join(bundle, 'release.json'),
    JSON.stringify({ release: { ...release, sha256: 'b'.repeat(64) } }),
  );
  const tool = new MulnxTool(data, bundle);
  await tool.load();
  const prepared = await tool.prepareRelease();
  expect(tool.view().installed).toBeNull();
  await expect(readFile(join(data, 'current.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  const restarted = new MulnxTool(data, bundle);
  await restarted.load();
  expect(await restarted.listPreparedReleases()).toEqual([
    {
      preparedId: prepared.preparedId,
      tag: release.tag,
      archiveSha256: release.sha256,
      state: 'available',
    },
  ]);
  const staged = await restarted.stageSelection(prepared.preparedId);
  expect(restarted.view().installed).toBeNull();
  await expect(restarted.commitSelection('wrong')).rejects.toThrow('mulnx_selection_changed');
  expect(restarted.view().installed).toBeNull();
  await expect(restarted.commitSelection(staged.id)).resolves.toEqual({ version: release.tag });
  await expect(restarted.commitSelection(staged.id)).rejects.toThrow('mulnx_selection_changed');
  expect(restarted.view().installed).toBe(release.tag);
  const current = JSON.parse(await readFile(join(data, 'current.json'), 'utf8')) as {
    directory: string;
    packs: { name: string }[];
  };
  const launcherConfig = join(
    data,
    current.directory,
    'MulNX/CS2Injector/CS2BootLoader/Config/config.yaml',
  );
  expect(await readFile(launcherConfig, 'utf8')).toContain('path: old');
  await restarted.prepare('D:\\Steam\\cs2.exe', true);
  expect(await readFile(launcherConfig, 'utf8')).toContain('D:\\\\Steam');
  expect(await readFile(launcherConfig, 'utf8')).toContain('-condebug');
  const source = await restarted.cameraSource(current.packs[0]!.name);
  expect(source).toMatchObject({
    sourceName: 'Source',
    converterVersion: 1,
    acquisition: { kind: 'upstream', release: { archiveSha256: release.sha256 } },
  });
  expect(source.treeSha256).toMatch(/^[a-f0-9]{64}$/);
  // Old current.json records have no content hash. Rebuild it from the verified local archive.
  const originalReceipt = await readFile(join(data, 'current.json'), 'utf8');
  const legacyReceipt = JSON.parse(originalReceipt) as { packs: { treeSha256?: string }[] };
  delete legacyReceipt.packs[0]!.treeSha256;
  await writeFile(join(data, 'current.json'), JSON.stringify(legacyReceipt));
  // A broken bundled copy and an invalid earlier receipt must not mask the valid prepared copy.
  await writeFile(join(bundle, 'release.json'), JSON.stringify({ release }));
  await writeFile(join(bundle, 'MulNX.7z'), 'bad');
  const invalid = join(data, `prepared-${release.sha256}-00000000-0000-4000-8000-000000000000`);
  await mkdir(invalid);
  await writeFile(join(invalid, 'receipt.json'), '{invalid');
  const legacy = new MulnxTool(data, bundle);
  await legacy.load();
  const legacyResolver = new CameraConfigResolver(legacy, {} as MusicStore, () =>
    Promise.resolve(true),
  );
  expect(await legacy.cameraSource(current.packs[0]!.name)).toEqual(source);
  await expect(legacyResolver.camera(source)).resolves.toEqual(source.acquisition);
  await expect(legacyResolver.localPack(source)).resolves.toBe(current.packs[0]!.name);
  expect(await readFile(join(data, 'current.json'), 'utf8')).toBe(JSON.stringify(legacyReceipt));
  await writeFile(join(data, 'current.json'), originalReceipt);
  const resolver = new CameraConfigResolver(restarted, {} as MusicStore, () =>
    Promise.resolve(true),
  );
  const preset = orchestrationPresetSchema.parse({
    format: 'mizar.orchestration',
    version: 1,
    name: 'Camera',
    maps: [{ map: 'de_dust2', pack: current.packs[0]!.name }],
  });
  const musicStore = new MusicStore(join(root, 'music'));
  await musicStore.load();
  const sound = await musicStore.add('opening.wav', Buffer.from('RIFF0000WAVEtest'));
  const soundPreset = orchestrationPresetSchema.parse({
    ...preset,
    maps: [{ ...preset.maps[0], openingSound: sound }],
  });
  const cameraStore = new OrchestrationStore(join(root, 'orchestration'));
  await cameraStore.load();
  await cameraStore.save(soundPreset);
  const productionResolver = new CameraConfigResolver(restarted, musicStore, () =>
    Promise.resolve(true),
  );
  const dependencies = createProductionBroadcastDependencies(
    root,
    musicStore,
    () => Promise.reject(new Error('unexpected_asset')),
    undefined,
    productionResolver,
  );
  const migrated = await prepareLegacyMigration({
    hud: new HudConfigStore().getState(),
    music: musicStore,
    camera: cameraStore,
    musicAutomaticEnabled: true,
    cameraConfig: (preset, enabled) => dependencies.camera.portable(preset, enabled),
    lock: (resolved) => dependencies.lockForActive(resolved),
  });
  expect(migrated.state).toBe('ready');
  if (migrated.state !== 'ready') throw new Error('migration failed');
  const active = migrated.document.active;
  expect(active.lock.tools).toEqual([source.acquisition]);
  expect(active.lock.resources).toContainEqual(
    active.resolved.camera!.maps[0]!.openingSound!.asset.resource,
  );
  expect(await dependencies.camera.localPack(source)).toBe(current.packs[0]!.name);
  expect(await dependencies.resolve.camera(source)).toEqual(source.acquisition);
  await expect(dependencies.verifyActive(active)).resolves.toBeUndefined();
  // Share the verified local source and standalone sound, then resolve the imported source.
  const shareResources = new MusicPackResources(join(root, 'share-packages'));
  const shareStore = new BroadcastConfigStore({
    filePath: join(root, 'share-config.json'),
    createInitial: () => Promise.resolve(migrated.document),
    resolver: { resolve: () => Promise.resolve({ resolved: active.resolved, lock: active.lock }) },
    withReferenceGuard: (operation) => operation(),
    assertReferenceCommitAllowed: () => Promise.resolve(),
    verifyLegacyActive: () => Promise.resolve(),
    withApplyGuard: (operation) => operation(() => true),
  });
  await shareStore.load();
  const zip = await exportPresetPack({
    document: migrated.document,
    presetId: migrated.document.presets[0]!.id,
    music: musicStore,
    resources: shareResources,
    metadata: { packageId: randomUUID(), version: '1.0.0', name: 'Camera', author: '' },
  });
  const imported = await importPresetPack({ zip, store: shareStore, resources: shareResources });
  const importedPreset = shareStore.snapshot.presets.find(
    (item) => item.id === imported.mapping.presetEntries.main,
  );
  const cameraBinding = importedPreset?.bindings.find((binding) => binding.kind === 'camera');
  if (!cameraBinding || cameraBinding.mode !== 'use') throw new Error('missing camera binding');
  const camera = shareStore.snapshot.modules.find((item) => item.id === cameraBinding.moduleId);
  if (!camera || camera.kind !== 'camera') throw new Error('missing imported camera');
  expect(camera.value.maps[0]!.source).toEqual(source);
  expect(await productionResolver.localPack(camera.value.maps[0]!.source)).toBe(
    current.packs[0]!.name,
  );
  expect((await shareResources.read(camera.value.maps[0]!.openingSound!.asset)).bytes).toEqual(
    Buffer.from('RIFF0000WAVEtest'),
  );
  expect(shareStore.snapshot.active).toEqual(active);
  // The old lock is historical; a compatible selected release can have the same source bytes.
  const olderTool = {
    ...source.acquisition,
    release: { ...source.acquisition.release, releaseId: 99, tag: 'older' },
  };
  await expect(
    dependencies.verifyActive({ ...active, lock: { ...active.lock, tools: [olderTool] } }),
  ).resolves.toBeUndefined();
  await expect(
    dependencies.verifyActive({ ...active, lock: { ...active.lock, tools: [] } }),
  ).rejects.toThrow('dependency_missing');
  // Exercise actual app assembly and legacy migration with no running game or gateway.
  await writeFile(join(data, 'current.json'), JSON.stringify(legacyReceipt));
  const hud = new HudConfigStore();
  await hud.load();
  await writeFile(
    join(bundle, 'release.json'),
    JSON.stringify({ release: { ...release, sha256: 'b'.repeat(64) } }),
  );
  const app = buildApp({
    obsConfigPath: join(root, 'obs.json'),
    hudConfigStore: hud,
    mulnxBundle: bundle,
    productRuntime: {
      artifactSha256: 'a'.repeat(64),
      gitSha: 'b'.repeat(40),
      instanceId: 'fixture',
      controlToken: 'c'.repeat(64),
      stop: () => {},
    },
  });
  try {
    const status = await app.inject('/local/v1/broadcast-config/migration');
    expect(status.json<unknown>()).toEqual({ state: 'ready' });
    const listing = await app.inject('/local/v1/broadcast-presets');
    expect(listing.statusCode).toBe(200);
    expect(listing.json<unknown>()).toMatchObject({
      active: {
        resolved: {
          camera: {
            maps: [
              { source: { treeSha256: source.treeSha256 }, openingSound: { name: 'opening.wav' } },
            ],
          },
        },
      },
    });
    const headers = { 'x-runtime-token': 'c'.repeat(64) };
    const switchRelease = async (contents: string) => {
      fixture.source = contents;
      const downloaded = await app.inject({
        method: 'POST',
        url: '/operator/runtime/mulnx-prepare-release',
        headers,
        payload: {},
      });
      expect(downloaded.statusCode).toBe(200);
      const preparedId = downloaded.json<{ preparedId: string }>().preparedId;
      const staged = await app.inject({
        method: 'POST',
        url: '/operator/runtime/mulnx-select',
        headers,
        payload: {
          action: 'stage',
          preparedId,
        },
      });
      expect(staged.statusCode).toBe(200);
      const committed = await app.inject({
        method: 'POST',
        url: '/operator/runtime/mulnx-select',
        headers,
        payload: { action: 'commit', id: staged.json<{ id: string }>().id },
      });
      expect(committed.statusCode).toBe(200);
      return committed.json<{ cameraReady: boolean }>().cameraReady;
    };
    expect(await switchRelease('different source')).toBe(false);
    expect((await app.inject('/local/v1/broadcast-presets')).json<unknown>()).toMatchObject({
      active: {
        resolved: { camera: { maps: [{ source: { treeSha256: source.treeSha256 } }] } },
      },
    });
    expect(await switchRelease('source')).toBe(true);
  } finally {
    await app.close();
    await writeFile(join(data, 'current.json'), originalReceipt);
  }
  const config = await resolver.cameraConfig(preset, true);
  expect(config).toMatchObject({
    format: 'mizar.camera-config',
    version: 2,
    automaticEnabled: true,
    maps: [{ source, openingSound: null }],
  });
  const fromOlderRelease = {
    ...source,
    acquisition: {
      kind: 'upstream' as const,
      release: { ...source.acquisition.release, tag: 'Older', releaseId: 44 },
    },
  };
  await expect(resolver.camera(fromOlderRelease)).resolves.toEqual(source.acquisition);
  await expect(resolver.localPack(fromOlderRelease)).resolves.toBe(current.packs[0]!.name);
  await expect(resolver.localPack({ ...source, treeSha256: 'b'.repeat(64) })).rejects.toThrow(
    'mulnx_source_unavailable',
  );
  await expect(resolver.camera({ ...source, treeSha256: 'b'.repeat(64) })).rejects.toThrow(
    'mulnx_source_unavailable',
  );
  const unsupported = new CameraConfigResolver(restarted, {} as MusicStore, () =>
    Promise.resolve(false),
  );
  await expect(unsupported.camera(source)).rejects.toThrow('mulnx_capability_unavailable');
  const isolated = join(
    data,
    current.directory,
    'MulNX/CS2OBTool/CameraSystem/CamPacks',
    current.packs[0]!.name,
    'Campaths',
    'extra',
  );
  await writeFile(isolated, 'changed');
  await expect(resolver.camera(source)).rejects.toThrow('mulnx_source_unverified');
  await expect(resolver.localPack(source)).rejects.toThrow('mulnx_source_unverified');
  await rm(isolated);

  await writeFile(
    join(data, current.directory, 'MulNX/CS2OBTool/CameraSystem/CamPacks/Source/Source.yaml'),
    'changed',
  );
  await expect(restarted.cameraSource(current.packs[0]!.name)).rejects.toThrow(
    'mulnx_source_changed',
  );
  await expect(legacy.cameraSource(current.packs[0]!.name)).rejects.toThrow('mulnx_source_changed');
  await writeFile(join(data, prepared.preparedId, 'MulNX.7z'), 'bad');
  await expect(legacy.cameraSource(current.packs[0]!.name)).rejects.toThrow('mulnx_source_changed');
  expect(await restarted.listPreparedReleases()).toEqual(
    expect.arrayContaining([
      {
        preparedId: `prepared-${release.sha256}-00000000-0000-4000-8000-000000000000`,
        tag: null,
        archiveSha256: null,
        state: 'damaged',
      },
      { preparedId: prepared.preparedId, tag: null, archiveSha256: null, state: 'damaged' },
    ]),
  );
  await expect(restarted.selectRelease(prepared.preparedId)).rejects.toThrow(
    'mulnx_prepared_integrity',
  );
  expect(JSON.parse(await readFile(join(data, 'current.json'), 'utf8')) as unknown).toEqual(
    current,
  );
  // Identical local pack names must not hide different source contents after a version switch.
  await writeFile(
    join(bundle, 'release.json'),
    JSON.stringify({ release: { ...release, sha256: 'b'.repeat(64) } }),
  );
  fixture.source = 'different source';
  const changedRelease = await restarted.prepareRelease();
  await restarted.selectRelease(changedRelease.preparedId);
  expect(restarted.view().packs[0]!.name).toBe(current.packs[0]!.name);
  await expect(resolver.localPack(source)).rejects.toThrow('mulnx_source_unavailable');
  fixture.source = 'source';
  const compatibleRelease = await restarted.prepareRelease();
  await restarted.selectRelease(compatibleRelease.preparedId);
  await expect(resolver.localPack(source)).resolves.toBe(current.packs[0]!.name);
});
