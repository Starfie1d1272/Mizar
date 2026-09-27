. (Join-Path $PSScriptRoot 'common.ps1')
$launcher = Start-Process -FilePath (Join-Path $script:ProductRoot 'Mizar.exe') -ArgumentList '--stop' -Wait -PassThru
exit $launcher.ExitCode
