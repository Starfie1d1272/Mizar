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
  expect(await restarted.listPreparedReleases()).toEqual([
    {
      preparedId: prepared.preparedId,
      tag: release.tag,
      archiveSha256: release.sha256,
      state: 'available',
    },
  ]);
  const staged = await restarted.stageSelection(prepared.preparedId, 'D:\\Steam\\cs2.exe', false);
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
  expect(
    await readFile(
      join(data, current.directory, 'MulNX/CS2Injector/CS2BootLoader/Config/config.yaml'),
      'utf8',
    ),
  ).toContain('D:\\\\Steam');
  const source = await restarted.cameraSource(current.packs[0]!.name);
  expect(source).toMatchObject({
    sourceName: 'Source',
    converterVersion: 1,
    acquisition: { kind: 'upstream', release: { archiveSha256: release.sha256 } },
  });
  expect(source.treeSha256).toMatch(/^[a-f0-9]{64}$/);
  await writeFile(
    join(data, current.directory, 'MulNX/CS2OBTool/CameraSystem/CamPacks/Source/Source.yaml'),
    'changed',
  );
  await expect(restarted.cameraSource(current.packs[0]!.name)).rejects.toThrow(
    'mulnx_source_changed',
  );
  await writeFile(join(data, prepared.preparedId, 'MulNX.7z'), 'bad');
  expect(await restarted.listPreparedReleases()).toEqual([
    { preparedId: prepared.preparedId, tag: null, archiveSha256: null, state: 'damaged' },
  ]);
  await expect(restarted.selectRelease(prepared.preparedId, 'D:\\Steam\\cs2.exe')).rejects.toThrow(
    'mulnx_prepared_integrity',
  );
  expect(JSON.parse(await readFile(join(data, 'current.json'), 'utf8')) as unknown).toEqual(
    current,
  );
});
