param([Parameter(Mandatory=$true)][string]$OutputDirectory, [switch]$CoreBootstrap)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler unavailable' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$plan = Join-Path $PSScriptRoot 'poc-plan.json'
$artifact = 'Mizar-WebInstaller-POC.exe'
if ($CoreBootstrap) {
  # The builder authenticates the fixed executable identity through the existing updater.
  $plan = Join-Path $output 'authenticated-core-plan.json'
  & node "$PSScriptRoot\pin-stable-core.mjs" $plan
  if ($LASTEXITCODE) { throw 'Existing StableSource Core authentication failed' }
  $artifact = 'Mizar-WebInstaller-Core-Development.exe'
}
$exe = Join-Path $output $artifact
& $compiler /nologo /target:winexe /optimize+ /platform:anycpu "/win32icon:$PSScriptRoot\..\..\apps\desktop\src-tauri\icons\icon.ico" "/out:$exe" /r:System.Net.Http.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "/resource:$plan,plan.json" "/resource:$PSScriptRoot\..\..\apps\desktop\src-tauri\icons\tray-icon.png,brand.png" "$PSScriptRoot\Bootstrap.cs" "$PSScriptRoot\Nsis.cs"
if ($LASTEXITCODE) { throw 'Bootstrap compilation failed' }
[ordered]@{artifact=(Split-Path $exe -Leaf); bytes=(Get-Item $exe).Length; sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant(); production=$false; developmentOnly=$true; coreBootstrap=[bool]$CoreBootstrap} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output $(if ($CoreBootstrap) { 'build-core.json' } else { 'build.json' })) -Encoding UTF8
