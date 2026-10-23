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
  it(
    'explicit repair rebuilds missing or edited owned GSI while preserving original backups and tokens',
    { timeout: 20_000 },
    async () => {
      const root = await library();
      const resources = join(root, 'product/resources');
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
      const other = join(cfg, 'gamestate_integration_other.cfg');
      await writeFile(canonical, 'original sender');
      await writeFile(other, '"uri" "http://localhost:4000/"');
      const install = join(resources, 'scripts/install-gsi.ps1');
      const restore = join(resources, 'scripts/restore-gsi.ps1');
      const result = run(
        `
        $env:MIZAR_STATE_ROOT=${quote(state)}; $env:STEAMROOT=${quote(root)};
        $cfg=${quote(canonical)}; $record=${quote(join(state, 'data/gsi-install/install.json'))};
        $repairs=${quote(join(state, 'data/gsi-repairs'))};
        $utf8=New-Object System.Text.UTF8Encoding($false);
        function Put($path,$text) { [IO.File]::WriteAllText($path,$text,$utf8) }
        function Install($expected) {
          $global:LASTEXITCODE=0; & ${quote(install)} -Product | Out-Null;
          if (($LASTEXITCODE -eq 0) -ne $expected) { throw "unexpected install exit: $LASTEXITCODE" }
        }
        Install $true;
        $installed=[IO.File]::ReadAllText($cfg); $initial=Get-Content -LiteralPath $record -Raw | ConvertFrom-Json;
        $token=$initial.gsiToken; $backup=$initial.backupPath;
        Put $cfg 'operator-edited'; Install $true;
        $current=Get-Content -LiteralPath $record -Raw | ConvertFrom-Json;
        if ([IO.File]::ReadAllText($cfg) -ne $installed -or $current.gsiToken -ne $token -or $current.backupPath -ne $backup) { throw 'repair changed installed identity or token' }
        if ([IO.File]::ReadAllText($backup) -ne 'original sender') { throw 'original backup replaced' }
        $editedBackup=@(Get-ChildItem -LiteralPath $repairs -Recurse -Filter '*.before-repair');
        if ($editedBackup.Count -ne 1 -or [IO.File]::ReadAllText($editedBackup[0].FullName) -ne 'operator-edited') { throw 'repair lost operator edit' }
        Remove-Item -LiteralPath $cfg; Install $true;
        if ([IO.File]::ReadAllText($cfg) -ne $installed) { throw 'missing sender not repaired' }
        $count=@(Get-ChildItem -LiteralPath $repairs -Directory).Count; Install $true;
        if (@(Get-ChildItem -LiteralPath $repairs -Directory).Count -ne $count) { throw 'unchanged repair created duplicate backups' }
        if ([IO.File]::ReadAllText(${quote(other)}) -ne '"uri" "http://localhost:4000/"') { throw 'unrelated sender changed' }
        # Token mismatch and missing initial backup fail before modifying edited bytes.
        Put $cfg 'second operator edit';
        $tokenPath=${quote(join(state, 'data/gsi-token.txt'))}; Put $tokenPath ('b' * 64); Install $false;
        if ([IO.File]::ReadAllText($cfg) -ne 'second operator edit') { throw 'invalid identity changed config' }
        Put $tokenPath $token;
        $savedBackup=[IO.File]::ReadAllText($backup); Remove-Item -LiteralPath $backup; Install $false;
        if ([IO.File]::ReadAllText($cfg) -ne 'second operator edit') { throw 'missing original backup changed config' }
        Put $backup $savedBackup; Install $true;
        $global:LASTEXITCODE=0; & ${quote(restore)} -Product | Out-Null;
        if ($LASTEXITCODE -ne 0 -or [IO.File]::ReadAllText($cfg) -ne 'original sender') { throw 'restore lost initial sender' }
        if ([IO.File]::ReadAllText($editedBackup[0].FullName) -ne 'operator-edited') { throw 'restore removed repair archive' }
        'GSI_EXPLICIT_REPAIR_PASS'; exit 0;
      `,
        true,
      );
      expect(result.split(/\r?\n/).at(-1)).toBe('GSI_EXPLICIT_REPAIR_PASS');
    },
  );
});
