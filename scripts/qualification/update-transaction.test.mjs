import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function payload(root, version) {
  const files = {
    'Mizar.exe': 'program ' + version,
    'resources/runtime/node.exe': 'runtime',
    'resources/app/dist/server.js': 'server ' + version,
    'resources/web/dist/index.html': 'web ' + version,
  };
  const digest = hash(
    Object.keys(files)
      .sort()
      .map((n) => n + '\0' + hash(files[n]) + '\n')
      .join(''),
  );
  files['resources/metadata/artifact.json'] = JSON.stringify({
    repository: 'Starfie1d1272/Mizar',
    appVersion: version,
    gitSha: 'a'.repeat(40),
    artifactSha256: digest,
  });
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), bytes);
  }
  await writeFile(
    join(root, 'resources/metadata/SHA256SUMS'),
    Object.keys(files)
      .sort()
      .map((n) => hash(files[n]) + '  ' + n)
      .join('\n'),
  );
  await writeFile(join(root, 'installed.flag'), 'old instance');
  return digest;
}

test(
  'directory transaction prepares before mutation, restores by rename, and cleans its payload',
  { skip: process.platform !== 'win32' },
  async () => {
    const area = await mkdtemp(join(tmpdir(), 'mizar-directory-transaction-'));
    try {
      const old = await payload(join(area, 'old'), '1.11.6');
      const next = await payload(join(area, 'next'), '1.11.7');
      const probe = join(area, 'probe.ps1');
      await writeFile(
        probe,
        String.raw`param([string]$Source, [string]$Area, [string]$OldDigest, [string]$NewDigest)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$text = [IO.File]::ReadAllText($Source)
$scope = [guid]::NewGuid().ToString('N')
# Filesystem tests use private OS synchronization names, so they neither
# interfere with the user's Host nor race another native handoff test.
foreach ($name in @('MizarUpdateWriter', 'MizarDesktop', 'MizarUpdateActive')) {
  $text = $text.Replace(('Global\' + $name), ('Local\' + $name + '-' + $scope))
}
$start = $text.IndexOf('Add-Type -TypeDefinition')
Invoke-Expression $text.Substring($start, $text.IndexOf('$script:updateWindowAvailable') - $start)
$ast = [Management.Automation.Language.Parser]::ParseInput($text, [ref]$null, [ref]$null)
foreach ($f in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { Invoke-Expression $f.Extent.Text }
# Substitute external process/registry boundaries only. Manifest, ownership,
# filesystem switching, recovery and cleanup are the actual production code.
function Assert-Stopped {}
function Assert-InstallationRegistration {}
function Assert-RecoveryRegistration {}
function Assert-ShortcutOwnership {}
function Save-Registration {}
function Restore-Registration { $script:restored++ }
function Recovery-Registration([bool]$enabled) {}
function Invoke-LegacyHandoff { return $plan.stateRoot }
function Open-HandoffLease { return [IO.File]::Open((Join-Path $StageRoot 'lease'), 'OpenOrCreate', 'ReadWrite', 'None') }
function Install-Registration {
  $script:registered++
  if ($script:scenario -eq 'registration-failure') { throw 'update_registration_failed' }
}
function Start-Process {
  param($FilePath, $WorkingDirectory, $ArgumentList, [switch]$PassThru)
  if ($ArgumentList -notcontains '/MIZARPREPARE') { throw 'Installer may write the live root' }
  if ([IO.File]::ReadAllText((Join-Path $plan.bundleRoot 'Mizar.exe')) -ne 'program 1.11.6' -or
    $script:registered -ne 0 -or (Test-Path -LiteralPath (Previous-Directory))) { throw 'Mutation preceded extraction' }
  $candidate = Candidate-Directory
  Copy-Item -Path (Join-Path $Area 'next/*') -Destination $candidate -Recurse -Force
  if ($script:scenario -eq 'collision') { [IO.File]::WriteAllText((Join-Path $candidate 'user-note.txt'), 'new managed content') }
  [IO.File]::WriteAllText((Join-Path $candidate 'installed.flag'), ('mizar.install.v1:' + (Split-Path -Leaf $StageRoot)))
  $code = if ($script:scenario -eq 'refusal') { 2 } elseif ($script:scenario -eq 'cancel') { 1 } else { 0 }
  if ($code -ne 0) { [IO.File]::WriteAllText((Join-Path $candidate 'Mizar.exe'), 'partial') }
  $process = [pscustomobject]@{ ExitCode = $code }
  $process | Add-Member ScriptMethod WaitForExit {}
  return $process
}
$NoStatusWindow=$true; $NoLaunch=$true; $KeepBackup=$true; $HostProcessId=2147483647
$ReadyEvent=''; $BootstrapLease=0; $script:updateWindowAvailable=$false; $script:updateWindowStarted=$false
foreach ($script:scenario in @('success', 'refusal', 'cancel', 'collision', 'registration-failure', 'interrupted', 'committed-blocked')) {
  $KeepBackup=$script:scenario -notin @('refusal','cancel','collision')
  $case=Join-Path $Area $script:scenario
  [IO.Directory]::CreateDirectory($case) | Out-Null
  $target=Join-Path $case 'program'
  Copy-Item -LiteralPath (Join-Path $Area 'old') -Destination $target -Recurse
  [IO.File]::WriteAllText((Join-Path $target 'user-note.txt'), 'keep me')
  $state=Join-Path $case 'state'
  $StageRoot=Join-Path $state ('updates/install-' + [guid]::NewGuid().ToString('N'))
  [IO.Directory]::CreateDirectory($StageRoot) | Out-Null
  $download=Join-Path $state 'updates/download-fixture/Mizar-v1.11.7-Windows-x64-Setup.exe'
  [IO.Directory]::CreateDirectory((Split-Path -Parent $download)) | Out-Null
  [IO.File]::WriteAllText($download, 'fixture installer')
  Copy-Item -LiteralPath $download -Destination (Join-Path $StageRoot 'Installer.exe')
  $plan=[pscustomobject]@{
    schemaVersion=1
    # Input aliases must be normalized before comparing FileInfo.FullName.
    bundleRoot=(Join-Path $case '.\program'); stateRoot=$state; installer=$download; version='1.11.7'; gitSha=('a'*40)
    installerBytes=(Get-Item $download).Length; installerSha256=[MizarUpdateFiles]::Hash($download)
    contentDigest=$NewDigest; previousContentDigest=$OldDigest
    previousInstallationId=[MizarUpdateFiles]::Hash((Join-Path $target 'installed.flag'))
    transactionProtocol='mizar.directory-swap.v1'
  }
  Assert-Plan $plan
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase='prepared' }
  $Mode='Install'; $script:registered=0; $script:restored=0; $script:programGate=$null
  $script:updateExitCode=0; $script:launchAfterCommit=$false; $script:restoredTransaction=$false
  Set-Location $StageRoot; [Environment]::CurrentDirectory=$StageRoot
  if ($script:scenario -eq 'interrupted') {
    $candidate=Candidate-Directory
    Copy-Item -LiteralPath (Join-Path $Area 'next') -Destination $candidate -Recurse
    Create-RecoveryOwner $candidate
    [IO.File]::WriteAllText((Join-Path $candidate 'installed.flag'), ('mizar.install.v1:' + (Split-Path -Leaf $StageRoot)))
    Preserve-ExtraFiles $candidate
    Create-RecoveryOwner
    Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase='installing' }
    [IO.Directory]::Move($target, (Previous-Directory))
    $Mode='Recover'
  }
  Invoke-UpdateTransaction
  $result=Get-Content (Join-Path $StageRoot 'result.json') -Raw | ConvertFrom-Json
  $expected=switch ($script:scenario) {
    'success' {'installed'}; 'committed-blocked' {'installed'}; 'cancel' {'cancelled'}
    'registration-failure' {'restored'}; 'interrupted' {'restored'}; default {'failed'}
  }
  if ($result.status -ne $expected) { throw "$script:scenario returned $($result.status): $($result.code)" }
  $version=if ($expected -eq 'installed') {'1.11.7'} else {'1.11.6'}
  if ([IO.File]::ReadAllText((Join-Path $target 'Mizar.exe')) -ne ('program ' + $version)) { throw 'Wrong program bytes' }
  if ([IO.File]::ReadAllText((Join-Path $target 'user-note.txt')) -ne 'keep me') { throw 'User file lost' }
  if ($script:scenario -eq 'committed-blocked') {
    function Assert-Stopped { throw 'update_process_remaining' }
    $Mode='Rollback'; Invoke-UpdateTransaction
    $blocked=Get-Content (Join-Path $StageRoot 'result.json') -Raw | ConvertFrom-Json
    if ($blocked.status -ne 'recovery-required' -or !(Test-Path (Previous-Directory))) { throw 'Blocked rollback was reported as installation success' }
    function Assert-Stopped {}
    Invoke-UpdateTransaction
    if ([IO.File]::ReadAllText((Join-Path $target 'Mizar.exe')) -ne 'program 1.11.6') { throw 'Rollback did not resume' }
  } elseif ($expected -eq 'installed') {
    if (!(Test-Path (Previous-Directory)) -or (Test-Path (Join-Path $StageRoot 'previous'))) { throw 'Expected one old directory' }
    $unknown=Join-Path (Previous-Directory) 'user-note.txt'
    [IO.File]::WriteAllText($unknown, 'changed externally')
    $refused=$false
    try { Complete-Cleanup } catch { $refused=$_.Exception.Message -eq 'update_cleanup_unknown_file' }
    if (!$refused -or !(Test-Path $unknown)) { throw 'Cleanup removed an unpreserved user file' }
    [IO.File]::WriteAllText($unknown, 'keep me')
    Complete-Cleanup
    if ((Test-Path (Previous-Directory)) -or (Test-Path $download) -or (Test-Path (Join-Path $StageRoot 'Installer.exe'))) { throw 'Payload not cleaned' }
  } else {
    if (Test-Path (Previous-Directory)) { throw 'Recovery copied the original directory' }
    if ($expected -eq 'restored') {
      if ($script:restored -ne 1) { throw 'Registration not restored' }
      $Mode='Recover'; Invoke-UpdateTransaction
      if ($script:restored -ne 1) { throw 'Recovery repeated after backup consumption' }
    } elseif ($script:registered -ne 0) { throw 'Refusal changed registration' }
    elseif ((Test-Path (Join-Path $StageRoot 'Installer.exe')) -or !(Test-Path $download)) { throw 'Failed preparation must retain only the download owner copy' }
  }
  "PASS: $script:scenario"
}
Set-Location $Area; [Environment]::CurrentDirectory=$Area
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
          '-OldDigest',
          old,
          '-NewDigest',
          next,
        ],
        {
          env: Object.fromEntries(
            Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
          ),
          encoding: 'utf8',
          windowsHide: true,
          timeout: 60000,
        },
      );
      assert.equal(result.status, 0, result.stderr || result.error?.message);
      assert.equal((result.stdout.match(/PASS:/g) ?? []).length, 7, result.stdout);
    } finally {
      await rm(area, { recursive: true, force: true });
    }
  },
);
