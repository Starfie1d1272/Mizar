param(
  [Parameter(Mandatory = $true)][string]$BundleRoot,
  [Parameter(Mandatory = $true)][string]$ArchivePath
)
$ErrorActionPreference = 'Stop'
$source = (Resolve-Path -LiteralPath $BundleRoot).Path
$destination = [IO.Path]::GetFullPath($ArchivePath)
if (Test-Path -LiteralPath $destination) { throw 'Archive already exists; refusing overwrite' }
if ($destination.StartsWith($source + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive must be outside the bundle' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($source, $destination, [IO.Compression.CompressionLevel]::Optimal, $true)
