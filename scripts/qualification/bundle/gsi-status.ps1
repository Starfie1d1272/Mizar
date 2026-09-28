. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'gsi-discovery.ps1')
$result = @{ detected = $false; installed = $false; conflict = $false; fileConflict = $false; endpointConflict = $false; cfgPath = $null }
try { $directory = Resolve-CfgDirectory; $result.detected = $true; $result.cfgPath = Join-Path $directory 'gamestate_integration_mizar.cfg' } catch { }
$path = Join-Path $script:StateRoot 'data\gsi-install\install.json'
if (Test-Path -LiteralPath $path -PathType Leaf) {
  try {
    $state = Read-JsonFile -Path $path
    $result.cfgPath = [string]$state.cfgPath
    $result.detected = Test-Path -LiteralPath (Split-Path -Parent $result.cfgPath) -PathType Container
    $result.installed = (Test-Path -LiteralPath $result.cfgPath -PathType Leaf) -and ((Get-FileHash -LiteralPath $result.cfgPath -Algorithm SHA256).Hash.ToLowerInvariant() -eq [string]$state.cfgFingerprint)
    $result.fileConflict = -not $result.installed
  } catch { $result.fileConflict = $true }
}
$directory = Split-Path -Parent ([string]$result.cfgPath)
if ($directory -and (Test-Path -LiteralPath $directory -PathType Container)) {
  try {
    $result.endpointConflict = @(Get-GsiEndpointConflicts -CfgDirectory $directory -CanonicalCfgPath ([string]$result.cfgPath)).Count -gt 0
  } catch { $result.endpointConflict = $true }
}
$result.conflict = $result.fileConflict -or $result.endpointConflict
$result | ConvertTo-Json -Compress
