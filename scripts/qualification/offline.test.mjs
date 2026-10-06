import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { windowsBundleName } from './app-version.mjs';
import { assertGsiScriptContract, assertPortableApp, findBundleDirectory } from './offline.mjs';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function bundleScripts() {
  const root = await mkdtemp(join(tmpdir(), 'mizar-gsi-bundle-'));
  roots.push(root);
  await cp(join(import.meta.dirname, 'bundle'), root, { recursive: true });
  return root;
}

async function changeScript(root, name, change) {
  const path = join(root, name);
  await writeFile(path, change(await readFile(path, 'utf8')));
}

describe('offline qualification bundle discovery', () => {
  it.each(['1.0.0-rc.13', '1.0.0'])(
    'accepts the canonical bundle and ZIP for %s',
    async (version) => {
      const root = await mkdtemp(join(tmpdir(), 'mizar-offline-bundle-'));
      roots.push(root);
      const bundleName = windowsBundleName(version);
      await mkdir(join(root, bundleName));
      await writeFile(join(root, `${bundleName}.zip`), '');
      await expect(findBundleDirectory(root, version)).resolves.toBe(join(root, bundleName));
    },
  );

  it.each(['missing', 'other-version'])(
    'rejects a %s ZIP instead of accepting another artifact',
    async (archive) => {
      const root = await mkdtemp(join(tmpdir(), 'mizar-offline-bundle-'));
      roots.push(root);
      const version = '1.0.0-rc.13';
      await mkdir(join(root, windowsBundleName(version)));
      if (archive === 'other-version') {
        await writeFile(join(root, `${windowsBundleName('1.0.0-rc.12')}.zip`), '');
      }
      await expect(findBundleDirectory(root, version)).rejects.toThrow(
        '未生成一个 bundle 目录和一个 ZIP',
      );
    },
  );
});

describe('offline qualification portable app', () => {
  it('retains dependency runtime directories and opaque map data', async () => {
    const root = await bundleScripts();
    const dependency = join(root, 'node_modules/dependency/test');
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, 'index.js'), 'module.exports = 1;');
    await writeFile(join(dependency, 'world.map'), 'runtime map data');
    await expect(assertPortableApp(root)).resolves.toBeUndefined();
  });

  it.each([
    'index.d.ts',
    'index.d.mts',
    'index.d.cts',
    'index.js.map',
    'style.css.map',
    'app.tsbuildinfo',
  ])('rejects nested development file %s', async (name) => {
    const root = await bundleScripts();
    const dependency = join(root, 'node_modules/dependency/dist');
    await mkdir(dependency, { recursive: true });
    await writeFile(join(dependency, name), '');
    await expect(assertPortableApp(root)).rejects.toThrow('production 包仍包含开发文件');
  });

  it('rejects directory symlinks that make the app nonportable', async () => {
    const root = await bundleScripts();
    const target = join(root, 'target');
    await mkdir(target);
    await symlink(target, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(assertPortableApp(root)).rejects.toThrow('qualification bundle 包含符号链接');
  });
});

describe('offline qualification GSI scripts', () => {
  it('accepts the shipped installer and status entry points with shared Steam discovery', async () => {
    await expect(assertGsiScriptContract(await bundleScripts())).resolves.toBeUndefined();
  });

  it.each(['common.ps1', 'gsi-discovery.ps1', 'gsi-status.ps1', 'restore-gsi.ps1'])(
    'rejects a bundle missing %s',
    async (name) => {
      const root = await bundleScripts();
      await rm(join(root, name));
      await expect(assertGsiScriptContract(root)).rejects.toThrow(`缺少 ${name}`);
    },
  );

  it.each(['install-gsi.ps1', 'gsi-status.ps1'])(
    'rejects %s when shared discovery is present but not loaded',
    async (name) => {
      const root = await bundleScripts();
      await changeScript(root, name, (source) =>
        source.replace(". (Join-Path $PSScriptRoot 'gsi-discovery.ps1')", ''),
      );
      await expect(assertGsiScriptContract(root)).rejects.toThrow(
        `${name} 未加载 gsi-discovery.ps1`,
      );
    },
  );

  it('rejects a missing script dependency even if the expected modules are present', async () => {
    const root = await bundleScripts();
    await changeScript(root, 'install-gsi.ps1', (source) =>
      source.concat("\n. (Join-Path $PSScriptRoot 'missing-helper.ps1')\n"),
    );
    await expect(assertGsiScriptContract(root)).rejects.toThrow(
      'install-gsi.ps1 依赖的 missing-helper.ps1',
    );
  });

  it('rejects lost Steam library discovery in the extracted module', async () => {
    const root = await bundleScripts();
    await changeScript(root, 'gsi-discovery.ps1', (source) =>
      source.replace('libraryfolders.vdf', 'missing.vdf'),
    );
    await expect(assertGsiScriptContract(root)).rejects.toThrow('缺少 Steam library');
  });
});
