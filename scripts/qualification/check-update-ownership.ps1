param([string]$Source = (Join-Path $PSScriptRoot 'bundle/update-install.ps1'))
$ErrorActionPreference = 'Stop'
# Execute production functions only. Never evaluate the script's entry point,
# start installers, inspect real processes, or access the user's registry/shortcuts.
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($function in $functions) { Invoke-Expression $function.Extent.Text }
$filesType = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] -and $node.GetCommandName() -eq 'Add-Type' }, $true) | Select-Object -First 1
Invoke-Expression $filesType.Extent.Text
$root = Join-Path ([IO.Path]::GetTempPath()) ('mizar-ownership-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$env:SystemRoot = $root
$script:registry = @{}
$script:registryWrites = 0
$script:registrationRestores = 0
function Test-Path {
  [CmdletBinding()] param([string]$LiteralPath, [string]$Path, [string]$PathType)
  $target = if ($LiteralPath) { $LiteralPath } else { $Path }
  if ($target.StartsWith('HKCU:')) { return $script:registry.ContainsKey($target) }
  Microsoft.PowerShell.Management\Test-Path @PSBoundParameters
}
function Get-ItemProperty {
  [CmdletBinding()] param([string]$LiteralPath, [string]$Name)
  if (!$LiteralPath.StartsWith('HKCU:')) { throw 'Fixture forbids non-mocked registry read' }
  if ($script:registryDenied) { throw 'fixture_registry_read_denied' }
  return $script:registry[$LiteralPath]
}
function New-Item {
  [CmdletBinding()] param([string]$Path, [switch]$Force)
  if (!$Path.StartsWith('HKCU:')) { throw 'Fixture forbids non-registry New-Item' }
  $script:registryWrites++
  if (!$script:registry.ContainsKey($Path)) { $script:registry[$Path] = @{} }
}
function New-ItemProperty {
  [CmdletBinding()] param([string]$Path, [string]$LiteralPath, [string]$Name, $Value, [string]$PropertyType, [switch]$Force)
  if ($LiteralPath) { $Path = $LiteralPath }
  if (!$Path.StartsWith('HKCU:')) { throw 'Fixture forbids non-mocked registry write' }
  $script:registryWrites++; $script:registry[$Path][$Name] = $Value
}
function Remove-ItemProperty {
  [CmdletBinding()] param([string]$Path, [string]$Name)
  if (!$Path.StartsWith('HKCU:')) { throw 'Fixture forbids non-mocked registry delete' }
  $script:registryWrites++
  if ($script:registry.ContainsKey($Path)) { $script:registry[$Path].Remove($Name) }
}
function Remove-Item {
  [CmdletBinding()] param([string]$LiteralPath, [switch]$Recurse, [switch]$Force)
  if ($LiteralPath.StartsWith('HKCU:')) {
    $script:registryWrites++; $script:registry.Remove($LiteralPath); return
  }
  Microsoft.PowerShell.Management\Remove-Item @PSBoundParameters
}
function Assert-Stopped { }
function Start-UpdateMutation { return $true }
function Update-WindowPhase { }
function Record-UpdateActivity { }
# The platform-specific restoration is deliberately mocked. Its preflight guard
# is tested separately below before it can reach any platform registry operation.
$restoreRegistrationSource = ($functions | Where-Object Name -eq 'Restore-Registration').Extent.Text
function Restore-Registration { $script:registrationRestores++ }
function Assert($condition, [string]$message) { if (!$condition) { throw $message } }
function Reject([scriptblock]$operation, [string]$code) {
  $message = ''
  try { & $operation } catch { $message = $_.Exception.GetBaseException().Message }
  Assert ($message -eq $code) ('Expected ' + $code + ', got ' + $message)
}
function Payload([string]$directory, [string]$version, [string]$content = $version) {
  $files = @{
    'Mizar.exe' = 'fixture executable'; 'resources/runtime/node.exe' = 'fixture node'
    'resources/app/dist/server.js' = ('server ' + $content)
    'resources/web/dist/index.html' = ('web ' + $content)
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  function Hash([string]$text) { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text)))).Replace('-', '').ToLowerInvariant() }
  $names = [string[]]@($files.Keys); [Array]::Sort($names, [StringComparer]::Ordinal)
  $identity = ''; foreach ($name in $names) { $identity += $name + [char]0 + (Hash $files[$name]) + "`n" }
  $digest = Hash $identity
  $files['resources/metadata/artifact.json'] = @{ repository = 'Starfie1d1272/Mizar'; appVersion = $version; gitSha = ('a' * 40); artifactSha256 = $digest } | ConvertTo-Json -Compress
  $sums = ''
  foreach ($name in $files.Keys) {
    $path = Join-Path $directory $name
    [IO.Directory]::CreateDirectory((Split-Path -Parent $path)) | Out-Null
    [IO.File]::WriteAllText($path, $files[$name], (New-Object Text.UTF8Encoding($false)))
    $sums += (Hash $files[$name]) + '  ' + $name + "`n"
  }
  [IO.File]::WriteAllText((Join-Path $directory 'resources/metadata/SHA256SUMS'), $sums)
  [IO.File]::WriteAllText((Join-Path $directory 'installed.flag'), ('mizar.install.v1:' + [guid]::NewGuid().ToString('N')))
  $sha.Dispose(); return $digest
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$installKey = 'HKCU:\Software\Mizar'
try {
  # This first test also reproduces the original bug with -Source <old-script>.
  $state = Join-Path $root 'state'
  $StageRoot = Join-Path $state ('updates/install-' + ('1' * 32))
  [IO.Directory]::CreateDirectory($StageRoot) | Out-Null
  [IO.File]::WriteAllText((Join-Path $StageRoot 'Installer.exe'), 'not executable')
  $previous = Payload (Join-Path $StageRoot 'previous') '1.0.0'
  $next = Payload (Join-Path $root 'candidate') '1.1.0'
  $target = Join-Path $root 'installed'
  $later = Payload $target '1.2.0'
  $state = Join-Path $root 'state'
  [IO.Directory]::CreateDirectory((Join-Path $state 'updates')) | Out-Null
  $plan = @{ schemaVersion = 1; bundleRoot = $target; stateRoot = $state; previousContentDigest = $previous; contentDigest = $next; version = '1.1.0'; gitSha = ('a' * 40); installerSha256 = ('b' * 64); installerBytes = 1; installer = (Join-Path $state 'updates/download-fixture/Mizar-v1.1.0-Windows-x64-Setup.exe'); previousInstallationId = [MizarUpdateFiles]::Hash((Join-Path $StageRoot 'previous/installed.flag')) }
  $Mode = 'Recover'
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'installing' }
  function Installation-Shortcuts {
    return @(@{ current = (Join-Path $root 'desktop/Mizar.lnk'); saved = (Join-Path $StageRoot 'shortcut-0'); target = (Join-Path $target 'Mizar.exe') })
  }
  function Read-ShortcutTarget([string]$path) { return Get-Content -LiteralPath $path -Raw }
  function Candidate {
    Payload $target '1.1.0' | Out-Null
    [IO.File]::WriteAllText((Join-Path $target 'installed.flag'), ('mizar.install.v1:' + (Split-Path -Leaf $StageRoot)))
  }
  $script:registry[$installKey] = @{ InstallDir = $target }
  $script:programGate = $null
  try { Restore-Previous } catch { if ($_.Exception.Message -notin @('update_recovery_target_changed','update_recovery_owner_changed')) { throw } }
  $actual = Get-Content (Join-Path $target 'resources/metadata/artifact.json') -Raw | ConvertFrom-Json
  Assert ($actual.artifactSha256 -eq $later) ('Old recovery replaced successor 1.2.0 with ' + $actual.appVersion)
  Assert-Payload $target $later
  Assert ($script:registrationRestores -eq 0 -and $script:registryWrites -eq 0) 'Old recovery changed successor registration'
  Write-Output 'PASS: later same-location installation remains unchanged'
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $target -Recurse -Force
  Payload $target '1.1.0' 'same-version successor bytes' | Out-Null
  Reject { Assert-RecoveryTarget } 'update_recovery_owner_changed'
  # Exact candidate bytes are still a different manual installation instance.
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $target -Recurse -Force
  Payload $target '1.1.0' | Out-Null
  Reject { Restore-Previous } 'update_recovery_owner_changed'
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $target -Recurse -Force
  Payload $target '1.0.0' | Out-Null
  Reject { Restore-Previous } 'update_recovery_owner_changed'
  Write-Output 'PASS: same-candidate and same-previous bytes still require the original instance'

  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $target -Recurse -Force
  Microsoft.PowerShell.Management\Copy-Item -LiteralPath (Join-Path $StageRoot 'previous') -Destination $target -Recurse
  Assert-RecoveryTarget
  $script:registry[$installKey].InstallDir = Join-Path $root 'different-install'
  Reject { Assert-RecoveryTarget } 'update_recovery_target_changed'
  # Exact production Restore-Registration must refuse before its Windows side effects.
  Invoke-Expression $restoreRegistrationSource
  Reject { Restore-Registration } 'update_recovery_target_changed'
  function Restore-Registration { $script:registrationRestores++ }
  $script:registry[$installKey].InstallDir = $target
  $script:registryDenied = $true
  Reject { Assert-RecoveryTarget } 'fixture_registry_read_denied'
  $script:registryDenied = $false
  Write-Output 'PASS: original payload accepted; changed or unreadable registration rejected'
  Write-JsonAtomic (Join-Path $StageRoot 'registration.json') @(
    @{ key = $installKey; exists = $true; values = @(@{ name = 'InstallDir'; value = (Join-Path $root 'different-install'); kind = 'String' }) },
    @{ key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar'; exists = $false; values = @() }
  )
  Invoke-Expression $restoreRegistrationSource
  Reject { Restore-Registration } 'update_registration_snapshot_invalid'
  function Restore-Registration { $script:registrationRestores++ }
  Write-Output 'PASS: saved registration cannot redirect restoration to another install'

  $script:registry[$runKey] = @{ '!MizarUpdateRecovery' = 'later transaction command' }
  Reject { Recovery-Registration $true } 'update_recovery_owner_changed'
  Reject { Recovery-Registration $false } 'update_recovery_owner_changed'
  Assert ($script:registry[$runKey].'!MizarUpdateRecovery' -eq 'later transaction command') 'Later recovery registration changed'
  $script:registry.Remove($runKey)
  Recovery-Registration $true
  Assert ($script:registry[$runKey].'!MizarUpdateRecovery' -eq (Recovery-Command)) 'Owned recovery entry not registered'
  Recovery-Registration $false
  Assert (!$script:registry[$runKey].ContainsKey('!MizarUpdateRecovery')) 'Owned recovery entry not removed'
  Write-Output 'PASS: later RunOnce entry is neither overwritten nor removed'
  $oldStage = Join-Path $state ('updates/install-' + ('3' * 32))
  [IO.Directory]::CreateDirectory($oldStage) | Out-Null
  Write-JsonAtomic (Join-Path $oldStage 'plan.json') $plan
  Write-JsonAtomic (Join-Path $oldStage 'journal.json') @{ phase = 'restored' }
  Write-JsonAtomic (Join-Path $oldStage 'result.json') @{ status = 'restored'; code = 'update_rolled_back'; version = $plan.version; recoveryDirectory = (Split-Path -Leaf $oldStage) }
  $script:registry[$runKey]['!MizarUpdateRecovery'] = Recovery-Command $oldStage
  $Mode = 'Install'
  Assert-RecoveryRegistration
  [IO.File]::WriteAllText((Join-Path $target '.mizar-update-owner'), (Split-Path -Leaf $oldStage))
  Clear-CompletedRecoveryOwner
  Assert (!(Test-Path -LiteralPath (Join-Path $target '.mizar-update-owner'))) 'Verified terminal marker blocked a new installation'
  Recovery-Registration $true
  Assert ($script:registry[$runKey].'!MizarUpdateRecovery' -eq (Recovery-Command)) 'Verified terminal predecessor was not handed over'
  Recovery-Registration $false
  $Mode = 'Recover'
  $script:registry[$runKey]['!MizarUpdateRecovery'] = Recovery-Command $oldStage
  Reject { Assert-RecoveryRegistration } 'update_recovery_owner_changed'
  $script:registry.Remove($runKey)
  Write-Output 'PASS: new install may take over verified terminal RunOnce, old recovery may not'
  $link = @(Installation-Shortcuts)[0].current
  [IO.Directory]::CreateDirectory((Split-Path -Parent $link)) | Out-Null
  [IO.File]::WriteAllText($link, (Join-Path $root 'another-program.exe'))
  Reject { Restore-Previous } 'update_shortcut_target_changed'
  Assert ((Get-Content $link -Raw) -eq (Join-Path $root 'another-program.exe')) 'Changed shortcut was overwritten'
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $link
  $savedLink = @(Installation-Shortcuts)[0].saved
  [IO.File]::WriteAllText($savedLink, (Join-Path $root 'another-program.exe'))
  Reject { Restore-Previous } 'update_shortcut_target_changed'
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $savedLink
  Write-Output 'PASS: later shortcut target preserved before directory restoration'


  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $target -Recurse -Force
  Candidate
  Write-JsonAtomic (Join-Path $StageRoot 'registration.json') @(
    @{ key = $installKey; exists = $true; values = @(@{ name = 'InstallDir'; value = $target; kind = 'String' }) },
    @{ key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar'; exists = $false; values = @() }
  )
  Invoke-Expression $restoreRegistrationSource
  Assert-RecoveryTarget
  Restore-Previous
  Assert-Payload $target $previous
  Assert ((Get-Content (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json).phase -eq 'restored') 'Recovery did not become terminal'
  $script:registry[$runKey] = @{ '!MizarUpdateRecovery' = 'later transaction command' }
  $writes = $script:registryWrites; $restores = $script:registrationRestores
  Assert (Test-RestoredTransaction @{ phase = 'restored' }) 'Verified terminal recovery was not recognized'
  Assert (Test-RestoredTransaction @{ phase = 'installing' }) 'Legacy completed recovery was not recognized'
  Assert ($writes -eq $script:registryWrites -and $restores -eq $script:registrationRestores) 'Terminal recovery performed another write'
  Assert ($script:registry[$runKey].'!MizarUpdateRecovery' -eq 'later transaction command') 'Old terminal touched later RunOnce'
  $script:registry.Remove($runKey)
  Write-Output 'PASS: candidate rollback and repeated terminal recovery'

  # A false result alone cannot retire a current candidate or damaged original.
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $target -Recurse -Force
  Candidate
  Reject { Test-RestoredTransaction @{ phase = 'restored' } } 'update_payload_identity_invalid'
  [IO.File]::WriteAllText((Join-Path $target 'resources/metadata/artifact.json'), '{')
  Reject { Assert-RecoveryTarget } 'update_recovery_target_unknown'
  [IO.File]::WriteAllText((Join-Path $target '.mizar-update-owner'), (Split-Path -Leaf $StageRoot))
  Assert-RecoveryTarget
  # Preserve unknown partial bytes while restoring the independently verified old program.
  $failed = $target + '.mizar-failed-' + (Split-Path -Leaf $StageRoot)
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $failed -Recurse -Force
  [IO.File]::WriteAllText((Join-Path $target 'unknown.txt'), 'preserve incomplete bytes')
  Restore-Previous
  Assert-Payload $target $previous
  Assert ((Get-Content (Join-Path $failed 'unknown.txt') -Raw) -eq 'preserve incomplete bytes') 'Partial files were not retained'
  [IO.File]::WriteAllText((Join-Path $target '.mizar-update-owner'), ('install-' + ('2' * 32)))
  Reject { Assert-RecoveryTarget } 'update_recovery_owner_changed'
  Write-Output 'PASS: partial payload requires its paired transaction; false terminal rejected'

  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $target -Recurse -Force
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath $failed -Recurse -Force
  $script:registry.Remove($installKey)
  Microsoft.PowerShell.Management\Remove-Item -LiteralPath (Join-Path $StageRoot 'result.json')
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'installing' }
  Reject { Restore-Previous } 'update_recovery_target_unknown'
  Assert (!(Test-Path -LiteralPath $target)) 'Old recovery resurrected an uninstalled program'
  Write-Output 'PASS: absent unowned destination is not treated as interrupted recovery'
  Candidate
  $script:registry[$installKey] = @{ InstallDir = $target }
  $script:interruptSwap = $true
  function Move-Item {
    [CmdletBinding()] param([string]$LiteralPath, [string]$Destination, [switch]$Force)
    if ($script:interruptSwap -and $LiteralPath -eq ($target + '.mizar-restore-' + (Split-Path -Leaf $StageRoot)) -and $Destination -eq $target) {
      $script:interruptSwap = $false
      throw 'fixture_swap_interrupted'
    }
    Microsoft.PowerShell.Management\Move-Item @PSBoundParameters
  }
  Reject { Restore-Previous } 'fixture_swap_interrupted'
  Assert (!(Test-Path -LiteralPath $target)) 'Fixture did not interrupt between directory moves'
  Assert-RecoveryTarget
  Restore-Previous
  Assert-Payload $target $previous
  Write-Output 'PASS: paired directories resume the actual interrupted swap'
  $originalFlag = Get-Content (Join-Path $target 'installed.flag') -Raw
  [IO.File]::WriteAllText((Join-Path $target 'installed.flag'), 'legacy flag without instance')
  Reject { Assert-RecoveryTarget } 'update_recovery_owner_changed'
  [IO.File]::WriteAllText((Join-Path $target 'installed.flag'), $originalFlag)
  [IO.File]::WriteAllText((Join-Path $target '.mizar-update-owner'), (Split-Path -Leaf $StageRoot))
  Assert (Test-RestoredTransaction @{ phase = 'restored' }) 'Terminal cleanup did not accept original restored instance'
  Assert (!(Test-Path -LiteralPath (Join-Path $target '.mizar-update-owner'))) 'Terminal cleanup left its own marker'
  Write-Output 'PASS: legacy identity rejected; interrupted terminal cleanup is owner-scoped'
  # The original static flag must survive a full swap, including the production
  # registration guard; a mocked Restore-Registration would hide this regression.
  [IO.File]::WriteAllText((Join-Path $StageRoot 'previous/installed.flag'), 'legacy installed')
  [IO.File]::WriteAllText((Join-Path $target 'installed.flag'), 'legacy installed')
  $plan.previousInstallationId = [MizarUpdateFiles]::Hash((Join-Path $target 'installed.flag'))
  if (Test-Path -LiteralPath $failed) { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $failed -Recurse -Force }
  Candidate
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'installing' }
  Create-RecoveryOwner
  Restore-Previous
  Assert ((Get-Content (Join-Path $target 'installed.flag') -Raw) -eq 'legacy installed') 'Legacy original instance was not restored'
  Assert (Test-RestoredTransaction @{ phase = 'restored' }) 'Legacy rollback did not finish registration and terminal cleanup'
  Write-Output 'PASS: legacy flag rollback reaches registration and restored terminal'

  # The real marker publication runs before installing is persisted. Both sides
  # of that boundary preserve a legacy installation until payload mutation starts.
  $plan.previousInstallationId = [MizarUpdateFiles]::Hash((Join-Path $target 'installed.flag'))
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'prepared' }
  Create-RecoveryOwner
  Assert-RecoveryTarget
  Assert-PreviousInstance $target
  Remove-RecoveryOwner
  Assert (!(Test-Path -LiteralPath (Join-Path $target '.mizar-update-owner'))) 'Prepared recovery did not clear its own marker'
  Write-Output 'PASS: marker publication before installing permits prepared recovery'


} finally { Microsoft.PowerShell.Management\Remove-Item -LiteralPath $root -Recurse -Force }
