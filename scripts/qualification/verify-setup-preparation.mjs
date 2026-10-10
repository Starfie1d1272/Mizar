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
