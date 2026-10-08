param([string]$Cs2Root, [switch]$Product, [switch]$Automatic)
. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-Cs2OperationFailure -Failure $_ -Stage 'install'; exit 1 }
. (Join-Path $PSScriptRoot 'gsi-discovery.ps1')
if (-not $Product -and @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { throw '请先停止本地制播服务，再安装或验证 GSI 配置' }
if ($Product) {
    $script:QualificationStateRoot = Join-Path $script:StateRoot 'data\gsi-install'
    $script:InstallStatePath = Join-Path $script:QualificationStateRoot 'install.json'
}
$LEGACY_GSI_CFG_NAME = 'gamestate_integration_rivalhub_broadcast.cfg'
$MIZAR_GSI_CFG_NAME = 'gamestate_integration_mizar.cfg'
# Automatic preparation never takes ownership of an unknown sender or disables third-party files.
if ($Automatic) {
    if (-not $Product) { throw 'Automatic configuration requires product mode' }
    $safeDirectory = Resolve-CfgDirectory -ExplicitRoot $Cs2Root
    $safePath = Join-Path $safeDirectory $MIZAR_GSI_CFG_NAME
    if (@(Get-GsiEndpointConflicts -CfgDirectory $safeDirectory -CanonicalCfgPath $safePath).Count -gt 0) { Stop-Cs2Discovery 'endpoint-conflict' }
    if (Test-Path -LiteralPath (Join-Path $safeDirectory $LEGACY_GSI_CFG_NAME)) { Stop-Cs2Discovery 'gsi-file-changed' }
    if (Test-Path -LiteralPath $script:InstallStatePath -PathType Leaf) {
        $owned = Read-InstallState
        if ([string]$owned.cfgPath -ine $safePath) { Stop-Cs2Discovery 'record-unreadable' }
        if (-not (Test-Path -LiteralPath $safePath)) {
            # Only recreate bytes whose identity was already recorded by our install transaction.
            $template = Get-Content -LiteralPath (Join-Path $script:BundleRoot 'config\gamestate_integration_mizar.cfg.template') -Raw -Encoding UTF8
            $restored = $template.Replace('REPLACE_WITH_GSI_TOKEN', [string]$owned.gsiToken)
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try { $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($restored))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
            if ($digest -ne [string]$owned.cfgFingerprint) { Stop-Cs2Discovery 'gsi-file-changed' }
            Write-Utf8NoBom -Path $safePath -Content $restored
        }
    } elseif (Test-Path -LiteralPath $safePath) { Stop-Cs2Discovery 'gsi-file-changed' }
}
if (Test-Path -LiteralPath $script:InstallStatePath -PathType Leaf) {
    try { $existing = Read-InstallState } catch { Stop-Cs2Discovery 'record-unreadable' }
    $existingCfgPath = [string]$existing.cfgPath
    $existingCfgName = Split-Path -Leaf $existingCfgPath
    if ($existingCfgName -ieq $LEGACY_GSI_CFG_NAME) {
        if (-not $Cs2Root -and $existingCfgPath) {
            $Cs2Root = Split-Path -Parent $existingCfgPath
        }
        if (Test-Path -LiteralPath $existingCfgPath -PathType Leaf) {
            Remove-Item -LiteralPath $existingCfgPath -Force
        }
        Remove-Item -LiteralPath $script:QualificationStateRoot -Recurse -Force
        Write-Output '已清理预发布 RivalHub Broadcast GSI 安装记录，继续安装 Mizar。'
    } else {
        if ($Cs2Root) { Stop-Cs2Discovery 'restore-before-selection' }
        if (-not (Test-Path -LiteralPath $existingCfgPath -PathType Leaf) -or
            (Get-FileHash -LiteralPath $existingCfgPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$existing.cfgFingerprint) { Stop-Cs2Discovery 'gsi-file-changed' }
        if ($existingCfgName -ieq $MIZAR_GSI_CFG_NAME) {
            $existingCfgDirectory = Split-Path -Parent $existingCfgPath
            $legacyCfgPath = Join-Path $existingCfgDirectory $LEGACY_GSI_CFG_NAME
            if (Test-Path -LiteralPath $legacyCfgPath -PathType Leaf) {
                Remove-Item -LiteralPath $legacyCfgPath -Force
            }
            if ($Product -and -not $Automatic) { Suspend-GsiEndpointConflicts -CfgDirectory $existingCfgDirectory -CanonicalCfgPath $existingCfgPath }
            Write-Output 'Mizar GSI 配置已安装且一致。'
            Clear-Cs2OperationError
            exit 0
        }
        Stop-Cs2Discovery 'record-unreadable'
    }
}

$cfgDirectory = Resolve-CfgDirectory -ExplicitRoot $Cs2Root
$cfgPath = Join-Path $cfgDirectory $MIZAR_GSI_CFG_NAME
$legacyCfgPath = Join-Path $cfgDirectory $LEGACY_GSI_CFG_NAME
New-Item -ItemType Directory -Force -Path $script:QualificationStateRoot | Out-Null
$backupPath = Join-Path $script:QualificationStateRoot "$MIZAR_GSI_CFG_NAME.original"
$hadExisting = Test-Path -LiteralPath $cfgPath -PathType Leaf
if ($hadExisting) { Copy-Item -LiteralPath $cfgPath -Destination $backupPath -Force }
if (Test-Path -LiteralPath $legacyCfgPath -PathType Leaf) {
    Remove-Item -LiteralPath $legacyCfgPath -Force
}
if (Test-Path -LiteralPath $legacyCfgPath) { throw '旧 GSI 配置仍然存在' }
if ($Product -and -not $Automatic) { Suspend-GsiEndpointConflicts -CfgDirectory $cfgDirectory -CanonicalCfgPath $cfgPath }
else { Write-GsiEndpointConflictWarning -CfgDirectory $cfgDirectory -CanonicalCfgPath $cfgPath | Out-Null }

$token = New-QualificationToken
if ($Product) {
    $tokenPath = Join-Path $script:StateRoot 'data\gsi-token.txt'
    if (Test-Path -LiteralPath $tokenPath -PathType Leaf) {
        $token = (Get-Content -LiteralPath $tokenPath -Raw -Encoding UTF8).Trim()
        if ($token -notmatch '^[a-f0-9]{64}$') { throw '本地 GSI 令牌文件无效' }
    } else {
        $bytes = [byte[]]::new(32)
        $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
        $token = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
        Write-Utf8NoBom -Path $tokenPath -Content $token
    }
}
$templatePath = Join-Path $script:BundleRoot 'config\gamestate_integration_mizar.cfg.template'
$template = Get-Content -LiteralPath $templatePath -Raw -Encoding UTF8
$materialized = $template.Replace('REPLACE_WITH_GSI_TOKEN', $token)

$cs2RootForVersion = Split-Path (Split-Path (Split-Path $cfgDirectory -Parent) -Parent) -Parent
$cs2ExecutableCandidates = @(
    (Join-Path $cs2RootForVersion 'game\bin\win64\cs2.exe'),
    (Join-Path (Split-Path $cfgDirectory -Parent) 'bin\win64\cs2.exe')
)
$cs2ExecutableCandidates = @($cs2ExecutableCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -Unique)
$cs2Version = 'unknown'
if ($cs2ExecutableCandidates.Count -gt 0) {
    $reportedVersion = [string](Get-Item -LiteralPath $cs2ExecutableCandidates[0]).VersionInfo.ProductVersion
    if (-not [string]::IsNullOrWhiteSpace($reportedVersion)) { $cs2Version = $reportedVersion.Trim() }
}

$hasher = [System.Security.Cryptography.SHA256]::Create()
try { $fingerprint = [BitConverter]::ToString($hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($materialized))).Replace('-', '').ToLowerInvariant() } finally { $hasher.Dispose() }
$state = [ordered]@{
    schemaVersion = 1
    cfgPath = $cfgPath
    backupPath = $(if ($hadExisting) { $backupPath } else { $null })
    hadExistingConfig = $hadExisting
    gsiToken = $token
    cs2Version = $cs2Version
    cfgFingerprint = $fingerprint
    installedAt = (Get-Date).ToUniversalTime().ToString('o')
}
# Record the original before touching the canonical sender; an interrupted write
# can then be undone by restore instead of losing the user's original config.
$pendingState = $script:InstallStatePath + '.pending'
Write-JsonFile -Path $pendingState -Value $state
[System.IO.File]::Move($pendingState, $script:InstallStatePath)
Write-Utf8NoBom -Path $cfgPath -Content $materialized

Write-Output "GSI 配置已安装：$cfgPath"
Write-Output "配置指纹（SHA-256）：$fingerprint"
Write-Output 'GSI 令牌仅保存在本地运行数据目录。'
if ($Product) { Write-Output '下一步：双击 Mizar.exe。' } else { Write-Output '下一步：执行 start.ps1。' }

Clear-Cs2OperationError
