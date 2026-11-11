param(
  [ValidateSet('Prepare', 'Install', 'Recover', 'Rollback', 'Finalize', 'Handoff')][string]$Mode,
  [string]$PlanPath,
  [string]$StageRoot,
  [int]$HostProcessId = 0,
  [string]$ReadyEvent,
  [switch]$NoLaunch,
  [switch]$NoStatusWindow,
  [switch]$KeepBackup,
  [string]$HandoffTarget,
  [string]$HandoffState,
  [int]$CallerProcessId = 0,
  [string]$ReceiptPath,
  [string]$ParentReceiptPath,
  [string]$InstallationOwner,
  [string]$ExpectedBootstrap,
  [switch]$ProbeWriter
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
[System.Runtime.InteropServices.ComImport, System.Runtime.InteropServices.Guid("000214F9-0000-0000-C000-000000000046"), System.Runtime.InteropServices.InterfaceType(System.Runtime.InteropServices.ComInterfaceType.InterfaceIsIUnknown)]
public interface MizarShortcutPath {
  [System.Runtime.InteropServices.PreserveSig]
  int GetPath([System.Runtime.InteropServices.Out, System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] System.Text.StringBuilder path, int capacity, IntPtr data, uint flags);
}
public static class MizarUpdateFiles {
  [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)] struct MutexOwner { public IntPtr Process, Thread; }
  [System.Runtime.InteropServices.DllImport("ntdll.dll")] static extern int NtQueryMutant(IntPtr handle, int kind, out MutexOwner owner, int size, out int returned);
  [System.Runtime.InteropServices.DllImport("shell32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string command, out int count);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static int WriterOwnerPid() {
    using(var mutex=new System.Threading.Mutex(false,@"Global\MizarUpdateWriter")) {
      MutexOwner owner; int returned, size=System.Runtime.InteropServices.Marshal.SizeOf(typeof(MutexOwner));
      int status=NtQueryMutant(mutex.SafeWaitHandle.DangerousGetHandle(),1,out owner,size,out returned);
      if(status!=0 || returned!=size) throw new IOException("update_handoff_writer_unknown");
      return owner.Process.ToInt32();
    }
  }
  [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] static extern uint GetLongPathNameW(string path, System.Text.StringBuilder result, uint capacity);
  public static string LongPath(string path) {
    var expanded=new System.Text.StringBuilder(32768);
    uint length=GetLongPathNameW(path,expanded,(uint)expanded.Capacity);
    return length>0 && length<expanded.Capacity ? expanded.ToString() : path;
  }
  public static string[] Arguments(string command) {
    int count; IntPtr memory=CommandLineToArgvW(command,out count);
    if(memory==IntPtr.Zero) throw new IOException("update_handoff_arguments_invalid");
    try {
      var arguments=new string[count];
      for(int i=0;i<count;i++) arguments[i]=System.Runtime.InteropServices.Marshal.PtrToStringUni(System.Runtime.InteropServices.Marshal.ReadIntPtr(memory,i*IntPtr.Size));
      return arguments;
    } finally { LocalFree(memory); }
  }
  public static string HashStream(FileStream file) {
    file.Position=0;
    using(var hash=SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant();
  }
  public static string ShortcutTarget(string path) {
    PlainPath(path);
    object shortcut=null;
    try {
      shortcut=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046"),true));
      ((System.Runtime.InteropServices.ComTypes.IPersistFile)shortcut).Load(path,0);
      var raw=new System.Text.StringBuilder(32768);
      if(((MizarShortcutPath)shortcut).GetPath(raw,raw.Capacity,IntPtr.Zero,4)!=0 || raw.Length==0) throw new IOException("update_shortcut_target_unknown");
      return Environment.ExpandEnvironmentVariables(raw.ToString());
    } finally { if(shortcut!=null) System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut); }
  }
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
  public static FileStream ExcludeProgram(string path) {
    PlainPath(path);
    try { return new FileStream(path,FileMode.Open,FileAccess.ReadWrite,FileShare.Delete); }
    catch(Exception error) { throw new IOException("update_program_in_use",error); }
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
$script:updateWindowAvailable = !$NoStatusWindow -and $Mode -and $Mode -notin @('Prepare', 'Handoff')
# A native status window shares this helper's lifetime, not a second updater.
if ($script:updateWindowAvailable) {
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Windows.Forms;
using System.Threading;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class MizarUpdateWindow {
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  static readonly object gate = new object();
  static readonly ManualResetEvent ready = new ManualResetEvent(false), closed = new ManualResetEvent(false);
  static readonly AutoResetEvent restore = new AutoResetEvent(false);
  static Form window;
  static Label heading, detail, hint;
  static Button cancel, logs, close;
  static ProgressBar activity;
  static LinkLabel packageLink;
  static bool cancellable, cancelled, finished, restoreAllowed;
  static Exception startupError;
  static Thread thread;
  static string directory;
  public static bool CancellationRequested { get { lock(gate) { return cancelled; } } }
  static void RequestCancel() {
    lock(gate) { if (!cancellable || finished) return; cancelled=true; cancellable=false; }
    cancel.Enabled=false; hint.Text="正在取消更新，请等待工具安全结束。";
  }
  public static void Start(string stage, bool canCancel, string version) {
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
        packageLink=new LinkLabel { Text="下载正式安装包", Location=new Point(160,263), Size=new Size(160,22), Visible=false, TabIndex=3 };
        packageLink.LinkClicked+=delegate { try { Process.Start(new ProcessStartInfo { FileName="https://github.com/Starfie1d1272/Mizar/releases/tag/v"+version, UseShellExecute=true }); } catch { hint.Text="下载页面无法打开，请从 GitHub 的 Mizar 正式发布页下载安装包。"; } };
        cancel=new Button { Text="取消更新", Location=new Point(347,255), Size=new Size(100,30), Enabled=canCancel, TabIndex=1 };
        cancel.Click+=delegate {
          if(finished && restoreAllowed) { finished=false; cancellable=false; cancel.Visible=false; close.Enabled=false; activity.Visible=true; window.Text="Mizar 应用更新"; heading.Text="正在核对恢复条件"; hint.Text="先核对程序和安装器是否已停止，失败时保留备份。"; restore.Set(); }
          else RequestCancel();
        };
        close=new Button { Text="关闭", Location=new Point(458,255), Size=new Size(100,30), Enabled=false, TabIndex=2 };
        close.Click+=delegate { window.Close(); };
        window.Controls.AddRange(new Control[] {banner,heading,detail,activity,hint,logs,cancel,close,packageLink});
        window.FormClosing+=delegate(object sender,FormClosingEventArgs args) {
          if (!finished) { args.Cancel=true; if (cancellable) RequestCancel(); else hint.Text="安装或恢复已开始，请等待完成后再关闭。"; }
        };
        window.Shown+=delegate { ShowWindow(window.Handle,1); if(!IsWindowVisible(window.Handle)) { startupError=new InvalidOperationException("update_window_hidden"); finished=true; window.Close(); } ready.Set(); };
        window.FormClosed+=delegate { closed.Set(); };
        Application.Run(window);
      } catch(Exception error) { startupError=error; ready.Set(); closed.Set(); }
    });
    thread.IsBackground=true; thread.SetApartmentState(ApartmentState.STA); thread.Start();
    if (!ready.WaitOne(10000)) { startupError=new TimeoutException("update_window_start_timeout"); closed.Set(); }
    if (startupError!=null) throw new InvalidOperationException("update_status_window_unavailable",startupError);
  }
  static void Apply(Action operation) {
    var form=window;
    if (form==null || form.IsDisposed || !form.IsHandleCreated || thread==null || !thread.IsAlive || startupError!=null) return;
    try { form.BeginInvoke(operation); } catch(ObjectDisposedException) { } catch(InvalidOperationException) { }
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
      case "program-exclusion": text="正在确认程序已停止"; break;
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
  public static void Complete(string status, string code, bool relaunch, bool canRestore) {
    Apply(delegate {
      finished=true; cancellable=false; restoreAllowed=canRestore && status=="recovery-required"; window.Text="Mizar 更新结果"; activity.Visible=false; cancel.Visible=false; packageLink.Visible=false; close.Enabled=true;
      if(status=="installed") { heading.Text="更新已完成"; detail.Text="新版程序已核验。"; hint.Text=relaunch ? "正在重新打开 Mizar。" : "可以关闭本窗口后重新打开 Mizar。"; }
      else if(status=="restored") { heading.Text="旧版已恢复"; detail.Text="本次更新未完成，原程序与资料已保留。"; hint.Text="关闭本窗口后可重新打开 Mizar，再查看诊断。"; }
      else if(status=="cancelled") { heading.Text="更新未启动"; detail.Text="原程序未被替换，可以重新打开 Mizar。"; hint.Text="请查看日志了解原因，或使用正式安装包。"; }
      else { heading.Text="需要恢复"; detail.Text="当前程序尚未核验，原文件与恢复记录已保留。";
        if(restoreAllowed) { hint.Text="先关闭 Mizar 与安装向导，再点击“恢复旧版”。"; cancel.Text="恢复旧版"; cancel.Visible=true; cancel.Enabled=true; }
        else { hint.Text="旧版备份未通过核验；请关闭 Mizar，手动安装正式安装包。"; cancel.Text="恢复旧版"; cancel.Visible=true; cancel.Enabled=false; packageLink.Visible=true; }
      }
      if(status=="recovery-required" && !String.IsNullOrEmpty(code) &&
        (code.Contains("update_recovery_target_") || code.Contains("update_recovery_owner_") || code.Contains("update_recovery_result_") || code.Contains("update_shortcut_"))) {
        heading.Text="恢复目标需要核对"; detail.Text="不能确认旧恢复任务仍属于当前安装。";
        hint.Text="请保留当前程序和恢复记录，核对后使用对应安装的恢复入口。"; cancel.Visible=false; packageLink.Visible=false;
      }
      if(status=="recovery-required" && restoreAllowed && !String.IsNullOrEmpty(code)) {
        if(code.Contains("update_process_remaining")) hint.Text="先正常退出残留的 Mizar，再点击“恢复旧版”重试。";
        else if(code.Contains("update_installer_remaining")) hint.Text="先关闭安装向导并确认安装已停止，再点击“恢复旧版”。";
        else if(code.Contains("update_program_in_use")) hint.Text="程序文件仍被占用；关闭 Mizar 和安装向导后重试恢复。";
      }
      if(!String.IsNullOrEmpty(code) && code.Contains("update_handoff_")) {
        heading.Text="旧安装任务需要交接"; detail.Text="原程序和恢复资料已保留，本次替换尚未开始。";
        hint.Text="请关闭旧更新窗口和轻量安装器，再使用完整安装包；不要运行旧脚本覆盖当前程序。"; cancel.Visible=false;
      }
      if(!String.IsNullOrEmpty(code)) detail.Text+="\r\n诊断代码："+code;
      window.AcceptButton=close; window.CancelButton=close; close.Focus();
    });
  }
  public static void LaunchFailed() { Apply(delegate { heading.Text="更新已完成，但未能重新打开"; hint.Text="程序已核验，请关闭本窗口后手动启动；失败时查看日志。"; }); }
  public static void CloseCompleted() { Apply(delegate { if(finished) window.Close(); }); }
  public static bool WaitForRestore() { if(thread==null || startupError!=null) return false; var action=WaitHandle.WaitAny(new WaitHandle[]{closed,restore}); if(action==0) { thread.Join(); return false; } return true; }
}
'@
}
function Update-WindowPhase([string]$phase) { if ($script:updateWindowAvailable) { [MizarUpdateWindow]::Phase($phase) } }
function Test-UpdateCancellation { if ($script:updateWindowAvailable) { return [MizarUpdateWindow]::CancellationRequested }; return $false }
function Start-UpdateMutation { if ($script:updateWindowAvailable) { return [MizarUpdateWindow]::BeginMutation() }; return $true }
function Invoke-UpdatePhase([string]$Name, [scriptblock]$Operation) {
  if (Test-UpdateCancellation) { throw 'update_cancelled_before_install' }
  Update-WindowPhase $Name
  Record-UpdateActivity $Name
  Measure-UpdatePhase $Name $Operation
}
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

# Retire only a recognized old execution capability, never its plan or backup.
function Read-HandoffJson([string]$path, [switch]$SharedSnapshot) {
  Assert-PlainPath $path
  if ((Get-Item -LiteralPath $path -Force).Length -gt 65536) { throw 'update_handoff_record_large' }
  if (!$SharedSnapshot) { return [IO.File]::ReadAllText($path, [Text.UTF8Encoding]::new($false, $true)) | ConvertFrom-Json }
  # Pending publication is an atomic replace. A read-only discovery snapshot must
  # not deny the active bootstrap's rename; mutation rechecks under its lease.
  $file = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, ([IO.FileShare]::Read -bor [IO.FileShare]::Delete))
  try {
    if ($file.Length -gt 65536) { throw 'update_handoff_record_large' }
    $reader = [IO.StreamReader]::new($file, [Text.UTF8Encoding]::new($false, $true))
    try { return $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
  } finally { $file.Dispose() }
}
function Handoff-Path([string]$path) {
  Assert-PlainPath $path
  $full = [IO.Path]::GetFullPath($path)
  if ($full -eq [IO.Path]::GetPathRoot($full)) { throw 'update_handoff_root_directory_forbidden' }
  return $full.TrimEnd('\')
}
function Test-LegacyHelperHash([string]$hash) {
  # Exact LF source and CRLF checkout bytes from v1.11.1–1.11.4. No text heuristics.
  return $hash -in @('04165df6360fdfeaf5fa5713d9d52801377746a8e70aa28c546fa95f94aa8465', 'e2805c1bb5465013baf1f03d992b584c5eee2518ffa50eb81a6e32e0b1c32cbe', 'e029b456edf6f1e95addd3c7a967f7f2f1450a285a462c3e03baa28d6443cd5e', '4c377e218825d3cfc99569a6ea558b3f7096b56159ec18ab72bc4a1c67c92d5f')
}
function Handoff-Process([int]$processId) {
  $snapshot = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $processId) -OperationTimeoutSec 10
  if (!$snapshot) { throw 'update_handoff_process_ended' }
  $process = [Diagnostics.Process]::GetProcessById($processId)
  try {
    [void]$process.Handle
    if ($process.HasExited -or [Math]::Abs($process.StartTime.ToUniversalTime().Ticks - $snapshot.CreationDate.ToUniversalTime().Ticks) -ge 10) { throw 'update_handoff_process_changed' }
    $script:handoffHandles.Add($process)
    return @{ process = $process; snapshot = $snapshot; started = $process.StartTime.ToUniversalTime().Ticks }
  } catch { $process.Dispose(); throw }
}
function Handoff-Arguments($snapshot) {
  if (!$snapshot.CommandLine) { throw 'update_handoff_process_unknown' }
  return [MizarUpdateFiles]::Arguments([string]$snapshot.CommandLine)
}
function Handoff-Argument($arguments, [string]$name) {
  $found = @()
  for ($i = 1; $i -lt $arguments.Count; $i++) {
    if ($arguments[$i] -eq $name) {
      if ($i + 1 -ge $arguments.Count) { throw 'update_handoff_arguments_invalid' }
      $found += $arguments[$i + 1]
    }
  }
  if ($found.Count -gt 1) { throw 'update_handoff_arguments_invalid' }
  if ($found.Count -eq 1) { return [string]$found[0] }
  return ''
}
function Handoff-Plan([string]$directory, [string]$target, [string]$state) {
  $directory = Handoff-Path $directory
  $binding = Read-HandoffJson (Join-Path $directory 'plan.json')
  if ($binding.schemaVersion -ne 1 -or (Handoff-Path $binding.bundleRoot) -ne $target -or
    (Handoff-Path $binding.stateRoot) -ne $state -or (Split-Path -Parent $directory) -ne (Join-Path $state 'updates') -or
    (Split-Path -Leaf $directory) -notmatch '^install-[a-f0-9]{32}$') { throw 'update_handoff_target_unknown' }
  return $binding
}
function Handoff-UpdateParent($caller, [string]$target) {
  $parent = Handoff-Process $caller.snapshot.ParentProcessId
  if ($parent.started -gt $caller.started) { throw 'update_handoff_parent_unknown' }
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  if ((Handoff-Path $parent.snapshot.ExecutablePath) -ne (Handoff-Path $powershell)) { throw 'update_handoff_parent_unknown' }
  $arguments = @(Handoff-Arguments $parent.snapshot)
  if ((Handoff-Argument $arguments '-Mode') -ne 'Install') { throw 'update_handoff_parent_unknown' }
  $stage = Handoff-Path (Handoff-Argument $arguments '-StageRoot')
  $state = Split-Path -Parent (Split-Path -Parent $stage)
  $binding = Handoff-Plan $stage $target $state
  $source = Handoff-Path (Handoff-Argument $arguments '-File')
  $stageSource = Join-Path $stage 'update-install.ps1'
  # Old bootstrap executes the download copy, with this exact stage as its argument.
  if ($source -ne $stageSource -and $source -ne (Join-Path (Split-Path -Parent $binding.installer) 'update-install.ps1')) { throw 'update_handoff_parent_unknown' }
  $hash = [MizarUpdateFiles]::Hash($source)
  if ($hash -ne [MizarUpdateFiles]::Hash($stageSource)) { throw 'update_handoff_parent_unknown' }
  if (!(Test-LegacyHelperHash $hash) -and $hash -ne [MizarUpdateFiles]::Hash($PSCommandPath) -and
    !($binding.recoveryProtocol -eq 'mizar.install-instance.v1' -and $binding.helperSha256 -eq $hash -and $binding.previousInstallationId -match '^[a-f0-9]{64}$')) { throw 'update_handoff_parent_unknown' }
  if ((Handoff-Path $caller.snapshot.ExecutablePath) -ne (Join-Path $stage 'Installer.exe')) { throw 'update_handoff_parent_unknown' }
  Assert-Installer $binding $caller.snapshot.ExecutablePath
  return @{ stage = $stage; state = $state; helper = $parent }
}
function Handoff-Caller([string]$target, [int]$processId, [string]$parentReceipt) {
  $self = Handoff-Process $PID
  if ($self.snapshot.ParentProcessId -ne $processId) { throw 'update_handoff_caller_unknown' }
  $caller = Handoff-Process $processId
  if ($caller.started -gt $self.started) { throw 'update_handoff_caller_unknown' }
  if ($parentReceipt) {
    $receipt = Read-HandoffJson $parentReceipt
    $setup = Handoff-Process $caller.snapshot.ParentProcessId
    if ($setup.started -gt $caller.started) { throw 'update_handoff_caller_unknown' }
    if ($receipt.schema -ne 'mizar.handoff.v1' -or $receipt.callerPid -ne $setup.process.Id -or $receipt.callerStarted -ne $setup.started -or
      (Handoff-Path $receipt.target) -ne $target -or $receipt.callerSha256 -ne [MizarUpdateFiles]::Hash($setup.snapshot.ExecutablePath) -or
      !$receipt.installationOwner -or (Get-Content -LiteralPath (Join-Path $target '.mizar-update-owner') -Raw) -ne $receipt.installationOwner) { throw 'update_handoff_caller_unknown' }
    # The receipt is only a same-parent, same-target capability. Recheck the
    # actual named mutex owner; a stale receipt or /MIZARUPDATE is insufficient.
    $caller = $setup
  }
  $owner = [MizarUpdateFiles]::WriterOwnerPid()
  if ($owner -eq 0) { return @{ needsWriter = $true; caller = $caller } }
  if ($owner -eq $caller.process.Id) { return @{ needsWriter = $false; caller = $caller } }
  if ($owner -ne $caller.snapshot.ParentProcessId) { throw 'update_transaction_busy' }
  $context = Handoff-UpdateParent $caller $target
  $context.needsWriter = $false; $context.caller = $caller
  return $context
}
function Assert-HandoffProcessEnded($processId, $started) {
  if ($processId -isnot [int] -or $processId -le 0 -or $started -isnot [long] -or $started -le 0) { throw 'update_handoff_process_unknown' }
  try { $process = [Diagnostics.Process]::GetProcessById($processId) } catch [ArgumentException] { return }
  try {
    [void]$process.Handle
    if (!$process.HasExited -and $process.StartTime.ToUniversalTime().Ticks -eq $started) { throw 'update_handoff_process_active' }
  } finally { $process.Dispose() }
}
function Publish-HandoffRefusal([string]$path, [string]$text) {
  Assert-PlainPath $path
  if (Test-Path -LiteralPath $path) {
    if ([IO.File]::ReadAllText($path) -ne $text) { throw 'update_handoff_archive_conflict' }
  } else {
    $temporary = $path + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
      $file = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $bytes = [Text.Encoding]::UTF8.GetBytes($text); $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
      [IO.File]::Move($temporary, $path)
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
  }
  [IO.File]::SetAttributes($path, ([IO.File]::GetAttributes($path) -bor [IO.FileAttributes]::ReadOnly))
}
function Invoke-LegacyHandoff([string]$target, [string]$state, [string]$currentStage = '', $context = $null) {
  $target = Handoff-Path $target; $state = Handoff-Path $state
  if (!$context -and [MizarUpdateFiles]::WriterOwnerPid() -ne $PID) { throw 'update_handoff_writer_unknown' }
  if ($context -and $context.stage) { $currentStage = $context.stage; $state = $context.state }
  if ($state -eq $target -or $state.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'update_data_inside_installation' }
  $roots = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  [void]$roots.Add($state)
  [void]$roots.Add((Join-Path $env:LOCALAPPDATA 'Mizar'))
  $installKey = 'HKCU:\Software\Mizar'
  if (Test-Path -LiteralPath $installKey) {
    $registered = Get-ItemProperty -LiteralPath $installKey
    if ($registered.InstallDir -and $registered.StateRoot -and (Handoff-Path $registered.InstallDir) -eq $target) { [void]$roots.Add((Handoff-Path $registered.StateRoot)) }
  }
  $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
  $entry = if (Test-Path -LiteralPath $runKey) { (Get-ItemProperty -LiteralPath $runKey).'!MizarUpdateRecovery' }
  # An old custom root can be discovered from its exact existing recovery entry.
  if ($entry -and $entry -match ' -StageRoot "([^"\r\n]+)"$') {
    $registeredStage = Handoff-Path $Matches[1]
    $registeredPlan = Read-HandoffJson (Join-Path $registeredStage 'plan.json')
    if ((Handoff-Path $registeredPlan.bundleRoot) -eq $target) { [void]$roots.Add((Handoff-Path $registeredPlan.stateRoot)) }
  }
  $refusal = "throw 'update_legacy_retired: use the current installer; original recovery files are preserved.'`r`n"
  $cache = Join-Path (Join-Path $env:LOCALAPPDATA 'Mizar') 'bootstrap-cache'
  $pendingPath = Join-Path $cache 'fresh-install.pending'; Assert-PlainPath $pendingPath
  $pendingSnapshot = if (Test-Path -LiteralPath $pendingPath) { Read-HandoffJson $pendingPath -SharedSnapshot }
  $candidates = @()
  foreach ($root in $roots) {
    $root = Handoff-Path $root
    if ($root -eq $target -or $root.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'update_data_inside_installation' }
    $updates = Join-Path (Handoff-Path $root) 'updates'
    if (!(Test-Path -LiteralPath $updates)) { continue }
    foreach ($directory in (Get-ChildItem -LiteralPath $updates -Directory -Force)) {
      if ($directory.Name -notmatch '^install-[a-f0-9]{32}$' -or $directory.FullName -eq $currentStage) { continue }
      $planPath = Join-Path $directory.FullName 'plan.json'
      if (!(Test-Path -LiteralPath $planPath -PathType Leaf)) { continue }
      $binding = Read-HandoffJson $planPath
      if ((Handoff-Path $binding.bundleRoot) -ne $target) { continue }
      $binding = Handoff-Plan $directory.FullName $target (Handoff-Path $root)
      $source = Join-Path $directory.FullName 'update-install.ps1'; $archive = $source + '.retired'
      Assert-PlainPath $source; Assert-PlainPath $archive
      $archived = Test-Path -LiteralPath $archive -PathType Leaf
      $hash = if ($archived) { [MizarUpdateFiles]::Hash($archive) } else { [MizarUpdateFiles]::Hash($source) }
      if (!$archived -and $binding.recoveryProtocol -eq 'mizar.install-instance.v1' -and $binding.helperSha256 -eq $hash -and $binding.previousInstallationId -match '^[a-f0-9]{64}$') { continue }
      if (!(Test-LegacyHelperHash $hash)) { throw 'update_handoff_source_unknown' }
      if ($archived -and (Test-Path -LiteralPath $source) -and [IO.File]::ReadAllText($source) -ne $refusal) { throw 'update_handoff_archive_conflict' }
      $cmd = Join-Path $directory.FullName 'Restore-Mizar.cmd'; Assert-PlainPath $cmd; Assert-PlainPath ($cmd + '.retired')
      if (Test-Path -LiteralPath $cmd) {
        $expected = '@echo off', 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0update-install.ps1" -Mode Recover -StageRoot "%~dp0."', 'pause'
        if (([IO.File]::ReadAllText($cmd).TrimEnd("`r", "`n") -replace "`r`n", "`n") -cne ($expected -join "`n") -or (Test-Path -LiteralPath ($cmd + '.retired'))) { throw 'update_handoff_archive_conflict' }
      }
      $command = '"' + (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $source + '" -Mode Recover -StageRoot "' + $directory.FullName + '"'
      if ($archived -and (Test-Path -LiteralPath $source) -and !(Test-Path -LiteralPath $cmd) -and $entry -ne $command -and $pendingSnapshot.updateStage -ne $directory.FullName) { continue }
      $cmdHash = if (Test-Path -LiteralPath $cmd) { [MizarUpdateFiles]::Hash($cmd) } else { '' }
      $candidates += @{ cmdHash = $cmdHash; stage = $directory.FullName; source = $source; archive = $archive; archived = $archived; hash = $hash; cmd = $cmd; plan = $binding }
    }
  }
  # No dormant execution capability is being retired. In particular a current
  # legacy bootstrap may retain its own lease and its one authenticated stage.
  if (!$candidates.Count) { return $state }
  $lease = $null
  $locks = [Collections.Generic.List[IDisposable]]::new()
  try {
    $cache = Join-Path (Join-Path $env:LOCALAPPDATA 'Mizar') 'bootstrap-cache'
    Assert-PlainPath $cache
    [IO.Directory]::CreateDirectory($cache) | Out-Null
    $leasePath = Join-Path $cache 'fresh-install.lock'; Assert-PlainPath $leasePath
    try { $lease = [IO.File]::Open($leasePath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw [IO.IOException]::new('update_handoff_bootstrap_active', $_.Exception) }
    # Exclude late standard loads before observing any already loaded processes.
    foreach ($candidate in $candidates) {
      if (!$candidate.archived) {
        $file = [IO.File]::Open($candidate.source, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Delete)
        $locks.Add($file)
        if ([MizarUpdateFiles]::HashStream($file) -ne $candidate.hash) { throw 'update_handoff_source_changed' }
      }
    }
    foreach ($candidate in $candidates) {
      if ($candidate.cmdHash) {
        $file = [IO.File]::Open($candidate.cmd, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::Delete)
        $locks.Add($file)
        if ([MizarUpdateFiles]::HashStream($file) -ne $candidate.cmdHash) { throw 'update_handoff_source_changed' }
      }
    }
    $processes = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -OperationTimeoutSec 10)
    foreach ($snapshot in $processes) {
      if ($snapshot.ProcessId -eq $PID) { continue }
      if (!$snapshot.CommandLine) {
        $owner = Invoke-CimMethod -InputObject $snapshot -MethodName GetOwnerSid -OperationTimeoutSec 10
        if ($owner.ReturnValue -ne 0 -or $owner.Sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'update_handoff_process_unknown' }
        continue
      }
      # Script parameters accept abbreviations and colon syntax. Retirement is
      # conservative: any mention of a candidate's path is enough to refuse;
      # only parent authorization uses the stricter canonical argument parser.
      $paths = @()
      foreach ($argument in @(Handoff-Arguments $snapshot)) {
        if ($argument -match '^-[^:]+:(.+)$') { $argument = $Matches[1] }
        if ([IO.Path]::IsPathRooted($argument)) { $paths += [MizarUpdateFiles]::LongPath($argument).TrimEnd('\') }
      }
      foreach ($candidate in $candidates) {
        $mentioned = $snapshot.CommandLine.IndexOf($candidate.stage, [StringComparison]::OrdinalIgnoreCase) -ge 0
        if (!$mentioned) {
          foreach ($path in $paths) {
            if ($path -eq $candidate.stage -or $path.StartsWith($candidate.stage + '\', [StringComparison]::OrdinalIgnoreCase)) { $mentioned = $true; break }
          }
        }
        if (!$mentioned) { continue }
        # Hold the actual process instance, not just its potentially reusable PID.
        $active = Handoff-Process $snapshot.ProcessId
        if (!$active.process.HasExited) { throw 'update_handoff_process_active' }
      }
    }
    foreach ($candidate in $candidates) {
      $installer = Join-Path $candidate.stage 'Installer.exe'; Assert-PlainPath $installer
      if (Test-Path -LiteralPath $installer) {
        try { $locks.Add([IO.File]::Open($installer, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)) }
        catch { throw [IO.IOException]::new('update_installer_remaining', $_.Exception) }
      }
    }
    $pendingPath = Join-Path $cache 'fresh-install.pending'; Assert-PlainPath $pendingPath
    $pendingCandidate = $null
    if (Test-Path -LiteralPath $pendingPath) {
      $pending = Read-HandoffJson $pendingPath
      $pendingCandidate = $candidates | Where-Object { $_.stage -eq $pending.updateStage } | Select-Object -First 1
      if ($pendingCandidate) {
        if ($pending.schemaVersion -ne 'mizar.bootstrap-pending.v1' -or (Handoff-Path $pending.target) -ne $target -or
          $pending.updatePlanSha256 -ne [MizarUpdateFiles]::Hash((Join-Path $pendingCandidate.stage 'plan.json')) -or $pending.updateScriptSha256 -ne $pendingCandidate.hash) { throw 'update_handoff_pending_unknown' }
        Assert-HandoffProcessEnded $pending.ownerPid $pending.ownerStarted
        if ($pending.stage -eq 'update-prepared' -and $pending.writerPid -eq 0 -and $pending.writerStarted -eq 0) {
          if ((Read-HandoffJson (Join-Path $pendingCandidate.stage 'journal.json')).phase -ne 'prepared') { throw 'update_handoff_pending_unknown' }
        } else {
          if ($pending.stage -notin @('update-writing', 'update-finalizing', 'update-rollback')) { throw 'update_handoff_pending_unknown' }
          Assert-HandoffProcessEnded $pending.writerPid $pending.writerStarted
        }
        $pendingArchive = Join-Path $pendingCandidate.stage 'fresh-install.pending.retired'
        Assert-PlainPath $pendingArchive
        if (Test-Path -LiteralPath $pendingArchive) { throw 'update_handoff_archive_conflict' }
        $pendingHash = [MizarUpdateFiles]::Hash($pendingPath)
      }
    }
    foreach ($candidate in $candidates) {
      if (!$candidate.archived) { [IO.File]::Move($candidate.source, $candidate.archive) }
      Publish-HandoffRefusal $candidate.source $refusal
      if (Test-Path -LiteralPath $candidate.cmd) { [IO.File]::Move($candidate.cmd, ($candidate.cmd + '.retired')) }
      $command = '"' + (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $candidate.source + '" -Mode Recover -StageRoot "' + $candidate.stage + '"'
      $current = if (Test-Path -LiteralPath $runKey) { (Get-ItemProperty -LiteralPath $runKey).'!MizarUpdateRecovery' }
      if ($current -eq $command) { Remove-ItemProperty -Path $runKey -Name '!MizarUpdateRecovery' }
    }
    if ($pendingCandidate) {
      if ([MizarUpdateFiles]::Hash($pendingPath) -ne $pendingHash) { throw 'update_handoff_pending_changed' }
      [IO.File]::Move($pendingPath, $pendingArchive)
      if ([MizarUpdateFiles]::Hash($pendingArchive) -ne $pendingHash) { throw 'update_handoff_pending_changed' }
    }
    return $state
  } finally {
    foreach ($file in $locks) { $file.Dispose() }
    if ($lease) { $lease.Dispose() }
  }
}

function Assert-Plan($plan) {
  if ($plan.schemaVersion -ne 1 -or $plan.version -notmatch '^\d+\.\d+\.\d+$' -or
    $plan.gitSha -notmatch '^[a-f0-9]{40}$' -or $plan.installerSha256 -notmatch '^[a-f0-9]{64}$' -or
    $plan.contentDigest -notmatch '^[a-f0-9]{64}$' -or $plan.previousContentDigest -notmatch '^[a-f0-9]{64}$' -or
    ($plan.coreArchiveSha256 -and $plan.coreArchiveSha256 -notmatch '^[a-f0-9]{64}$') -or
    ($plan.previousInstallationId -and $plan.previousInstallationId -notmatch '^[a-f0-9]{64}$') -or
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
function Recovery-Command([string]$directory = $StageRoot) {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  return '"' + $ps + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + (Join-Path $directory 'update-install.ps1') + '" -Mode Recover -StageRoot "' + $directory + '"'
}
function Test-CompletedRecovery([string]$command) {
  if ($command -notmatch ' -StageRoot "([^"\r\n]+)"$') { return $false }
  $directory = $Matches[1]
  Assert-PlainPath $directory
  $directory = [IO.Path]::GetFullPath($directory).TrimEnd('\')
  if ((Split-Path -Parent $directory) -ne [IO.Path]::GetFullPath((Join-Path $plan.stateRoot 'updates')).TrimEnd('\') -or
    (Split-Path -Leaf $directory) -notmatch '^install-[a-f0-9]{32}$' -or $command -ne (Recovery-Command $directory)) { return $false }
  $old = @{}
  foreach ($name in @('plan','journal','result')) {
    $path = Join-Path $directory ($name + '.json'); Assert-PlainPath $path
    if ((Get-Item -LiteralPath $path).Length -gt 65536) { return $false }
    $old[$name] = Get-Content -Encoding UTF8 -LiteralPath $path -Raw | ConvertFrom-Json
  }
  $previousPlan = $old.plan
  Assert-Plan $previousPlan
  if ([IO.Path]::GetFullPath($previousPlan.bundleRoot).TrimEnd('\') -ne [IO.Path]::GetFullPath($plan.bundleRoot).TrimEnd('\') -or
    [IO.Path]::GetFullPath($previousPlan.stateRoot).TrimEnd('\') -ne [IO.Path]::GetFullPath($plan.stateRoot).TrimEnd('\') -or
    $old.result.version -ne $previousPlan.version -or $old.result.recoveryDirectory -ne (Split-Path -Leaf $directory)) { return $false }
  if ($old.journal.phase -eq 'committed' -and $old.result.status -eq 'installed' -and $old.result.code -eq 'update_completed') {
    Assert-Payload $previousPlan.bundleRoot $previousPlan.contentDigest $previousPlan.version $previousPlan.gitSha
    if ((Get-Content -LiteralPath (Join-Path $previousPlan.bundleRoot 'installed.flag') -Raw) -ne ('mizar.install.v1:' + (Split-Path -Leaf $directory))) { return $false }
    return $true
  }
  if ($old.journal.phase -in @('installing','restored') -and $old.result.status -eq 'restored' -and $old.result.code -eq 'update_rolled_back' -and $previousPlan.previousInstallationId) {
    Assert-Payload $previousPlan.bundleRoot $previousPlan.previousContentDigest
    return [MizarUpdateFiles]::Hash((Join-Path $previousPlan.bundleRoot 'installed.flag')) -eq $previousPlan.previousInstallationId
  }
  return $false
}
function Assert-RecoveryRegistration {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
  $entry = if (Test-Path -LiteralPath $key) { Get-ItemProperty -LiteralPath $key }
  $command = if ($entry) { $entry.'!MizarUpdateRecovery' }
  if ($command -and $command -ne (Recovery-Command)) {
    if ($Mode -eq 'Install' -and (Test-CompletedRecovery $command)) { return }
    throw 'update_recovery_owner_changed'
  }
}
function Recovery-Registration([bool]$enabled) {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
  Assert-RecoveryRegistration
  if ($enabled) {
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name '!MizarUpdateRecovery' -Value (Recovery-Command) -PropertyType String -Force | Out-Null
  } else {
    $entry = if (Test-Path -LiteralPath $key) { Get-ItemProperty -LiteralPath $key }
    if ($entry -and $entry.'!MizarUpdateRecovery' -eq (Recovery-Command)) { Remove-ItemProperty -Path $key -Name '!MizarUpdateRecovery' }
  }
}
function Assert-InstallationRegistration {
  $key = 'HKCU:\Software\Mizar'
  $registered = if (Test-Path -LiteralPath $key) { Get-ItemProperty -LiteralPath $key }
  if ($registered -and $registered.InstallDir -and
    [IO.Path]::GetFullPath([string]$registered.InstallDir).TrimEnd('\') -ne [IO.Path]::GetFullPath($plan.bundleRoot).TrimEnd('\')) { throw 'update_recovery_target_changed' }
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar'
  $uninstall = if (Test-Path -LiteralPath $key) { Get-ItemProperty -LiteralPath $key }
  if ($uninstall -and $uninstall.UninstallString -and
    $uninstall.UninstallString -ne ('"' + (Join-Path $plan.bundleRoot 'Uninstall.exe') + '"')) { throw 'update_recovery_target_changed' }
}
function Clear-CompletedRecoveryOwner {
  $marker = Join-Path $plan.bundleRoot '.mizar-update-owner'; Assert-PlainPath $marker
  if (!(Test-Path -LiteralPath $marker -PathType Leaf)) { return }
  if ((Get-Item -LiteralPath $marker -Force).Length -gt 64) { return }
  $owner = Get-Content -LiteralPath $marker -Raw
  if ($owner -eq (Split-Path -Leaf $StageRoot) -or $owner -notmatch '^install-[a-f0-9]{32}$') { return }
  $oldStage = Join-Path (Join-Path $plan.stateRoot 'updates') $owner
  if (Test-CompletedRecovery (Recovery-Command $oldStage)) { Remove-Item -LiteralPath $marker -Force }
}
function Assert-RecoveryTarget {
  Assert-RecoveryRegistration
  Assert-InstallationRegistration
  Assert-PlainPath $plan.bundleRoot
  $marker = Join-Path $plan.bundleRoot '.mizar-update-owner'
  Assert-PlainPath $marker
  if ((Test-Path -LiteralPath $marker -PathType Leaf) -and (Get-Item -LiteralPath $marker -Force).Length -gt 64) { throw 'update_recovery_owner_changed' }
  $owned = (Test-Path -LiteralPath $marker -PathType Leaf) -and
    (Get-Content -LiteralPath $marker -Raw) -eq (Split-Path -Leaf $StageRoot)
  if ((Test-Path -LiteralPath $marker) -and !$owned) { throw 'update_recovery_owner_changed' }
  if (!(Test-Path -LiteralPath $plan.bundleRoot)) {
    # Absence alone is also the result of an intentional uninstall. Resume only
    # our interrupted swap, with both independently verified, paired directories.
    $restore = $plan.bundleRoot + '.mizar-restore-' + (Split-Path -Leaf $StageRoot)
    $failed = $plan.bundleRoot + '.mizar-failed-' + (Split-Path -Leaf $StageRoot)
    foreach ($directory in @($restore, $failed)) {
      Assert-PlainPath $directory
      $pair = Join-Path $directory '.mizar-update-owner'; Assert-PlainPath $pair
      if (!(Test-Path -LiteralPath $directory -PathType Container) -or !(Test-Path -LiteralPath $pair -PathType Leaf) -or
        (Get-Item -LiteralPath $pair -Force).Length -gt 64 -or (Get-Content -LiteralPath $pair -Raw) -ne (Split-Path -Leaf $StageRoot)) { throw 'update_recovery_target_unknown' }
    }
    Assert-PreviousInstance $restore
    $displacedFlag = Join-Path $failed 'installed.flag'; Assert-PlainPath $displacedFlag
    if (Test-Path -LiteralPath $displacedFlag) {
      if ([MizarUpdateFiles]::Hash($displacedFlag) -ne $plan.previousInstallationId -and
        (Get-Content -LiteralPath $displacedFlag -Raw) -ne ('mizar.install.v1:' + (Split-Path -Leaf $StageRoot))) { throw 'update_recovery_owner_changed' }
    }
    return
  }
  $flag = Join-Path $plan.bundleRoot 'installed.flag'
  Assert-PlainPath $flag
  if (Test-Path -LiteralPath $flag -PathType Leaf) {
    if ((Get-Item -LiteralPath $flag -Force).Length -gt 256) { throw 'update_recovery_owner_changed' }
    $instance = Get-Content -LiteralPath $flag -Raw
    $original = $plan.previousInstallationId -and [MizarUpdateFiles]::Hash($flag) -eq $plan.previousInstallationId
    $candidate = $instance -eq ('mizar.install.v1:' + (Split-Path -Leaf $StageRoot))
    if (!$original -and !$candidate) { throw 'update_recovery_owner_changed' }
    if ($original -and !$owned -and $instance -notmatch '^mizar\.install\.v1:' -and $Mode -ne 'Install') {
      $journal = Get-Content -LiteralPath (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json
      if ($journal.phase -ne 'prepared') { throw 'update_recovery_target_unknown' }
    }
  } elseif (!$owned) { throw 'update_recovery_target_unknown' }
  $artifactPath = Join-Path $plan.bundleRoot 'resources\metadata\artifact.json'
  Assert-PlainPath $artifactPath
  $artifact = $null
  try {
    if ((Get-Item -LiteralPath $artifactPath).Length -le 65536) { $artifact = Get-Content -Encoding UTF8 -LiteralPath $artifactPath -Raw | ConvertFrom-Json }
  } catch { }
  if ($artifact -and $artifact.repository -eq 'Starfie1d1272/Mizar' -and
    $artifact.artifactSha256 -match '^[a-f0-9]{64}$') {
    # A later complete OR partial installation must never be replaced by an old recovery.
    if ($artifact.artifactSha256 -notin @($plan.previousContentDigest, $plan.contentDigest)) { throw 'update_recovery_target_changed' }
    return
  }
  # New transactions keep a paired marker through partial NSIS writes. Legacy
  # records without either a recognized identity or ownership remain untouched.
  if (!$owned) { throw 'update_recovery_target_unknown' }
}
function Assert-PreviousInstance([string]$directory) {
  Assert-Payload $directory $plan.previousContentDigest
  if (!$plan.previousInstallationId -or [MizarUpdateFiles]::Hash((Join-Path $directory 'installed.flag')) -ne $plan.previousInstallationId) { throw 'update_recovery_owner_changed' }
}
function Assert-CandidateInstance {
  Assert-Payload $plan.bundleRoot $plan.contentDigest $plan.version $plan.gitSha
  $flag = Join-Path $plan.bundleRoot 'installed.flag'; Assert-PlainPath $flag
  if ((Get-Content -LiteralPath $flag -Raw) -ne ('mizar.install.v1:' + (Split-Path -Leaf $StageRoot))) { throw 'update_recovery_owner_changed' }
}
function Create-RecoveryOwner([string]$directory = $plan.bundleRoot) {
  $ownerPath = Join-Path $directory '.mizar-update-owner'
  $temporary = $ownerPath + '.' + (Split-Path -Leaf $StageRoot) + '.tmp'
  Assert-PlainPath $ownerPath; Assert-PlainPath $temporary
  if (Test-Path -LiteralPath $ownerPath) { throw 'update_recovery_owner_changed' }
  # Publish a fully written marker before entering installing. A crash beforehand
  # leaves prepared + unchanged program; a crash afterwards has paired ownership.
  $owner = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try { $bytes = [Text.Encoding]::UTF8.GetBytes((Split-Path -Leaf $StageRoot)); $owner.Write($bytes, 0, $bytes.Length); $owner.Flush($true) }
  finally { $owner.Dispose() }
  [IO.File]::Move($temporary, $ownerPath)
}
function Remove-RecoveryOwner {
  $marker = Join-Path $plan.bundleRoot '.mizar-update-owner'
  Assert-PlainPath $marker
  if (Test-Path -LiteralPath $marker) {
    if ((Get-Content -LiteralPath $marker -Raw) -ne (Split-Path -Leaf $StageRoot)) { throw 'update_recovery_owner_changed' }
    Remove-Item -LiteralPath $marker -Force
  }
}
function Test-RestoredTransaction($journal) {
  if ($journal.phase -notin @('installing', 'restored')) { return $false }
  $resultPath = Join-Path $StageRoot 'result.json'
  Assert-PlainPath $resultPath
  $result = $null
  try { $result = Get-Content -Encoding UTF8 -LiteralPath $resultPath -Raw | ConvertFrom-Json } catch { }
  if ($null -eq $result -or $result.status -ne 'restored' -or $result.code -ne 'update_rolled_back' -or
    $result.version -ne $plan.version -or $result.recoveryDirectory -ne (Split-Path -Leaf $StageRoot)) {
    if ($journal.phase -eq 'restored') { throw 'update_recovery_result_invalid' }
    return $false
  }
  Assert-PreviousInstance $plan.bundleRoot
  if ($journal.phase -ne 'restored') { Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'restored' } }
  # Only finish our interrupted terminal cleanup. New owners and registrations
  # remain untouched; a fully completed reentry performs no writes.
  $marker = Join-Path $plan.bundleRoot '.mizar-update-owner'; Assert-PlainPath $marker
  if ((Test-Path -LiteralPath $marker -PathType Leaf) -and (Get-Content -LiteralPath $marker -Raw) -eq (Split-Path -Leaf $StageRoot)) { Remove-RecoveryOwner }
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce'
  $entry = if (Test-Path -LiteralPath $key) { Get-ItemProperty -LiteralPath $key }
  if ($entry -and $entry.'!MizarUpdateRecovery' -eq (Recovery-Command)) { Recovery-Registration $false }
  return $true
}
function Installation-Shortcuts {
  $menu = Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\Mizar'
  return @(
    @{ current = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mizar.lnk'); saved = (Join-Path $StageRoot 'shortcut-0'); target = (Join-Path $plan.bundleRoot 'Mizar.exe') },
    @{ current = (Join-Path $menu 'Mizar.lnk'); saved = (Join-Path $StageRoot 'shortcut-1\Mizar.lnk'); target = (Join-Path $plan.bundleRoot 'Mizar.exe') },
    @{ current = (Join-Path $menu '卸载 Mizar.lnk'); saved = (Join-Path $StageRoot 'shortcut-1\卸载 Mizar.lnk'); target = (Join-Path $plan.bundleRoot 'Uninstall.exe') }
  )
}
function Read-ShortcutTarget([string]$path) { return [MizarUpdateFiles]::ShortcutTarget($path) }
function Assert-ShortcutOwnership([bool]$includeSaved = $false) {
  foreach ($shortcut in (Installation-Shortcuts)) {
    $paths = @($shortcut.current)
    if ($includeSaved) { $paths += $shortcut.saved }
    foreach ($path in $paths) {
      Assert-PlainPath $path
      if (!(Test-Path -LiteralPath $path)) { continue }
      $target = Read-ShortcutTarget $path
      if (![IO.Path]::IsPathRooted($target) -or [IO.Path]::GetFullPath($target) -ne [IO.Path]::GetFullPath($shortcut.target)) { throw 'update_shortcut_target_changed' }
    }
  }
}
function Save-Registration {
  Assert-ShortcutOwnership
  Assert-RecoveryRegistration
  Assert-InstallationRegistration
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
  Assert-RecoveryTarget
  Assert-ShortcutOwnership $true
  # PowerShell 5.1 emits a JSON array as one pipeline object. Assign it first
  # so foreach visits individual registry records rather than the outer array.
  $snapshot = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'registration.json') -Raw | ConvertFrom-Json
  $expectedKeys = @('HKCU:\Software\Mizar', 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar')
  $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  if ($null -eq $snapshot -or $snapshot.Count -ne 2) { throw 'update_registration_snapshot_invalid' }
  foreach ($entry in $snapshot) {
    if ($entry.key -notin $expectedKeys -or $entry.exists -isnot [bool] -or !$seen.Add($entry.key)) { throw 'update_registration_snapshot_invalid' }
    foreach ($value in $entry.values) {
      if (($entry.key -eq $expectedKeys[0] -and $value.name -eq 'InstallDir' -and
        [IO.Path]::GetFullPath([string]$value.value).TrimEnd('\') -ne [IO.Path]::GetFullPath($plan.bundleRoot).TrimEnd('\')) -or
        ($entry.key -eq $expectedKeys[1] -and $value.name -eq 'UninstallString' -and
        $value.value -ne ('"' + (Join-Path $plan.bundleRoot 'Uninstall.exe') + '"'))) { throw 'update_registration_snapshot_invalid' }
    }
  }
  foreach ($entry in $snapshot) {
    Remove-Item -LiteralPath $entry.key -Recurse -Force -ErrorAction SilentlyContinue
    if ($entry.exists) {
      New-Item -Path $entry.key -Force | Out-Null
      foreach ($value in $entry.values) { New-ItemProperty -LiteralPath $entry.key -Name $value.name -Value $value.value -PropertyType $value.kind -Force | Out-Null }
    }
  }
  # Restore only the three owned links. Never recursively remove a menu directory
  # that may now contain unrelated user files.
  foreach ($shortcut in (Installation-Shortcuts)) {
    if (Test-Path -LiteralPath $shortcut.current) { Remove-Item -LiteralPath $shortcut.current -Force }
    if (Test-Path -LiteralPath $shortcut.saved) {
      [IO.Directory]::CreateDirectory((Split-Path -Parent $shortcut.current)) | Out-Null
      Copy-Item -LiteralPath $shortcut.saved -Destination $shortcut.current
    }
  }
}
function Record-Result([string]$status, [string]$code) {
  $result = @{ status = $status; code = $code; version = $plan.version; recoveryDirectory = (Split-Path $StageRoot -Leaf) }
  Write-JsonAtomic (Join-Path $StageRoot 'result.json') $result
  Write-JsonAtomic (Join-Path $plan.stateRoot 'updates\result.json') $result
  $script:updateResultWritten = $true
}
function Complete-Restore {
  Assert-PreviousInstance $plan.bundleRoot
  Record-Result 'restored' 'update_rolled_back'
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'restored' }
  Remove-RecoveryOwner
  Recovery-Registration $false
}
function Restore-Previous {
  if ($null -ne $script:programGate) { $script:programGate.Dispose(); $script:programGate = $null }
  [void](Start-UpdateMutation)
  Update-WindowPhase 'restore-check'
  Record-UpdateActivity 'restore-check'
  Assert-Stopped
  Assert-RecoveryTarget
  Assert-ShortcutOwnership $true
  # Windows refuses write access to an executable image while it is mapped.
  # Check the actual file, avoiding PID gaps and short/Unicode path aliases.
  # No bytes are written; an unreadable or still-used installer fails closed.
  try {
    $image = [IO.File]::Open((Join-Path $StageRoot 'Installer.exe'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $image.Dispose()
  } catch { throw 'update_installer_remaining' }
  $backup = Join-Path $StageRoot 'previous'
  Assert-PreviousInstance $backup
  $restore = $plan.bundleRoot + '.mizar-restore-' + (Split-Path $StageRoot -Leaf)
  $failed = $plan.bundleRoot + '.mizar-failed-' + (Split-Path $StageRoot -Leaf)
  Assert-PlainPath $restore; Assert-PlainPath $failed
  if (Test-Path -LiteralPath $plan.bundleRoot) {
    # A retry after a directory swap must not destroy its only failed copy.
    try { Assert-PreviousInstance $plan.bundleRoot; $alreadyRestored = $true } catch { $alreadyRestored = $false }
    if ($alreadyRestored) { Restore-Registration; Complete-Restore; return }
  }
  if ((Test-Path -LiteralPath $plan.bundleRoot) -and (Test-Path -LiteralPath $failed)) { throw 'update_recovery_conflict' }
  # Check an already restored payload before materializing another full restore copy.
  # The backup and current payload remain independently verified above.
  Update-WindowPhase 'restore-copy'
  Record-UpdateActivity 'restore-copy'
  if (!(Test-Path -LiteralPath $restore)) { Copy-Item -LiteralPath $backup -Destination $restore -Recurse }
  Assert-PreviousInstance $restore
  # The backup predates ownership publication. Carry this transaction's marker
  # across the swap, including restoration of a legacy static installed.flag.
  $restoreMarker = Join-Path $restore '.mizar-update-owner'; Assert-PlainPath $restoreMarker
  if (Test-Path -LiteralPath $restoreMarker) {
    if ((Get-Content -LiteralPath $restoreMarker -Raw) -ne (Split-Path -Leaf $StageRoot)) { throw 'update_recovery_owner_changed' }
  } else { Create-RecoveryOwner $restore }
  if ((Test-Path -LiteralPath $plan.bundleRoot) -and !(Test-Path -LiteralPath (Join-Path $plan.bundleRoot '.mizar-update-owner'))) { Create-RecoveryOwner }
  if (Test-Path -LiteralPath (Join-Path $plan.bundleRoot 'Mizar.exe')) { $script:programGate = [MizarUpdateFiles]::ExcludeProgram((Join-Path $plan.bundleRoot 'Mizar.exe')) }
  Update-WindowPhase 'restore-swap'
  Record-UpdateActivity 'restore-swap'
  if (Test-Path -LiteralPath $plan.bundleRoot) {
    if (Test-Path -LiteralPath $failed) { throw 'update_recovery_conflict' }
    Move-Item -LiteralPath $plan.bundleRoot -Destination $failed
  }
  Move-Item -LiteralPath $restore -Destination $plan.bundleRoot
  if ($null -ne $script:programGate) { $script:programGate.Dispose(); $script:programGate = $null }
  Update-WindowPhase 'restore-verify'
  Record-UpdateActivity 'restore-verify'
  Assert-PreviousInstance $plan.bundleRoot
  Restore-Registration
  Complete-Restore
  # Retain the displaced directory: unverified files must never be deleted during recovery.
}

if ($Mode -eq 'Handoff') {
  $script:handoffHandles = [Collections.Generic.List[IDisposable]]::new()
  try {
    $target = Handoff-Path $HandoffTarget
    $context = Handoff-Caller $target $CallerProcessId $ParentReceiptPath
    if ($ProbeWriter) { if ($context.needsWriter) { exit 10 }; exit 0 }
    if ($context.needsWriter) { throw 'update_handoff_writer_unknown' }
    if ($ExpectedBootstrap) {
      if ($ExpectedBootstrap -notmatch '^bootstrap-[a-f0-9]{32}$') { throw 'update_handoff_bootstrap_owner_changed' }
      $bootstrapMarker = Join-Path $target '.mizar-bootstrap-owner'; Assert-PlainPath $bootstrapMarker
      if ((Get-Content -LiteralPath $bootstrapMarker -Raw) -ne $ExpectedBootstrap.Substring(10)) { throw 'update_handoff_bootstrap_owner_changed' }
      foreach ($name in @('installed.flag', '.mizar-update-owner')) {
        $marker = Join-Path $target $name; Assert-PlainPath $marker
        $expected = if ($name -eq 'installed.flag') { 'mizar.install.v1:' + $ExpectedBootstrap } else { $ExpectedBootstrap }
        if ((Test-Path -LiteralPath $marker) -and (Get-Content -LiteralPath $marker -Raw) -ne $expected) { throw 'update_handoff_bootstrap_owner_changed' }
      }
    }
    $root = Invoke-LegacyHandoff $target $HandoffState '' $context
    if ($ReceiptPath) {
      if ($InstallationOwner -notmatch '^[a-zA-Z0-9{}_-]{1,64}$') { throw 'update_handoff_caller_unknown' }
      $receipt = @{ schema = 'mizar.handoff.v1'; callerPid = $CallerProcessId; callerStarted = $context.caller.started; callerSha256 = [MizarUpdateFiles]::Hash($context.caller.snapshot.ExecutablePath); target = $target; state = $root; installationOwner = $InstallationOwner }
      Publish-HandoffRefusal $ReceiptPath ($receipt | ConvertTo-Json -Compress)
    }
    [Console]::Write($root)
    exit 0
  } catch {
    $failure = $_.Exception.ToString()
    [Console]::Error.WriteLine($failure)
    try {
      $logRoot = Handoff-Path $(if ($context -and $context.state) { $context.state } else { $HandoffState })
      if ($logRoot -eq $target -or $logRoot.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'update_data_inside_installation' }
      $logDirectory = Join-Path $logRoot 'updates'; Assert-PlainPath $logDirectory
      [IO.Directory]::CreateDirectory($logDirectory) | Out-Null
      $logPath = Join-Path $logDirectory 'handoff-last.log'; Assert-PlainPath $logPath
      if ($failure.Length -gt 32768) { $failure = $failure.Substring(0,32768) }
      [IO.File]::WriteAllText($logPath, ([DateTime]::UtcNow.ToString('o') + " target=" + $HandoffTarget + " caller=" + $CallerProcessId + "`r`n" + $failure), [Text.UTF8Encoding]::new($false))
    } catch { }
    exit 1
  }
  finally { foreach ($handle in $script:handoffHandles) { $handle.Dispose() } }
}

if ($Mode -eq 'Prepare') {
  $plan = Get-Content -Encoding UTF8 -LiteralPath $PlanPath -Raw | ConvertFrom-Json
  Assert-Plan $plan
  if (!(Test-Path -LiteralPath (Join-Path $plan.bundleRoot 'installed.flag'))) { throw 'update_portable_install_forbidden' }
  Assert-Installer $plan $plan.installer
  $plan | Add-Member -NotePropertyName previousInstallationId -NotePropertyValue ([MizarUpdateFiles]::Hash((Join-Path $plan.bundleRoot 'installed.flag'))) -Force
  $plan | Add-Member -NotePropertyName recoveryProtocol -NotePropertyValue 'mizar.install-instance.v1' -Force
  $plan | Add-Member -NotePropertyName helperSha256 -NotePropertyValue ([MizarUpdateFiles]::Hash($PSCommandPath)) -Force
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
$script:programGate = $null
$script:updateWindowStarted = $false
$script:launchAfterCommit = $false
function Invoke-UpdateTransaction {
# One writer spans Install/Recover/Rollback, including all failure preservation.
# Retaining the existing desktop object also blocks older Hosts which check its existence.
$writer = New-Object Threading.Mutex($false, 'Global\MizarUpdateWriter')
$writerOwned = $false
$desktop = $null
$active = $null
try {
  try { $writerOwned = $writer.WaitOne(0) }
  catch [Threading.AbandonedMutexException] { $writerOwned = $true }
  if (!$writerOwned) { throw 'update_transaction_busy' }
  $desktop = New-Object Threading.Mutex($false, 'Global\MizarDesktop')
  $active = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, 'Global\MizarUpdateActive')
  if (!$NoStatusWindow -and !$script:updateWindowStarted) { [MizarUpdateWindow]::Start($StageRoot, ($Mode -eq 'Install'), $plan.version); $script:updateWindowStarted = $true }
  if ($ReadyEvent) {
    if ($Mode -ne 'Install' -or $ReadyEvent -notmatch '^Global\\MizarUpdateReady-[0-9]+-[0-9]+$') { throw 'update_handoff_invalid' }
    $ready = [Threading.EventWaitHandle]::OpenExisting($ReadyEvent)
    try { [void]$ready.Set() } finally { $ready.Dispose() }
  }
if ($Mode -eq 'Install') {
  $script:handoffHandles = [Collections.Generic.List[IDisposable]]::new()
  try { [void](Invoke-LegacyHandoff $plan.bundleRoot $plan.stateRoot $StageRoot) }
  finally { foreach ($handle in $script:handoffHandles) { $handle.Dispose() } }
}
# Reject stale recovery before any registration/result write or automatic rollback.
$journal = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json
if ($Mode -in @('Recover', 'Rollback')) {
  if (Test-RestoredTransaction $journal) {
    $script:restoredTransaction = $true
    return
  }
  Assert-RecoveryTarget
}
try {
  if ($Mode -eq 'Finalize') {
    $journal = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json
    if ($journal.phase -ne 'committed') { throw 'update_not_committed' }
    Assert-Stopped
    Assert-CandidateInstance
    # Only the successful bootstrap owner requests finalization, after resource
    # readiness and its last cancellation check. Failed/recovering stages never enter.
    $previous = Join-Path $StageRoot 'previous'
    Assert-PlainPath $previous
    if (Test-Path -LiteralPath $previous) {
      if (!(Test-Path -LiteralPath $previous -PathType Container)) { throw 'update_backup_path_invalid' }
      if (Get-ChildItem -LiteralPath $previous -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'update_reparse_point' }
      Remove-Item -LiteralPath $previous -Recurse -Force
    }
    foreach ($download in @((Join-Path $StageRoot 'Installer.exe'), $plan.installer)) {
      Assert-PlainPath $download
      if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force }
    }
    Record-UpdateActivity 'finalized'
    Record-Result 'installed' 'update_completed'
    return
  }
  if ($Mode -eq 'Rollback') { Restore-Previous; return }
  if ($Mode -eq 'Recover') {
    Recovery-Registration $true
    $journal = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json
    if ($journal.phase -eq 'committed') {
      Assert-CandidateInstance
      Recovery-Registration $false
      Record-Result 'installed' 'update_completed'
    } elseif ($journal.phase -eq 'prepared') {
      Assert-PreviousInstance $plan.bundleRoot
      Remove-RecoveryOwner
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
  Invoke-UpdatePhase 'stopped-and-installer' {
    Assert-Stopped
    Assert-Installer $plan (Join-Path $StageRoot 'Installer.exe')
  }
  Invoke-UpdatePhase 'previous-payload' { Clear-CompletedRecoveryOwner; Assert-RecoveryTarget; Assert-PreviousInstance $plan.bundleRoot }
  Invoke-UpdatePhase 'reparse-and-registration' {
    if (Get-ChildItem -LiteralPath $plan.bundleRoot -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'update_reparse_point' }
    Save-Registration
  }
  Invoke-UpdatePhase 'backup-copy' { Copy-Item -LiteralPath $plan.bundleRoot -Destination (Join-Path $StageRoot 'previous') -Recurse }
  Invoke-UpdatePhase 'backup-payload' { Assert-PreviousInstance (Join-Path $StageRoot 'previous') }
  Invoke-UpdatePhase 'program-exclusion' { $script:programGate = [MizarUpdateFiles]::ExcludeProgram((Join-Path $plan.bundleRoot 'Mizar.exe')) }
  if (!(Start-UpdateMutation)) { throw 'update_cancelled_before_install' }
  Recovery-Registration $true
  Create-RecoveryOwner
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'installing' }
  # Remove only the verified previous product files; preserve state and every untracked file.
  Invoke-UpdatePhase 'remove-previous-files' {
    foreach ($line in (Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'previous/resources/metadata/SHA256SUMS'))) {
      $name = $line.Substring(66)
      if ($name -match '\\|^/|:|(^|/)\.\.?(/|$)|//|^state/') { throw 'update_payload_path_invalid' }
      $file = [IO.Path]::Combine($plan.bundleRoot, $name)
      [MizarUpdateFiles]::Delete($file)
      if ($name -eq 'Mizar.exe') { $script:programGate.Dispose(); $script:programGate = $null }
    }
  }
  Invoke-UpdatePhase 'nsis-install' {
    $installer = Start-Process -FilePath (Join-Path $StageRoot 'Installer.exe') -ArgumentList @('/S', '/MIZARUPDATE', ('/MIZAROWNER=' + (Split-Path -Leaf $StageRoot)), ('"/MIZARSTATE=' + $plan.stateRoot + '"'), ('/D=' + $plan.bundleRoot)) -PassThru
    $installer.WaitForExit()
    if ($installer.ExitCode -ne 0) { throw 'update_installer_cancelled' }
  }
  Invoke-UpdatePhase 'installed-payload' { Assert-CandidateInstance }
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
    Assert-ShortcutOwnership $true
    Copy-Item -LiteralPath $desktopShortcut -Destination (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mizar.lnk') -Force
  }
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'committed' }
  Remove-RecoveryOwner
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
  $code = 'update_installation_failed'
  while ($null -ne $cause) {
    if ([string]$cause.Message -match '^update_[a-z_]+$') { $code = [string]$cause.Message; break }
    $cause = $cause.InnerException
  }
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
      Assert-CandidateInstance
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
  if ($null -ne $script:programGate) { $script:programGate.Dispose(); $script:programGate = $null }
  if ($null -ne $desktop) { $desktop.Dispose() }
  if ($null -ne $active) { $active.Dispose() }
  if ($writerOwned) { $writer.ReleaseMutex() }
  $writer.Dispose()
}
}
do {
$script:updateExitCode = 0
$script:updateFailureCode = ''
$script:updateResultWritten = $false
$script:launchAfterCommit = $false
$script:restoredTransaction = $false
try { Invoke-UpdateTransaction }
catch {
  $script:updateExitCode = 1
  $cause = $_.Exception
  $script:updateFailureCode = 'update_installation_failed'
  while ($null -ne $cause) {
    if ([string]$cause.Message -match '^update_[a-z_]+$') { $script:updateFailureCode = [string]$cause.Message; break }
    $cause = $cause.InnerException
  }
  Record-UpdateActivity 'transaction_entry_failed' $_.ToString()
  [Console]::Error.WriteLine($_.ToString())
}
$result = $null
try { $result = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $plan.stateRoot 'updates/result.json') -Raw | ConvertFrom-Json } catch { }
$phase = ''
try { $phase = [string](Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json).phase } catch { }
$currentResult = $script:updateResultWritten -and $null -ne $result -and $result.recoveryDirectory -eq (Split-Path -Leaf $StageRoot)
$status = if ($script:restoredTransaction) { 'restored' } elseif ($currentResult) { [string]$result.status } elseif ($phase -eq 'prepared') { 'cancelled' } else { 'recovery-required' }
$code = if ($script:restoredTransaction) { 'update_rolled_back' } elseif ($currentResult) { [string]$result.code } elseif ($phase -eq 'prepared') { 'update_not_started' } else { 'update_result_unavailable' }
if ($script:updateFailureCode -and $script:updateFailureCode -ne $code) { $code = $script:updateFailureCode + ' / ' + $code }
$canRestore = $false
if ($status -eq 'recovery-required' -and $script:updateFailureCode -notmatch '^(update_recovery_(target|owner|result)_|update_shortcut_)' -and (Test-Path -LiteralPath (Join-Path $StageRoot 'Installer.exe'))) {
  try { Assert-Payload (Join-Path $StageRoot 'previous') $plan.previousContentDigest; $canRestore = $true } catch { Record-UpdateActivity 'backup_unavailable' $_.ToString() }
}
if ($script:updateWindowAvailable) { [MizarUpdateWindow]::Complete($status, $code, $script:launchAfterCommit, $canRestore) }
# No protected writes remain; the new Host can now acquire its desktop object.
if ($script:launchAfterCommit) {
  try { Start-Process -FilePath (Join-Path $plan.bundleRoot 'Mizar.exe') -WorkingDirectory $plan.bundleRoot; if ($script:updateWindowAvailable) { [MizarUpdateWindow]::CloseCompleted() } }
  catch { Record-UpdateActivity 'launch_failed' $_.ToString(); if ($script:updateWindowAvailable) { [MizarUpdateWindow]::LaunchFailed() }; $script:updateExitCode = 1 }
} elseif ($status -eq 'installed' -and $NoLaunch -and $script:updateWindowAvailable) { [MizarUpdateWindow]::CloseCompleted() }
$restoreRequested = $script:updateWindowAvailable -and [MizarUpdateWindow]::WaitForRestore()
if ($restoreRequested) {
  # A user request, not an automatic install retry. Restore-Previous performs fresh
  # process/installer, backup, path, registration and complete-content checks.
  $Mode = 'Rollback'
  $ReadyEvent = ''
  Record-UpdateActivity 'restore-requested'
}
} while ($restoreRequested)
exit $script:updateExitCode
