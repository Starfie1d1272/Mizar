param([switch]$Product)
. (Join-Path $PSScriptRoot 'common.ps1')
trap { Write-Cs2OperationFailure -Failure $_ -Stage 'restore'; exit 1 }
if (-not $Product -and @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { throw '请先停止本地制播服务再恢复 GSI 配置' }
if ($Product) {
    $script:QualificationStateRoot = Join-Path $script:StateRoot 'data\gsi-install'
    $script:InstallStatePath = Join-Path $script:QualificationStateRoot 'install.json'
}
Restore-InstalledGsiConfig -State (Read-InstallState)
Remove-Item -LiteralPath $script:QualificationStateRoot -Recurse -Force
Write-Output '原 GSI 配置已恢复。'

Clear-Cs2OperationError
