param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [Parameter(Mandatory = $true)][string]$Destination,
    [int]$TimeoutSeconds = 180
)
$ErrorActionPreference = 'Stop'
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
if (Test-Path -LiteralPath $Destination) { throw "解压目录已存在：$Destination" }
New-Item -ItemType Directory -Path $Destination | Out-Null
$destinationPath = (Resolve-Path -LiteralPath $Destination).Path
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
try {
    $expected = @($zip.Entries | Where-Object { $_.Name -ne '' }).Count
    if ($expected -eq 0) { throw '产品 ZIP 没有文件' }
} finally {
    $zip.Dispose()
}
$shell = New-Object -ComObject Shell.Application
$source = $shell.NameSpace($archivePath)
$target = $shell.NameSpace($destinationPath)
if ($null -eq $source -or $null -eq $target) { throw 'Windows 资源管理器无法打开 ZIP 或解压目录' }
# CopyHere is asynchronous. Suppress dialogs, then wait for every ZIP file.
$target.CopyHere($source.Items(), 1556)
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
do {
    Start-Sleep -Milliseconds 250
    $actual = @(Get-ChildItem -LiteralPath $destinationPath -Recurse -File).Count
    if ($actual -eq $expected) {
        Write-Host "Windows 资源管理器解压完成：$actual 个文件。"
        return
    }
} while ((Get-Date) -lt $deadline)
throw "Windows 资源管理器解压未完成：$actual / $expected 个文件。"
