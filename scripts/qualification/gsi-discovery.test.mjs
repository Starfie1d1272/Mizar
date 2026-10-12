import { execFileSync } from 'node:child_process';
import { cp, readFile, realpath, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const script = resolve(import.meta.dirname, 'bundle/gsi-discovery.ps1');
function run(source, isolatedSteam = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const isolation = isolatedSteam
    ? `function Get-ItemProperty { [CmdletBinding()] param([string]$LiteralPath) [pscustomobject]@{} }; $env:ProgramFiles=''; \${env:ProgramFiles(x86)}='';`
    : '';
  return execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$ErrorActionPreference='Stop'; ${isolation} . ${quote(script)}; ${source}`,
    ],
    {
      env,
      encoding: 'utf8',
      timeout: 15000,
    },
  ).trim();
}
async function library() {
  // Windows TEMP can use an 8.3 alias; expected paths must use the filesystem identity.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mizar-steam-paths-')));
  roots.push(root);
  await mkdir(join(root, 'steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg'), {
    recursive: true,
  });
  const exe = join(root, 'steamapps/common/Counter-Strike Global Offensive/game/bin/win64');
  await mkdir(exe, { recursive: true });
  await writeFile(join(exe, 'cs2.exe'), 'fixture');
  await writeFile(
    join(root, 'steamapps/libraryfolders.vdf'),
    `"libraryfolders"\n{\n"0"\n{\n"path" "${root.replaceAll('\\', '\\\\')}"\n}\n}\n`,
  );
  return root;
}

describe.skipIf(process.platform !== 'win32')('Windows Steam directory discovery', () => {
  // This lifecycle intentionally launches several real Windows PowerShell processes.
  it(
    'automatically prepares only owned GSI, preserves its token, and refuses unknown senders',
    { timeout: 20_000 },
    async () => {
      const root = await library();
      const product = join(root, 'product');
      const resources = join(product, 'resources');
      await cp(resolve(import.meta.dirname, 'bundle'), join(resources, 'scripts'), {
        recursive: true,
      });
      await mkdir(join(resources, 'config'), { recursive: true });
      await cp(
        resolve(import.meta.dirname, '../../config/gamestate_integration_mizar.cfg.example'),
        join(resources, 'config/gamestate_integration_mizar.cfg.template'),
      );
      const state = join(root, 'state');
      const cfg = join(root, 'steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg');
      const canonical = join(cfg, 'gamestate_integration_mizar.cfg');
      const duplicate = join(cfg, 'gamestate_integration_other.cfg');
      const ensure = join(resources, 'scripts/ensure-gsi.ps1');
      const prepare = () =>
        run(
          `$env:MIZAR_STATE_ROOT=${quote(state)}; $env:STEAMROOT=${quote(root)}; & ${quote(ensure)} -Product`,
          true,
        );
      await writeFile(duplicate, '"uri" "http://localhost:3000/"');
      expect(prepare).toThrow();
      expect(await readFile(duplicate, 'utf8')).toContain('3000');
      await rm(duplicate);
      await writeFile(canonical, 'operator-owned');
      expect(prepare).toThrow();
      expect(await readFile(canonical, 'utf8')).toBe('operator-owned');
      await rm(canonical);
      prepare();
      const installed = await readFile(canonical, 'utf8');
      const record = await readFile(join(state, 'data/gsi-install/install.json'), 'utf8');
      prepare();
      expect(await readFile(canonical, 'utf8')).toBe(installed);
      expect(await readFile(join(state, 'data/gsi-install/install.json'), 'utf8')).toBe(record);
      await rm(canonical);
      prepare();
      expect(await readFile(canonical, 'utf8')).toBe(installed);
      await writeFile(canonical, 'operator-edited');
      expect(prepare).toThrow();
      expect(await readFile(canonical, 'utf8')).toBe('operator-edited');
    },
  );
  it(
    'explicit repair suspends duplicate senders, preserves other endpoints and restores without overwriting new files',
    { timeout: 20_000 },
    async () => {
      const root = await library();
      const cfg = join(root, 'steamapps/common/Counter-Strike Global Offensive/game/csgo/cfg');
      const state = join(root, 'state/data/gsi-install');
      const common = resolve(import.meta.dirname, 'bundle/common.ps1');
      const canonical = join(cfg, 'gamestate_integration_mizar.cfg');
      const duplicate = join(cfg, 'gamestate_integration_duplicate.cfg');
      const other = join(cfg, 'gamestate_integration_other.cfg');
      await writeFile(canonical, 'canonical');
      await writeFile(duplicate, '"uri" "http://localhost:3000/"');
      await writeFile(other, '"uri" "http://localhost:4000/"');
      const invoke = (source) =>
        run(`. ${quote(common)}; $script:QualificationStateRoot=${quote(state)}; ${source}`);
      const suspend = `Suspend-GsiEndpointConflicts -CfgDirectory ${quote(cfg)} -CanonicalCfgPath ${quote(canonical)}`;
      const restore = `Restore-GsiEndpointConflicts -CfgDirectory ${quote(cfg)}`;
      invoke(`${suspend}; ${suspend}`); // Idempotent: the original backup survives a retry.
      const { readFile, access } = await import('node:fs/promises');
      await expect(access(duplicate)).rejects.toThrow();
      expect(await readFile(other, 'utf8')).toContain('4000');
      expect(await readFile(canonical, 'utf8')).toBe('canonical');
      await writeFile(duplicate, 'new sender from another application');
      expect(invoke(`try { ${restore}; 'unexpected success' } catch { 'preserved' }`)).toBe(
        'preserved',
      );
      expect(await readFile(duplicate, 'utf8')).toBe('new sender from another application');
      await rm(duplicate);
      invoke(`${restore}; ${restore}`);
      expect(await readFile(duplicate, 'utf8')).toBe('"uri" "http://localhost:3000/"');
      // Simulate interruption after journaling but before the original was removed.
      invoke(`${suspend}; ${restore}; ${suspend}`);
      await expect(access(duplicate)).rejects.toThrow();
      const journal = JSON.parse(await readFile(join(state, 'conflicts.json'), 'utf8'));
      await writeFile(journal.entries[0].backupPath, 'corrupted backup');
      expect(invoke(`try { ${restore}; 'unexpected success' } catch { 'preserved' }`)).toBe(
        'preserved',
      );
      await expect(access(duplicate)).rejects.toThrow();
      expect(await readFile(other, 'utf8')).toContain('4000');
    },
  );
});
