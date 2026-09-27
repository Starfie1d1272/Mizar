param([switch]$ObjectiveTiming, [switch]$Release)
. (Join-Path $PSScriptRoot 'common.ps1')

$qualificationProfile = if ($Release) { 'release' } elseif ($ObjectiveTiming) { 'objective-timing' } else { 'base' }

$install = Read-InstallState
Write-GsiEndpointConflictWarning -CfgDirectory (Split-Path -Parent ([string]$install.cfgPath)) -CanonicalCfgPath ([string]$install.cfgPath) | Out-Null
$artifact = Read-JsonFile -Path (Join-Path $script:BundleRoot 'metadata\artifact.json')
if ($artifact.PSObject.Properties.Name -contains 'developmentOnly' -and $artifact.developmentOnly) { throw '开发结构包不能作为真实环境验收产物，请使用 CI exact-revision 产品包' }
$nodePath = Join-Path $script:BundleRoot 'runtime\node.exe'
$appPath = Join-Path $script:BundleRoot 'app'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw '验收包内缺少 runtime\node.exe' }
if (-not (Test-Path -LiteralPath (Join-Path $appPath 'dist\server.js') -PathType Leaf)) { throw '验收包内缺少本地制播服务 dist\server.js' }
$nodeModulesPath = Join-Path $appPath 'node_modules'
if (-not (Test-Path -LiteralPath $nodeModulesPath -PathType Container)) { throw '验收包内缺少 node_modules' }
$dependencyPath = Join-Path $nodeModulesPath '.pnpm\node_modules'

$listeners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) { throw '3000 端口已被占用；请先停止其他进程再开始现场验收' }

$runId = "$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$runDir = Join-Path $script:StateRoot "evidence\$runId"
foreach ($directory in @($runDir, (Join-Path $runDir 'recorder'), (Join-Path $runDir 'debug'), (Join-Path $runDir 'logs'), (Join-Path $runDir 'cfg'))) {
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
}
New-Item -ItemType File -Force -Path (Join-Path $runDir 'scenario.jsonl') | Out-Null
New-Item -ItemType File -Force -Path (Join-Path $runDir 'host-checkpoints.jsonl') | Out-Null
Copy-Item -LiteralPath (Join-Path $script:BundleRoot 'metadata\artifact.json') -Destination (Join-Path $runDir 'artifact.json') -Force
Write-JsonFile -Path (Join-Path $runDir 'cfg\fingerprint.json') -Value ([ordered]@{
    schemaVersion = 1
    path = [string]$install.cfgPath
    sha256 = [string]$install.cfgFingerprint
})

$windowsVersion = 'unknown'
try { $windowsVersion = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).Caption } catch { $windowsVersion = $env:OS }
$cs2Version = [string]$install.cs2Version
if ([string]::IsNullOrWhiteSpace($cs2Version)) { $cs2Version = 'unknown' }
Write-JsonFile -Path (Join-Path $runDir 'environment.json') -Value ([ordered]@{
    schemaVersion = 1
    runId = $runId
    windowsVersion = $windowsVersion
    cs2Version = $cs2Version
    qualificationProfile = $qualificationProfile
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
})

$controlToken = New-QualificationToken
$runState = [ordered]@{
    schemaVersion = 1
    runId = $runId
    runDir = $runDir
    gsiToken = [string]$install.gsiToken
    controlToken = $controlToken
    cfgPath = [string]$install.cfgPath
    backupPath = $install.backupPath
    hadExistingConfig = [bool]$install.hadExistingConfig
    artifactSha256 = [string]$artifact.artifactSha256
    processId = $null
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
}
Write-JsonFile -Path $script:RunStatePath -Value $runState

$env:HOST = '127.0.0.1'
$env:PORT = '3000'
$env:LOCAL_WEB_LAN_MODE = '0'
$env:WEB_ROOT = Join-Path $script:BundleRoot 'web\dist'
$env:HUD_CONFIG_PATH = Join-Path $script:StateRoot 'data\hud-config.json'
$env:SERIES_PROGRESS_CHECKPOINT_PATH = Join-Path $script:StateRoot 'data\series-progress.json'
Remove-Item Env:MIZAR_PRODUCT_INSTANCE -ErrorAction SilentlyContinue
Remove-Item Env:MIZAR_RUNTIME_TOKEN -ErrorAction SilentlyContinue
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
$env:MIZAR_COMMIT = [string]$artifact.gitSha
$env:GSI_TOKEN = [string]$install.gsiToken
$env:CAPTURE_DIR = (Join-Path $runDir 'recorder')
$env:QUALIFICATION_MODE = 'true'
$env:QUALIFICATION_PROFILE = $qualificationProfile
$env:QUALIFICATION_CONTROL_TOKEN = $controlToken
$env:QUALIFICATION_RUN_ID = $runId
$env:QUALIFICATION_WINDOWS_VERSION = $windowsVersion
$env:QUALIFICATION_CS2_VERSION = $cs2Version
$env:QUALIFICATION_ARTIFACT_SHA256 = [string]$artifact.artifactSha256
$env:QUALIFICATION_SCENARIO_PATH = (Join-Path $runDir 'scenario.jsonl')
$env:QUALIFICATION_HOST_CHECKPOINTS_PATH = (Join-Path $runDir 'host-checkpoints.jsonl')
$env:QUALIFICATION_EVIDENCE_DIR = $runDir
$env:QUALIFICATION_BUNDLE_ROOT = $script:BundleRoot
$env:QUALIFICATION_APP_ROOT = $appPath
$env:QUALIFICATION_NODE_PATH = $nodePath
$env:QUALIFICATION_RUN_DIR = $runDir
$env:QUALIFICATION_RUN_STATE_PATH = $script:RunStatePath
$env:QUALIFICATION_FINALIZATION_PATH = (Join-Path $script:QualificationStateRoot 'finalization.json')
if (Test-Path -LiteralPath $dependencyPath -PathType Container) {
    $env:NODE_PATH = if ($env:NODE_PATH) { "$dependencyPath;$($env:NODE_PATH)" } else { $dependencyPath }
}

$supervisorPath = Join-Path $script:BundleRoot 'scripts\qualification-supervisor.mjs'
if (-not (Test-Path -LiteralPath $supervisorPath -PathType Leaf)) { throw '验收包内缺少验收管理脚本' }
$supervisorLogPath = Join-Path $script:QualificationStateRoot 'supervisor.log'
$supervisorErrorPath = Join-Path $script:QualificationStateRoot 'supervisor.stderr.log'
$quotedSupervisorPath = '"' + $supervisorPath.Replace('"', '\"') + '"'
$supervisor = Start-Process -FilePath $nodePath -ArgumentList @($quotedSupervisorPath) -WorkingDirectory $script:BundleRoot -RedirectStandardOutput $supervisorLogPath -RedirectStandardError $supervisorErrorPath -WindowStyle Hidden -PassThru

$ready = $false
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
    if (-not (Test-ProcessRunning -ProcessId $supervisor.Id)) { throw "验收管理进程在服务就绪前退出；请查看 $supervisorErrorPath" }
    try {
        $health = Invoke-RestMethod -Method GET -Uri 'http://127.0.0.1:3000/health' -TimeoutSec 2 -ErrorAction Stop
        if ($health.status -eq 'ok') { $ready = $true; break }
    } catch { }
    Start-Sleep -Milliseconds 250
}
$runState = Read-RunState
if ($null -eq $runState.processId) { throw "未记录本地制播服务 PID；请查看 $supervisorErrorPath" }
if (-not $ready) { throw "等待本地制播服务就绪超过 30 秒；请查看 $supervisorErrorPath" }
$runState | Add-Member -NotePropertyName supervisorProcessId -NotePropertyValue ([int]$supervisor.Id) -Force
Write-JsonFile -Path $script:RunStatePath -Value $runState

Write-Output "本地制播服务正在运行（PID $([int]$runState.processId)）；验收管理进程 PID $($supervisor.Id)"
Write-Output '请打开 http://127.0.0.1:3000/qualification 进入现场验收页面。'
Write-Output '页面是首选流程；服务退出后会自动整理并验证验收证据。'
Write-Output 'check.ps1、mark.ps1 和 stop.ps1 可作为自动化备用入口。'
