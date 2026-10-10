param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path ([IO.Path]::GetFullPath($OutputDirectory)) | Out-Null
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$test = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'bootstrap-tests.exe'
& $compiler /nologo /target:exe /main:Mizar.WebInstaller.Tests "/out:$test" /r:System.Net.Http.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "$PSScriptRoot\Bootstrap.cs" "$PSScriptRoot\Nsis.cs" "$PSScriptRoot\Bootstrap.Tests.cs" "$PSScriptRoot\Window.Tests.cs"
if ($LASTEXITCODE) { throw 'Test compilation failed' }
& $test
if ($LASTEXITCODE) { throw 'Bootstrap tests failed' }

# Explicit UI-state demonstration executable; never included in the product bootstrap.
$demo = Join-Path ([IO.Path]::GetFullPath($OutputDirectory)) 'ui-state-demo.exe'
& $compiler /nologo /target:winexe /main:Mizar.WebInstaller.UiDemo "/out:$demo" "/resource:$PSScriptRoot\..\..\apps\desktop\src-tauri\icons\tray-icon.png,brand.png" "/win32icon:$PSScriptRoot\..\..\apps\desktop\src-tauri\icons\icon.ico" /r:System.Net.Http.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll /r:System.Web.Extensions.dll "$PSScriptRoot\Bootstrap.cs" "$PSScriptRoot\Nsis.cs" "$PSScriptRoot\Window.Tests.cs"
if ($LASTEXITCODE) { throw 'Explicit UI demonstration compilation failed' }
