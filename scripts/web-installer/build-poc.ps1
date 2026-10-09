param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler unavailable' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$exe = Join-Path $output 'Mizar-WebInstaller-POC.exe'
& $compiler /nologo /target:winexe /optimize+ /platform:anycpu "/out:$exe" /r:System.Net.Http.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "/resource:$PSScriptRoot\poc-plan.json,plan.json" "/resource:$PSScriptRoot\..\qualification\installer-assets\header.bmp,header.bmp" "$PSScriptRoot\Bootstrap.cs"
if ($LASTEXITCODE) { throw 'Bootstrap compilation failed' }
[ordered]@{artifact=(Split-Path $exe -Leaf); bytes=(Get-Item $exe).Length; sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant(); production=$false} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output 'build.json') -Encoding UTF8
