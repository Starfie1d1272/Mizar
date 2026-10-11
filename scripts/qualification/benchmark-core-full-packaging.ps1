param(
  [Parameter(Mandatory = $true)][ValidateSet('full', 'core')][string]$First,
  [Parameter(Mandatory = $true)][string]$SourceDirectory,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$sourceSha = '433c86836cfc36224bdadb17928cff58385f2c7b'
$candidateRun = '38112555048'
$repository = 'Starfie1d1272/Mizar'
$source = (Resolve-Path -LiteralPath $SourceDirectory).Path
$root = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $root) { throw 'Measurement output must be fresh' }
if ((& git -C $source rev-parse HEAD).Trim() -ne $sourceSha) { throw 'Packaging source differs' }
New-Item -ItemType Directory -Path $root | Out-Null
$report = [ordered]@{
  schemaVersion = 1; candidateSourceSha = $sourceSha; candidateRun = $candidateRun
  toolsSourceSha = (& git rev-parse HEAD).Trim(); first = $First
  publication = $false; rustCompilationCount = 0
  assemblyBoundary = 'Full: Node fs.cp of verified compiled Full payload into fresh output. Core: production prepareCoreCandidate copies that same Full payload, strips optional assets, regenerates and verifies identity. Common compilation, dependency deploy and original Full staging are excluded; no rebuild.'
  cacheBoundary = 'Round 1: first packaging invocation on fresh runner, inputs already read by extraction and verification. Rounds 2-3: warm repeated invocation; fresh output every time. OS page cache is not flushed; no physical disk-cold claim.'
  runner = [ordered]@{ os = [Environment]::OSVersion.VersionString; image = $env:ImageVersion; cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Name; processors = [Environment]::ProcessorCount; node = (& node --version); powershell = $PSVersionTable.PSVersion.ToString() }
  preparation = @(); originals = @(); samples = @()
}
function Save-Report {
  $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $root 'report.json') -Encoding utf8NoBOM
}
function Invoke-PackagingPhase([string]$Phase, [scriptblock]$Operation) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $status = 'failure'
  try { & $Operation | Out-Host; $status = 'success' }
  finally {
    $record = [ordered]@{ phase = $Phase; durationMs = $timer.ElapsedMilliseconds; status = $status }
    Write-Host "PACKAGING_TIMING ${Phase}: $($record.durationMs) ms ($status)"
    if ($null -ne $script:sample) { $script:sample.phases += $record }
    else { $report.preparation += $record }
    Save-Report
  }
}
$product = Join-Path $root 'original'
Invoke-PackagingPhase 'download-and-verify-original-candidate' {
  $runText = & gh api "repos/$repository/actions/runs/$candidateRun"
  if ($LASTEXITCODE) { throw 'Candidate run lookup failed' }
  $run = ($runText | Out-String) | ConvertFrom-Json
  if ($run.head_sha -ne $sourceSha -or $run.head_branch -ne 'main' -or $run.conclusion -ne 'success' -or $run.path -ne '.github/workflows/release-qualification.yml') { throw 'Original Qualification identity differs' }
  & gh run download $candidateRun --repo $repository --name release-candidate --dir $product
  if ($LASTEXITCODE) { throw 'Original candidate unavailable; do not rebuild' }
  foreach ($entry in @(
    @('release-manifest.json', 'aea929179a06f74759af49940fc7754d3d61c9d83214ddbd62544a0294bf0a97'),
    @('core-release-manifest.json', '0bf0b00a1243942050cb26537c1a86ad8ab570b63b1f1a1d9de42b7dffc3ef1b')
  )) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $product $entry[0])).Hash.ToLowerInvariant() -ne $entry[1]) { throw 'Frozen manifest differs' }
  }
  foreach ($mode in @('full', 'core')) {
    $manifestName = if ($mode -eq 'full') { 'release-manifest.json' } else { 'core-release-manifest.json' }
    $manifest = Get-Content -Raw -LiteralPath (Join-Path $product $manifestName) | ConvertFrom-Json
    $archive = Get-Item -LiteralPath (Join-Path $product $manifest.archive)
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $archive.FullName).Hash.ToLowerInvariant() -ne $manifest.archiveSha256) { throw 'Original archive differs' }
    $report.originals += [ordered]@{ mode = $mode; archive = $manifest.archive; bytes = $archive.Length; sha256 = $manifest.archiveSha256; contentDigest = $manifest.contentDigest }
    $extract = Join-Path $root "input-$mode"
    & (Join-Path $source 'scripts/qualification/extract-windows-shell.ps1') -Archive $archive.FullName -Destination $extract -Native
    if ($LASTEXITCODE) { throw 'Candidate extraction failed' }
    $payload = @(Get-ChildItem -LiteralPath $extract -Directory)
    if ($payload.Count -ne 1) { throw 'Ambiguous candidate root' }
    $env:PACKAGING_PAYLOAD = $payload[0].FullName
    $env:PACKAGING_SOURCE = $source
    $env:PACKAGING_MODE = $mode
    node --input-type=module -e "import {pathToFileURL} from 'node:url'; const base=pathToFileURL(process.env.PACKAGING_SOURCE+'/scripts/qualification/'); const {verifyPayload}=await import(new URL('product-runtime.mjs',base)); const {verifyWebResources}=await import(new URL('verify-web-resources.mjs',base)); const a=await verifyPayload(process.env.PACKAGING_PAYLOAD); if(a.gitSha!=='$sourceSha'||a.desktopBuildProfile!=='release'||a.developmentOnly||a.resourceMode!==process.env.PACKAGING_MODE) throw Error('Payload identity differs'); await verifyWebResources(process.env.PACKAGING_PAYLOAD+'/resources/web/dist',process.env.PACKAGING_MODE);"
    if ($LASTEXITCODE) { throw 'Original payload verification failed' }
  }
  $fullExe = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root 'input-full/Mizar-v1.3.0-Windows-x64/Mizar.exe')).Hash
  $coreExe = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $root 'input-core/Mizar-v1.3.0-Windows-x64-Core/Mizar.exe')).Hash
  if ($fullExe -ne $coreExe) { throw 'Full/Core do not reuse identical formal compilation' }
  $report.desktopExeSha256 = $fullExe.ToLowerInvariant()
}
Invoke-PackagingPhase 'install-fixed-nsis-tools' {
  & choco install nsis --version=3.11 -y --no-progress
  if ($LASTEXITCODE) { throw 'Fixed NSIS tools unavailable' }
}
$order = if ($First -eq 'full') { @('full', 'core') } else { @('core', 'full') }
for ($round = 1; $round -le 3; $round++) {
  # Counterbalance both runner first order and within-run repeated order.
  $currentOrder = if ($round -eq 2) { @($order[1], $order[0]) } else { $order }
  foreach ($mode in $currentOrder) {
    $script:sample = [ordered]@{ round = $round; mode = $mode; cache = $(if ($round -eq 1) { 'first-invocation-input-prewarmed' } else { 'warm-repeat-fresh-output' }); phases = @() }
    $report.samples += $script:sample
    $out = Join-Path $root "$round-$mode"
    New-Item -ItemType Directory -Path $out | Out-Null
    $originalRoot = @(Get-ChildItem -LiteralPath (Join-Path $root "input-$mode") -Directory)[0]
    $bundle = Join-Path $out $originalRoot.Name
    $env:PACKAGING_INPUT = $originalRoot.FullName
    $env:PACKAGING_OUTPUT = $bundle
    $archive = Join-Path $out ($originalRoot.Name + '.zip')
    if ($mode -eq 'full') {
      $env:PACKAGING_SAMPLE_ROOT = $out
      Invoke-PackagingPhase 'full-assembly-and-compression-total' {
        node --input-type=module -e "import {cp,writeFile} from 'node:fs/promises';import {pathToFileURL} from 'node:url';import {basename} from 'node:path';import {performance} from 'node:perf_hooks';const {createArchive}=await import(pathToFileURL(process.env.PACKAGING_SOURCE+'/scripts/qualification/build.mjs'));const phases=[];const timed=async(phase,op)=>{const t=performance.now();await op();phases.push({phase,durationMs:Math.round(performance.now()-t),status:'success'});await writeFile(process.env.PACKAGING_SAMPLE_ROOT+'/full-packaging-timings.json',JSON.stringify({phases},null,2));};await timed('copy-full-payload',()=>cp(process.env.PACKAGING_INPUT,process.env.PACKAGING_OUTPUT,{recursive:true,force:false,errorOnExist:true}));await timed('zip-archive',()=>createArchive(process.env.PACKAGING_OUTPUT,process.env.PACKAGING_SAMPLE_ROOT,basename(process.env.PACKAGING_OUTPUT)));"
        if ($LASTEXITCODE) { throw 'Full assembly or compression failed' }
      }
      $script:sample.fullPackagingPhases = (Get-Content -Raw -LiteralPath (Join-Path $out 'full-packaging-timings.json') | ConvertFrom-Json).phases
    } else {
      # The original formal Full is the shared compilation/staging boundary. Materialize
      # that input outside Core partition timing; the partition itself always copies it.
      $fullInput = @(Get-ChildItem -LiteralPath (Join-Path $root 'input-full') -Directory)[0]
      $env:PACKAGING_INPUT = $fullInput.FullName
      $env:PACKAGING_OUTPUT = Join-Path $out $fullInput.Name
      Invoke-PackagingPhase 'prepare-shared-full-input-excluded-from-comparison' {
        node --input-type=module -e "import {cp} from 'node:fs/promises'; await cp(process.env.PACKAGING_INPUT,process.env.PACKAGING_OUTPUT,{recursive:true,force:false,errorOnExist:true});"
        if ($LASTEXITCODE) { throw 'Shared Full input preparation failed' }
        Copy-Item -LiteralPath (Join-Path $product 'release-manifest.json') -Destination $out
        Copy-Item -LiteralPath (Join-Path $product 'Mizar-v1.3.0-Windows-x64.zip') -Destination $out
      }
      $env:PACKAGING_OUTPUT = $out
      $env:PACKAGING_INSTRUMENTED_SOURCE = (Get-Location).Path
      Invoke-PackagingPhase 'core-partition-and-compression-total-with-input-verification' {
        node --input-type=module -e "import {pathToFileURL} from 'node:url';import {writeFile} from 'node:fs/promises';import {performance} from 'node:perf_hooks';const {prepareCoreCandidate}=await import(pathToFileURL(process.env.PACKAGING_INSTRUMENTED_SOURCE+'/scripts/qualification/core-candidate.mjs'));const phases=[];const timed=async(phase,op)=>{const t=performance.now();const result=await op();phases.push({phase,durationMs:Math.round(performance.now()-t),status:'success'});await writeFile(process.env.PACKAGING_OUTPUT+'/core-partition-timings.json',JSON.stringify({phases},null,2));return result;};await prepareCoreCandidate(process.env.PACKAGING_OUTPUT,{repository:'$repository',ref:'refs/heads/main',sha:'$sourceSha',event:'workflow_dispatch',workflowRef:'$repository/.github/workflows/release-qualification.yml@refs/heads/main'},'$sourceSha','$sourceSha',timed);"
        if ($LASTEXITCODE) { throw 'Real Core partition failed' }
      }
      $derived = Get-Content -Raw -LiteralPath (Join-Path $out 'core-release-manifest.json') | ConvertFrom-Json
      $originalCore = Get-Content -Raw -LiteralPath (Join-Path $product 'core-release-manifest.json') | ConvertFrom-Json
      if ($derived.contentDigest -ne $originalCore.contentDigest) { throw 'Measured Core payload differs from original qualified Core' }
      $script:sample.corePartitionPhases = (Get-Content -Raw -LiteralPath (Join-Path $out 'core-partition-timings.json') | ConvertFrom-Json).phases
    }
    $script:sample.zipBytes = (Get-Item -LiteralPath $archive).Length
    $script:sample.zipSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
    # Original helper performs actual compile/install/uninstall/reinstall and compares every installed byte.
    $manifestName = if ($mode -eq 'full') { 'release-manifest.json' } else { 'core-release-manifest.json' }
    $distributionName = if ($mode -eq 'full') { 'distribution-manifest.json' } else { 'core-distribution-manifest.json' }
    if ($mode -eq 'full') { Copy-Item -LiteralPath (Join-Path $product $manifestName) -Destination (Join-Path $out $manifestName) }
    $installed = Join-Path $out 'installed'
    Invoke-PackagingPhase 'original-setup-lifecycle' {
      & (Join-Path $source 'scripts/qualification/create-windows-setup.ps1') -BundleRoot $bundle -OutputRoot $out -ExtractRoot $installed -ManifestName $manifestName -DistributionName $distributionName
    }
    $distribution = Get-Content -Raw -LiteralPath (Join-Path $out $distributionName) | ConvertFrom-Json
    $script:sample.setupBytes = $distribution.archiveBytes
    $script:sample.setupSha256 = $distribution.archiveSha256
    $script:sample.installerCompilerSha256 = $distribution.installerCompilerSha256
    $script:sample.installerScriptSha256 = $distribution.installerScriptSha256
    Invoke-PackagingPhase 'cleanup-runner-installation' {
      $uninstaller = Join-Path (Join-Path $installed $originalRoot.Name) 'Uninstall.exe'
      $p = Start-Process -FilePath $uninstaller -ArgumentList @('/S', ('_?=' + (Split-Path $uninstaller))) -PassThru -Wait
      if ($p.ExitCode) { throw 'Runner uninstall failed' }
    }
    Save-Report
    $script:sample = $null
  }
}
