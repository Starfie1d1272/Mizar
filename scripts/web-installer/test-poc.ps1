param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
& "$PSScriptRoot\build-poc.ps1" -OutputDirectory $OutputDirectory
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$test = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'bootstrap-tests.exe'
& $compiler /nologo /target:exe /main:Mizar.WebInstaller.Tests "/out:$test" /r:System.Net.Http.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "$PSScriptRoot\Bootstrap.cs" "$PSScriptRoot\Nsis.cs" "$PSScriptRoot\Bootstrap.Tests.cs"
if ($LASTEXITCODE) { throw 'Test compilation failed' }
& $test
if ($LASTEXITCODE) { throw 'Bootstrap tests failed' }
