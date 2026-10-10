param(
  [Parameter(Mandatory = $true)][string]$Archive,
  [Parameter(Mandatory = $true)][string]$Destination
)
$ErrorActionPreference = 'Stop'
# Tool installation writes Program Files; extraction writes only Destination.
# Both must finish before any payload or installer can execute.
$tool = Start-Job -ScriptBlock {
  $ErrorActionPreference = 'Stop'
  $timer = [Diagnostics.Stopwatch]::StartNew()
  try {
    choco install nsis --version=3.11 -y --no-progress
    if ($LASTEXITCODE -ne 0) { throw 'Pinned NSIS installation failed' }
  } finally {
    Write-Host "SETUP_PREPARATION nsis: $($timer.ElapsedMilliseconds) ms"
  }
}
$timer = [Diagnostics.Stopwatch]::StartNew()
try {
  & (Join-Path $PSScriptRoot 'extract-windows-shell.ps1') -Archive $Archive -Destination $Destination
} finally {
  Write-Host "SETUP_PREPARATION extract: $($timer.ElapsedMilliseconds) ms"
  try {
    $tool | Wait-Job | Out-Null
    $tool | Receive-Job -ErrorAction Stop
    if ($tool.State -ne 'Completed') { throw 'Pinned NSIS installation did not complete' }
  } finally {
    $tool | Remove-Job
  }
}
