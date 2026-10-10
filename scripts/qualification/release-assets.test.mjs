import { afterEach, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assetInventory, reconcileAssets } from './release-assets.mjs';
let directory;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});
it('resumes a partial upload using existing original bytes, and refuses changed metadata or actual bytes before mutation', async () => {
  directory = await mkdtemp(join(tmpdir(), 'mizar-release-retry-'));
  for (const name of ['original.zip', 'installer.exe'])
    await writeFile(join(directory, name), Buffer.from(name));
  const expected = await assetInventory(
    ['original.zip', 'installer.exe'].map((name) => join(directory, name)),
  );
  const identity = { tag: 'v2.0.0', gitSha: 'a'.repeat(40) };
  const ref = { object: { type: 'commit', sha: identity.gitSha } };
  const metadata = (asset) => ({
    name: asset.name,
    size: asset.size,
    digest: `sha256:${asset.sha256}`,
    browser_download_url: `https://github.com/Starfie1d1272/Mizar/releases/download/v2.0.0/${asset.name}`,
  });
  const release = {
    tag_name: identity.tag,
    draft: true,
    prerelease: false,
    assets: [metadata(expected[0])],
  };
  const readExisting = (name) => readFile(join(directory, name));
  const uploaded = [];
  await expect(
    reconcileAssets(release, ref, identity, expected, readExisting, async (path) => {
      uploaded.push(path);
      throw new Error('upload failed');
    }),
  ).rejects.toThrow('upload failed');
  expect(uploaded).toEqual([expected[1].path]);
  uploaded.length = 0;
  await reconcileAssets(release, ref, identity, expected, readExisting, async (path) => {
    uploaded.push(path);
    release.assets.push(metadata(expected[1]));
  });
  expect(uploaded).toEqual([expected[1].path]);
  uploaded.length = 0;
  await reconcileAssets(release, ref, identity, expected, readExisting, async (path) =>
    uploaded.push(path),
  );
  expect(uploaded).toEqual([]);
  release.assets[0].digest = 'sha256:' + '0'.repeat(64);
  await expect(
    reconcileAssets(release, ref, identity, expected, readExisting, async (path) =>
      uploaded.push(path),
    ),
  ).rejects.toThrow('拒绝覆盖');
  expect(uploaded).toEqual([]);
  release.assets[0] = metadata(expected[0]);
  await writeFile(expected[0].path, 'changed!');
  await expect(
    reconcileAssets(release, ref, identity, expected, readExisting, async (path) =>
      uploaded.push(path),
    ),
  ).rejects.toThrow('实际字节');
  expect(uploaded).toEqual([]);
});
