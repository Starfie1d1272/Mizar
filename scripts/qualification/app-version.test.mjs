import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAppVersion, validateReleaseTag } from './app-version.mjs';

async function createVersionFixture(
  t,
  { host = '1.14.0', installer = '1.14.0', tauri = '1.14.0', policy = '1.14.0' } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-app-version-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'apps/desktop/src-tauri'), { recursive: true });
  await mkdir(join(dir, 'apps/desktop/installer'), { recursive: true });
  await mkdir(join(dir, 'scripts/qualification'), { recursive: true });
  await writeFile(
    join(dir, 'apps/desktop/src-tauri/Cargo.toml'),
    `[package]\nname = "mizar-desktop"\nversion = "${host}"\n`,
  );
  await writeFile(
    join(dir, 'apps/desktop/installer/Cargo.toml'),
    `[workspace]\nmembers = ["common"]\n\n[workspace.package]\nversion = "${installer}"\n`,
  );
  await writeFile(
    join(dir, 'apps/desktop/src-tauri/tauri.conf.json'),
    JSON.stringify({ productName: 'Mizar', version: tauri }),
  );
  await writeFile(
    join(dir, 'scripts/qualification/update-release.json'),
    JSON.stringify({ version: policy, minimumVersion: '1.12.0', maximumVersionExclusive: '2.0.0' }),
  );
  return pathToFileURL(`${dir}/`);
}

test('readAppVersion validates host, installer, tauri, and stable update policy', async (t) => {
  const root = await createVersionFixture(t);
  assert.equal(await readAppVersion(root), '1.14.0');

  const prereleaseRoot = await createVersionFixture(t, {
    host: '1.14.0-rc.1',
    installer: '1.14.0-rc.1',
    tauri: '1.14.0-rc.1',
    policy: '1.13.5',
  });
  assert.equal(await readAppVersion(prereleaseRoot), '1.14.0-rc.1');
});

test('readAppVersion rejects mismatched installer, tauri, or stable update policy versions', async (t) => {
  const mismatchInstaller = await createVersionFixture(t, { installer: '1.13.9' });
  await assert.rejects(readAppVersion(mismatchInstaller), /Installer/);

  const mismatchTauri = await createVersionFixture(t, { tauri: '1.13.9' });
  await assert.rejects(readAppVersion(mismatchTauri), /Tauri/);

  const mismatchPolicy = await createVersionFixture(t, { policy: '1.13.5' });
  await assert.rejects(readAppVersion(mismatchPolicy), /更新发布配置/);
});

test('validateReleaseTag enforces semver and prerelease format', () => {
  validateReleaseTag('v1.14.0', '1.14.0');
  validateReleaseTag('v1.14.0-rc.1', '1.14.0-rc.1');
  assert.throws(() => validateReleaseTag('1.14.0', '1.14.0'), /发布标签/);
  assert.throws(() => validateReleaseTag('v1.14.0', '1.14.1'), /发布标签/);
});
