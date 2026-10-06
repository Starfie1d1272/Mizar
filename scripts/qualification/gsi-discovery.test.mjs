import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const script = resolve(import.meta.dirname, 'bundle/gsi-discovery.ps1');
function run(source) {
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; . ${quote(script)}; ${source}`,
    ],
    {
      encoding: 'utf8',
      timeout: 15000,
    },
  ).trim();
}
async function library() {
  const root = await mkdtemp(join(tmpdir(), 'mizar-steam-paths-'));
  roots.push(root);
  await mkdir(join(root, 'steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg'), {
    recursive: true,
  });
  await writeFile(
    join(root, 'steamapps/libraryfolders.vdf'),
    `"libraryfolders"\n{\n"0"\n{\n"path" "${root.replaceAll('\\', '\\\\')}"\n}\n}\n`,
  );
  return root;
}

describe.skipIf(process.platform !== 'win32')('Windows Steam directory discovery', () => {
  it('deduplicates slash, case, trailing separator and VDF aliases of one installation', async () => {
    const root = await library();
    const alias = root.replaceAll('\\', '/').toUpperCase() + '/';
    const cfg = run(
      `function Get-SteamInstallRoots { @(${quote(root)}, ${quote(alias)}) }; Resolve-CfgDirectory`,
    );
    expect(cfg.toLowerCase()).toBe(
      join(root, 'steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg').toLowerCase(),
    );
  });
  it('still rejects genuinely different installations', async () => {
    const first = await library();
    const second = await library();
    const result = run(
      `function Get-SteamInstallRoots { @(${quote(first)}, ${quote(second)}) }; try { Resolve-CfgDirectory; throw 'unexpected success' } catch { if ($_.Exception.Message -notmatch '2') { throw }; 'multiple installations' }`,
    );
    expect(result).toBe('multiple installations');
  });
});
