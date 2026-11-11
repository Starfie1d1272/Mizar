param()
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'bundle/update-install.ps1'
$legacy = Join-Path $PSScriptRoot 'legacy-v1.11.4.ps1'
$root = Join-Path ([IO.Path]::GetTempPath()) ('mizar handoff ' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($root) | Out-Null
$oldLocal = $env:LOCALAPPDATA; $env:LOCALAPPDATA = Join-Path $root 'local'
$env:MIZAR_STATE_ROOT = Join-Path $root 'state with spaces'
$state = $env:MIZAR_STATE_ROOT
$target = Join-Path $root 'installed'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
$script:registry = @{}
# Function tests use a registry double. NSIS below runs in its own process and
# uses the real empty runner hive, after an explicit no-existing-install check.
function Test-Path {
  [CmdletBinding()]param([string]$LiteralPath,[string]$Path,[string]$PathType)
  $value = if ($LiteralPath) { $LiteralPath } else { $Path }
  if ($value.StartsWith('HKCU:')) { return $script:registry.ContainsKey($value) }
  Microsoft.PowerShell.Management\Test-Path @PSBoundParameters
}
function Get-ItemProperty { [CmdletBinding()]param([string]$LiteralPath) return $script:registry[$LiteralPath] }
function Remove-ItemProperty { [CmdletBinding()]param([string]$Path,[string]$Name) $script:registry[$Path].Remove($Name) }
function Assert($value,[string]$message) { if (!$value) { throw $message } }
function Reject([scriptblock]$operation,[string]$code) {
  $message=''; try { & $operation | Out-Null } catch { $message=$_.Exception.ToString() }
  Assert ($message.Contains($code)) ('Expected '+$code+', got '+$message)
}
function Hash([string]$path) { return (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
function Put([string]$path,[string]$text) { [IO.Directory]::CreateDirectory((Split-Path -Parent $path)) | Out-Null; [IO.File]::WriteAllText($path,$text,[Text.UTF8Encoding]::new($false)) }
function Json([string]$path,$value) { Put $path ($value|ConvertTo-Json -Depth 8 -Compress) }
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
Assert (!$errors.Count) 'Production script syntax errors'
$functions=$ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)
foreach($function in $functions) { Invoke-Expression $function.Extent.Text }
$add=$ast.FindAll({param($n) $n -is [Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Add-Type'},$true)|Select-Object -First 1
Invoke-Expression $add.Extent.Text
$script:handoffHandles=[Collections.Generic.List[IDisposable]]::new()
function Stage([string]$digit='1') {
  $stage=Join-Path $state ('updates\install-'+($digit*32))
  [IO.Directory]::CreateDirectory($stage)|Out-Null
  Copy-Item -LiteralPath $legacy -Destination (Join-Path $stage 'update-install.ps1')
  Json (Join-Path $stage 'plan.json') @{schemaVersion=1;bundleRoot=$target;stateRoot=$state}
  Json (Join-Path $stage 'journal.json') @{phase='prepared'}
  Put (Join-Path $stage 'previous\sentinel') 'preserved backup'
  Put (Join-Path $stage 'Restore-Mizar.cmd') "@echo off`r`npowershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"%~dp0update-install.ps1`" -Mode Recover -StageRoot `"%~dp0.`"`r`npause`r`n"
  return $stage
}
$writer=[Threading.Mutex]::new($false,'Global\MizarUpdateWriter')
$owned=$writer.WaitOne(0);Assert $owned 'Unexpected pre-existing writer on isolated runner'
try {
  Put (Join-Path $target 'successor') 'same location successor must remain'
  $stage=Stage
  $original=Hash (Join-Path $stage 'update-install.ps1');$planHash=Hash (Join-Path $stage 'plan.json');$journalHash=Hash (Join-Path $stage 'journal.json')
  $script:registry[$runKey]=@{'!MizarUpdateRecovery'=('"'+(Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')+'" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $stage 'update-install.ps1')+'" -Mode Recover -StageRoot "'+$stage+'"')}
  $gone=Start-Process powershell.exe -ArgumentList '-NoProfile -NonInteractive -Command "Start-Sleep -Milliseconds 500"' -PassThru -WindowStyle Hidden
  $endedPid=$gone.Id;$endedStarted=$gone.StartTime.ToUniversalTime().Ticks;$gone.WaitForExit();$gone.Dispose()
  $pending=Join-Path $env:LOCALAPPDATA 'Mizar\bootstrap-cache\fresh-install.pending'
  Json $pending @{schemaVersion='mizar.bootstrap-pending.v1';target=$target;updateStage=$stage;updatePlanSha256=$planHash;updateScriptSha256=$original;ownerPid=$endedPid;ownerStarted=$endedStarted;writerPid=0;writerStarted=0;stage='update-prepared'}
  $pendingHash=Hash $pending
  Invoke-LegacyHandoff $target $state|Out-Null
  Assert ((Hash (Join-Path $stage 'update-install.ps1.retired')) -eq $original) 'Original helper bytes changed'
  Assert ((Hash (Join-Path $stage 'plan.json')) -eq $planHash -and (Hash (Join-Path $stage 'journal.json')) -eq $journalHash) 'Plan or journal was rewritten'
  Assert ((Hash (Join-Path $stage 'fresh-install.pending.retired')) -eq $pendingHash -and !(Test-Path -LiteralPath $pending)) 'Pending was not archived unchanged'
  Assert ((Get-Content (Join-Path $target 'successor')) -eq 'same location successor must remain') 'Successor payload changed'
  Assert (!$script:registry[$runKey].ContainsKey('!MizarUpdateRecovery')) 'Exact old RunOnce retained'
  Invoke-LegacyHandoff $target $state|Out-Null
  $completedLease=[IO.File]::Open((Join-Path (Split-Path -Parent $pending) 'fresh-install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try { Invoke-LegacyHandoff $target $state|Out-Null } finally { $completedLease.Dispose() }
  Write-Output 'PASS production retirement + repeat: original plan/journal/helper/backup preserved, same-location successor unchanged, pending/cmd/RunOnce retired'
  # Resume the exact crash boundary after rename, before refusal publication.
  $interrupted=Stage '2';Move-Item (Join-Path $interrupted 'update-install.ps1') (Join-Path $interrupted 'update-install.ps1.retired')
  Invoke-LegacyHandoff $target $state|Out-Null
  Assert ((Get-Content (Join-Path $interrupted 'update-install.ps1') -Raw).StartsWith('throw ')) 'Interrupted retirement not resumed'
  $blocked=Stage '3'
  $lease=[IO.File]::Open((Join-Path (Split-Path -Parent $pending) 'fresh-install.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  try { Reject { Invoke-LegacyHandoff $target $state } 'update_handoff_bootstrap_active' } finally { $lease.Dispose() }
  Assert (!(Test-Path -LiteralPath (Join-Path $blocked 'update-install.ps1.retired'))) 'Busy bootstrap still retired a helper'
  $fake=Join-Path $root 'active.ps1';Put $fake 'param([string]$StageRoot) Start-Sleep -Seconds 6'
  $active=Start-Process powershell.exe -ArgumentList ('-NoProfile -NonInteractive -File "'+$fake+'" -StageRoot "'+$blocked+'"') -PassThru -WindowStyle Hidden
  try { Reject { Invoke-LegacyHandoff $target $state } 'update_handoff_process_active' } finally { $active.WaitForExit();$active.Dispose() }
  Assert (!(Test-Path -LiteralPath (Join-Path $blocked 'update-install.ps1.retired'))) 'Live helper still retired'
  Invoke-LegacyHandoff $target $state|Out-Null
  Write-Output 'PASS production crash resume; busy bootstrap and active same-stage PowerShell refuse before retirement, with no process termination'
} finally {
  foreach($handle in $script:handoffHandles){$handle.Dispose()}
  if($owned){$writer.ReleaseMutex()};$writer.Dispose()
}
# Actual NSIS path, including the controlled nested uninstaller and the two
# generations of real update PowerShell parent. Payload is deliberately inert.
Assert (!(Microsoft.PowerShell.Management\Test-Path 'HKCU:\Software\Mizar')) 'Runner already has Mizar; refuse any real installation'
Assert (!(Microsoft.PowerShell.Management\Test-Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar')) 'Runner already has Mizar uninstall registration'
Remove-Item -LiteralPath $target -Recurse -Force
$payload=Join-Path $root 'payload'
$files=@{'Mizar.exe'='inert fixture';'resources/runtime/node.exe'='inert node';'resources/app/dist/server.js'='fixture';'resources/web/dist/index.html'='fixture'}
$records=@{};foreach($name in $files.Keys){Put (Join-Path $payload $name) $files[$name];$records[$name]=Hash (Join-Path $payload $name)}
$scriptName='resources/scripts/update-install.ps1';[IO.Directory]::CreateDirectory((Join-Path $payload 'resources/scripts'))|Out-Null;Copy-Item -LiteralPath $source -Destination (Join-Path $payload $scriptName);$records[$scriptName]=Hash (Join-Path $payload $scriptName)
$names=[string[]]@($records.Keys);[Array]::Sort($names,[StringComparer]::Ordinal);$identity='';foreach($name in $names){$identity+=$name+[char]0+$records[$name]+"`n"}
$sha=[Security.Cryptography.SHA256]::Create();$digest=[BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))).Replace('-','').ToLowerInvariant();$sha.Dispose()
Json (Join-Path $payload 'resources/metadata/artifact.json') @{repository='Starfie1d1272/Mizar';appVersion='1.2.0';gitSha=('a'*40);artifactSha256=$digest}
$records['resources/metadata/artifact.json']=Hash (Join-Path $payload 'resources/metadata/artifact.json')
$sums='';foreach($name in $records.Keys){$sums+=$records[$name]+'  '+$name+"`n"};Put (Join-Path $payload 'resources/metadata/SHA256SUMS') $sums
$remove=Join-Path $root 'remove.nsh';$lines=@(Get-ChildItem $payload -Recurse -File|ForEach-Object{'Delete "$INSTDIR\'+$_.FullName.Substring($payload.Length+1)+'"'})
$lines+=@(Get-ChildItem $payload -Recurse -Directory|Sort-Object {$_.FullName.Length} -Descending|ForEach-Object{'RMDir "$INSTDIR\'+$_.FullName.Substring($payload.Length+1)+'"'})
Put $remove ($lines -join "`r`n")
$download=Join-Path $state 'updates\download-fixture';[IO.Directory]::CreateDirectory($download)|Out-Null
$installer=Join-Path $download 'Mizar-v1.2.0-Windows-x64-Setup.exe'
$compiler=Join-Path ${env:ProgramFiles(x86)} 'NSIS\makensis.exe'
# Log NSIS-captured errors outside the payload; diagnostics do not change decisions.
$nsisProbe=Join-Path $root 'fixture.nsi'
$nsisText=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'windows-setup.nsi'))
$nsisText=$nsisText.Replace('  DetailPrint "$1"', ('  DetailPrint "$1"'+"`r`n"+'  FileOpen $2 "'+(Join-Path $root 'nsis-error.log')+'" a'+"`r`n"+'  FileWrite $2 "$0: $1$\r$\n"'+"`r`n"+'  FileClose $2'))
Put $nsisProbe $nsisText
& $compiler /V2 /INPUTCHARSET UTF8 "/DPAYLOAD=$payload" "/DOUTPUT=$installer" /DVERSION=1.2.0 "/DICON=$PSScriptRoot/../../apps/desktop/src-tauri/icons/icon.ico" "/DREMOVE_FILES=$remove" $nsisProbe
Assert ($LASTEXITCODE -eq 0) 'NSIS compilation failed'
function Run-Setup {
  $p=Start-Process $installer -ArgumentList @('/S',('"/MIZARSTATE='+$state+'"'),('/D='+$target)) -PassThru
  Assert ($p.WaitForExit(60000)) 'NSIS fixture exceeded its bounded wait; do not kill it'
  if($p.ExitCode -ne 0) { $native=Join-Path $root 'nsis-error.log'; if(Test-Path -LiteralPath $native){Get-Content -LiteralPath $native|Write-Output}; $log=Join-Path $state 'updates/handoff-last.log'; if(Test-Path -LiteralPath $log){Get-Content -LiteralPath $log|Write-Output} }
  Assert ($p.ExitCode -eq 0) ('NSIS fixture failed '+$p.ExitCode);$p.Dispose()
}
function Run-Update([string]$helper) {
  $planPath=Join-Path $root ('plan-'+[guid]::NewGuid().ToString('N')+'.json')
  Json $planPath @{schemaVersion=1;bundleRoot=$target;stateRoot=$state;installer=$installer;installerSha256=(Hash $installer);installerBytes=(Get-Item $installer).Length;previousContentDigest=$digest;contentDigest=$digest;version='1.2.0';gitSha=('a'*40)}
  $output=& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $helper -Mode Prepare -PlanPath $planPath
  Assert ($LASTEXITCODE -eq 0) 'Native Prepare failed'
  $stage=($output|ConvertFrom-Json).stageRoot
  & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $stage 'update-install.ps1') -Mode Install -StageRoot $stage -HostProcessId 2147483647 -NoLaunch -NoStatusWindow
  Assert ($LASTEXITCODE -eq 0) ('Native Install failed; stage '+$stage)
  return $stage
}
try {
  Run-Setup
  $flag1=Get-Content (Join-Path $target 'installed.flag') -Raw
  Run-Setup
  Assert ((Get-Content (Join-Path $target 'installed.flag') -Raw) -ne $flag1) 'Same-package reinstall did not create a new instance'
  Write-Output 'PASS actual independent NSIS + same-package reinstall + authenticated controlled nested uninstall; custom state root with spaces'
  $legacyStage=Run-Update $legacy
  Assert (!(Test-Path -LiteralPath (Join-Path $legacyStage 'update-install.ps1.retired'))) 'Current legacy parent falsely marked retired'
  Write-Output 'PASS actual v1.11.4 helper -> new NSIS -> new controlled uninstaller; exact current legacy responsibility preserved'
  $modernStage=Run-Update $source
  Assert (Test-Path -LiteralPath (Join-Path $legacyStage 'update-install.ps1.retired')) 'Next modern Install did not retire the ended legacy parent'
  Write-Output 'PASS actual modern PS Install -> NSIS -> controlled uninstall; ended legacy parent retired before replacement'
  $extra=Stage '4'
  $uninstall=Join-Path $target 'Uninstall.exe'
  $p=Start-Process $uninstall -ArgumentList @('/S',('_?='+$target)) -PassThru
  Assert ($p.WaitForExit(60000)) 'Uninstaller fixture exceeded its bounded wait; do not kill it'
  Assert ($p.ExitCode -eq 0) ('Independent uninstall failed '+$p.ExitCode);$p.Dispose()
  Assert (!(Test-Path -LiteralPath (Join-Path $target 'installed.flag'))) 'Independent uninstall did not remove its marker'
  Assert (Test-Path -LiteralPath (Join-Path $extra 'update-install.ps1.retired')) 'Independent uninstall did not retire legacy stage'
  Assert (Test-Path -LiteralPath (Join-Path $extra 'previous/sentinel')) 'Independent uninstall deleted recovery backup'
  Write-Output 'PASS actual independent uninstall retires legacy execution first and preserves recovery backup'
} finally {
  $env:LOCALAPPDATA=$oldLocal
  # CI runner and isolated temp directory remain available in logs on failure.
}
