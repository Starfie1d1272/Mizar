param(
  [Parameter(Mandatory = $true)][string]$BundleRoot,
  [Parameter(Mandatory = $true)][string]$OutputRoot,
  [Parameter(Mandatory = $true)][string]$ExtractRoot,
  [switch]$BuildOnly,
  [string]$CompilerPath = (Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'),
  [ValidateSet('release-manifest.json','core-release-manifest.json')][string]$ManifestName = 'release-manifest.json',
  [ValidateSet('distribution-manifest.json','core-distribution-manifest.json')][string]$DistributionName = 'distribution-manifest.json'
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $BundleRoot).Path
$name = Split-Path $source -Leaf
$output = [IO.Path]::GetFullPath($OutputRoot)
$extract = [IO.Path]::GetFullPath($ExtractRoot)
$target = Join-Path $extract $name
$archive = Join-Path $output ($name + '-Setup.exe')
if ((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath $extract)) { throw 'Setup output/install path already exists' }
$compiler = [IO.Path]::GetFullPath($CompilerPath)
if (!(Test-Path -LiteralPath $compiler)) { throw 'NSIS 3.11 is required' }
$version = (& $compiler /VERSION | Out-String).Trim()
if ($version -ne 'v3.11') { throw "Unexpected NSIS version: $version" }
$manifest = Get-Content -Raw -LiteralPath (Join-Path $output $ManifestName) | ConvertFrom-Json
$files = @(Get-ChildItem -LiteralPath $source -Recurse -File)
$phases = [Collections.Generic.List[object]]::new()
$timingsName = if ($ManifestName -eq 'core-release-manifest.json') { 'core-setup-timings.json' } else { 'setup-timings.json' }
function Invoke-SetupPhase([string]$Name, [scriptblock]$Operation) {
  $timer = [Diagnostics.Stopwatch]::StartNew()
  $status = 'failure'
  try {
    & $Operation
    $status = 'success'
  } finally {
    $duration = $timer.ElapsedMilliseconds
    $phases.Add([ordered]@{ phase = $Name; durationMs = $duration; status = $status })
    [ordered]@{ schemaVersion = 1; gitSha = $manifest.gitSha; appVersion = $manifest.appVersion; archive = (Split-Path $archive -Leaf); phases = @($phases.ToArray()) } |
      ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output $timingsName) -Encoding utf8NoBOM
    Write-Host "SETUP_TIMING ${Name}: $duration ms ($status)"
    if ($env:GITHUB_STEP_SUMMARY) { Add-Content -LiteralPath $env:GITHUB_STEP_SUMMARY -Value "- Setup ${Name}: $duration ms ($status)" }
  }
}
$script = Join-Path $PSScriptRoot 'windows-setup.nsi'
$assets = Join-Path $PSScriptRoot 'installer-assets'
$assetManifestPath = Join-Path $assets 'sources.json'
$assetManifest = Get-Content -Raw -LiteralPath $assetManifestPath | ConvertFrom-Json
$installerAssets = @($assetManifest.files | ForEach-Object {
  if ($_.path -notmatch '^[a-z]+\.(bmp|svg)$') { throw 'Invalid installer asset path' }
  $asset = Join-Path $assets $_.path
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $asset).Hash.ToLowerInvariant()
  if ($hash -ne $_.sha256 -or (Get-Item -LiteralPath $asset).Length -ne $_.bytes) { throw "Installer asset differs: $($_.path)" }
  [ordered]@{ path = $_.path; sha256 = $hash; bytes = $_.bytes }
})
$brandSource = Join-Path $PSScriptRoot ('../../' + $assetManifest.source)
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $brandSource).Hash.ToLowerInvariant() -ne $assetManifest.sourceSha256) { throw 'Installer brand source differs' }
$icon = Join-Path $PSScriptRoot '../../apps/desktop/src-tauri/icons/icon.ico'
Invoke-SetupPhase 'compile' {
  & $compiler /INPUTCHARSET UTF8 "/DPAYLOAD=$source" "/DOUTPUT=$archive" "/DVERSION=$($manifest.appVersion)" "/DICON=$icon" "/DINSTALLER_ASSETS=$assets" $script
  if ($LASTEXITCODE -ne 0) { throw 'NSIS build failed' }
}
function Install-Setup {
  $process = Start-Process -FilePath $archive -ArgumentList @('/S', ('/D=' + $target)) -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw 'Setup installation failed' }
}
if (!$BuildOnly) {
Invoke-SetupPhase 'first-install' { Install-Setup }
Invoke-SetupPhase 'first-payload-verification' {
  # Verify v2 side-by-side layout: current.json, root Mizar.exe (launcher), Uninstall.exe (applier), and versions/<id>/*
  $pointer = Get-Content -Raw -LiteralPath (Join-Path $target 'current.json') | ConvertFrom-Json
  if ($pointer.schemaVersion -ne 2 -or !$pointer.current) { throw 'Invalid current.json' }
  $versionDir = Join-Path (Join-Path $target 'versions') $pointer.current
  foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($source, $file.FullName)
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $versionDir $relative)).Hash) { throw "Setup payload differs: $relative" }
  }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $source 'mizar-launcher.exe')).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target 'Mizar.exe')).Hash) { throw 'Root Mizar.exe differs from mizar-launcher.exe' }
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $source 'mizar-applier.exe')).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target 'Uninstall.exe')).Hash) { throw 'Root Uninstall.exe differs from mizar-applier.exe' }
}
}
$licenseName = 'NSIS-LICENSE.txt'
$licensePath = Join-Path $output $licenseName
Copy-Item -LiteralPath (Join-Path (Split-Path $compiler) 'COPYING') -Destination $licensePath
$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
$archiveName = Split-Path $archive -Leaf
Set-Content -LiteralPath ($archive + '.sha256') -Value "$digest  $archiveName" -Encoding utf8NoBOM
$distribution = [ordered]@{
  schemaVersion = 1; gitSha = $manifest.gitSha; appVersion = $manifest.appVersion
  contentDigest = $manifest.contentDigest; originalArchiveSha256 = $manifest.archiveSha256
  archive = $archiveName; archiveSha256 = $digest; archiveBytes = (Get-Item -LiteralPath $archive).Length
  format = 'nsis-setup'; installerVersion = $version
  installerCompilerSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $compiler).Hash.ToLowerInvariant()
  installerScriptSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $script).Hash.ToLowerInvariant()
  installerAssets = $installerAssets
  installerAssetsManifestSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $assetManifestPath).Hash.ToLowerInvariant()
  installerIconSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $icon).Hash.ToLowerInvariant()
  installerLicense = $licenseName
  installerLicenseSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $licensePath).Hash.ToLowerInvariant()
  verifiedFiles = $(if ($BuildOnly) { 0 } else { $files.Count })
}
$distribution | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $output $DistributionName) -Encoding utf8NoBOM
$distribution | ConvertTo-Json -Depth 5
