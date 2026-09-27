param([string]$Cs2Root, [switch]$Product)
. (Join-Path $PSScriptRoot 'common.ps1')
if (@(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { throw '请先停止本地制播服务，再安装或验证 GSI 配置' }
if ($Product) {
    $script:QualificationStateRoot = Join-Path $script:StateRoot 'data\gsi-install'
    $script:InstallStatePath = Join-Path $script:QualificationStateRoot 'install.json'
}
$LEGACY_GSI_CFG_NAME = 'gamestate_integration_rivalhub_broadcast.cfg'
$MIZAR_GSI_CFG_NAME = 'gamestate_integration_mizar.cfg'
if (Test-Path -LiteralPath $script:InstallStatePath -PathType Leaf) {
    $existing = Read-InstallState
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
        if ($Cs2Root) { throw '已有安装记录，请先恢复配置后再选择其它 CS2 目录' }
        if (-not (Test-Path -LiteralPath $existingCfgPath -PathType Leaf) -or
            (Get-FileHash -LiteralPath $existingCfgPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$existing.cfgFingerprint) { throw '现有 GSI 配置与安装记录不一致，已保留原备份；请先恢复配置' }
        if ($existingCfgName -ieq $MIZAR_GSI_CFG_NAME) {
            $existingCfgDirectory = Split-Path -Parent $existingCfgPath
            $legacyCfgPath = Join-Path $existingCfgDirectory $LEGACY_GSI_CFG_NAME
            if (Test-Path -LiteralPath $legacyCfgPath -PathType Leaf) {
                Remove-Item -LiteralPath $legacyCfgPath -Force
            }
            Write-Output 'Mizar GSI 配置已安装且一致。'
            exit 0
        }
        throw '现有安装记录不属于 Mizar GSI 配置，已保留原配置；请先恢复配置'
    }
}

function Get-SteamInstallRoots {
    $roots = @()
    foreach ($baseRoot in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:STEAMROOT)) {
        if (-not $baseRoot) { continue }
        $roots += [string]$baseRoot
        $roots += Join-Path ([string]$baseRoot) 'Steam'
    }
    foreach ($registryPath in @(
        'HKCU:\Software\Valve\Steam',
        'HKLM:\SOFTWARE\Valve\Steam',
        'HKLM:\SOFTWARE\WOW6432Node\Valve\Steam'
    )) {
        try {
            $properties = Get-ItemProperty -LiteralPath $registryPath -ErrorAction Stop
            foreach ($propertyName in @('InstallPath', 'SteamPath')) {
                $value = $properties.$propertyName
                if ($value) { $roots += [string]$value }
            }
        } catch { }
    }
    return @($roots | Where-Object { $_ } | ForEach-Object { [string]$_ } | Select-Object -Unique)
}

function Convert-VdfPath {
    param([Parameter(Mandatory = $true)][string]$Value)
    return $Value.Replace('\\', '\').Replace('\"', '"')
}

function Get-SteamLibraryRoots {
    param([Parameter(Mandatory = $true)][string]$SteamRoot)
    $libraries = @($SteamRoot)
    $metadataPath = Join-Path $SteamRoot 'steamapps\libraryfolders.vdf'
    if (Test-Path -LiteralPath $metadataPath -PathType Leaf) {
        try {
            $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8
            foreach ($pattern in @(
                '(?im)^\s*"path"\s+"(?<path>(?:\\.|[^"])*)"',
                '(?im)^\s*"\d+"\s+"(?<path>(?:\\.|[^"])*)"'
            )) {
                foreach ($match in [regex]::Matches($metadata, $pattern)) {
                    $path = Convert-VdfPath -Value $match.Groups['path'].Value
                    if ($path -and (Test-Path -LiteralPath $path -PathType Container)) { $libraries += $path }
                }
            }
        } catch { }
    }
    return @($libraries | Where-Object { $_ } | Select-Object -Unique)
}

function Resolve-CfgDirectory {
    param([string]$ExplicitRoot)
    if ($ExplicitRoot) {
        $resolved = (Resolve-Path -LiteralPath $ExplicitRoot -ErrorAction Stop).Path
        $leaf = Split-Path -Leaf $resolved
        if ($leaf -ieq 'cfg' -and (Test-Path -LiteralPath $resolved -PathType Container)) { return $resolved }
        $candidates = @(
            (Join-Path $resolved 'game\csgo\cfg'),
            (Join-Path $resolved 'csgo\cfg'),
            (Join-Path $resolved 'cfg')
        )
        $candidates = @($candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Container } | Select-Object -Unique)
        if ($candidates.Count -eq 1) { return [string]$candidates[0] }
        throw "无法从 -Cs2Root 解析唯一的 CS2 cfg 目录；请传入 game\csgo\cfg 或 CS2 安装根目录"
    }

    $steamRoots = @(Get-SteamInstallRoots)
    $libraryRoots = @()
    foreach ($steamRoot in $steamRoots) { $libraryRoots += @(Get-SteamLibraryRoots -SteamRoot $steamRoot) }
    $libraryRoots = @($libraryRoots | Where-Object { $_ } | Select-Object -Unique)
    $candidates = @()
    foreach ($libraryRoot in $libraryRoots) {
        foreach ($product in @('Counter-Strike 2', 'Counter-Strike Global Offensive')) {
            foreach ($relative in @('game\csgo\cfg', 'csgo\cfg')) {
                $candidate = Join-Path $libraryRoot "steamapps\common\$product\$relative"
                if (Test-Path -LiteralPath $candidate -PathType Container) { $candidates += $candidate }
            }
        }
    }
    $candidates = @($candidates | Select-Object -Unique)
    if ($candidates.Count -eq 1) { return [string]$candidates[0] }
    if ($candidates.Count -eq 0) { throw '未找到 CS2 cfg 目录；请传入 -Cs2Root <path>' }
    throw "找到多个 CS2 cfg 目录；请传入 -Cs2Root <path> 选择一个（候选数：$($candidates.Count)）"
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
