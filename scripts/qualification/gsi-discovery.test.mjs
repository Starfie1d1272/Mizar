import { execFileSync } from 'node:child_process';
import { cp, realpath, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
  // Run each complete lifecycle in one real PowerShell process. Repeated cold
  // starts consumed the timeout and blocked Vitest cleanup on Windows runners.
  // Keep the existing process/test deadlines and all filesystem assertions.
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
      const result = run(
        `
        $env:MIZAR_STATE_ROOT=${quote(state)}; $env:STEAMROOT=${quote(root)};
        $cfg=${quote(canonical)}; $duplicate=${quote(duplicate)};
        $record=${quote(join(state, 'data/gsi-install/install.json'))};
        $utf8=New-Object System.Text.UTF8Encoding($false);
        function Put($path,$text) { [IO.File]::WriteAllText($path,$text,$utf8) }
        function Prepare($expected) {
          # Match a fresh process for the inherited native/script exit status.
          $global:LASTEXITCODE=0;
          & ${quote(ensure)} -Product | Out-Null;
          if (($LASTEXITCODE -eq 0) -ne $expected) { throw "unexpected prepare exit: $LASTEXITCODE" }
        }
        Put $duplicate '"uri" "http://localhost:3000/"';
        Prepare $false;
        if ([IO.File]::ReadAllText($duplicate) -ne '"uri" "http://localhost:3000/"') { throw 'unknown sender changed' }
        Remove-Item -LiteralPath $duplicate;
        Put $cfg 'operator-owned'; Prepare $false;
        if ([IO.File]::ReadAllText($cfg) -ne 'operator-owned') { throw 'unknown canonical changed' }
        Remove-Item -LiteralPath $cfg;
        Prepare $true;
        $installed=[IO.File]::ReadAllText($cfg); $originalRecord=[IO.File]::ReadAllText($record);
        Prepare $true;
        if ([IO.File]::ReadAllText($cfg) -ne $installed -or [IO.File]::ReadAllText($record) -ne $originalRecord) { throw 'idempotent install changed bytes or token' }
        Remove-Item -LiteralPath $cfg; Prepare $true;
        if ([IO.File]::ReadAllText($cfg) -ne $installed) { throw 'restore changed original config' }
        Put $cfg 'operator-edited'; Prepare $false;
        if ([IO.File]::ReadAllText($cfg) -ne 'operator-edited') { throw 'operator edit overwritten' }
        'GSI_PREPARE_LIFECYCLE_PASS'; exit 0;
      `,
        true,
      );
      expect(result).toBe('GSI_PREPARE_LIFECYCLE_PASS');
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
      const result = run(`
        . ${quote(common)}; $script:QualificationStateRoot=${quote(state)};
        $canonical=${quote(canonical)}; $duplicate=${quote(duplicate)}; $other=${quote(other)};
        function Suspend { Suspend-GsiEndpointConflicts -CfgDirectory ${quote(cfg)} -CanonicalCfgPath $canonical }
        function Restore { Restore-GsiEndpointConflicts -CfgDirectory ${quote(cfg)} }
        Suspend; Suspend;
        if (Test-Path -LiteralPath $duplicate) { throw 'duplicate not suspended' }
        if ([IO.File]::ReadAllText($other) -ne '"uri" "http://localhost:4000/"') { throw 'other endpoint changed' }
        if ([IO.File]::ReadAllText($canonical) -ne 'canonical') { throw 'canonical changed' }
        [IO.File]::WriteAllText($duplicate,'new sender from another application');
        $refused=$false; try { Restore } catch { $refused=$true }
        if (-not $refused -or [IO.File]::ReadAllText($duplicate) -ne 'new sender from another application') { throw 'new sender not preserved' }
        Remove-Item -LiteralPath $duplicate; Restore; Restore;
        if ([IO.File]::ReadAllText($duplicate) -ne '"uri" "http://localhost:3000/"') { throw 'original sender not restored' }
        Suspend; Restore; Suspend;
        if (Test-Path -LiteralPath $duplicate) { throw 'duplicate not suspended after recovery' }
        $journal=Get-Content -LiteralPath ${quote(join(state, 'conflicts.json'))} -Raw | ConvertFrom-Json;
        [IO.File]::WriteAllText($journal.entries[0].backupPath,'corrupted backup');
        $refused=$false; try { Restore } catch { $refused=$true }
        if (-not $refused -or (Test-Path -LiteralPath $duplicate)) { throw 'corrupt backup restored' }
        if ([IO.File]::ReadAllText($other) -ne '"uri" "http://localhost:4000/"') { throw 'other endpoint changed during restore' }
        'GSI_REPAIR_LIFECYCLE_PASS';
      `);
      expect(result.split(/\r?\n/).at(-1)).toBe('GSI_REPAIR_LIFECYCLE_PASS');
    },
  );
});
