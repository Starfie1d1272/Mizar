. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-Cs2OperationFailure -Failure $_ -Stage 'status'; exit 1 }
. (Join-Path $PSScriptRoot 'gsi-discovery.ps1')
$result = @{
    detected = $false; installed = $false; conflict = $false; fileConflict = $false; endpointConflict = $false
    readFailed = $false; cfgPath = $null; issueCodes = @(); conflictFiles = @(); candidateCount = 0
    lastOperation = $null; conflictCount = 0
}
try {
    $directory = Resolve-CfgDirectory
    $result.detected = $true
    $result.cfgPath = Join-Path $directory 'gamestate_integration_mizar.cfg'
} catch {
    $code = [string]$_.Exception.Data['MizarCode']
    if (-not $code) { $code = 'status-unreadable'; $result.readFailed = $true }
    $result.issueCodes += $code
}
$result.candidateCount = $script:Cs2CandidateCount
$path = Join-Path $script:StateRoot 'data\gsi-install\install.json'
if (Test-Path -LiteralPath $path -PathType Leaf) {
    try {
        $state = Read-JsonFile $path
        $cfgPath = [string]$state.cfgPath
        if (-not $cfgPath -or (Split-Path -Leaf $cfgPath) -ine 'gamestate_integration_mizar.cfg') { Stop-Cs2Discovery 'record-unreadable' }
        # A selected installation failure remains visible even if the old GSI file survives.
        if ($result.detected -and $result.cfgPath -ine $cfgPath) { Stop-Cs2Discovery 'record-unreadable' }
        if (-not $result.cfgPath) { $result.cfgPath = $cfgPath }
        if (-not (Test-Path -LiteralPath $cfgPath -PathType Leaf)) {
            $result.fileConflict = $true
            $result.issueCodes += 'gsi-file-missing'
        } else {
            $result.installed = (Get-FileHash -LiteralPath $cfgPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -eq [string]$state.cfgFingerprint
            if (-not $result.installed) { $result.fileConflict = $true; $result.issueCodes += 'gsi-file-changed' }
        }
    } catch { $result.readFailed = $true; $result.issueCodes += 'record-unreadable' }
}
if ($result.cfgPath) {
    $directory = Split-Path -Parent $result.cfgPath
    if (Test-Path -LiteralPath $directory -PathType Container) {
        try {
            $result.conflictFiles = @(Get-GsiEndpointConflicts -CfgDirectory $directory -CanonicalCfgPath $result.cfgPath)
            $result.conflictCount = $result.conflictFiles.Count
            $result.endpointConflict = $result.conflictCount -gt 0
            $result.conflictFiles = @($result.conflictFiles | Select-Object -First 32)
            if ($result.endpointConflict) { $result.issueCodes += 'endpoint-conflict' }
        } catch { $result.readFailed = $true; $result.issueCodes += 'status-unreadable' }
    }
}
$failurePath = Join-Path $script:StateRoot 'data\cs2-last-error.json'
if (Test-Path -LiteralPath $failurePath -PathType Leaf) {
    try { $result.lastOperation = Read-JsonFile $failurePath } catch { }
}
$result.issueCodes = @($result.issueCodes | Select-Object -Unique)
$pendingJournal = Join-Path $script:StateRoot 'data\gsi-install\conflicts.json'
if (-not $result.installed -and (Test-Path -LiteralPath $pendingJournal -PathType Leaf)) {
    $result.fileConflict = $true
    $result.issueCodes += 'operation-failed'
}
$result.conflict = $result.fileConflict -or $result.endpointConflict
$result | ConvertTo-Json -Depth 4 -Compress
