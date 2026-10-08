param([Parameter(Mandatory = $true)][string]$Cs2Root, [switch]$Product)
. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-Cs2OperationFailure -Failure $_ -Stage 'selection'; exit 1 }
. (Join-Path $PSScriptRoot 'gsi-discovery.ps1')
$installation = Resolve-Cs2Input $Cs2Root
$recordPath = Join-Path $script:StateRoot 'data\gsi-install\install.json'
if (Test-Path -LiteralPath $recordPath -PathType Leaf) {
    try { $record = Read-JsonFile $recordPath } catch { Stop-Cs2Discovery 'record-unreadable' }
    $existing = [string]$record.cfgPath
    $target = Join-Path $installation.cfg 'gamestate_integration_mizar.cfg'
    if ($existing -ine $target) { Stop-Cs2Discovery 'restore-before-selection' }
}
$journalPath = Join-Path $script:StateRoot 'data\gsi-install\conflicts.json'
if (Test-Path -LiteralPath $journalPath -PathType Leaf) {
    try { $journal = Read-JsonFile $journalPath } catch { Stop-Cs2Discovery 'record-unreadable' }
    if ([string]$journal.cfgDirectory -ine $installation.cfg) { Stop-Cs2Discovery 'restore-before-selection' }
}
$selectionPath = Get-Cs2SelectionPath
$directory = Split-Path -Parent $selectionPath
New-Item -ItemType Directory -Force -Path $directory | Out-Null
$temporary = Join-Path $directory ([IO.Path]::GetRandomFileName())
try {
    Write-JsonFile $temporary @{ version = 1; root = $installation.root }
    if (Test-Path -LiteralPath $selectionPath -PathType Leaf) { [IO.File]::Replace($temporary, $selectionPath, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $selectionPath) }
} finally {
    if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force }
}
Clear-Cs2OperationError
