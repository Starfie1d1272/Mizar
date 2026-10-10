param([Parameter(Mandatory=$true)][string]$ProductDirectory, [Parameter(Mandatory=$true)][string]$CoreDirectory, [Parameter(Mandatory=$true)][string]$OutputDirectory, [switch]$Qualification)
$ErrorActionPreference = 'Stop'
if (!$Qualification) { throw 'Formal installer requires the existing main Release Qualification workflow' }
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
if (!(Test-Path -LiteralPath $compiler)) { throw 'Windows .NET Framework compiler unavailable' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $output | Out-Null
$planPath = Join-Path $output 'web-installer-plan.json'
node "$PSScriptRoot/qualification-plan.mjs" ([IO.Path]::GetFullPath($ProductDirectory)) ([IO.Path]::GetFullPath($CoreDirectory)) $planPath
if ($LASTEXITCODE) { throw 'Qualification identity or payload verification failed' }
$plan = Get-Content -Raw -LiteralPath $planPath | ConvertFrom-Json
$exe = Join-Path $output "Mizar-v$($plan.version)-Windows-x64-WebInstaller.exe"
if (Test-Path -LiteralPath $exe) { throw 'Refusing to replace an existing candidate' }
& $compiler /nologo /target:winexe /optimize+ /platform:anycpu "/out:$exe" "/win32icon:$PSScriptRoot/../../apps/desktop/src-tauri/icons/icon.ico" "/resource:$planPath,plan.json" "/resource:$PSScriptRoot/../../apps/desktop/src-tauri/icons/tray-icon.png,brand.png" /r:System.Net.Http.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "$PSScriptRoot/Bootstrap.cs" "$PSScriptRoot/Nsis.cs"
if ($LASTEXITCODE) { throw 'Formal bootstrap compilation failed' }
[ordered]@{schemaVersion=1; artifact=(Split-Path $exe -Leaf); bytes=(Get-Item $exe).Length; sha256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant(); gitSha=$plan.gitSha; version=$plan.version; published=$false; publicationRequired=$true; productionReady=$false; domesticMirrorReady=$false; productionCompletionEvidence=$false; blockers=@('Box-first authenticated publication and resource bootstrap','published cold-cache installation and offline EPL qualification'); core=$plan.coreName; installer=$plan.name} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $output 'web-installer-build.json') -Encoding UTF8
