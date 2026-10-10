param([Parameter(Mandatory=$true)][string]$OutputDirectory, [ValidateSet('all','update','faults')][string]$CaseGroup = 'all')
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$test = Join-Path $output 'nsis-qualification.exe'
& $compiler /nologo /target:exe /main:Mizar.WebInstaller.NsisTests "/out:$test" "/resource:$PSScriptRoot\..\qualification\bundle\update-install.ps1,update-install.ps1" /r:System.Net.Http.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "/resource:$PSScriptRoot\legacy-stable-plan.json,legacy-plan.json" "$PSScriptRoot\Bootstrap.cs" "$PSScriptRoot\Nsis.cs" "$PSScriptRoot\Bootstrap.Tests.cs" "$PSScriptRoot\Window.Tests.cs" "$PSScriptRoot\Nsis.Tests.cs"
if ($LASTEXITCODE) { throw 'NSIS qualification compilation failed' }
& $test $CaseGroup (Join-Path $output 'nsis-evidence.json')
if ($LASTEXITCODE) { throw 'Real NSIS qualification failed' }
