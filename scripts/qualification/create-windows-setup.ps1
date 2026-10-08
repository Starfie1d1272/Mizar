param(
  [Parameter(Mandatory = $true)][string]$BundleRoot,
  [Parameter(Mandatory = $true)][string]$OutputRoot,
  [Parameter(Mandatory = $true)][string]$ExtractRoot
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $BundleRoot).Path
$name = Split-Path $source -Leaf
$output = [IO.Path]::GetFullPath($OutputRoot)
$extract = [IO.Path]::GetFullPath($ExtractRoot)
$target = Join-Path $extract $name
$archive = Join-Path $output ($name + '-Setup.exe')
if ((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath $extract)) { throw 'Setup output/install path already exists' }
$compiler = Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'NSIS 3.11 is required' }
$version = (& $compiler /VERSION | Out-String).Trim()
if ($version -ne 'v3.11') { throw "Unexpected NSIS version: $version" }
$manifest = Get-Content -Raw -LiteralPath (Join-Path $output 'release-manifest.json') | ConvertFrom-Json
$files = @(Get-ChildItem -LiteralPath $source -Recurse -File)
# NSIS has its own escaping rules. Never interpolate a payload path as instructions.
function Escape-Nsis([string]$text) { $text.Replace('$', '$$').Replace('"', '$\"') }
$remove = Join-Path $output 'setup-remove.nsh'
$lines = @($files | ForEach-Object { 'Delete "$INSTDIR\' + (Escape-Nsis ([IO.Path]::GetRelativePath($source, $_.FullName))) + '"' })
$lines += @(Get-ChildItem -LiteralPath $source -Recurse -Directory | Sort-Object { $_.FullName.Length } -Descending | ForEach-Object { 'RMDir "$INSTDIR\' + (Escape-Nsis ([IO.Path]::GetRelativePath($source, $_.FullName))) + '"' })
$lines | Set-Content -LiteralPath $remove -Encoding utf8
$script = Join-Path $PSScriptRoot 'windows-setup.nsi'
$icon = Join-Path $PSScriptRoot '../../apps/desktop/src-tauri/icons/icon.ico'
& $compiler /INPUTCHARSET UTF8 "/DPAYLOAD=$source" "/DOUTPUT=$archive" "/DVERSION=$($manifest.appVersion)" "/DICON=$icon" "/DREMOVE_FILES=$remove" $script
if ($LASTEXITCODE -ne 0) { throw 'NSIS build failed' }
function Install-Setup {
  $process = Start-Process -FilePath $archive -ArgumentList @('/S', ('/D=' + $target)) -PassThru -Wait
  if ($process.ExitCode -ne 0) { throw 'Setup installation failed' }
}
Install-Setup
# Verify exact qualified payload before running anything from the installation.
foreach ($file in $files) {
  $relative = [IO.Path]::GetRelativePath($source, $file.FullName)
  if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target $relative)).Hash) { throw "Setup payload differs: $relative" }
}
$extra = @(Get-ChildItem -LiteralPath $target -Recurse -File | Where-Object {
  $relative = [IO.Path]::GetRelativePath($target, $_.FullName)
  $relative -notin @('installed.flag', 'Uninstall.exe') -and !(Test-Path -LiteralPath (Join-Path $source $relative))
})
if ($extra.Count) { throw 'Unexpected Setup payload files' }
$sentinel = Join-Path $env:LOCALAPPDATA 'Mizar\data\setup-smoke-sentinel.txt'
if (Test-Path -LiteralPath $sentinel) { throw 'Refusing to overwrite existing smoke sentinel' }
New-Item -ItemType Directory -Force -Path (Split-Path $sentinel) | Out-Null
Set-Content -LiteralPath $sentinel -Value 'preserve-user-data'
try {
  Install-Setup
  $process = Start-Process -FilePath (Join-Path $target 'Uninstall.exe') -ArgumentList @('/S', ('_?=' + $target)) -PassThru -Wait
  if ($process.ExitCode -ne 0 -or (Test-Path -LiteralPath (Join-Path $target 'Mizar.exe'))) { throw 'Setup uninstall failed' }
  if ((Get-Content -LiteralPath $sentinel -Raw).Trim() -ne 'preserve-user-data') { throw 'User data changed' }
  Install-Setup
  foreach ($file in $files) {
    $relative = [IO.Path]::GetRelativePath($source, $file.FullName)
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $target $relative)).Hash) { throw "Reinstall payload differs: $relative" }
  }
} finally { Remove-Item -LiteralPath $sentinel -ErrorAction SilentlyContinue }
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
  installerLicense = $licenseName
  installerLicenseSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $licensePath).Hash.ToLowerInvariant()
  verifiedFiles = $files.Count
}
$distribution | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'distribution-manifest.json') -Encoding utf8NoBOM
$distribution | ConvertTo-Json
