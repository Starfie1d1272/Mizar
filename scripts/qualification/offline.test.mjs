import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertGsiScriptContract, assertPortableApp, offlineChecks } from './offline.mjs';

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

describe('offline qualification check ownership', () => {
  it('requires Quality ownership before replacing full tests with platform consumers', () => {
    expect(() => offlineChecks(['--platform-only'])).toThrow('requires');
    expect(offlineChecks(['--platform-only', '--quality-owned-static-checks'])).toEqual({
      qualityOwnedStaticChecks: true,
      platformOnly: true,
      commands: ['typecheck', 'build'],
    });
  });
});

describe('offline qualification portable app', () => {
  it('rejects directory symlinks that make the app nonportable', async () => {
    const root = await bundleScripts();
    const target = join(root, 'target');
    await mkdir(target);
    await symlink(target, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(assertPortableApp(root)).rejects.toThrow('qualification bundle 包含符号链接');
  });
});

describe('offline qualification GSI scripts', () => {
  it('rejects a missing script dependency even if the expected modules are present', async () => {
    const root = await bundleScripts();
    await changeScript(root, 'install-gsi.ps1', (source) =>
      source.concat("\n. (Join-Path $PSScriptRoot 'missing-helper.ps1')\n"),
    );
    await expect(assertGsiScriptContract(root)).rejects.toThrow(
      'install-gsi.ps1 依赖的 missing-helper.ps1',
    );
  });
});
