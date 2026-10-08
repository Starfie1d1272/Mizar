param([switch]$Product)
& (Join-Path $PSScriptRoot 'install-gsi.ps1') -Product:$Product -Automatic
exit $LASTEXITCODE
