$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$exe = Join-Path $env:RUNNER_TEMP 'Mizar-WriterLockProbe.exe'
& $compiler /nologo /target:exe /optimize+ /platform:anycpu /main:WriterLockProbe "/out:$exe" /r:System.Net.Http.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "$PWD\scripts\web-installer\Bootstrap.cs" "$PWD\scripts\web-installer\Nsis.cs" "$PWD\.agent-tmp\WriterLockProbe.cs"
if ($LASTEXITCODE -ne 0) { throw 'Writer-lock probe compilation failed' }
& $exe
if ($LASTEXITCODE -ne 0) { throw 'Writer-lock probe failed' }
