param(
  [Parameter(Mandatory = $true)][ValidateSet('serial', 'parallel')][string]$Mode,
  [Parameter(Mandatory = $true)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
$source = 'fbf4bf51680dd206e0f0cb303884af82714011b7'
$run = '38134657329'
$coreManifestHash = '608873fc8ecf128e5ff072356321ca4164181e7efc9340ee189efbf28cae6f1d'
$root = [IO.Path]::GetFullPath($OutputDirectory)
if (Test-Path -LiteralPath $root) { throw 'Benchmark destination must be fresh' }
New-Item -ItemType Directory -Path $root | Out-Null
$product = Join-Path $root 'product'
$extract = Join-Path $root 'core candidate extracted'
$installed = Join-Path $root 'core installed qualification'
$phases = [Collections.Generic.List[object]]::new()
$toolsSource = (& git rev-parse HEAD).Trim()
function Invoke-BenchmarkPhase([string]$Name, [scriptblock]$Operation) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $status = 'failure'
  try { & $Operation; $status = 'success' }
  finally {
    $phases.Add([ordered]@{ phase = $Name; durationMs = $timer.ElapsedMilliseconds; status = $status })
    [ordered]@{ schemaVersion = 1; mode = $Mode; toolsSourceSha = $toolsSource; candidateSourceSha = $source; candidateRun = $run; publication = $false; phases = @($phases.ToArray()) } |
      ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'report.json') -Encoding utf8NoBOM
    Write-Host "CORE_PREPARATION_BENCHMARK ${Name}: $($timer.ElapsedMilliseconds) ms ($status)"
  }
}
Invoke-BenchmarkPhase 'candidate-download-and-identity' {
  $runJson = & gh api "repos/Starfie1d1272/Mizar/actions/runs/$run"
  if ($LASTEXITCODE -ne 0) { throw 'Cannot read fixed successful qualification run' }
  $env:CORE_BENCHMARK_RUN_JSON = $runJson | Out-String
  try {
    node --input-type=module -e "import { assertQualificationRun } from './scripts/qualification/release-identity.mjs'; assertQualificationRun(JSON.parse(process.env.CORE_BENCHMARK_RUN_JSON), '$source');"
    if ($LASTEXITCODE -ne 0) { throw 'Benchmark candidate run is not the pinned main qualification' }
  } finally { Remove-Item Env:CORE_BENCHMARK_RUN_JSON }
  & gh run download $run --repo Starfie1d1272/Mizar --name release-candidate --dir $product
  if ($LASTEXITCODE -ne 0) { throw 'Cannot download the unchanged candidate' }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $product 'core-release-manifest.json')).Hash.ToLowerInvariant() -ne $coreManifestHash) { throw 'Fixed Core manifest differs' }
  $script:core = Get-Content -LiteralPath (Join-Path $product 'core-release-manifest.json') -Raw | ConvertFrom-Json
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $product $core.archive)).Hash.ToLowerInvariant() -ne $core.archiveSha256) { throw 'Fixed Core ZIP differs' }
  $full = Get-Content -LiteralPath (Join-Path $product 'release-manifest.json') -Raw | ConvertFrom-Json
  node scripts/qualification/verify-candidate.mjs $product $source $full.archiveSha256
  if ($LASTEXITCODE -ne 0) { throw 'Same-run Full candidate identity differs' }
}
Invoke-BenchmarkPhase 'preparation' {
  if ($Mode -eq 'parallel') {
    & ./scripts/qualification/prepare-windows-setup.ps1 -Archive (Join-Path $product $core.archive) -Destination $extract
  } else {
    & choco install nsis --version=3.11 -y --no-progress
    if ($LASTEXITCODE -ne 0) { throw 'Pinned NSIS installation failed' }
  }
}
Invoke-BenchmarkPhase 'native-update-recovery' {
  node scripts/qualification/verify-update-recovery.mjs | Tee-Object -FilePath (Join-Path $root 'update-recovery.log')
  if ($LASTEXITCODE -ne 0) { throw 'Native update recovery failed' }
}
Invoke-BenchmarkPhase 'serial-extraction' {
  if ($Mode -eq 'serial') {
    & ./scripts/qualification/extract-windows-shell.ps1 -Archive (Join-Path $product $core.archive) -Destination $extract
  }
}
Invoke-BenchmarkPhase 'core-build-install-and-all-qualification-checks' {
  $payload = @(Get-ChildItem -LiteralPath $extract -Directory)
  if ($payload.Count -ne 1) { throw 'Core extraction is ambiguous' }
  & ./scripts/qualification/create-windows-setup.ps1 -BundleRoot $payload[0].FullName -OutputRoot $product -ExtractRoot $installed -ManifestName core-release-manifest.json -DistributionName core-distribution-manifest.json
  $installedRoot = @(Get-ChildItem -LiteralPath $installed -Directory)
  if ($installedRoot.Count -ne 1) { throw 'Core installation is ambiguous' }
  node scripts/qualification/verify-core-candidate.mjs $product $installedRoot[0].FullName $source (Join-Path $product 'core-setup-identity.json')
  if ($LASTEXITCODE -ne 0) { throw 'Core identity or resource boundary failed' }
  node scripts/qualification/product-smoke.mjs $installedRoot[0].FullName
  if ($LASTEXITCODE -ne 0) { throw 'Real installed Core startup failed' }
  node scripts/qualification/desktop-smoke.mjs $installedRoot[0].FullName (Join-Path $product 'core-desktop-smoke.json')
  if ($LASTEXITCODE -ne 0) { throw 'Real Core desktop startup failed' }
}
