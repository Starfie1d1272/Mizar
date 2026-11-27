import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareRelease } from './release-prepare.mjs';
import { readAppVersion } from './app-version.mjs';

async function setupRepo(t, { changelog, currentVersion = '1.13.5' }) {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-release-prepare-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'apps/desktop/src-tauri'), { recursive: true });
  await mkdir(join(dir, 'apps/desktop/installer'), { recursive: true });
  await mkdir(join(dir, 'scripts/qualification'), { recursive: true });
  await writeFile(join(dir, 'CHANGELOG.md'), changelog);
  await writeFile(
    join(dir, 'apps/desktop/src-tauri/Cargo.toml'),
    `[package]\nname = "mizar-desktop"\nversion = "${currentVersion}"\n\n[dependencies]\nserde = "1.0.229"\n`,
  );
  await writeFile(
    join(dir, 'apps/desktop/installer/Cargo.toml'),
    `[workspace]\nmembers = ["common", "launcher", "applier"]\n\n[workspace.package]\nversion = "${currentVersion}"\n`,
  );
  await writeFile(
    join(dir, 'apps/desktop/src-tauri/tauri.conf.json'),
    `{\n  "productName": "Mizar",\n  "version": "${currentVersion}"\n}\n`,
  );
  await writeFile(
    join(dir, 'apps/desktop/src-tauri/Cargo.lock'),
    `[[package]]\nname = "mizar-desktop"\nversion = "${currentVersion}"\n\n[[package]]\nname = "serde"\nversion = "1.0.229"\n`,
  );
  await writeFile(
    join(dir, 'apps/desktop/installer/Cargo.lock'),
    `[[package]]\nname = "mizar-applier"\nversion = "${currentVersion}"\n\n[[package]]\nname = "mizar-common"\nversion = "${currentVersion}"\n\n[[package]]\nname = "mizar-launcher"\nversion = "${currentVersion}"\n\n[[package]]\nname = "serde"\nversion = "1.0.229"\n`,
  );
  await writeFile(
    join(dir, 'scripts/qualification/update-release.json'),
    `{\n  "version": "1.13.5",\n  "minimumVersion": "1.12.0",\n  "maximumVersionExclusive": "2.0.0"\n}\n`,
  );
  return dir;
}

test('prepareRelease fails before modifying files when CHANGELOG lacks target and Unreleased', async (t) => {
  const dir = await setupRepo(t, {
    changelog: '# Mizar 更新日志\n\n## [1.13.5]\n\n### 体验改进\n\n- 已有更新。\n',
  });
  await assert.rejects(prepareRelease('1.14.0', { root: dir, log: () => {} }), /先编写更新日志/);
  const cargo = await readFile(join(dir, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8');
  assert.match(cargo, /version = "1.13.5"/);
});

test('prepareRelease promotes Unreleased for prerelease without changing update-release.json', async (t) => {
  const dir = await setupRepo(t, {
    changelog:
      '# Mizar 更新日志\n\n## [Unreleased]\n\n### 新增功能\n\n- 候选版本测试特性。\n\n## [1.13.5]\n\n### 体验改进\n\n- 旧版本。\n',
  });
  const dry = await prepareRelease('1.14.0-rc.1', { root: dir, dryRun: true, log: () => {} });
  assert.equal(dry.dryRun, true);
  assert.ok(!dry.changedPaths.includes('scripts/qualification/update-release.json'));
  assert.match(
    await readFile(join(dir, 'apps/desktop/src-tauri/Cargo.toml'), 'utf8'),
    /version = "1.13.5"/,
  );

  const res = await prepareRelease('1.14.0-rc.1', { root: dir, log: () => {} });
  assert.equal(res.promoted, true);
  assert.equal(await readAppVersion(pathToFileURL(`${dir}/`)), '1.14.0-rc.1');
  const changelog = await readFile(join(dir, 'CHANGELOG.md'), 'utf8');
  assert.match(changelog, /^## \[Unreleased\]\n\n## \[1\.14\.0-rc\.1\]/m);
  const policy = JSON.parse(
    await readFile(join(dir, 'scripts/qualification/update-release.json'), 'utf8'),
  );
  assert.equal(policy.version, '1.13.5');
});

test('prepareRelease updates all files including update-release.json and warns when RC exists', async (t) => {
  const dir = await setupRepo(t, {
    changelog:
      '# Mizar 更新日志\n\n## [Unreleased]\n\n### 体验改进\n\n- 正式版汇总。\n\n## [1.14.0-rc.1]\n\n### 新增功能\n\n- RC 改动。\n',
  });
  const logs = [];
  await prepareRelease('1.14.0', { root: dir, log: (msg) => logs.push(msg) });
  assert.ok(logs.some((line) => line.includes('预发布章节')));
  const policy = JSON.parse(
    await readFile(join(dir, 'scripts/qualification/update-release.json'), 'utf8'),
  );
  assert.equal(policy.version, '1.14.0');
  assert.equal(policy.minimumVersion, '1.12.0');
  const installerLock = await readFile(join(dir, 'apps/desktop/installer/Cargo.lock'), 'utf8');
  assert.match(installerLock, /name = "mizar-applier"\nversion = "1\.14\.0"/);
  assert.match(installerLock, /name = "serde"\nversion = "1\.0\.229"/);
});
