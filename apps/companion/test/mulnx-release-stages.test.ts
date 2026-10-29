import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';

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
  latestMulnxRelease: async () => release,
  fileSha256: async (path: string) => (path.endsWith('7zr.exe') ? 'extractor' : release.sha256),
  downloadVerified: async (_url: string, path: string) => writeFile(path, 'x'),
  upstreamNotice: async () => 'notice',
  extractMulnx: async (_extractor: string, _archive: string, destination: string) => {
    const root = join(destination, 'MulNX');
    await mkdir(join(root, 'Config'), { recursive: true });
    await mkdir(join(root, 'CS2Injector/CS2BootLoader/Config'), { recursive: true });
    await mkdir(join(root, 'CS2OBTool/CameraSystem/CamPacks'), { recursive: true });
    await mkdir(join(root, 'CS2OBTool/CameraSystem/CamPacks/Source/CamMacros'), {
      recursive: true,
    });
    await mkdir(join(root, 'CS2OBTool/CameraSystem/CamPacks/Source/Campaths'));
    await writeFile(join(root, 'CS2OBTool/CameraSystem/CamPacks/Source/Source.yaml'), 'source');
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
import { CameraConfigResolver } from '../src/broadcast-config/camera.js';
import type { MusicStore } from '../src/music/store.js';
import { orchestrationPresetSchema } from '@mizar/protocol/orchestration';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
it('prepares without selecting and publishes a configured instance only after selection succeeds', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-mulnx-stages-'));
  roots.push(root);
  const bundle = join(root, 'bundle');
  const data = join(root, 'data');
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
  await expect(
    restarted.selectRelease(prepared.preparedId, 'D:\\Steam\\cs2.exe'),
  ).resolves.toBeUndefined();
  expect(restarted.view().installed).toBe(release.tag);
  const current = JSON.parse(await readFile(join(data, 'current.json'), 'utf8'));
  expect(
    await readFile(
      join(data, current.directory, 'MulNX/CS2Injector/CS2BootLoader/Config/config.yaml'),
      'utf8',
    ),
  ).toContain('D:\\\\Steam');
  const source = await restarted.cameraSource(current.packs[0].name);
  expect(source).toMatchObject({
    sourceName: 'Source',
    converterVersion: 1,
    acquisition: { kind: 'upstream', release: { archiveSha256: release.sha256 } },
  });
  expect(source.treeSha256).toMatch(/^[a-f0-9]{64}$/);
  const resolver = new CameraConfigResolver(restarted, {} as MusicStore, async () => true);
  const preset = orchestrationPresetSchema.parse({
    format: 'mizar.orchestration',
    version: 1,
    name: 'Camera',
    maps: [{ map: 'de_dust2', pack: current.packs[0].name }],
  });
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
  await expect(resolver.camera({ ...source, treeSha256: 'b'.repeat(64) })).rejects.toThrow(
    'mulnx_source_unavailable',
  );
  const unsupported = new CameraConfigResolver(restarted, {} as MusicStore, async () => false);
  await expect(unsupported.camera(source)).rejects.toThrow('mulnx_capability_unavailable');
  const isolated = join(
    data,
    current.directory,
    'MulNX/CS2OBTool/CameraSystem/CamPacks',
    current.packs[0].name,
    'Campaths',
    'extra',
  );
  await writeFile(isolated, 'changed');
  await expect(resolver.camera(source)).rejects.toThrow('mulnx_source_unavailable');
  await rm(isolated);

  await writeFile(
    join(data, current.directory, 'MulNX/CS2OBTool/CameraSystem/CamPacks/Source/Source.yaml'),
    'changed',
  );
  await expect(restarted.cameraSource(current.packs[0].name)).rejects.toThrow(
    'mulnx_source_changed',
  );
  await writeFile(join(data, prepared.preparedId, 'MulNX.7z'), 'bad');
  await expect(restarted.selectRelease(prepared.preparedId, 'D:\\Steam\\cs2.exe')).rejects.toThrow(
    'mulnx_prepared_integrity',
  );
  expect(JSON.parse(await readFile(join(data, 'current.json'), 'utf8'))).toEqual(current);
});
