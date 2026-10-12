import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'mizar setup preparation '));
const literal = (text) => `'${text.replaceAll("'", "''")}'`;
const shell = process.env.POWERSHELL_BINARY || 'pwsh';
try {
  for (const mode of ['success', 'tool-failure', 'extract-failure']) {
    const fixture = join(root, mode);
    await mkdir(fixture);
    await cp(
      join(import.meta.dirname, 'prepare-windows-setup.ps1'),
      join(fixture, 'prepare-windows-setup.ps1'),
    );
    await writeFile(
      join(fixture, 'choco.ps1'),
      `
$ErrorActionPreference = 'Stop'
if (($args -join ' ') -ne 'install nsis --version=3.11 -y --no-progress') { throw 'Unpinned tool arguments' }
Set-Content (Join-Path $env:SETUP_FIXTURE 'tool-started') 'started'
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (!(Test-Path (Join-Path $env:SETUP_FIXTURE 'extract-started'))) {
  if ([DateTime]::UtcNow -gt $deadline) { throw 'Extraction did not overlap tool installation' }
  Start-Sleep -Milliseconds 25
}
Set-Content (Join-Path $env:SETUP_FIXTURE 'tool-ended') 'ended'
if ($env:SETUP_CASE -eq 'tool-failure') { exit 23 }
exit 0
`,
    );
    await writeFile(
      join(fixture, 'extract-windows-shell.ps1'),
      `
param([string]$Archive, [string]$Destination)
$ErrorActionPreference = 'Stop'
if ($Archive -ne 'exact-candidate.zip' -or $Destination -ne 'isolated destination') { throw 'Candidate arguments changed' }
Set-Content (Join-Path $env:SETUP_FIXTURE 'extract-started') 'started'
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (!(Test-Path (Join-Path $env:SETUP_FIXTURE 'tool-started'))) {
  if ([DateTime]::UtcNow -gt $deadline) { throw 'Tool installation did not overlap extraction' }
  Start-Sleep -Milliseconds 25
}
if ($env:SETUP_CASE -eq 'extract-failure') { throw 'Candidate extraction failed' }
`,
    );
    const output = execFileSync(
      shell,
      [
        '-NoProfile',
        '-Command',
        `
$ErrorActionPreference = 'Stop'
$failure = $null
try { & ${literal(join(fixture, 'prepare-windows-setup.ps1'))} -Archive 'exact-candidate.zip' -Destination 'isolated destination' }
catch { $failure = $_.Exception.Message }
if (@(Get-Job).Count -ne 0) { throw 'Tool job was left behind' }
if ($env:SETUP_CASE -eq 'success') { if ($failure) { throw $failure } }
elseif (!$failure) { throw 'Preparation failure was ignored' }
elseif ($env:SETUP_CASE -eq 'tool-failure' -and $failure -notmatch 'Pinned NSIS installation failed') { throw $failure }
elseif ($env:SETUP_CASE -eq 'extract-failure' -and $failure -notmatch 'Candidate extraction failed') { throw $failure }
`,
      ],
      {
        env: {
          ...process.env,
          PATH: `${fixture}${delimiter}${process.env.PATH}`,
          SETUP_FIXTURE: fixture,
          SETUP_CASE: mode,
        },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    assert.equal((await readFile(join(fixture, 'tool-ended'), 'utf8')).trim(), 'ended');
    assert.match(output, /SETUP_PREPARATION nsis:/);
    assert.match(output, /SETUP_PREPARATION extract:/);
    console.log(`Setup preparation overlap and joined failure ${mode}: PASS`);
  }
  // Exercise the actual installer orchestrator with controlled branch failures.
  for (const mode of ['dependency-failure', 'ui-failure', 'second-start-failure']) {
    const fixture = join(root, mode);
    await mkdir(fixture);
    await cp(join(import.meta.dirname, '../web-installer/verify.ps1'), join(fixture, 'verify.ps1'));
    await writeFile(
      join(fixture, 'test-nsis.ps1'),
      `
param([string]$OutputDirectory, [string]$DownloadCache, [switch]$PrepareDownloadOnly, [string]$CaseGroup)
$ErrorActionPreference = 'Stop'
if (!$PrepareDownloadOnly) { Set-Content (Join-Path $env:SETUP_FIXTURE 'nsis-started') 'started'; throw 'Unexpected NSIS write' }
Set-Content (Join-Path $env:SETUP_FIXTURE 'download-started') 'started'
$deadline = [DateTime]::UtcNow.AddSeconds(10)
while (!(Test-Path (Join-Path $env:SETUP_FIXTURE 'release-download'))) {
  if ([DateTime]::UtcNow -gt $deadline) { throw 'Download branch was not released' }
  Start-Sleep -Milliseconds 25
}
Set-Content (Join-Path $env:SETUP_FIXTURE 'download-ended') 'ended'
`,
    );
    await writeFile(
      join(fixture, 'test-native.ps1'),
      `
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
Set-Content (Join-Path $env:SETUP_FIXTURE 'release-download') 'released'
if ($env:SETUP_CASE -eq 'ui-failure') { throw 'Controlled native UI failure' }
`,
    );
    await writeFile(join(fixture, 'capture-ui.ps1'), 'param([string]$OutputDirectory)\n');
    await writeFile(
      join(fixture, 'pnpm.ps1'),
      `
if ($env:SETUP_CASE -eq 'dependency-failure' -and $args[0] -eq 'install') {
  Set-Content (Join-Path $env:SETUP_FIXTURE 'release-download') 'released'
  exit 23
}
exit 0
`,
    );
    await writeFile(join(fixture, 'node.ps1'), 'exit 0\n');
    execFileSync(
      process.platform === 'win32' ? 'powershell.exe' : shell,
      [
        '-NoProfile',
        '-Command',
        `
$ErrorActionPreference = 'Stop'
$global:fixtureStarts = 0
function Start-Job {
  param([object[]]$ArgumentList, [scriptblock]$ScriptBlock)
  $global:fixtureStarts++
  if ($env:SETUP_CASE -eq 'second-start-failure' -and $global:fixtureStarts -eq 2) {
    Set-Content (Join-Path $env:SETUP_FIXTURE 'release-download') 'released'
    throw 'Controlled second branch startup failure'
  }
  Microsoft.PowerShell.Core\\Start-Job -ArgumentList $ArgumentList -ScriptBlock $ScriptBlock
}
$failure = $null
try { & ${literal(join(fixture, 'verify.ps1'))} -OutputDirectory ${literal(join(fixture, 'output'))} -CaseGroup faults }
catch { $failure = $_.Exception.Message }
if (!$failure) { throw 'Orchestrator ignored branch failure' }
if (@(Get-Job).Count -ne 0) { throw 'Orchestrator left a branch job behind' }
if (!(Test-Path (Join-Path $env:SETUP_FIXTURE 'download-ended'))) { throw 'Orchestrator returned before download joined' }
if (Test-Path (Join-Path $env:SETUP_FIXTURE 'nsis-started')) { throw 'Failure entered NSIS mutation' }
if ($env:SETUP_CASE -eq 'dependency-failure' -and $failure -notmatch 'Dependency installation failed') { throw $failure }
if ($env:SETUP_CASE -eq 'ui-failure' -and $failure -notmatch 'Native UI checks did not complete') { throw $failure }
if ($env:SETUP_CASE -eq 'second-start-failure' -and $failure -notmatch 'Controlled second branch startup failure') { throw $failure }
`,
      ],
      {
        env: {
          ...process.env,
          PATH: `${fixture}${delimiter}${process.env.PATH}`,
          SETUP_FIXTURE: fixture,
          SETUP_CASE: mode,
        },
        encoding: 'utf8',
        timeout: 30000,
      },
    );
    console.log(`Installer verification joined failure ${mode}: PASS`);
  }
  const output = execFileSync(
    shell,
    [
      '-NoProfile',
      '-Command',
      `
$ErrorActionPreference = 'Stop'
$errors = $null; $tokens = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${literal(join(import.meta.dirname, 'create-windows-setup.ps1'))}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-SetupPhase' }, $true)
. ([scriptblock]::Create($function.Extent.Text))
$phases = [Collections.Generic.List[object]]::new()
$manifest = @{ gitSha = ('a' * 40); appVersion = '1.2.1' }
$archive = 'exact-Setup.exe'; $output = ${literal(root)}; $timingsName = 'setup-timings.json'
$env:GITHUB_STEP_SUMMARY = ''
Invoke-SetupPhase 'install' { }
try { Invoke-SetupPhase 'payload-verification' { throw 'Payload differs' }; throw 'Expected verification failure' }
catch { if ($_.Exception.Message -ne 'Payload differs') { throw } }
exit 0
`,
    ],
    { encoding: 'utf8', timeout: 10000 },
  );
  const timings = JSON.parse(await readFile(join(root, 'setup-timings.json'), 'utf8'));
  assert.equal(timings.gitSha, 'a'.repeat(40));
  assert.equal(timings.archive, 'exact-Setup.exe');
  assert.deepEqual(
    timings.phases.map(({ phase, status }) => ({ phase, status })),
    [
      { phase: 'install', status: 'success' },
      { phase: 'payload-verification', status: 'failure' },
    ],
  );
  assert(timings.phases.every(({ durationMs }) => Number.isFinite(durationMs) && durationMs >= 0));
  assert.match(output, /SETUP_TIMING payload-verification: .*\(failure\)/);
  console.log('Setup timing records original identity and preserves verification failure: PASS');
} finally {
  await rm(root, { recursive: true, force: true });
}
