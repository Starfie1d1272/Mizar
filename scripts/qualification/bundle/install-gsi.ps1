param([string]$Cs2Root, [switch]$Product)
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
Write-GsiEndpointConflictWarning -CfgDirectory $cfgDirectory -CanonicalCfgPath $cfgPath | Out-Null

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
Write-Utf8NoBom -Path $cfgPath -Content $materialized

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

$fingerprint = (Get-FileHash -LiteralPath $cfgPath -Algorithm SHA256).Hash.ToLowerInvariant()
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
Write-JsonFile -Path $script:InstallStatePath -Value $state

Write-Output "GSI 配置已安装：$cfgPath"
Write-Output "配置指纹（SHA-256）：$fingerprint"
Write-Output 'GSI 令牌仅保存在本地运行数据目录。'
if ($Product) { Write-Output '下一步：双击 Mizar.exe。' } else { Write-Output '下一步：执行 start.ps1。' }

Clear-Cs2OperationError
