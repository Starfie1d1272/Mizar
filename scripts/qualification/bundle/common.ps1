Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# The desktop reads pipes as UTF-8 even when PowerShell has no console.
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$script:BundleRoot = Split-Path -Parent $PSScriptRoot
$script:ProductRoot = Split-Path -Parent $script:BundleRoot
$script:StateRoot = Join-Path $script:ProductRoot 'state'
if ($env:MIZAR_STATE_ROOT) {
    if (-not [System.IO.Path]::IsPathRooted($env:MIZAR_STATE_ROOT)) { throw '运行数据目录必须是绝对路径' }
    $script:StateRoot = [System.IO.Path]::GetFullPath($env:MIZAR_STATE_ROOT)
}
$resourcePath = [System.IO.Path]::GetFullPath($script:BundleRoot).TrimEnd('\')
$statePath = [System.IO.Path]::GetFullPath($script:StateRoot).TrimEnd('\')
if ($statePath -eq $resourcePath -or $statePath.StartsWith($resourcePath + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw '运行数据目录不能位于程序资源目录内' }
$script:QualificationStateRoot = Join-Path $script:StateRoot 'qualification'
$script:InstallStatePath = Join-Path $script:QualificationStateRoot 'install.json'
$script:RunStatePath = Join-Path $script:QualificationStateRoot 'run.json'

# Export only bounded error codes; raw PowerShell errors never cross desktop IPC.
function Write-Cs2OperationFailure {
    param([System.Management.Automation.ErrorRecord]$Failure, [string]$Stage)
    $code = [string]$Failure.Exception.Data['MizarCode']
    if (-not $code) {
        $code = if ($Failure.Exception -is [UnauthorizedAccessException] -or $Failure.CategoryInfo.Category -eq 'PermissionDenied') { 'access-denied' } else { 'operation-failed' }
    }
    $diagnostic = @{ code = $code; stage = $Stage }
    try { Write-JsonFile -Path (Join-Path $script:StateRoot 'data\cs2-last-error.json') -Value $diagnostic } catch { }
    @{ error = $diagnostic } | ConvertTo-Json -Compress
}

function Clear-Cs2OperationError {
    $path = Join-Path $script:StateRoot 'data\cs2-last-error.json'
    if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
}

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    [System.IO.File]::WriteAllText($Path, $Content, [System.Text.UTF8Encoding]::new($false))
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "缺少 JSON 文件：$Path" }
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}

function Write-JsonFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    Write-Utf8NoBom -Path $Path -Content (($Value | ConvertTo-Json -Depth 20) + [Environment]::NewLine)
}

function New-QualificationToken {
    $bytes = [byte[]]::new(32)
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Read-InstallState {
    return Read-JsonFile -Path $script:InstallStatePath
}

function Read-RunState {
    return Read-JsonFile -Path $script:RunStatePath
}

function Get-GsiEndpointConflicts {
    param(
        [Parameter(Mandatory = $true)][string]$CfgDirectory,
        [Parameter(Mandatory = $true)][string]$CanonicalCfgPath
    )
    $uriPattern = '(?im)^\s*"uri"\s+"https?://(?:127\.0\.0\.1|localhost):3000(?:[/?#"]|$)'
    $canonicalFullPath = $null
    try { $canonicalFullPath = [System.IO.Path]::GetFullPath($CanonicalCfgPath) } catch { }
    $conflicts = @()
    foreach ($file in @(Get-ChildItem -LiteralPath $CfgDirectory -Filter 'gamestate_integration_*.cfg' -File -ErrorAction Stop)) {
        $fileFullPath = $null
        try { $fileFullPath = [System.IO.Path]::GetFullPath($file.FullName) } catch { }
        if ($null -ne $canonicalFullPath -and [string]::Equals($fileFullPath, $canonicalFullPath, [System.StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        try {
            $contents = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
            if ([regex]::IsMatch($contents, $uriPattern)) { $conflicts += $file.FullName }
        } catch { throw }
    }
    return @($conflicts)
}

function Write-GsiEndpointConflictWarning {
    param(
        [Parameter(Mandatory = $true)][string]$CfgDirectory,
        [Parameter(Mandatory = $true)][string]$CanonicalCfgPath
    )
    $conflicts = @(Get-GsiEndpointConflicts -CfgDirectory $CfgDirectory -CanonicalCfgPath $CanonicalCfgPath)
    if ($conflicts.Count -gt 0) {
        Write-Warning ('GSI 配置冲突：其他配置也指向 127.0.0.1:3000：' + ($conflicts -join '; '))
    }
    return @($conflicts)
}

function Invoke-QualificationApi {
    param(
        [Parameter(Mandatory = $true)][ValidateSet('GET', 'POST')][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        $Body
    )
    $state = Read-RunState
    $headers = @{ 'x-qualification-token' = [string]$state.controlToken }
    $request = @{
        Method = $Method
        Uri = "http://127.0.0.1:3000$Path"
        Headers = $headers
        ErrorAction = 'Stop'
    }
    if ($null -ne $Body) {
        $request.ContentType = 'application/json'
        $request.Body = ($Body | ConvertTo-Json -Depth 10 -Compress)
    } elseif ($Method -eq 'POST') {
        $request.ContentType = 'application/json'
        $request.Body = '{}'
    }
    return Invoke-RestMethod @request
}

function Test-ProcessRunning {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        return -not $process.HasExited
    } catch {
        return $false
    }
}

function Restore-InstalledGsiConfig {
    param($State)
    if ($null -eq $State -or $null -eq $State.cfgPath) { return }
    $cfgPath = [string]$State.cfgPath
    if ([bool]$State.hadExistingConfig) {
        if ($null -eq $State.backupPath -or -not (Test-Path -LiteralPath $State.backupPath -PathType Leaf)) {
            throw "无法恢复原 GSI 配置：备份文件不存在"
        }
        Copy-Item -LiteralPath $State.backupPath -Destination $cfgPath -Force
    } elseif (Test-Path -LiteralPath $cfgPath -PathType Leaf) {
        Remove-Item -LiteralPath $cfgPath -Force
    }
    if ($null -ne $State.backupPath -and (Test-Path -LiteralPath $State.backupPath -PathType Leaf)) {
        Remove-Item -LiteralPath $State.backupPath -Force
    }
}
