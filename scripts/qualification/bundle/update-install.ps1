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
  [long]$BootstrapLease = 0,
  [switch]$ProbeWriter,
  [switch]$PreparePayload
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
  [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr from, IntPtr source, IntPtr to, out IntPtr duplicate, uint access, bool inherit, uint options);
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandleW(IntPtr handle, System.Text.StringBuilder path, uint size, uint flags);
  static IntPtr Duplicate(int from, IntPtr source, int to) {
    IntPtr parent=OpenProcess(0x40,false,from), child=OpenProcess(0x40,false,to), copied;
    try {
      if(parent==IntPtr.Zero || child==IntPtr.Zero || !DuplicateHandle(parent,source,child,out copied,0,false,2)) throw new IOException("update_handoff_lease_unknown",new System.ComponentModel.Win32Exception());
      return copied;
    } finally { if(parent!=IntPtr.Zero) CloseHandle(parent); if(child!=IntPtr.Zero) CloseHandle(child); }
  }
  public static FileStream BorrowLease(int parent, long handle, string path) {
    var safe=new Microsoft.Win32.SafeHandles.SafeFileHandle(Duplicate(parent,new IntPtr(handle),System.Diagnostics.Process.GetCurrentProcess().Id),true);
    FileStream lease=null;
    try {
      var final=new System.Text.StringBuilder(32768);
      uint count=GetFinalPathNameByHandleW(safe.DangerousGetHandle(),final,(uint)final.Capacity,0);
      string name=final.ToString();
      if(name.StartsWith(@"\\?\UNC\",StringComparison.OrdinalIgnoreCase)) name=@"\\"+name.Substring(8);
      else if(name.StartsWith(@"\\?\",StringComparison.OrdinalIgnoreCase)) name=name.Substring(4);
      if(count==0 || count>=final.Capacity || !String.Equals(LongPath(Path.GetFullPath(path)),name,StringComparison.OrdinalIgnoreCase)) throw new IOException("update_handoff_lease_unknown");
      lease=new FileStream(safe,FileAccess.ReadWrite);
      bool exclusive=false;
      try { using(var probe=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete)) { } }
      catch(IOException error) { int code=error.HResult&65535; if(code==32 || code==33) exclusive=true; else throw; }
      if(!exclusive) throw new IOException("update_handoff_lease_unknown");
      return lease;
    } catch { if(lease!=null) lease.Dispose(); else safe.Dispose(); throw; }
  }
  public static long RetainLease(FileStream lease, int caller) {
    return Duplicate(System.Diagnostics.Process.GetCurrentProcess().Id,lease.SafeFileHandle.DangerousGetHandle(),caller).ToInt64();
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
  public static void PlainPath(string path) {
    if (!Path.IsPathRooted(path) || path.IndexOfAny(new char[]{'"','\r','\n'}) >= 0) throw new IOException("update_path_invalid");
    for (string cursor=Path.GetFullPath(path); cursor!=null; cursor=Path.GetDirectoryName(cursor)) {
      FileAttributes attributes;
      // One metadata query per component, rather than File.Exists +
      // Directory.Exists + GetAttributes. Every ancestor is still checked.
      try { attributes=File.GetAttributes(cursor); }
      catch(FileNotFoundException) { continue; }
      catch(DirectoryNotFoundException) { continue; }
      if ((attributes & FileAttributes.ReparsePoint)!=0) throw new IOException("update_reparse_point");
    }
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
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint parameter, out int value, uint flags);
  static bool Animate() { int enabled; return SystemParametersInfo(0x1042,0,out enabled,0) && enabled!=0; }
  static readonly object gate = new object();
  static readonly ManualResetEvent ready = new ManualResetEvent(false), closed = new ManualResetEvent(false);
  static readonly AutoResetEvent restore = new AutoResetEvent(false);
  static Form window;
  static Label heading, detail, hint;
  static Button cancel, logs, close;
  static ProgressBar activity;
  static System.Windows.Forms.Timer elapsed;
  static readonly Stopwatch phaseClock = new Stopwatch();
  static void RefreshElapsed() {
    detail.Text="本阶段已用 "+(long)phaseClock.Elapsed.TotalSeconds+" 秒。完成核验后自动继续。";
  }
  static LinkLabel packageLink;
  static bool cancellable, cancelled, finished, restoreAllowed, firstInstall;
  static Exception startupError;
  static Thread thread;
  static string directory;
  public static bool CancellationRequested { get { lock(gate) { return cancelled; } } }
  static void RequestCancel() {
    lock(gate) { if (!cancellable || finished) return; cancelled=true; cancellable=false; }
    cancel.Enabled=false; hint.Text="正在取消更新，请等待工具安全结束。";
  }
  public static void Start(string stage, bool canCancel, string version, bool fresh) {
    firstInstall=fresh;
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
        activity=new ProgressBar { Location=new Point(32,191), Size=new Size(526,12), Style=ProgressBarStyle.Marquee, MarqueeAnimationSpeed=Animate() ? 30 : 0 };
        elapsed=new System.Windows.Forms.Timer { Interval=1000 };
        elapsed.Tick+=delegate { RefreshElapsed(); };
        phaseClock.Restart(); elapsed.Start();
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
        window.FormClosed+=delegate { elapsed.Dispose(); closed.Set(); };
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
      case "program-exclusion": text="正在确认程序已停止"; break;
      case "prepare-payload": text="正在解包新版，原程序尚未替换"; break;
      case "prepared-payload": text="正在核对新版完整性"; break;
      case "preserve-extra-files": text="正在保留安装目录中的其他文件"; break;
      case "switch-program": text="正在切换到新版"; break;
      case "starting-program": text="正在确认新版能够启动"; break;
      case "cleanup": text="正在清理本次更新的临时文件"; break;
      case "resources": text="正在核对并准备素材"; break;
      case "restore-check": text="正在核对恢复条件"; break;
      case "restore-swap": text="正在恢复原程序"; break;
      default: text="正在处理更新，请稍候"; break;
    }
    Apply(delegate { heading.Text=text; phaseClock.Restart(); RefreshElapsed(); elapsed.Start(); });
  }
  public static void Complete(string status, string code, bool relaunch, bool canRestore) {
    Apply(delegate {
      elapsed.Stop(); finished=true; cancellable=false; restoreAllowed=canRestore && status=="recovery-required"; window.Text="Mizar 更新结果"; activity.Visible=false; cancel.Visible=false; packageLink.Visible=false; close.Enabled=true;
      if(status=="installed") { heading.Text="更新已完成"; detail.Text="新版程序已核验。"; hint.Text=relaunch ? "正在重新打开 Mizar。" : "可以关闭本窗口后重新打开 Mizar。"; }
      else if(status=="restored") { heading.Text="旧版已恢复"; detail.Text="本次更新未完成，原程序与资料已保留。"; hint.Text="关闭本窗口后可重新打开 Mizar，再查看诊断。"; }
      else if(status=="cancelled") { heading.Text="更新未启动"; detail.Text="原程序未被替换，可以重新打开 Mizar。"; hint.Text="请查看日志了解原因，或使用正式安装包。"; }
      else if(status=="failed") { heading.Text="更新准备失败"; detail.Text="原程序未被替换，仍可使用。"; hint.Text="查看日志了解失败原因，处理后可重新更新。"; }
      else { heading.Text="需要恢复"; detail.Text="当前程序尚未核验，原文件与恢复记录已保留。";
        if(restoreAllowed) { hint.Text="自动恢复未完成。备份已核验，可点击“重试恢复”；失败原因见日志。"; cancel.Text="重试恢复"; cancel.Visible=true; cancel.Enabled=true; }
        else { hint.Text="旧版备份未通过核验；请关闭 Mizar，手动安装正式安装包。"; cancel.Text="重试恢复"; cancel.Visible=true; cancel.Enabled=false; packageLink.Visible=true; }
      }
      if(status=="recovery-required" && !String.IsNullOrEmpty(code) &&
        (code.Contains("update_recovery_target_") || code.Contains("update_recovery_owner_") || code.Contains("update_recovery_result_"))) {
        heading.Text="恢复目标需要核对"; detail.Text="不能确认旧恢复任务仍属于当前安装。";
        hint.Text="请保留当前程序和恢复记录，核对后使用对应安装的恢复入口。"; cancel.Visible=false; packageLink.Visible=false;
      }
      if(status=="recovery-required" && restoreAllowed && !String.IsNullOrEmpty(code)) {
        if(code.Contains("update_process_remaining")) hint.Text="Mizar 仍在运行。正常退出应用后点击“重试恢复”，保留本窗口。";
        else if(code.Contains("update_installer_remaining")) hint.Text="安装器仍在运行。结束安装向导后点击“重试恢复”，保留本窗口。";
        else if(code.Contains("update_program_in_use")) hint.Text="程序文件仍被占用；关闭 Mizar 和安装向导后重试恢复。";
      }
      if((status=="cancelled" || status=="failed") && !String.IsNullOrEmpty(code) && code.Contains("update_handoff_")) {
        heading.Text="旧安装任务需要交接"; detail.Text="原程序和恢复资料已保留，本次替换尚未开始。";
        hint.Text="请关闭旧更新窗口和轻量安装器，再使用完整安装包；不要运行旧脚本覆盖当前程序。"; cancel.Visible=false;
      }
      if(!String.IsNullOrEmpty(code) && code.Contains("update_installer_failed")) {
        detail.Text=status=="restored" ? "新版安装失败，旧版已核验并恢复。" :
          (status=="cancelled" || status=="failed") ? "新版准备失败，原程序未被替换，仍可使用。" : "新版安装失败，自动恢复也未完成。原程序备份已保留。";
      }
      if(status=="cancelled" && !String.IsNullOrEmpty(code) && !code.Contains("update_cancelled_before_install") && !code.Contains("update_installer_cancelled") && !code.Contains("update_not_started")) {
        heading.Text="更新未能开始"; detail.Text="原程序未被替换，仍可使用。"; hint.Text="查看日志了解失败原因，处理后可重新更新。";
      }
      if(firstInstall) {
        window.Text="Mizar 安装结果";
        if(status=="installed") { heading.Text="安装已完成"; detail.Text="程序已核验。"; }
        else if(status=="failed" || status=="cancelled") { heading.Text=status=="cancelled" ? "安装已取消" : "安装未完成"; detail.Text=code.Contains("update_rolled_back") ? "本次安装已撤回，原有资料保留。" : "安装尚未写入目标目录。"; hint.Text="查看日志了解原因后，可以重新安装。"; }
        else { detail.Text="本次安装尚未恢复完成，现场已保留。"; hint.Text="正常退出 Mizar 和安装向导后，重新打开原安装器恢复。"; }
      }
      window.AcceptButton=close; window.CancelButton=close; close.Focus();
    });
  }
  public static void LaunchFailed() { Apply(delegate { heading.Text="新版启动尚未确认"; hint.Text="旧程序备份已保留。请查看启动日志；更新记录中的恢复入口仍可使用。"; }); }
  public static void CleanupFailed() { Apply(delegate { heading.Text="更新已完成，临时文件未清理"; detail.Text="新版已经启动，旧程序副本仍保留。"; hint.Text="清理失败原因已记录；用户资料不受影响。"; }); }
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
    $path = Join-Path $StageRoot 'update-activity.ndjson'
    Assert-PlainPath $path
    if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt 65536) {
      $previousLog = $path + '.previous'; Assert-PlainPath $previousLog
      Move-Item -LiteralPath $path -Destination $previousLog -Force
    }
    [IO.File]::AppendAllText($path, $record + "`n", (New-Object Text.UTF8Encoding($false)))
  } catch { }
}
function Assert-PlainPath([string]$path) { [MizarUpdateFiles]::PlainPath($path) }
function Update-ErrorCode($errorRecord, [string]$fallback) {
  $cause = $errorRecord.Exception
  while ($null -ne $cause) {
    if ([string]$cause.Message -match '^update_[a-z_]+$') { return [string]$cause.Message }
    $cause = $cause.InnerException
  }
  return $fallback
}

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
  if ($path -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)' -or $path -match '^\\\\[?.]\\') { throw 'update_path_invalid' }
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
function Handoff-ReferencedPath([string]$argument) {
  # Discovery sees arbitrary -Command text too. Only normalize actual absolute
  # path arguments; exact owner/parent validation still uses strict Handoff-Path.
  if ($argument -notmatch '^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)' -or
    $argument.IndexOfAny([IO.Path]::GetInvalidPathChars()) -ge 0) { return '' }
  return [MizarUpdateFiles]::LongPath($argument).TrimEnd('\')
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
    !($binding.recoveryProtocol -eq 'mizar.install-instance.v1' -and $binding.helperSha256 -eq $hash -and ($binding.previousInstallationId -match '^[a-f0-9]{64}$' -or $binding.transactionProtocol -eq 'mizar.directory-swap.v1'))) { throw 'update_handoff_parent_unknown' }
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
  $leaseParent = if ($parentReceipt) { @{ process = $setup; handle = $receipt.leaseHandle } } else { $null }
  $owner = [MizarUpdateFiles]::WriterOwnerPid()
  if ($owner -eq 0) { return @{ needsWriter = $true; caller = $caller; leaseParent = $leaseParent } }
  if ($owner -eq $caller.process.Id) { return @{ needsWriter = $false; caller = $caller; leaseParent = $leaseParent } }
  if ($owner -ne $caller.snapshot.ParentProcessId) { throw 'update_transaction_busy' }
  $context = Handoff-UpdateParent $caller $target
  $context.needsWriter = $false; $context.caller = $caller; $context.leaseParent = $leaseParent
  return $context
}
function Handoff-LeasePath {
  $cache = Join-Path (Join-Path $env:LOCALAPPDATA 'Mizar') 'bootstrap-cache'
  Assert-PlainPath $cache
  [IO.Directory]::CreateDirectory($cache) | Out-Null
  $path = Join-Path $cache 'fresh-install.lock'; Assert-PlainPath $path
  return $path
}
function Handoff-BootstrapParent($child, [string]$target, [string]$stage, [string]$token = '') {
  $parent = Handoff-Process $child.snapshot.ParentProcessId
  $pending = Read-HandoffJson ((Handoff-LeasePath) -replace 'fresh-install.lock$', 'fresh-install.pending') -SharedSnapshot
  if ($parent.started -gt $child.started -or $pending.schemaVersion -ne 'mizar.bootstrap-pending.v1' -or
    $pending.ownerPid -ne $parent.process.Id -or $pending.ownerStarted -ne $parent.started -or
    $pending.bootstrapSha256 -ne [MizarUpdateFiles]::Hash($parent.snapshot.ExecutablePath) -or
    (Handoff-Path $pending.target) -ne $target -or ($stage -and (Handoff-Path $pending.updateStage) -ne $stage) -or
    ($token -and $pending.token -ne $token)) { throw 'update_handoff_bootstrap_owner_changed' }
  return $parent
}
function Open-HandoffLease($parent = $null, [long]$handle = 0) {
  $path = Handoff-LeasePath
  if ($handle -ne 0) {
    if (!$parent) { throw 'update_handoff_lease_unknown' }
    return [MizarUpdateFiles]::BorrowLease($parent.process.Id, $handle, $path)
  }
  try { return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
  catch { throw [IO.IOException]::new('update_handoff_bootstrap_active', $_.Exception) }
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
  if ((!$context -or !$context.caller) -and [MizarUpdateFiles]::WriterOwnerPid() -ne $PID) { throw 'update_handoff_writer_unknown' }
  if ($context -and $context.stage) { $currentStage = $context.stage; $state = $context.state }
  if ($state -eq $target -or $state.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'update_data_inside_installation' }
  $lease = $null
  $locks = [Collections.Generic.List[IDisposable]]::new()
  try {
  if (!$context -or !$context.lease) { $lease = Open-HandoffLease }
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
      if (!(Test-Path -LiteralPath $planPath -PathType Leaf)) { throw 'update_handoff_record_incomplete' }
      $binding = Read-HandoffJson $planPath
      if ((Handoff-Path $binding.bundleRoot) -ne $target) { continue }
      $binding = Handoff-Plan $directory.FullName $target (Handoff-Path $root)
      $source = Join-Path $directory.FullName 'update-install.ps1'; $archive = $source + '.retired'
      Assert-PlainPath $source; Assert-PlainPath $archive
      $archived = Test-Path -LiteralPath $archive -PathType Leaf
      $hash = if ($archived) { [MizarUpdateFiles]::Hash($archive) } else { [MizarUpdateFiles]::Hash($source) }
      if (!$archived -and $binding.recoveryProtocol -eq 'mizar.install-instance.v1' -and $binding.helperSha256 -eq $hash -and ($binding.previousInstallationId -match '^[a-f0-9]{64}$' -or $binding.transactionProtocol -eq 'mizar.directory-swap.v1')) { continue }
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
    # Only legacy stages need process discovery. Modern stages enforce their own
    # instance ownership; an unrelated PowerShell is not evidence of an old writer.
    if ($candidates.Count -eq 0) { return $state }
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
        # Desktop updates run in an interactive session. Session 0 services are
        # not discoverable desktop recovery windows. Actual writer/pending owners
        # are checked independently, regardless of session or query permissions.
        if ($snapshot.SessionId -eq 0 -and [Diagnostics.Process]::GetCurrentProcess().SessionId -ne 0) { continue }
        $owner = Invoke-CimMethod -InputObject $snapshot -MethodName GetOwnerSid -OperationTimeoutSec 10
        if ($owner.ReturnValue -ne 0 -or $owner.Sid -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { throw 'update_handoff_process_unknown' }
        continue
      }
      # A crashed bootstrap may leave Prepare running before plan.json exists.
      # Its standard script path still identifies the loaded legacy source.
      $arguments = @(Handoff-Arguments $snapshot)
      foreach ($argument in $arguments) {
        if ($argument -notmatch '(?i)[\\/]update-install\.ps1$') { continue }
        $sourcePath = Handoff-ReferencedPath $argument
        if (!$sourcePath) { continue }
        $knownRoot = $false
        foreach ($root in $roots) {
          if ($sourcePath.StartsWith((Join-Path $root 'updates') + '\', [StringComparison]::OrdinalIgnoreCase)) { $knownRoot = $true; break }
        }
        if (!$knownRoot -or !(Test-Path -LiteralPath $sourcePath -PathType Leaf)) { continue }
        if ((Get-Item -LiteralPath $sourcePath).Length -gt 131072) { throw 'update_handoff_source_unknown' }
        if (!(Test-LegacyHelperHash ([MizarUpdateFiles]::Hash($sourcePath)))) { continue }
        $runningStage = Handoff-Argument $arguments '-StageRoot'
        if ($currentStage -and $runningStage -and (Handoff-Path $runningStage) -eq $currentStage) { continue }
        $active = Handoff-Process $snapshot.ProcessId
        if (!$active.process.HasExited) { throw 'update_handoff_process_active' }
      }
      # Script parameters accept abbreviations and colon syntax. Retirement is
      # conservative: any mention of a candidate's path is enough to refuse;
      # only parent authorization uses the stricter canonical argument parser.
      $paths = @()
      foreach ($argument in @(Handoff-Arguments $snapshot)) {
        if ($argument -match '^-[^:]+:(.+)$') { $argument = $Matches[1] }
        $path = Handoff-ReferencedPath $argument
        if ($path) { $paths += $path }
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
    if (!$candidates.Count) { return $state }
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
    $plan.contentDigest -notmatch '^[a-f0-9]{64}$' -or ($plan.previousContentDigest -and $plan.previousContentDigest -notmatch '^[a-f0-9]{64}$') -or
    ($plan.coreArchiveSha256 -and $plan.coreArchiveSha256 -notmatch '^[a-f0-9]{64}$') -or
    ($plan.previousInstallationId -and (!$plan.previousContentDigest -or $plan.previousInstallationId -notmatch '^[a-f0-9]{64}$')) -or
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
  # FileInfo.FullName is expanded by Windows PowerShell. Use the same spelling
  # for all later relative-path calculations, including short-name input paths.
  $plan.bundleRoot = $bundle
  $plan.stateRoot = $state
  $plan.installer = $installerPath
}
function Assert-Installer($plan, [string]$path) {
  Assert-PlainPath $path
  if ((Get-Item -LiteralPath $path).Length -ne $plan.installerBytes -or
    (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $plan.installerSha256) { throw 'update_installer_corrupt' }
}
function Read-PayloadRecords([string]$directory, [string]$digest, [string]$version = '', [string]$gitSha = '') {
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
  return $records
}
function Assert-Payload([string]$directory, [string]$digest, [string]$version = '', [string]$gitSha = '') {
  $records = Read-PayloadRecords $directory $digest $version $gitSha
  foreach ($name in $records.Keys) {
    if ([MizarUpdateFiles]::Hash([IO.Path]::Combine($directory, $name)) -ne $records[$name]) { throw 'update_payload_corrupt' }
  }
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
  return !$previousPlan.previousContentDigest -and $old.journal.phase -eq 'restored' -and $old.result.status -eq 'failed' -and $old.result.code -eq 'update_rolled_back' -and !(Test-Path -LiteralPath $previousPlan.bundleRoot)
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
    if (!(Test-Path -LiteralPath $key)) { New-Item -Path $key | Out-Null }
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
function Assert-EmptyTarget {
  Assert-PlainPath $plan.bundleRoot
  if ((Test-Path -LiteralPath $plan.bundleRoot) -and
    (!(Test-Path -LiteralPath $plan.bundleRoot -PathType Container) -or @(Get-ChildItem -LiteralPath $plan.bundleRoot -Force).Count -ne 0)) { throw 'update_install_target_not_empty' }
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
  if (!$plan.previousContentDigest -and !(Test-Path -LiteralPath (Join-Path $plan.bundleRoot 'installed.flag'))) {
    Assert-EmptyTarget
    $phase = (Read-HandoffJson (Join-Path $StageRoot 'journal.json')).phase
    if ($phase -notin @('prepared', 'restored')) {
      $paired = Candidate-Directory
      if (!(Test-Path -LiteralPath $paired)) { $paired = $plan.bundleRoot + '.mizar-failed-' + (Split-Path -Leaf $StageRoot) }
      Assert-TransactionDirectory $paired
    }
    return
  }
  if (!(Test-Path -LiteralPath $plan.bundleRoot)) {
    # Absence alone is also the result of an intentional uninstall. Resume only
    # our interrupted swap, with both independently verified, paired directories.
    $restore = $plan.bundleRoot + '.mizar-restore-' + (Split-Path -Leaf $StageRoot)
    $failed = $plan.bundleRoot + '.mizar-failed-' + (Split-Path -Leaf $StageRoot)
    $paired = $failed
    if (!(Test-Path -LiteralPath $failed)) {
      $paired = Candidate-Directory
      Assert-CandidateInstance $paired
    }
    foreach ($directory in @($restore, $paired)) {
      Assert-PlainPath $directory
      $pair = Join-Path $directory '.mizar-update-owner'; Assert-PlainPath $pair
      if (!(Test-Path -LiteralPath $directory -PathType Container) -or !(Test-Path -LiteralPath $pair -PathType Leaf) -or
        (Get-Item -LiteralPath $pair -Force).Length -gt 64 -or (Get-Content -LiteralPath $pair -Raw) -ne (Split-Path -Leaf $StageRoot)) { throw 'update_recovery_target_unknown' }
    }
    Assert-PreviousInstance $restore
    $displacedFlag = Join-Path $paired 'installed.flag'; Assert-PlainPath $displacedFlag
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
  if (!$plan.previousContentDigest) { Assert-EmptyTarget; return }
  Assert-Payload $directory $plan.previousContentDigest
  if (!$plan.previousInstallationId -or [MizarUpdateFiles]::Hash((Join-Path $directory 'installed.flag')) -ne $plan.previousInstallationId) { throw 'update_recovery_owner_changed' }
}
function Assert-CandidateInstance {
  param([string]$directory = $plan.bundleRoot)
  Assert-Payload $directory $plan.contentDigest $plan.version $plan.gitSha
  $flag = Join-Path $directory 'installed.flag'; Assert-PlainPath $flag
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
  if ($null -eq $result -or $result.status -ne $(if ($plan.previousContentDigest) { 'restored' } else { 'failed' }) -or $result.code -ne 'update_rolled_back' -or
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
function Save-Registration {
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
}
function Restore-Registration {
  Assert-RecoveryTarget
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
}
function Record-Result([string]$status, [string]$code) {
  $result = @{ status = $status; code = $code; version = $plan.version; recoveryDirectory = (Split-Path $StageRoot -Leaf) }
  Write-JsonAtomic (Join-Path $StageRoot 'result.json') $result
  Write-JsonAtomic (Join-Path $plan.stateRoot 'updates\result.json') $result
  $script:updateResultWritten = $true
}
function Previous-Directory {
  return $plan.bundleRoot + '.mizar-restore-' + (Split-Path -Leaf $StageRoot)
}
function Candidate-Directory {
  return $plan.bundleRoot + '.mizar-candidate-' + (Split-Path -Leaf $StageRoot)
}
function Assert-TransactionDirectory([string]$directory) {
  # Only fixed, same-volume siblings derived from the validated target and stage.
  $allowed = @((Candidate-Directory), (Previous-Directory), ($plan.bundleRoot + '.mizar-failed-' + (Split-Path -Leaf $StageRoot)))
  if ($directory -notin $allowed) { throw 'update_stage_invalid' }
  Assert-PlainPath $directory
  $marker = Join-Path $directory '.mizar-update-owner'; Assert-PlainPath $marker
  if ((Get-Content -LiteralPath $marker -Raw) -ne (Split-Path -Leaf $StageRoot)) { throw 'update_recovery_owner_changed' }
  if (Get-ChildItem -LiteralPath $directory -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'update_reparse_point' }
}
function Product-Paths([string]$directory) {
  # Call only after Read-PayloadRecords has authenticated the manifest.
  $paths = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($line in (Get-Content -Encoding UTF8 -LiteralPath (Join-Path $directory 'resources/metadata/SHA256SUMS'))) {
    [void]$paths.Add($line.Substring(66).Replace('/', '\'))
  }
  foreach ($name in @('resources\metadata\SHA256SUMS', 'installed.flag', 'Uninstall.exe', '.mizar-update-owner')) { [void]$paths.Add($name) }
  return ,$paths
}
function Preserve-ExtraFiles([string]$candidate) {
  $managed = Product-Paths $plan.bundleRoot
  $prefix = $plan.bundleRoot.TrimEnd('\') + '\'
  # Unknown files stay usable at their original relative paths. A collision
  # with a new product file is a preparation failure, before the old root moves.
  foreach ($file in (Get-ChildItem -LiteralPath $plan.bundleRoot -Recurse -Force -File)) {
    $relative = $file.FullName.Substring($prefix.Length)
    if ($managed.Contains($relative)) { continue }
    $destination = Join-Path $candidate $relative; Assert-PlainPath $destination
    if (Test-Path -LiteralPath $destination) { throw 'update_user_file_conflict' }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    [IO.File]::Copy($file.FullName, $destination)
    if ([MizarUpdateFiles]::Hash($file.FullName) -ne [MizarUpdateFiles]::Hash($destination)) { throw 'update_user_file_changed' }
  }
}
function Install-Registration {
  Assert-InstallationRegistration
  $productKey = 'HKCU:\Software\Mizar'
  $uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar'
  foreach ($key in @($productKey, $uninstallKey)) {
    if (!(Test-Path -LiteralPath $key)) { New-Item -Path $key | Out-Null }
  }
  Set-ItemProperty -LiteralPath $productKey -Name InstallDir -Value $plan.bundleRoot
  Set-ItemProperty -LiteralPath $productKey -Name StateRoot -Value $plan.stateRoot
  $values = @{ DisplayName = 'Mizar'; DisplayVersion = $plan.version; UninstallString = ('"' + (Join-Path $plan.bundleRoot 'Uninstall.exe') + '"'); DisplayIcon = (Join-Path $plan.bundleRoot 'Mizar.exe') }
  foreach ($name in $values.Keys) { Set-ItemProperty -LiteralPath $uninstallKey -Name $name -Value $values[$name] }
  foreach ($name in @('NoModify', 'NoRepair')) { New-ItemProperty -LiteralPath $uninstallKey -Name $name -PropertyType DWord -Value 1 -Force | Out-Null }
  # Existing shortcuts already point at the unchanged final path.
}
function Remove-TransactionDirectory([string]$directory, [string]$digest, [string]$preservedAt) {
  if (!(Test-Path -LiteralPath $directory)) { return }
  Assert-TransactionDirectory $directory
  $entries = @(Get-ChildItem -LiteralPath $directory -Force)
  if ($entries.Count -eq 1 -and $entries[0].Name -eq '.mizar-update-owner') {
    Remove-Item -LiteralPath $directory -Recurse -Force
    return
  }
  # The authenticated manifest identifies owned files even after partial extraction.
  # Recovery verifies payload bytes separately before using a directory as a program.
  [void](Read-PayloadRecords $directory $digest)
  $managed = Product-Paths $directory
  $prefix = $directory.TrimEnd('\') + '\'
  $files = @(Get-ChildItem -LiteralPath $directory -Recurse -Force -File)
  # First prove every extra file is retained in the current installation.
  # If another program wrote anything new here, leave the directory untouched.
  foreach ($file in $files) {
    $relative = $file.FullName.Substring($prefix.Length)
    if ($managed.Contains($relative)) { continue }
    $retained = Join-Path $preservedAt $relative; Assert-PlainPath $retained
    if (!(Test-Path -LiteralPath $retained -PathType Leaf) -or
      [MizarUpdateFiles]::Hash($file.FullName) -ne [MizarUpdateFiles]::Hash($retained)) { throw 'update_cleanup_unknown_file' }
  }
  # Paths were checked above, including the absence of reparse points.
  Remove-Item -LiteralPath $directory -Recurse -Force
}
function Trim-CompletedRecords {
  $finished = @()
  $updates = Join-Path $plan.stateRoot 'updates'
  $runOnce = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name '!MizarUpdateRecovery' -ErrorAction SilentlyContinue).'!MizarUpdateRecovery'
  $allowed = @('plan.json', 'journal.json', 'result.json', 'registration.json', 'update-install.ps1', 'Restore-Mizar.cmd',
    'update-activity.ndjson', 'update-activity.ndjson.previous', 'installer.log', 'install-timings.json', 'recover-timings.json',
    'rollback-timings.json', 'finalize-timings.json')
  foreach ($entry in (Get-ChildItem -LiteralPath $updates -Directory)) {
    if ($entry.Name -notmatch '^install-[a-f0-9]{32}$' -or $entry.FullName -eq $StageRoot) { continue }
    try {
      Assert-PlainPath $entry.FullName
      if ($runOnce -and $runOnce.Contains($entry.FullName)) { continue }
      $oldPlan = Read-HandoffJson (Join-Path $entry.FullName 'plan.json')
      $oldJournal = Read-HandoffJson (Join-Path $entry.FullName 'journal.json')
      $oldResult = Read-HandoffJson (Join-Path $entry.FullName 'result.json')
      if ($oldPlan.transactionProtocol -ne 'mizar.directory-swap.v1' -or $oldPlan.bundleRoot -ne $plan.bundleRoot -or
        $oldPlan.stateRoot -ne $plan.stateRoot -or $oldJournal.phase -ne 'committed' -or
        $oldResult.status -ne 'installed' -or $oldResult.recoveryDirectory -ne $entry.Name) { continue }
      $remaining = $false
      foreach ($kind in @('restore', 'candidate', 'failed')) {
        if (Test-Path -LiteralPath ($plan.bundleRoot + '.mizar-' + $kind + '-' + $entry.Name)) { $remaining = $true }
      }
      if ($remaining) { continue }
      $prefix = $entry.FullName + '\'
      foreach ($item in (Get-ChildItem -LiteralPath $entry.FullName -Recurse -Force)) {
        Assert-PlainPath $item.FullName
        $relative = $item.FullName.Substring($prefix.Length)
        if ($item.PSIsContainer -or $relative -notin $allowed) { $remaining = $true }
      }
      if (!$remaining) { $finished += $entry }
    } catch { Record-UpdateActivity 'history_cleanup_retained' $_.ToString() }
  }
  # Keep the current record and nine prior successful records; unknown, failed
  # and recoverable transactions do not qualify for automatic deletion.
  foreach ($entry in @($finished | Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 9)) {
    Remove-Item -LiteralPath $entry.FullName -Recurse -Force
  }
}
function Remove-StagedPayload {
  foreach ($name in @('Installer.exe', 'Mizar.lnk', '卸载 Mizar.lnk')) {
    $path = Join-Path $StageRoot $name; Assert-PlainPath $path
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  }
}
function Install-StartMenu {
  # NSIS prepares the links. Publish only missing entries after completion.
  $menu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Mizar'
  try {
    Assert-PlainPath $menu
    [IO.Directory]::CreateDirectory($menu) | Out-Null
    foreach ($name in @('Mizar.lnk', '卸载 Mizar.lnk')) {
      $path = Join-Path $menu $name; Assert-PlainPath $path
      $prepared = Join-Path $StageRoot $name; Assert-PlainPath $prepared
      if (!(Test-Path -LiteralPath $prepared)) { continue }
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $prepared -Force }
      else { [IO.File]::Move($prepared, $path) }
    }
  } catch { Record-UpdateActivity 'shortcut_creation_failed' $_.ToString() }
}
function Complete-Cleanup {
  $previous = Previous-Directory
  if (Test-Path -LiteralPath $previous) { Remove-TransactionDirectory $previous $plan.previousContentDigest $plan.bundleRoot }
  foreach ($download in @((Join-Path $StageRoot 'Installer.exe'), $plan.installer)) {
    Assert-PlainPath $download
    if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force }
  }
  if (!$plan.previousContentDigest) { Install-StartMenu }
  Record-UpdateActivity 'finalized'
  Trim-CompletedRecords
}
function Start-VerifiedInstallation {
  $script:startupConfirmed = $false
  Update-WindowPhase 'starting-program'
  Record-UpdateActivity 'starting-program'
  $name = 'Local\MizarUpdateStarted-' + [guid]::NewGuid().ToString('N')
  $started = [Threading.EventWaitHandle]::new($false, [Threading.EventResetMode]::ManualReset, $name)
  $saved = $env:MIZAR_UPDATE_READY_EVENT
  try {
    $env:MIZAR_UPDATE_READY_EVENT = $name
    $script:launchedProcess = Start-Process -FilePath (Join-Path $plan.bundleRoot 'Mizar.exe') -WorkingDirectory $plan.bundleRoot -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    while (!$started.WaitOne(200)) {
      if ($script:launchedProcess.HasExited) { throw 'update_start_failed' }
      if ([DateTime]::UtcNow -ge $deadline) { throw 'update_start_unconfirmed' }
    }
    if ($script:launchedProcess.HasExited) { throw 'update_start_failed' }
    $script:startupConfirmed = $true
    Record-UpdateActivity 'started'
  } finally {
    $env:MIZAR_UPDATE_READY_EVENT = $saved
    $started.Dispose()
  }
  # Startup must run without the desktop gate. Cleanup reacquires only the
  # writer, verifies this instance again, and never modifies the running root.
  $cleanupWriter = [Threading.Mutex]::new($false, 'Global\MizarUpdateWriter')
  $owned = $false
  try {
    try { $owned = $cleanupWriter.WaitOne(0) } catch [Threading.AbandonedMutexException] { $owned = $true }
    if (!$owned) { throw 'update_transaction_busy' }
    Assert-CandidateInstance
    if (!$KeepBackup) { Update-WindowPhase 'cleanup'; Complete-Cleanup }
    Recovery-Registration $false
  } finally {
    if ($owned) { $cleanupWriter.ReleaseMutex() }
    $cleanupWriter.Dispose()
  }
}
function Complete-Restore {
  Assert-PreviousInstance $plan.bundleRoot
  Record-Result $(if ($plan.previousContentDigest) { 'restored' } else { 'failed' }) 'update_rolled_back'
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'restored' }
  Remove-RecoveryOwner
  Recovery-Registration $false
  if (!$KeepBackup) {
    foreach ($directory in @((Candidate-Directory), ($plan.bundleRoot + '.mizar-failed-' + (Split-Path -Leaf $StageRoot)))) {
      try { Remove-TransactionDirectory $directory $plan.contentDigest $plan.bundleRoot }
      catch { Record-UpdateActivity 'restore_cleanup_retained' $_.ToString() }
    }
    try { Remove-StagedPayload } catch { Record-UpdateActivity 'restore_cleanup_retained' $_.ToString() }
  }
}
function Restore-Previous {
  if ($null -ne $script:programGate) { $script:programGate.Dispose(); $script:programGate = $null }
  [void](Start-UpdateMutation)
  Update-WindowPhase 'restore-check'
  Record-UpdateActivity 'restore-check'
  Assert-Stopped
  Assert-RecoveryTarget
  # Windows refuses write access to an executable image while it is mapped.
  # Check the actual file, avoiding PID gaps and short/Unicode path aliases.
  # No bytes are written; an unreadable or still-used installer fails closed.
  try {
    $image = [IO.File]::Open((Join-Path $StageRoot 'Installer.exe'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $image.Dispose()
  } catch { throw 'update_installer_remaining' }
  $backup = Previous-Directory
  if (!$plan.previousContentDigest) {
    $failed = $plan.bundleRoot + '.mizar-failed-' + (Split-Path -Leaf $StageRoot)
    if (Test-Path -LiteralPath (Join-Path $plan.bundleRoot 'installed.flag')) {
      Assert-PlainPath $failed
      if (Test-Path -LiteralPath $failed) { throw 'update_recovery_conflict' }
      if (!(Test-Path -LiteralPath (Join-Path $plan.bundleRoot '.mizar-update-owner'))) { Create-RecoveryOwner }
      [IO.Directory]::Move($plan.bundleRoot, $failed)
    }
    Restore-Registration
    Complete-Restore
    return
  }
  $restore = $plan.bundleRoot + '.mizar-restore-' + (Split-Path $StageRoot -Leaf)
  $failed = $plan.bundleRoot + '.mizar-failed-' + (Split-Path $StageRoot -Leaf)
  Assert-PlainPath $restore; Assert-PlainPath $failed
  if (Test-Path -LiteralPath $plan.bundleRoot) {
    # A retry after a directory swap must not destroy its only failed copy.
    try { Assert-PreviousInstance $plan.bundleRoot; $alreadyRestored = $true } catch { $alreadyRestored = $false }
    if ($alreadyRestored) { Restore-Registration; Complete-Restore; return }
  }
  Assert-PreviousInstance $backup
  if ((Test-Path -LiteralPath $plan.bundleRoot) -and (Test-Path -LiteralPath $failed)) { throw 'update_recovery_conflict' }
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
  # Windows will not rename a directory while our own child-file handle is
  # open, even with FILE_SHARE_DELETE. The desktop mutex remains held.
  if ($null -ne $script:programGate) { $script:programGate.Dispose(); $script:programGate = $null }
  if (Test-Path -LiteralPath $plan.bundleRoot) {
    if (Test-Path -LiteralPath $failed) { throw 'update_recovery_conflict' }
    Move-Item -LiteralPath $plan.bundleRoot -Destination $failed
  }
  Move-Item -LiteralPath $restore -Destination $plan.bundleRoot
  Restore-Registration
  Complete-Restore
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
    $leaseParent = $null; $leaseHandle = $BootstrapLease
    if ($context.leaseParent) { $leaseParent = $context.leaseParent.process; $leaseHandle = $context.leaseParent.handle }
    elseif ($BootstrapLease -ne 0) {
      if ($context.helper) { $leaseParent = $context.helper }
      elseif ($ExpectedBootstrap) { $leaseParent = Handoff-BootstrapParent $context.caller $target '' $ExpectedBootstrap.Substring(10) }
      else { throw 'update_handoff_lease_unknown' }
    }
    $context.lease = Open-HandoffLease $leaseParent $leaseHandle
    $script:handoffHandles.Add($context.lease)
    # The NSIS process owns a duplicate until it exits, including its entire
    # marker/payload window. Parent death cannot release this file object early.
    $retainedLease = [MizarUpdateFiles]::RetainLease($context.lease, $CallerProcessId)
    $root = Invoke-LegacyHandoff $target $HandoffState '' $context
    if ($PreparePayload) {
      if (!$context.stage -or $InstallationOwner -ne (Split-Path -Leaf $context.stage)) { throw 'update_handoff_parent_unknown' }
      $binding = Handoff-Plan $context.stage $target $root
      if ($binding.transactionProtocol -ne 'mizar.directory-swap.v1') { throw 'update_install_protocol_unsupported' }
      $prepared = $target + '.mizar-candidate-' + $InstallationOwner
      Assert-PlainPath $prepared
      $preparedMarker = Join-Path $prepared '.mizar-update-owner'; Assert-PlainPath $preparedMarker
      if ((Get-Content -LiteralPath $preparedMarker -Raw) -ne $InstallationOwner -or
        @(Get-ChildItem -LiteralPath $prepared -Force).Count -ne 1) { throw 'update_stage_invalid' }
    }
    if ($ReceiptPath) {
      if ($InstallationOwner -notmatch '^[a-zA-Z0-9{}_-]{1,64}$') { throw 'update_handoff_caller_unknown' }
      $receipt = @{ schema = 'mizar.handoff.v1'; callerPid = $CallerProcessId; callerStarted = $context.caller.started; callerSha256 = [MizarUpdateFiles]::Hash($context.caller.snapshot.ExecutablePath); target = $target; state = $root; installationOwner = $InstallationOwner; leaseHandle = $retainedLease }
      Publish-HandoffRefusal $ReceiptPath ($receipt | ConvertTo-Json -Compress)
    }
    [Console]::Write($root)
    exit 0
  } catch {
    $failure = $_.ToString() + "`r`n" + $_.ScriptStackTrace + "`r`n" + $_.Exception.ToString()
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
  $previousId = $null
  if ($plan.previousContentDigest) {
    if (!(Test-Path -LiteralPath (Join-Path $plan.bundleRoot 'installed.flag'))) { throw 'update_portable_install_forbidden' }
    $previousId = [MizarUpdateFiles]::Hash((Join-Path $plan.bundleRoot 'installed.flag'))
  } else { Assert-EmptyTarget }
  Assert-Installer $plan $plan.installer
  $plan | Add-Member -NotePropertyName previousInstallationId -NotePropertyValue $previousId -Force
  $plan | Add-Member -NotePropertyName recoveryProtocol -NotePropertyValue 'mizar.install-instance.v1' -Force
  $plan | Add-Member -NotePropertyName helperSha256 -NotePropertyValue ([MizarUpdateFiles]::Hash($PSCommandPath)) -Force
  # This extraction contract first ships in 1.11.7. Never pass an unknown
  # switch to an older Setup, which would otherwise install into the live root.
  if ([version]$plan.version -lt [version]'1.11.7') { throw 'update_install_protocol_unsupported' }
  $plan | Add-Member -NotePropertyName transactionProtocol -NotePropertyValue 'mizar.directory-swap.v1' -Force
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
if ($plan.transactionProtocol -ne 'mizar.directory-swap.v1') { throw 'update_install_protocol_unsupported' }
$StageRoot = [IO.Path]::GetFullPath($StageRoot).TrimEnd('\')
if ((Split-Path -Parent $StageRoot) -ne [IO.Path]::GetFullPath((Join-Path $plan.stateRoot 'updates')).TrimEnd('\') -or
  (Split-Path -Leaf $StageRoot) -notmatch '^install-[a-f0-9]{32}$') { throw 'update_stage_invalid' }
# A process's native working directory holds a Windows directory handle. Neither
# the helper nor its children may pin the installation that rollback must rename.
Set-Location -LiteralPath $StageRoot
[Environment]::CurrentDirectory = $StageRoot
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
  if (!$NoStatusWindow -and !$script:updateWindowStarted) { [MizarUpdateWindow]::Start($StageRoot, ($Mode -eq 'Install'), $plan.version, (!$plan.previousContentDigest)); $script:updateWindowStarted = $true }
  if ($ReadyEvent) {
    if ($Mode -ne 'Install' -or $ReadyEvent -notmatch '^Global\\MizarUpdateReady-[0-9]+-[0-9]+$') { throw 'update_handoff_invalid' }
    $ready = [Threading.EventWaitHandle]::OpenExisting($ReadyEvent)
    try { [void]$ready.Set() } finally { $ready.Dispose() }
  }
  $script:handoffHandles = [Collections.Generic.List[IDisposable]]::new()
  try {
    $parent = if ($BootstrapLease -ne 0) { Handoff-BootstrapParent (Handoff-Process $PID) (Handoff-Path $plan.bundleRoot) (Handoff-Path $StageRoot) }
    $script:handoffLeaseStream = Open-HandoffLease $parent $BootstrapLease
    if ($Mode -eq 'Install') { [void](Invoke-LegacyHandoff $plan.bundleRoot $plan.stateRoot $StageRoot @{ lease = $script:handoffLeaseStream }) }
  } finally { foreach ($handle in $script:handoffHandles) { $handle.Dispose() } }
# Reject stale recovery before any registration/result write or automatic rollback.
$journal = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json
if ($Mode -in @('Recover', 'Rollback')) {
  if (Test-RestoredTransaction $journal) {
    $script:updateResultWritten = $true
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
    Complete-Cleanup
    Record-Result 'installed' 'update_completed'
    return
  }
  if ($Mode -eq 'Rollback') { Restore-Previous; return }
  if ($Mode -eq 'Recover') {
    Recovery-Registration $true
    $journal = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json
    if ($journal.phase -eq 'committed') {
      Assert-CandidateInstance
      Record-Result 'installed' 'update_completed'
      $env:MIZAR_STATE_ROOT = $plan.stateRoot
      $script:launchAfterCommit = !$NoLaunch
      if ($NoLaunch) { Recovery-Registration $false }
    } elseif ($journal.phase -eq 'prepared') {
      Assert-PreviousInstance $plan.bundleRoot
      Remove-RecoveryOwner
      # Installation never started; no need to change files or registration.
      Recovery-Registration $false
      Record-Result 'cancelled' 'update_not_started'
    } else { Restore-Previous }
    return
  }
  if ($Mode -ne 'Install' -or $HostProcessId -lt 0) { throw 'update_host_invalid' }
  Update-WindowPhase 'waiting-host'
  Record-UpdateActivity 'waiting-host'
  $deadline = [DateTime]::UtcNow.AddSeconds(60)
  while ($HostProcessId -gt 0 -and (Get-Process -Id $HostProcessId -ErrorAction SilentlyContinue)) {
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
    if ((Test-Path -LiteralPath $plan.bundleRoot) -and (Get-ChildItem -LiteralPath $plan.bundleRoot -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) { throw 'update_reparse_point' }
    Save-Registration
  }
  $candidate = Candidate-Directory
  $previous = Previous-Directory
  foreach ($directory in @($candidate, $previous)) {
    Assert-PlainPath $directory
    if (Test-Path -LiteralPath $directory) { throw 'update_recovery_conflict' }
  }
  [IO.Directory]::CreateDirectory($candidate) | Out-Null
  Create-RecoveryOwner $candidate
  Invoke-UpdatePhase 'prepare-payload' {
    $installer = Start-Process -FilePath (Join-Path $StageRoot 'Installer.exe') -WorkingDirectory $StageRoot -ArgumentList @('/S', '/MIZARUPDATE', '/MIZARPREPARE', ('/MIZAROWNER=' + (Split-Path -Leaf $StageRoot)), ('/MIZARSTATE="' + $plan.stateRoot + '"'), ('/MIZARLEASE=' + $script:handoffLeaseStream.SafeFileHandle.DangerousGetHandle().ToInt64()), ('/D=' + $plan.bundleRoot)) -PassThru
    $installer.WaitForExit()
    Record-UpdateActivity 'installer-exit' ([string]$installer.ExitCode)
    $installerLog = Join-Path $StageRoot 'installer.log'; Assert-PlainPath $installerLog
    if (Test-Path -LiteralPath $installerLog) { Record-UpdateActivity 'installer-stages' ((Get-Content -LiteralPath $installerLog -Tail 20) -join '; ') }
    if ($installer.ExitCode -eq 1) { throw 'update_installer_cancelled' }
    if ($installer.ExitCode -ne 0) { throw 'update_installer_failed' }
  }
  Invoke-UpdatePhase 'prepared-payload' { Assert-CandidateInstance $candidate }
  if ($plan.coreArchiveSha256) {
    # Resource Store retains ownership of user resources. Prepare via the verified
    # candidate before switching any program files or installation registration.
    Update-WindowPhase 'resources'
    Record-UpdateActivity 'resources'
    $node = Join-Path $candidate 'resources/runtime/node.exe'
    $bridge = Join-Path $candidate 'resources/app/dist/web-installer/installed-entry.mjs'
    $env:MIZAR_STATE_ROOT = $plan.stateRoot
    $savedNodeOptions = $env:NODE_OPTIONS; $savedNodePath = $env:NODE_PATH
    try {
      Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
      Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
      & $node $bridge $plan.version $plan.gitSha $plan.contentDigest $plan.coreArchiveSha256 $plan.installerSha256 $plan.installerBytes
      if ($LASTEXITCODE -ne 0) { throw 'update_resources_incomplete' }
    } finally { $env:NODE_OPTIONS = $savedNodeOptions; $env:NODE_PATH = $savedNodePath }
  }
  if ($plan.previousContentDigest) {
    Invoke-UpdatePhase 'preserve-extra-files' { Preserve-ExtraFiles $candidate }
    Invoke-UpdatePhase 'program-exclusion' { Assert-Stopped; $script:programGate = [MizarUpdateFiles]::ExcludeProgram((Join-Path $plan.bundleRoot 'Mizar.exe')) }
  } else { Assert-Stopped; Assert-EmptyTarget }
  if (!(Start-UpdateMutation)) { throw 'update_cancelled_before_install' }
  Recovery-Registration $true
  if ($plan.previousContentDigest) { Create-RecoveryOwner }
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'installing' }
  Invoke-UpdatePhase 'switch-program' {
    # Both fixed sibling paths are on the installation volume, even when user
    # data and the journal live elsewhere. Rename retains the verified bytes.
    Assert-TransactionDirectory $candidate
    Assert-PlainPath $previous
    # Keep the desktop gate, but release the file probe before directory rename.
    if ($null -ne $script:programGate) { $script:programGate.Dispose(); $script:programGate = $null }
    if ($plan.previousContentDigest) { [IO.Directory]::Move($plan.bundleRoot, $previous) }
    else {
      Assert-EmptyTarget
      if (Test-Path -LiteralPath $plan.bundleRoot) { [IO.Directory]::Delete($plan.bundleRoot, $false) }
    }
    [IO.Directory]::Move($candidate, $plan.bundleRoot)
  }
  Install-Registration
  Write-JsonAtomic (Join-Path $StageRoot 'journal.json') @{ phase = 'committed' }
  Remove-RecoveryOwner
  Record-Result 'installed' 'update_completed'
  if ($NoLaunch) { Recovery-Registration $false }
  if (!$KeepBackup -and $NoLaunch) { Complete-Cleanup }
  $env:MIZAR_STATE_ROOT = $plan.stateRoot
  $script:launchAfterCommit = !$NoLaunch
} catch {
  Record-UpdateActivity 'failure' ($_.ToString() + "`n" + $_.ScriptStackTrace)
  [Console]::Error.WriteLine($_.ToString())
  [Console]::Error.WriteLine($_.ScriptStackTrace)
  $code = Update-ErrorCode $_ 'update_installation_failed'
  $script:updateFailureCode = $code
  $journal = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json
  if ($Mode -eq 'Rollback' -or ($Mode -eq 'Recover' -and $journal.phase -eq 'installing')) {
    # A failed recovery is not a successful committed installation, even if
    # the candidate's bytes remain intact. Do not retry the same blocked swap.
    Record-UpdateActivity 'restore-failure' $_.Exception.ToString()
    Recovery-Registration $true
    Record-Result 'recovery-required' $code
  } elseif ($journal.phase -eq 'installing') {
    try { Restore-Previous }
    catch {
      Record-UpdateActivity 'restore-failure' ($_.ToString() + "`n" + $_.ScriptStackTrace + "`n" + $_.Exception.ToString())
      [Console]::Error.WriteLine($_.ToString())
      Recovery-Registration $true
      Record-Result 'recovery-required' (Update-ErrorCode $_ 'update_restore_failed')
    }
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
  else {
    $status = if ($code -in @('update_cancelled_before_install', 'update_installer_cancelled')) { 'cancelled' } else { 'failed' }
    Record-Result $status $code
    Recovery-Registration $false
    try { Remove-TransactionDirectory (Candidate-Directory) $plan.contentDigest $plan.bundleRoot } catch { Record-UpdateActivity 'preparation_cleanup_failed' $_.ToString() }
    if (!$KeepBackup) {
      try { Remove-StagedPayload } catch { Record-UpdateActivity 'preparation_cleanup_failed' $_.ToString() }
    }
  }
  $script:updateExitCode = 1
  return
}
} catch {
  # Entry/preflight failures happen before the inner installation handler.
  # Publish an actual failure while still owning the writer, never a cancellation.
  if ($writerOwned -and $Mode -eq 'Install') {
    $entryJournal = Read-HandoffJson (Join-Path $StageRoot 'journal.json')
    if ($entryJournal.phase -eq 'prepared') { Record-Result 'failed' (Update-ErrorCode $_ 'update_installation_failed') }
  }
  throw
} finally {
  if ($null -ne $script:programGate) { $script:programGate.Dispose(); $script:programGate = $null }
  if ($null -ne $desktop) { $desktop.Dispose() }
  if ($null -ne $active) { $active.Dispose() }
  if ($script:handoffLeaseStream) { $script:handoffLeaseStream.Dispose(); $script:handoffLeaseStream = $null }
  if ($writerOwned) { $writer.ReleaseMutex() }
  $writer.Dispose()
}
}
do {
$script:updateExitCode = 0
$script:updateFailureCode = ''
$script:updateResultWritten = $false
$script:launchAfterCommit = $false
try { Invoke-UpdateTransaction }
catch {
  $script:updateExitCode = 1
  $script:updateFailureCode = Update-ErrorCode $_ 'update_installation_failed'
  Record-UpdateActivity 'transaction_entry_failed' $_.ToString()
  [Console]::Error.WriteLine($_.ToString())
}
$result = $null
try { $result = Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'result.json') -Raw | ConvertFrom-Json } catch { }
$phase = ''
try { $phase = [string](Get-Content -Encoding UTF8 -LiteralPath (Join-Path $StageRoot 'journal.json') -Raw | ConvertFrom-Json).phase } catch { }
$currentResult = $script:updateResultWritten -and $null -ne $result -and $result.recoveryDirectory -eq (Split-Path -Leaf $StageRoot)
$status = if ($currentResult) { [string]$result.status } elseif ($phase -eq 'prepared') { if ($script:updateFailureCode) { 'failed' } else { 'cancelled' } } else { 'recovery-required' }
$code = if ($currentResult) { [string]$result.code } elseif ($phase -eq 'prepared') { 'update_not_started' } else { 'update_result_unavailable' }
if ($script:updateFailureCode -and $script:updateFailureCode -ne $code) { $code = $script:updateFailureCode + ' / ' + $code }
$canRestore = $false
# No protected writes remain; the new Host can now acquire its desktop object.
$launchFailed = $false
if ($script:launchAfterCommit) {
  try { Start-VerifiedInstallation }
  catch {
    Record-UpdateActivity 'launch_or_cleanup_failed' $_.ToString()
    $script:updateExitCode = 1
    $launchFailed = $true
    # Recovery rechecks instance ownership and process exclusion under the
    # writer. A live unconfirmed Host is preserved and reported as a blocker.
    if (!$script:startupConfirmed) {
      $Mode = 'Rollback'; $ReadyEvent = ''
      try {
        Invoke-UpdateTransaction
        $result = Get-Content -LiteralPath (Join-Path $StageRoot 'result.json') -Raw | ConvertFrom-Json
        $status = [string]$result.status; $code = [string]$result.code
        $launchFailed = $status -ne 'restored'
      } catch { Record-UpdateActivity 'startup_restore_failed' $_.ToString(); $status = 'recovery-required' }
    }
  }
}
if ($plan.previousContentDigest -and $status -eq 'recovery-required' -and $script:updateFailureCode -notmatch '^(update_recovery_(target|owner|result)_)') {
  try { Assert-PreviousInstance (Previous-Directory); $canRestore = $true } catch { Record-UpdateActivity 'backup_unavailable' $_.ToString() }
}
if ($script:updateWindowAvailable) {
  [MizarUpdateWindow]::Complete($status, $code, $false, $canRestore)
  if ($launchFailed -and $script:startupConfirmed) { [MizarUpdateWindow]::CleanupFailed() }
  elseif ($launchFailed) { [MizarUpdateWindow]::LaunchFailed() }
  elseif ($status -eq 'installed') { [MizarUpdateWindow]::CloseCompleted() }
}
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
