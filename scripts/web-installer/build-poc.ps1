param([Parameter(Mandatory=$true)][string]$OutputDirectory, [switch]$CoreBootstrap)
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler unavailable' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$assets = Join-Path $PSScriptRoot '..\qualification\installer-assets'
$manifest = Get-Content -LiteralPath (Join-Path $assets 'sources.json') -Raw | ConvertFrom-Json
$header = @($manifest.files | Where-Object { $_.path -eq 'header.bmp' })
if ($header.Count -ne 1) { throw 'Installer header identity missing' }
$headerPath = Join-Path $assets 'header.bmp'
if ((Get-Item -LiteralPath $headerPath).Length -ne $header[0].bytes -or (Get-FileHash -LiteralPath $headerPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $header[0].sha256) { throw 'Installer header identity mismatch' }
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
& $compiler /nologo /target:winexe /optimize+ /platform:anycpu "/win32icon:$PSScriptRoot\..\..\apps\desktop\src-tauri\icons\icon.ico" "/out:$exe" /r:System.Net.Http.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "/resource:$plan,plan.json" "/resource:$PSScriptRoot\..\qualification\installer-assets\header.bmp,header.bmp" "$PSScriptRoot\Bootstrap.cs" "$PSScriptRoot\Nsis.cs"
if ($LASTEXITCODE) { throw 'Bootstrap compilation failed' }
[ordered]@{artifact=(Split-Path $exe -Leaf); bytes=(Get-Item $exe).Length; sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant(); production=$false; developmentOnly=$true; coreBootstrap=[bool]$CoreBootstrap} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $output $(if ($CoreBootstrap) { 'build-core.json' } else { 'build.json' })) -Encoding UTF8
