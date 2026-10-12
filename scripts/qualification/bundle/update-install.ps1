param(
  [ValidateSet('Prepare', 'Install', 'Recover', 'Rollback')][string]$Mode,
  [string]$PlanPath,
  [string]$StageRoot,
  [int]$HostProcessId = 0,
  [string]$ReadyEvent,
  [switch]$NoLaunch,
  [switch]$NoStatusWindow,
  [switch]$KeepBackup
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Write-JsonAtomic($path, $value) {
  $temp = $path + '.tmp'
  [IO.File]::WriteAllText($temp, ($value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $temp -Destination $path -Force
}
# Optional qualification timing never changes the transaction's decision or order.
function Measure-UpdatePhase([string]$Name, [scriptblock]$Operation) {
  if (Test-UpdateCancellation) { throw 'update_cancelled_before_install' }
  Update-WindowPhase $Name
  Record-UpdateActivity $Name
  if ($env:MIZAR_MEASURE_UPDATE -ne '1') { & $Operation; return }
  $clock = [Diagnostics.Stopwatch]::StartNew()
  $status = 'failure'
  try { & $Operation; $status = 'success' }
  finally {
    try {
      $script:updatePhases.Add(@{ phase = $Name; durationMs = $clock.ElapsedMilliseconds; status = $status })
      Write-JsonAtomic (Join-Path $StageRoot ($Mode.ToLowerInvariant() + '-timings.json')) @{
        mode = $Mode; version = $plan.version; gitSha = $plan.gitSha
        previousContentDigest = $plan.previousContentDigest; contentDigest = $plan.contentDigest
        phases = @($script:updatePhases.ToArray())
      }
    } catch {
      # A diagnostic failure must neither replace the operation's exception nor start rollback.
      Write-Warning ('update_timing_write_failed [' + $Name + ']: ' + $_.Exception.Message) -WarningAction Continue
    }
  }
}
if ($env:MIZAR_MEASURE_UPDATE -eq '1') { $script:updatePhases = [Collections.Generic.List[object]]::new() }

# Keep every path/byte check; avoid invoking a provider cmdlet per manifest entry.
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Security.Cryptography;
public static class MizarUpdateFiles {
  public static void PlainPath(string path) {
    if (!Path.IsPathRooted(path) || path.IndexOfAny(new char[]{'"','\r','\n'}) >= 0) throw new IOException("update_path_invalid");
    for (string cursor=Path.GetFullPath(path); cursor!=null; cursor=Path.GetDirectoryName(cursor))
      if ((File.Exists(cursor) || Directory.Exists(cursor)) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint)!=0)
        throw new IOException("update_reparse_point");
  }
  public static string Hash(string path) {
    PlainPath(path);
    using (var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read))
    using (var hash=SHA256.Create())
      return BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant();
  }
  public static void Delete(string path) {
    PlainPath(path);
    if (!File.Exists(path)) throw new FileNotFoundException("Product file is missing",path);
    var attributes=File.GetAttributes(path);
    if ((attributes & FileAttributes.ReadOnly)!=0) File.SetAttributes(path,attributes & ~FileAttributes.ReadOnly);
    File.Delete(path);
  }
}
'@
$script:updateWindowAvailable = !$NoStatusWindow -and $Mode -and $Mode -ne 'Prepare'
# A native status window shares this helper's lifetime, not a second updater.
if ($script:updateWindowAvailable) {
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Windows.Forms;
using System.Threading;
using System.Diagnostics;
public static class MizarUpdateWindow {
  static readonly object gate = new object();
  static readonly ManualResetEvent ready = new ManualResetEvent(false), closed = new ManualResetEvent(false);
  static Form window;
  static Label heading, detail, hint;
  static Button cancel, logs, close;
  static ProgressBar activity;
  static bool cancellable, cancelled, finished;
  static Exception startupError;
  static Thread thread;
  static string directory;
  public static bool CancellationRequested { get { lock(gate) { return cancelled; } } }
  static void RequestCancel() {
    lock(gate) { if (!cancellable || finished) return; cancelled=true; cancellable=false; }
    cancel.Enabled=false; hint.Text="正在取消更新，请等待工具安全结束。";
  }
  public static void Start(string stage, bool canCancel) {
    directory=stage; cancellable=canCancel;
    thread=new Thread(delegate() {
      try {
        Application.EnableVisualStyles();
        window=new Form { Text="Mizar 应用更新", ClientSize=new Size(590,300), StartPosition=FormStartPosition.CenterScreen, Font=new Font("Microsoft YaHei UI",9F), BackColor=Color.White, AutoScaleMode=AutoScaleMode.Dpi, MaximizeBox=false, MinimizeBox=true, ShowInTaskbar=true };
        window.MinimumSize=window.Size;
        var banner=new Panel { Dock=DockStyle.Top, Height=72, BackColor=Color.FromArgb(14,24,41) };
        banner.Controls.Add(new Label { Text="Mizar", ForeColor=Color.White, Font=new Font("Segoe UI",24F), AutoSize=true, Location=new Point(32,12) });
        heading=new Label { Text=canCancel ? "正在等待 Mizar 安全退出" : "正在恢复 Mizar", Location=new Point(32,94), Size=new Size(526,34), Font=new Font(window.Font.FontFamily,15F) };
        detail=new Label { Text="工具将核对程序和备份，再完成当前操作。", Location=new Point(32,139), Size=new Size(526,45) };
        activity=new ProgressBar { Location=new Point(32,191), Size=new Size(526,12), Style=ProgressBarStyle.Marquee, MarqueeAnimationSpeed=0 };
        hint=new Label { Text="请等待本窗口完成，不要重复打开 Mizar。", Location=new Point(32,217), Size=new Size(526,30), ForeColor=Color.FromArgb(80,92,110) };
        logs=new Button { Text="查看日志", Location=new Point(32,255), Size=new Size(100,30), TabIndex=0 };
        logs.Click+=delegate { try { Process.Start(new ProcessStartInfo { FileName=directory, UseShellExecute=true }); } catch { hint.Text="日志目录无法打开，请保留更新记录并反馈。"; } };
        cancel=new Button { Text="取消更新", Location=new Point(347,255), Size=new Size(100,30), Enabled=canCancel, TabIndex=1 };
        cancel.Click+=delegate { RequestCancel(); };
        close=new Button { Text="关闭", Location=new Point(458,255), Size=new Size(100,30), Enabled=false, TabIndex=2 };
        close.Click+=delegate { window.Close(); };
        window.Controls.AddRange(new Control[] {banner,heading,detail,activity,hint,logs,cancel,close});
        window.FormClosing+=delegate(object sender,FormClosingEventArgs args) {
          if (!finished) { args.Cancel=true; if (cancellable) RequestCancel(); else hint.Text="安装或恢复已开始，请等待完成后再关闭。"; }
        };
        window.Shown+=delegate { ready.Set(); };
        window.FormClosed+=delegate { closed.Set(); };
        Application.Run(window);
      } catch(Exception error) { startupError=error; ready.Set(); closed.Set(); }
    });
    thread.IsBackground=true; thread.SetApartmentState(ApartmentState.STA); thread.Start();
    if (!ready.WaitOne(10000) || startupError!=null) throw new InvalidOperationException("update_status_window_unavailable",startupError);
  }
  static void Apply(Action operation) {
    var form=window;
    if (form==null || form.IsDisposed) return;
    try { form.Invoke(operation); } catch(ObjectDisposedException) { } catch(InvalidOperationException) { }
  }
  public static bool BeginMutation() {
    lock(gate) { if(cancelled) return false; cancellable=false; }
    Apply(delegate { cancel.Enabled=false; hint.Text="安装或恢复进行中，请勿重新打开 Mizar。"; });
    return true;
  }
  public static void Phase(string phase) {
    string text;
    switch(phase) {
      case "waiting-host": text="正在等待 Mizar 安全退出"; break;
      case "stopped-and-installer": text="正在核对安装工具"; break;
      case "previous-payload": text="正在核对原程序"; break;
      case "reparse-and-registration": text="正在保存安装登记"; break;
      case "backup-copy": text="正在备份原程序"; break;
      case "backup-payload": text="正在核对备份"; break;
      case "remove-previous-files": text="正在准备替换程序"; break;
      case "nsis-install": text="正在安装新版 Mizar"; break;
      case "installed-payload": text="正在核对新版完整性"; break;
      case "resources": text="正在核对并准备素材"; break;
      case "restore-check": text="正在核对恢复条件"; break;
      case "restore-copy": text="正在准备恢复旧版"; break;
      case "restore-swap": text="正在恢复原程序"; break;
      case "restore-verify": text="正在核对恢复结果"; break;
      default: text="正在处理更新，请稍候"; break;
    }
    Apply(delegate { heading.Text=text; detail.Text="当前阶段完成后会继续；耗时取决于磁盘、安装器和素材准备。"; });
  }
  public static void Complete(string status, string code, bool relaunch) {
    Apply(delegate {
      finished=true; cancellable=false; window.Text="Mizar 更新结果"; activity.Visible=false; cancel.Visible=false; close.Enabled=true;
      if(status=="installed") { heading.Text="更新已完成"; detail.Text="新版程序已核验。"; hint.Text=relaunch ? "正在重新打开 Mizar。" : "可以关闭本窗口后重新打开 Mizar。"; }
      else if(status=="restored") { heading.Text="旧版已恢复"; detail.Text="本次更新未完成，原程序与资料已保留。"; hint.Text="关闭本窗口后可重新打开 Mizar，再查看诊断。"; }
      else if(status=="cancelled") { heading.Text="更新未启动"; detail.Text="原程序未被替换，可以重新打开 Mizar。"; hint.Text="请查看日志了解原因，或使用正式安装包。"; }
      else { heading.Text="需要恢复"; detail.Text="当前程序尚未核验，备份与恢复记录已保留。"; hint.Text="请勿删除目录；查看日志并核对恢复记录后再继续。"; }
      if(!String.IsNullOrEmpty(code)) detail.Text+="\r\n诊断代码："+code;
      window.AcceptButton=close; window.CancelButton=close; close.Focus();
    });
  }
  public static void LaunchFailed() { Apply(delegate { heading.Text="更新已完成，但未能重新打开"; hint.Text="程序已核验，请关闭本窗口后手动启动；失败时查看日志。"; }); }
  public static void CloseCompleted() { Apply(delegate { if(finished) window.Close(); }); }
  public static void WaitForClose() { if(thread!=null) { closed.WaitOne(); thread.Join(); } }
}
'@
}
function Update-WindowPhase([string]$phase) { if ($script:updateWindowAvailable) { [MizarUpdateWindow]::Phase($phase) } }
function Test-UpdateCancellation { if ($script:updateWindowAvailable) { return [MizarUpdateWindow]::CancellationRequested }; return $false }
function Start-UpdateMutation { if ($script:updateWindowAvailable) { return [MizarUpdateWindow]::BeginMutation() }; return $true }
function Record-UpdateActivity([string]$phase, [string]$detail = '') {
  try {
    $text = $detail
    $text = [regex]::Replace($text, '(?im)^.*(?:authorization|token|password|credential|secret|api[_-]?key)["'']?\s*[:=].*$', '[credential-bearing line redacted]')
    if ($text.Length -gt 8192) { $text = $text.Substring(0,8192) + ' [truncated]' }
    $record = @{ phase=$phase; time=[DateTime]::UtcNow.ToString('o'); detail=$text } | ConvertTo-Json -Compress
    [IO.File]::AppendAllText((Join-Path $StageRoot 'update-activity.ndjson'), $record + "`n", (New-Object Text.UTF8Encoding($false)))
  } catch { }
}
function Assert-PlainPath([string]$path) { [MizarUpdateFiles]::PlainPath($path) }

function Assert-Plan($plan) {
  if ($plan.schemaVersion -ne 1 -or $plan.version -notmatch '^\d+\.\d+\.\d+$' -or
    $plan.gitSha -notmatch '^[a-f0-9]{40}$' -or $plan.installerSha256 -notmatch '^[a-f0-9]{64}$' -or
    $plan.contentDigest -notmatch '^[a-f0-9]{64}$' -or $plan.previousContentDigest -notmatch '^[a-f0-9]{64}$' -or
    ($plan.coreArchiveSha256 -and $plan.coreArchiveSha256 -notmatch '^[a-f0-9]{64}$') -or
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
    (Split-Path -Leaf $installerPath) -ne ('Mizar-v' + $plan.version + '-Windows-x64-' + $(if ($plan.coreArchiveSha256) { 'Core-' } else { '' }) + 'Setup.exe')) { throw 'update_installer_path_invalid' }
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
    $file = [IO.Path]::Combine($directory, $name)
    if ([MizarUpdateFiles]::Hash($file) -ne $hash) { throw 'update_payload_corrupt' }
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
  $script:updateResultWritten = $true
}
function Restore-Previous {
  [void](Start-UpdateMutation)
  Update-WindowPhase 'restore-check'
  Record-UpdateActivity 'restore-check'
  Assert-Stopped
  # Windows refuses write access to an executable image while it is mapped.
  # Check the actual file, avoiding PID gaps and short/Unicode path aliases.
  # No bytes are written; an unreadable or still-used installer fails closed.
  try {
    $image = [IO.File]::Open((Join-Path $StageRoot 'Installer.exe'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $image.Dispose()
  } catch { throw 'update_installer_remaining' }
  $backup = Join-Path $StageRoot 'previous'
  Assert-Payload $backup $plan.previousContentDigest
  $restore = $plan.bundleRoot + '.mizar-restore-' + (Split-Path $StageRoot -Leaf)
  $failed = $plan.bundleRoot + '.mizar-failed-' + (Split-Path $StageRoot -Leaf)
  Assert-PlainPath $restore; Assert-PlainPath $failed
  if (Test-Path -LiteralPath $plan.bundleRoot) {
    # A retry after a directory swap must not destroy its only failed copy.
    try { Assert-Payload $plan.bundleRoot $plan.previousContentDigest; Restore-Registration; Record-Result 'restored' 'update_rolled_back'; Recovery-Registration $false; return } catch { }
  }
  # Check an already restored payload before materializing another full restore copy.
  # The backup and current payload remain independently verified above.
  Update-WindowPhase 'restore-copy'
  Record-UpdateActivity 'restore-copy'
  if (!(Test-Path -LiteralPath $restore)) { Copy-Item -LiteralPath $backup -Destination $restore -Recurse }
  Assert-Payload $restore $plan.previousContentDigest
  Update-WindowPhase 'restore-swap'
  Record-UpdateActivity 'restore-swap'
  if (Test-Path -LiteralPath $plan.bundleRoot) {
    if (Test-Path -LiteralPath $failed) { throw 'update_recovery_conflict' }
    Move-Item -LiteralPath $plan.bundleRoot -Destination $failed
  }
  Move-Item -LiteralPath $restore -Destination $plan.bundleRoot
  Update-WindowPhase 'restore-verify'
  Record-UpdateActivity 'restore-verify'
  Assert-Payload $plan.bundleRoot $plan.previousContentDigest
  Restore-Registration
  Record-Result 'restored' 'update_rolled_back'
  Recovery-Registration $false
  # Retain the displaced directory: unverified files must never be deleted during recovery.
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
$script:updateExitCode = 0
$script:updateFailureCode = ''
$script:updateResultWritten = $false
$script:launchAfterCommit = $false
function Invoke-UpdateTransaction {
# One writer spans Install/Recover/Rollback, including all failure preservation.
# Retaining the existing desktop object also blocks older Hosts which check its existence.
$writer = New-Object Threading.Mutex($false, 'Global\MizarUpdateWriter')
$writerOwned = $false
$desktop = $null
$active = $null
$windowOpened = $false
try {
  try { $writerOwned = $writer.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $writerOwned = $true }
  if (!$writerOwned) { throw 'update_transaction_busy' }
  $desktop = New-Object Threading.Mutex($false, 'Global\MizarDesktop')
  $active = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, 'Global\MizarUpdateActive')
  if (!$NoStatusWindow) { [MizarUpdateWindow]::Start($StageRoot, ($Mode -eq 'Install')); $windowOpened = $true }
  if ($ReadyEvent) {
    if ($Mode -ne 'Install' -or $ReadyEvent -notmatch '^Global\\MizarUpdateReady-[0-9]+-[0-9]+$') { throw 'update_handoff_invalid' }
    $ready = [Threading.EventWaitHandle]::OpenExisting($ReadyEvent)
    try { [void]$ready.Set() } finally { $ready.Dispose() }
  }
try {
  if ($Mode -eq 'Rollback') { Restore-Previous; return }
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
    return
  }
  if ($Mode -ne 'Install' -or $HostProcessId -le 0) { throw 'update_host_invalid' }
  Update-WindowPhase 'waiting-host'
  Record-UpdateActivity 'waiting-host'
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while (Get-Process -Id $HostProcessId -ErrorAction SilentlyContinue) {
    if (Test-UpdateCancellation) { throw 'update_cancelled_before_install' }
    if ([DateTime]::UtcNow -gt $deadline) { throw 'update_host_exit_timeout' }
    Start-Sleep -Milliseconds 200
  }
  Measure-UpdatePhase 'stopped-and-installer' {
    Assert-Stopped
    Assert-Installer $plan (Join-Path $StageRoot 'Installer.exe')
  }
  Measure-UpdatePhase 'previous-payload' { Assert-Payload $plan.bundleRoot $plan.previousContentDigest }
  Measure-UpdatePhase 'reparse-and-registration' {
    if (Get-ChildItem -LiteralPath $plan.bundleRoot -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'update_reparse_point' }
    Save-Registration
  }
  Measure-UpdatePhase 'backup-copy' { Copy-Item -LiteralPath $plan.bundleRoot -Destination (Join-Path $StageRoot 'previous') -Recurse }
  Measure-UpdatePhase 'backup-payload' { Assert-Payload (Join-Path $StageRoot 'previous') $plan.previousContentDigest }
  if (!(Start-UpdateMutation)) { throw 'update_cancelled_before_install' }
  Recovery-Registration $true
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'installing' }
  # Remove only the verified previous product files; preserve state and every untracked file.
  Measure-UpdatePhase 'remove-previous-files' {
    foreach ($line in (Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'previous/resources/metadata/SHA256SUMS'))) {
      $name = $line.Substring(66)
      if ($name -match '\\|^/|:|(^|/)\.\.?(/|$)|//|^state/') { throw 'update_payload_path_invalid' }
      $file = [IO.Path]::Combine($plan.bundleRoot, $name)
      [MizarUpdateFiles]::Delete($file)
    }
  }
  Measure-UpdatePhase 'nsis-install' {
    $installer = Start-Process -FilePath (Join-Path $StageRoot 'Installer.exe') -ArgumentList @('/S', '/MIZARUPDATE', ('/D=' + $plan.bundleRoot)) -PassThru
    $installer.WaitForExit()
    if ($installer.ExitCode -ne 0) { throw 'update_installer_cancelled' }
  }
  Measure-UpdatePhase 'installed-payload' { Assert-Payload $plan.bundleRoot $plan.contentDigest $plan.version $plan.gitSha }
  if ($plan.coreArchiveSha256) {
    # Complete resources through the verified deployed App/SDK before committing.
    # Failure retains the existing program backup and enters the normal rollback.
    Update-WindowPhase 'resources'
    Record-UpdateActivity 'resources'
    $node = Join-Path $plan.bundleRoot 'resources/runtime/node.exe'
    $bridge = Join-Path $plan.bundleRoot 'resources/app/dist/web-installer/installed-entry.mjs'
    $env:MIZAR_STATE_ROOT = $plan.stateRoot
    $savedNodeOptions = $env:NODE_OPTIONS; $savedNodePath = $env:NODE_PATH
    try {
      Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
      Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
      & $node $bridge $plan.version $plan.gitSha $plan.contentDigest $plan.coreArchiveSha256 $plan.installerSha256 $plan.installerBytes
      if ($LASTEXITCODE -ne 0) { throw 'update_resources_incomplete' }
    } finally { $env:NODE_OPTIONS = $savedNodeOptions; $env:NODE_PATH = $savedNodePath }
  }
  # Silent Setup removes the old shortcut and leaves its optional section off.
  # Preserve the user's existing shortcut without creating one for other users.
  $desktopShortcut = Join-Path $StageRoot 'shortcut-0'
  if (Test-Path -LiteralPath $desktopShortcut) {
    Copy-Item -LiteralPath $desktopShortcut -Destination (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mizar.lnk') -Force
  }
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'committed' }
  Record-Result 'installed' 'update_completed'
  Recovery-Registration $false
  if (!$KeepBackup) { Remove-Item -LiteralPath (Join-Path $StageRoot 'previous') -Recurse -Force }
  if (!$KeepBackup) { Remove-Item -LiteralPath (Join-Path $StageRoot 'Installer.exe') -Force }
  $env:MIZAR_STATE_ROOT = $plan.stateRoot
  $script:launchAfterCommit = !$NoLaunch
} catch {
  Record-UpdateActivity 'failure' ($_.ToString() + "`n" + $_.ScriptStackTrace)
  [Console]::Error.WriteLine($_.ToString())
  [Console]::Error.WriteLine($_.ScriptStackTrace)
  # Static file operations preserve the original named failure through invocation wrappers.
  $cause = $_.Exception
  while ($cause.InnerException) { $cause = $cause.InnerException }
  $code = [string]$cause.Message
  if ($code -notmatch '^update_[a-z_]+$') { $code = 'update_installation_failed' }
  $script:updateFailureCode = $code
  $journal = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json
  if ($journal.phase -eq 'installing') {
    try { Restore-Previous }
    catch { [Console]::Error.WriteLine($_.ToString()); [Console]::Error.WriteLine($_.ScriptStackTrace); Recovery-Registration $true; Record-Result 'recovery-required' $code }
  } elseif ($journal.phase -eq 'committed') {
    # A committed journal is not evidence that the current files are intact.
    # Cleanup/launch errors may still be successful installs, but corruption
    # must retain recovery registration and never be presented as completion.
    try {
      Assert-Payload $plan.bundleRoot $plan.contentDigest $plan.version $plan.gitSha
      Record-Result 'installed' 'update_completed'
      Recovery-Registration $false
    } catch {
      Recovery-Registration $true
      Record-Result 'recovery-required' 'update_committed_payload_invalid'
    }
  }
  else { Record-Result 'cancelled' $code; Recovery-Registration $false }
  $script:updateExitCode = 1
  return
}
} finally {
  if ($null -ne $desktop) { $desktop.Dispose() }
  if ($null -ne $active) { $active.Dispose() }
  if ($writerOwned) { $writer.ReleaseMutex() }
  $writer.Dispose()
}
}
try { Invoke-UpdateTransaction }
catch {
  $script:updateExitCode = 1
  Record-UpdateActivity 'transaction_entry_failed' $_.ToString()
  [Console]::Error.WriteLine($_.ToString())
}
$result = $null
try { $result = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $plan.stateRoot 'updates/result.json') -Raw | ConvertFrom-Json } catch { }
$phase = ''
try { $phase = [string](Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json).phase } catch { }
$currentResult = $script:updateResultWritten -and $null -ne $result -and $result.recoveryDirectory -eq (Split-Path -Leaf $StageRoot)
$status = if ($currentResult) { [string]$result.status } elseif ($phase -eq 'prepared') { 'cancelled' } else { 'recovery-required' }
$code = if ($currentResult) { [string]$result.code } elseif ($phase -eq 'prepared') { 'update_not_started' } else { 'update_result_unavailable' }
if ($script:updateFailureCode) { $code = $script:updateFailureCode + ' / ' + $code }
if ($script:updateWindowAvailable) { [MizarUpdateWindow]::Complete($status, $code, $script:launchAfterCommit) }
# No protected writes remain; the new Host can now acquire its desktop object.
if ($script:launchAfterCommit) {
  try { Start-Process -FilePath (Join-Path $plan.bundleRoot 'Mizar.exe') -WorkingDirectory $plan.bundleRoot; if ($script:updateWindowAvailable) { [MizarUpdateWindow]::CloseCompleted() } }
  catch { Record-UpdateActivity 'launch_failed' $_.ToString(); if ($script:updateWindowAvailable) { [MizarUpdateWindow]::LaunchFailed() }; $script:updateExitCode = 1 }
} elseif ($status -eq 'installed' -and $NoLaunch -and $script:updateWindowAvailable) { [MizarUpdateWindow]::CloseCompleted() }
if ($script:updateWindowAvailable) { [MizarUpdateWindow]::WaitForClose() }
exit $script:updateExitCode
