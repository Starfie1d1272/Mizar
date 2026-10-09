param(
  [ValidateSet('Prepare', 'Install', 'Recover')][string]$Mode,
  [string]$PlanPath,
  [string]$StageRoot,
  [int]$HostProcessId = 0
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-JsonAtomic($path, $value) {
  $temp = $path + '.tmp'
  [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temp -Destination $path -Force
}
function Assert-PlainPath([string]$path) {
  if (![IO.Path]::IsPathRooted($path) -or $path -match '["\r\n]') { throw 'update_path_invalid' }
  $cursor = [IO.Path]::GetFullPath($path)
  while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'update_reparse_point' }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}
function Assert-Plan($plan) {
  if ($plan.schemaVersion -ne 1 -or $plan.version -notmatch '^\d+\.\d+\.\d+$' -or
    $plan.gitSha -notmatch '^[a-f0-9]{40}$' -or $plan.installerSha256 -notmatch '^[a-f0-9]{64}$' -or
    $plan.contentDigest -notmatch '^[a-f0-9]{64}$' -or $plan.previousContentDigest -notmatch '^[a-f0-9]{64}$' -or
    $plan.installerBytes -le 0 -or $plan.installerBytes -gt 536870912) { throw 'update_plan_invalid' }
  foreach ($path in @($plan.bundleRoot, $plan.stateRoot, $plan.installer)) { Assert-PlainPath $path }
  $bundle = [IO.Path]::GetFullPath($plan.bundleRoot).TrimEnd('\')
  $state = [IO.Path]::GetFullPath($plan.stateRoot).TrimEnd('\')
  if ($state -eq $bundle -or $state.StartsWith($bundle + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'update_data_inside_installation' }
  $installerPath = [IO.Path]::GetFullPath($plan.installer)
  $downloadDirectory = Split-Path -Parent $installerPath
  $downloadName = Split-Path -Leaf $downloadDirectory
  $updatesDirectory = [IO.Path]::GetFullPath((Join-Path $state 'updates')).TrimEnd('\')
  if ((Split-Path -Parent $downloadDirectory).TrimEnd('\') -ne $updatesDirectory -or
    $downloadName -notmatch '^download-[A-Za-z0-9_-]+$' -or
    (Split-Path -Leaf $installerPath) -ne ('Mizar-v' + $plan.version + '-Windows-x64-Setup.exe')) { throw 'update_installer_path_invalid' }
}
function Assert-Installer($plan, [string]$path) {
  Assert-PlainPath $path
  if ((Get-Item -LiteralPath $path).Length -ne $plan.installerBytes -or
    (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $plan.installerSha256) { throw 'update_installer_corrupt' }
}
function Assert-Payload([string]$directory, [string]$digest, [string]$version = '', [string]$gitSha = '') {
  Assert-PlainPath $directory
  $artifact = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $directory 'resources\metadata\artifact.json') -Raw | ConvertFrom-Json
  if ($artifact.repository -ne 'Starfie1d1272/Mizar' -or $artifact.artifactSha256 -ne $digest -or
    ($version -and $artifact.appVersion -ne $version) -or ($gitSha -and $artifact.gitSha -ne $gitSha)) { throw 'update_payload_identity_invalid' }
  $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
  $records = @{}
  foreach ($line in (Get-Content -Encoding UTF8 -LiteralPath (Join-Path $directory 'resources\metadata\SHA256SUMS'))) {
    if ($line -notmatch '^([a-f0-9]{64})  (.+)$') { throw 'update_payload_manifest_invalid' }
    $hash = $Matches[1]; $name = $Matches[2]
    if ($name -match '\\|^/|:|(^|/)\.\.?(/|$)|//|^state/' -or !$names.Add($name)) { throw 'update_payload_path_invalid' }
    $file = Join-Path $directory $name
    Assert-PlainPath $file
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw 'update_payload_corrupt' }
    $records[$name] = $hash
  }
  foreach ($required in @('Mizar.exe','resources/runtime/node.exe','resources/app/dist/server.js','resources/web/dist/index.html','resources/metadata/artifact.json')) {
    if (!$names.Contains($required)) { throw 'update_payload_incomplete' }
  }
  $ordered = [string[]]@($names)
  [Array]::Sort($ordered, [StringComparer]::Ordinal)
  $builder = New-Object Text.StringBuilder
  foreach ($name in $ordered) {
    if ($name -ne 'resources/metadata/artifact.json') { [void]$builder.Append($name + [char]0 + $records[$name] + "`n") }
  }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $actual = ([BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($builder.ToString())))).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
  if ($actual -ne $digest) { throw 'update_payload_digest_invalid' }
}
function Assert-Stopped {
  if (Get-Process -Name Mizar -ErrorAction SilentlyContinue) { throw 'update_process_remaining' }
  if (Get-NetTCPConnection -State Listen -LocalPort 3000 -ErrorAction SilentlyContinue) { throw 'update_service_remaining' }
}
function Recovery-Registration([bool]$enabled) {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
  if ($enabled) {
    New-Item -Path $key -Force | Out-Null
    $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $command = '"' + $ps + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $StageRoot 'update-install.ps1') + '" -Mode Recover -StageRoot "' + $StageRoot + '"'
    New-ItemProperty -Path $key -Name '!MizarUpdateRecovery' -Value $command -PropertyType String -Force | Out-Null
  } else { Remove-ItemProperty -Path $key -Name '!MizarUpdateRecovery' -ErrorAction SilentlyContinue }
}
function Save-Registration {
  $keys = @('HKCU:\Software\Mizar', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar')
  $snapshot = @()
  foreach ($key in $keys) {
    $item = Get-Item -LiteralPath $key -ErrorAction SilentlyContinue
    $values = @()
    if ($item) { foreach ($name in $item.GetValueNames()) { $values += @{ name = $name; value = $item.GetValue($name); kind = $item.GetValueKind($name).ToString() } } }
    $snapshot += @{ key = $key; exists = [bool]$item; values = $values }
  }
  Write-JsonAtomic (Join-Path $StageRoot 'registration.json') $snapshot
  $shortcuts = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mizar.lnk'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Mizar'))
  for ($index = 0; $index -lt $shortcuts.Count; $index++) {
    if (Test-Path -LiteralPath $shortcuts[$index]) { Copy-Item -LiteralPath $shortcuts[$index] -Destination (Join-Path $StageRoot ('shortcut-' + $index)) -Recurse }
  }
}
function Restore-Registration {
  # PowerShell 5.1 emits a JSON array as one pipeline object. Assign it first
  # so foreach visits individual registry records rather than the outer array.
  $snapshot = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'registration.json') -Raw | ConvertFrom-Json
  $expectedKeys = @('HKCU:\Software\Mizar', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar')
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  if ($null -eq $snapshot -or $snapshot.Count -ne 2) { throw 'update_registration_snapshot_invalid' }
  foreach ($entry in $snapshot) {
    if ($entry.key -notin $expectedKeys -or $entry.exists -isnot [bool] -or !$seen.Add($entry.key)) { throw 'update_registration_snapshot_invalid' }
  }
  foreach ($entry in $snapshot) {
    Remove-Item -LiteralPath $entry.key -Recurse -Force -ErrorAction SilentlyContinue
    if ($entry.exists) {
      New-Item -Path $entry.key -Force | Out-Null
      foreach ($value in $entry.values) { New-ItemProperty -LiteralPath $entry.key -Name $value.name -Value $value.value -PropertyType $value.kind -Force | Out-Null }
    }
  }
  $shortcuts = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mizar.lnk'), (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Mizar'))
  for ($index = 0; $index -lt $shortcuts.Count; $index++) {
    Remove-Item -LiteralPath $shortcuts[$index] -Recurse -Force -ErrorAction SilentlyContinue
    $saved = Join-Path $StageRoot ('shortcut-' + $index)
    if (Test-Path -LiteralPath $saved) { Copy-Item -LiteralPath $saved -Destination $shortcuts[$index] -Recurse }
  }
}
function Record-Result([string]$status, [string]$code) {
  $result = @{ status = $status; code = $code; version = $plan.version; recoveryDirectory = (Split-Path $StageRoot -Leaf) }
  Write-JsonAtomic (Join-Path $StageRoot 'result.json') $result
  Write-JsonAtomic (Join-Path $plan.stateRoot 'updates\result.json') $result
}
function Restore-Previous {
  Assert-Stopped
  # Recover may run after the helper died immediately after Start-Process.
  # Inspect the staged executable directly; a journal PID is not reliable evidence.
  foreach ($running in @(Get-Process -Name Installer -ErrorAction SilentlyContinue)) {
    if (!$running.Path -or $running.Path -eq (Join-Path $StageRoot 'Installer.exe')) { throw 'update_installer_remaining' }
  }
  $backup = Join-Path $StageRoot 'previous'
  Assert-Payload $backup $plan.previousContentDigest
  $restore = $plan.bundleRoot + '.mizar-restore-' + (Split-Path $StageRoot -Leaf)
  $failed = $plan.bundleRoot + '.mizar-failed-' + (Split-Path $StageRoot -Leaf)
  Assert-PlainPath $restore; Assert-PlainPath $failed
  if (!(Test-Path -LiteralPath $restore)) { Copy-Item -LiteralPath $backup -Destination $restore -Recurse }
  Assert-Payload $restore $plan.previousContentDigest
  if (Test-Path -LiteralPath $plan.bundleRoot) {
    # A retry after a directory swap must not destroy its only failed copy.
    try { Assert-Payload $plan.bundleRoot $plan.previousContentDigest; Restore-Registration; Record-Result 'restored' 'update_rolled_back'; Recovery-Registration $false; return } catch { }
    if (Test-Path -LiteralPath $failed) { throw 'update_recovery_conflict' }
    Move-Item -LiteralPath $plan.bundleRoot -Destination $failed
  }
  Move-Item -LiteralPath $restore -Destination $plan.bundleRoot
  Assert-Payload $plan.bundleRoot $plan.previousContentDigest
  Restore-Registration
  Record-Result 'restored' 'update_rolled_back'
  Recovery-Registration $false
  Remove-Item -LiteralPath $failed -Recurse -Force -ErrorAction SilentlyContinue
}

if ($Mode -eq 'Prepare') {
  $plan = Get-Content -Encoding UTF8 -LiteralPath $PlanPath -Raw | ConvertFrom-Json
  Assert-Plan $plan
  if (!(Test-Path -LiteralPath (Join-Path $plan.bundleRoot 'installed.flag'))) { throw 'update_portable_install_forbidden' }
  Assert-Installer $plan $plan.installer
  $StageRoot = Join-Path $plan.stateRoot ('updates\install-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $StageRoot | Out-Null
  Copy-Item -LiteralPath $plan.installer -Destination (Join-Path $StageRoot 'Installer.exe')
  Assert-Installer $plan (Join-Path $StageRoot 'Installer.exe')
  Copy-Item -LiteralPath $PSCommandPath -Destination (Join-Path $StageRoot 'update-install.ps1')
  Write-JsonAtomic (Join-Path $StageRoot 'plan.json') $plan
  '@echo off', 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0update-install.ps1" -Mode Recover -StageRoot "%~dp0."', 'pause' | Set-Content -LiteralPath (Join-Path $StageRoot 'Restore-Mizar.cmd') -Encoding ASCII
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'prepared' }
  @{ stageRoot = $StageRoot } | ConvertTo-Json -Compress
  exit 0
}
Assert-PlainPath $StageRoot
$plan = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'plan.json') -Raw | ConvertFrom-Json
Assert-Plan $plan
$StageRoot = [IO.Path]::GetFullPath($StageRoot).TrimEnd('\')
if ((Split-Path -Parent $StageRoot) -ne [IO.Path]::GetFullPath((Join-Path $plan.stateRoot 'updates')).TrimEnd('\') -or
  (Split-Path -Leaf $StageRoot) -notmatch '^install-[a-f0-9]{32}$') { throw 'update_stage_invalid' }
try {
  if ($Mode -eq 'Recover') {
    Recovery-Registration $true
    $journal = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json
    if ($journal.phase -eq 'committed') {
      Assert-Payload $plan.bundleRoot $plan.contentDigest $plan.version $plan.gitSha
      Recovery-Registration $false
      Record-Result 'installed' 'update_completed'
    } elseif ($journal.phase -eq 'prepared') {
      # Installation never started; no need to change files or registration.
      Recovery-Registration $false
      Record-Result 'cancelled' 'update_not_started'
    } else { Restore-Previous }
    exit 0
  }
  if ($Mode -ne 'Install' -or $HostProcessId -le 0) { throw 'update_host_invalid' }
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while (Get-Process -Id $HostProcessId -ErrorAction SilentlyContinue) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'update_host_exit_timeout' }
    Start-Sleep -Milliseconds 200
  }
  Assert-Stopped
  Assert-Installer $plan (Join-Path $StageRoot 'Installer.exe')
  Assert-Payload $plan.bundleRoot $plan.previousContentDigest
  if (Get-ChildItem -LiteralPath $plan.bundleRoot -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'update_reparse_point' }
  Save-Registration
  Copy-Item -LiteralPath $plan.bundleRoot -Destination (Join-Path $StageRoot 'previous') -Recurse
  Assert-Payload (Join-Path $StageRoot 'previous') $plan.previousContentDigest
  Recovery-Registration $true
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'installing' }
  $installer = Start-Process -FilePath (Join-Path $StageRoot 'Installer.exe') -ArgumentList @('/S', '/MIZARUPDATE', ('/D=' + $plan.bundleRoot)) -PassThru
  $installer.WaitForExit()
  if ($installer.ExitCode -ne 0) { throw 'update_installer_cancelled' }
  Assert-Payload $plan.bundleRoot $plan.contentDigest $plan.version $plan.gitSha
  # Silent Setup removes the old shortcut and leaves its optional section off.
  # Preserve the user's existing shortcut without creating one for other users.
  $desktopShortcut = Join-Path $StageRoot 'shortcut-0'
  if (Test-Path -LiteralPath $desktopShortcut) {
    Copy-Item -LiteralPath $desktopShortcut -Destination (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mizar.lnk') -Force
  }
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'committed' }
  Record-Result 'installed' 'update_completed'
  Recovery-Registration $false
  Remove-Item -LiteralPath (Join-Path $StageRoot 'previous') -Recurse -Force
  Remove-Item -LiteralPath (Join-Path $StageRoot 'Installer.exe') -Force
  $env:MIZAR_STATE_ROOT = $plan.stateRoot
  Start-Process -FilePath (Join-Path $plan.bundleRoot 'Mizar.exe') -WorkingDirectory $plan.bundleRoot
} catch {
  $code = [string]$_.Exception.Message
  if ($code -notmatch '^update_[a-z_]+$') { $code = 'update_installation_failed' }
  $journal = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json
  if ($journal.phase -eq 'installing') {
    try { Restore-Previous }
    catch { Recovery-Registration $true; Record-Result 'recovery-required' $code }
  } elseif ($journal.phase -eq 'committed') { Record-Result 'installed' 'update_completed'; Recovery-Registration $false }
  else { Record-Result 'cancelled' $code; Recovery-Registration $false }
  exit 1
}
