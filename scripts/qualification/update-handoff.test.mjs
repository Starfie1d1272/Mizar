import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

test(
  'desktop handoff distinguishes service discovery from known recovery owners',
  { skip: process.platform !== 'win32' },
  async () => {
    const area = await mkdtemp(join(tmpdir(), 'mizar-handoff-scope-'));
    try {
      const probe = join(area, 'probe.ps1');
      await writeFile(
        probe,
        String.raw`param([string]$Source, [string]$Area)
$ErrorActionPreference = 'Stop'
$sourceText = [IO.File]::ReadAllText($Source)
$writerName = 'MizarUpdateWriter-' + [guid]::NewGuid().ToString('N')
$sourceText = $sourceText.Replace('MizarUpdateWriter', $writerName)
$start = $sourceText.IndexOf('Add-Type -TypeDefinition')
$end = $sourceText.IndexOf('$script:updateWindowAvailable')
Invoke-Expression $sourceText.Substring($start, $end - $start)
$ast = [Management.Automation.Language.Parser]::ParseInput($sourceText, [ref]$null, [ref]$null)
foreach ($definition in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Invoke-Expression $definition.Extent.Text }
$env:LOCALAPPDATA = $Area
$state = Join-Path $Area 'Mizar'
$target = Join-Path $Area 'program'
[IO.Directory]::CreateDirectory($state) | Out-Null
[IO.Directory]::CreateDirectory($target) | Out-Null
$writer = [Threading.Mutex]::new($false, ('Global\' + $writerName))
$owned = $false
try {
  $owned = $writer.WaitOne(0)
  if (!$owned) { throw 'Another update is running; do not test concurrently' }
  $script:handoffHandles = [Collections.Generic.List[IDisposable]]::new()
  $script:session = 0
  $script:commandLine=$null
  function Get-CimInstance { [pscustomobject]@{ ProcessId=2147483647; SessionId=$script:session; CommandLine=$script:commandLine } }
  function Invoke-CimMethod { [pscustomobject]@{ ReturnValue=2; Sid=$null } }
  if ([Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0) {
    if ((Invoke-LegacyHandoff $target $state) -ne $state) { throw 'Unrelated service prevented desktop handoff' }
  }
  $script:session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $refused = $false
  try { Invoke-LegacyHandoff $target $state | Out-Null } catch { $refused = $_.Exception.Message -eq 'update_handoff_process_unknown' }
  if (!$refused) { throw 'Unknown interactive process must remain unresolved' }
  $script:commandLine='pwsh.exe -Command "Write-Output hello' + [char]10 + 'Write-Output world"'
  if ((Invoke-LegacyHandoff $target $state) -ne $state) { throw 'Unrelated command text was treated as an installation path' }
  $refused = $false
  try { Assert-HandoffProcessEnded ([int]$PID) ([long][Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks) } catch { $refused = $_.Exception.Message -eq 'update_handoff_process_active' }
  if (!$refused) { throw 'A named recovery owner must not be ignored' }
  'PASS: unrelated service, unresolved interactive process, live recovery owner'
} finally { if ($owned) { $writer.ReleaseMutex() }; $writer.Dispose() }
`,
      );
      const result = spawnSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          probe,
          '-Source',
          resolve('scripts/qualification/bundle/update-install.ps1'),
          '-Area',
          area,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 30000 },
      );
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.match(result.stdout, /PASS:/);
    } finally {
      await rm(area, { recursive: true, force: true });
    }
  },
);
