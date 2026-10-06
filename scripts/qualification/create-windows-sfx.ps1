param(
  [Parameter(Mandatory = $true)][string]$BundleRoot,
  [Parameter(Mandatory = $true)][string]$OutputRoot,
  [Parameter(Mandatory = $true)][string]$ExtractRoot
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $BundleRoot).Path
$name = Split-Path $source -Leaf
$sevenZip = Join-Path $env:ProgramFiles '7-Zip/7z.exe'
$stub = Join-Path $env:ProgramFiles '7-Zip/7z.sfx'
if (!(Test-Path -LiteralPath $sevenZip) -or !(Test-Path -LiteralPath $stub)) { throw 'Missing 7-Zip GUI SFX tooling' }
$output = [IO.Path]::GetFullPath($OutputRoot)
$archive = Join-Path $output ($name + '.exe')
$extract = [IO.Path]::GetFullPath($ExtractRoot)
if ((Test-Path -LiteralPath $archive) -or (Test-Path -LiteralPath $extract)) { throw 'SFX output/extraction already exists; refusing overwrite' }
if ($extract.StartsWith($source + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Extraction must be outside the source bundle' }
Push-Location (Split-Path $source -Parent)
try {
  & $sevenZip a '-t7z' '-m0=LZMA2' '-mx=9' '-md=64m' '-ms=on' '-mmt=2' "-sfx$stub" $archive $name
  if ($LASTEXITCODE -ne 0) { throw 'SFX compression failed' }
} finally { Pop-Location }
# Execute the actual extractor, including its handling of a path with spaces.
$process = Start-Process -FilePath $archive -ArgumentList @('-y', ('-o"' + $extract + '"')) -PassThru -Wait
if ($process.ExitCode -ne 0) { throw 'SFX extraction failed' }
$extractedBundle = Join-Path $extract $name
$original = @(Get-ChildItem -LiteralPath $source -Recurse -File | ForEach-Object { [IO.Path]::GetRelativePath($source, $_.FullName) } | Sort-Object)
$actual = @(Get-ChildItem -LiteralPath $extractedBundle -Recurse -File | ForEach-Object { [IO.Path]::GetRelativePath($extractedBundle, $_.FullName) } | Sort-Object)
if ($original.Count -ne $actual.Count -or @(Compare-Object $original $actual).Count -ne 0) { throw 'SFX file paths differ' }
foreach ($relative in $original) {
  $expected = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $source $relative)).Hash
  $observed = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $extractedBundle $relative)).Hash
  if ($expected -ne $observed) { throw "SFX content differs: $relative" }
}
$manifest = Get-Content -Raw -LiteralPath (Join-Path $output 'release-manifest.json') | ConvertFrom-Json
$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $archive).Hash.ToLowerInvariant()
$archiveName = Split-Path $archive -Leaf
Set-Content -LiteralPath ($archive + '.sha256') -Value "$digest  $archiveName" -Encoding utf8NoBOM
$toolVersion = (Get-Item -LiteralPath $sevenZip).VersionInfo.FileVersion
if ($toolVersion -notmatch '^(\d+)\.(\d+)') { throw 'Cannot resolve exact 7-Zip source version' }
$sourceArchiveName = '7z' + ([int]$Matches[1]).ToString('D2') + ([int]$Matches[2]).ToString('D2') + '-src.7z'
$sourceUrl = 'https://www.7-zip.org/a/' + $sourceArchiveName
$sourceArchive = Join-Path $output $sourceArchiveName
Invoke-WebRequest -Uri $sourceUrl -OutFile $sourceArchive
& $sevenZip t $sourceArchive
if ($LASTEXITCODE -ne 0) { throw '7-Zip source archive verification failed' }
$licensePath = Join-Path $source '7zip-LICENSE.txt'
$licenseName = '7zip-LICENSE.txt'
Copy-Item -LiteralPath $licensePath -Destination (Join-Path $output $licenseName)
$distribution = [ordered]@{
  schemaVersion = 1
  gitSha = $manifest.gitSha
  appVersion = $manifest.appVersion
  contentDigest = $manifest.contentDigest
  originalArchiveSha256 = $manifest.archiveSha256
  archive = $archiveName
  archiveSha256 = $digest
  archiveBytes = (Get-Item -LiteralPath $archive).Length
  originalArchiveBytes = (Get-Item -LiteralPath (Join-Path $output $manifest.archive)).Length
  format = '7zip-gui-sfx-lzma2-solid'
  sevenZipVersion = $toolVersion
  extractorLicense = $licenseName
  extractorLicenseSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $licensePath).Hash.ToLowerInvariant()
  extractorSourceArchive = $sourceArchiveName
  extractorSourceUrl = $sourceUrl
  extractorSourceSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $sourceArchive).Hash.ToLowerInvariant()
  extractorStubSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $stub).Hash.ToLowerInvariant()
  verifiedFiles = $original.Count
}
$distribution | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'distribution-manifest.json') -Encoding utf8NoBOM
$distribution | ConvertTo-Json
