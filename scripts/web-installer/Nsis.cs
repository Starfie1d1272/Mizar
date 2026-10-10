using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Mizar.WebInstaller {
  public sealed class FreshInstallResult {
    internal FreshInstallResult(string directory, PendingInstall pending) { Directory = directory; CoreInstalled = true; record = pending; }
    readonly PendingInstall record;
    public string Directory { get; private set; }
    public Task RollbackAsync() { return record.updateStage == null ? Nsis.RollbackFreshExclusive(Directory, record) : Nsis.RollbackUpdate(record); }
    // Core installation is never the Core + default resource completion signal.
    public bool CoreInstalled { get; private set; }
    public bool ResourcesReady { get { return record.updateStage != null && record.coreResourcesReady; } }
  }
  public sealed class InstallerRecoveryRequired : IOException {
    public readonly string InstallDirectory;
    public InstallerRecoveryRequired(string directory, string reason, Exception cause=null) : base(reason,cause) { InstallDirectory = directory; }
  }
  public sealed class InstallerActionRequired : IOException {
    public readonly bool CanRetry;
    public InstallerActionRequired(string message,bool canRetry=false,Exception cause=null) : base(message,cause) { CanRetry=canRetry; }
  }
  [System.Runtime.InteropServices.ComImport, System.Runtime.InteropServices.Guid("000214F9-0000-0000-C000-000000000046"), System.Runtime.InteropServices.InterfaceType(System.Runtime.InteropServices.ComInterfaceType.InterfaceIsIUnknown)]
  internal interface ShellLinkPath {
    [System.Runtime.InteropServices.PreserveSig]
    int GetPath([System.Runtime.InteropServices.Out, System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] System.Text.StringBuilder path, int capacity, IntPtr data, uint flags);
  }
  internal sealed class PendingInstall {
    public string schemaVersion, target, token, planSha256, bootstrapSha256, installer, stage, updateStage, updatePlanSha256, updateScriptSha256;
    public bool coreResourcesReady;
    public int ownerPid, writerPid;
    public long ownerStarted, writerStarted;
  }
  public static class Nsis {
    const string OwnershipName = ".mizar-bootstrap-owner";
    static string selectedDestination;
    static string Hash(string path) {
      Downloader.NoReparse(path);
      using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read))
      using (var hash = System.Security.Cryptography.SHA256.Create())
        return BitConverter.ToString(hash.ComputeHash(input)).Replace("-", "").ToLowerInvariant();
    }
    static string PlanHash(Plan plan) {
      // Only immutable Qualification inputs identify this installer transaction.
      string value = String.Join("\n", new [] {plan.version, plan.name, plan.sha256, plan.bytes.ToString(System.Globalization.CultureInfo.InvariantCulture), plan.gitSha, plan.contentDigest, plan.coreSha256});
      using (var hash = System.Security.Cryptography.SHA256.Create())
        return BitConverter.ToString(hash.ComputeHash(System.Text.Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant();
    }
    static System.Web.Script.Serialization.JavaScriptSerializer Serializer() { return new System.Web.Script.Serialization.JavaScriptSerializer {MaxJsonLength=65536}; }
    internal static void SavePending(PendingInstall record, bool create) {
      string path = PendingPath(); Downloader.NoReparse(path);
      string staging=path+".new-"+Guid.NewGuid().ToString("N"); Downloader.NoReparse(staging);
      try {
        using (var output = new FileStream(staging, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        using (var writer = new StreamWriter(output)) { writer.Write(Serializer().Serialize(record)); writer.Flush(); output.Flush(true); }
        Downloader.NoReparse(path);
        if(create) File.Move(staging,path); else File.Replace(staging,path,null);
      } finally { if(File.Exists(staging)) File.Delete(staging); }
    }
    internal static PendingInstall NewPending(Plan plan, string target, string installer) {
      using (var process = Process.GetCurrentProcess()) return new PendingInstall {
        schemaVersion="mizar.bootstrap-pending.v1", target=target, token=Guid.NewGuid().ToString("N"),
        planSha256=PlanHash(plan), bootstrapSha256=Hash(process.MainModule.FileName), installer=installer,
        ownerPid=process.Id, ownerStarted=process.StartTime.ToUniversalTime().Ticks, stage="prepared",
      };
    }
    internal static bool ProcessStillActive(int pid, long started) {
      if (pid <= 0 || started <= 0) throw new IOException("安装进程记录损坏，保留现场。");
      try { using (var process = Process.GetProcessById(pid)) return !process.HasExited && process.StartTime.ToUniversalTime().Ticks == started; }
      catch (ArgumentException) { return false; }
      // Access failure is unknown, never evidence that a writer has stopped.
    }
    static void AssertOwnedTarget(PendingInstall record, string target) {
      if ((record.target != target && target != record.target + ".incomplete-" + record.token) || !System.Text.RegularExpressions.Regex.IsMatch(record.token ?? "", "^[a-f0-9]{32}$")) throw new IOException("安装所有权记录无效。");
      string owner = Path.Combine(target, OwnershipName); Downloader.NoReparse(owner);
      if (new FileInfo(owner).Length != 32 || File.ReadAllText(owner) != record.token) throw new IOException("安装目录所有权无法确认，保留现场。");
      AssertOwnedRegistration(record.target);
    }
    internal static bool RecoverPending(Plan plan, string target) {
      string path = PendingPath(); Downloader.NoReparse(path);
      if (!File.Exists(path)) return false;
      try {
        if (new FileInfo(path).Length > 65536) throw new IOException("安装记录超限。");
        string raw = File.ReadAllText(path);
        var record = Serializer().Deserialize<PendingInstall>(raw);
        using (var process = Process.GetCurrentProcess()) {
          if (record == null || record.schemaVersion != "mizar.bootstrap-pending.v1" ||
              raw != Serializer().Serialize(record) || record.planSha256 != PlanHash(plan) ||
              record.bootstrapSha256 != Hash(process.MainModule.FileName)) throw new IOException("记录不属于当前安装器。");
        }
        AssertAllowedTarget(target);
        if (record.updateStage != null) return RecoverUpdate(plan,target,record);
        if (record.target != target || ProcessStillActive(record.ownerPid, record.ownerStarted)) throw new IOException("旧安装操作仍活跃或目标不同。");
        if ((new [] {"writing", "complete", "quarantined", "rollback-writing", "rollback-cleanup"}.Contains(record.stage) && (record.writerPid <= 0 || record.writerStarted <= 0)) || (record.stage == "launching" || record.stage == "rollback" || record.stage == "rollback-launching") || (record.writerPid > 0 && ProcessStillActive(record.writerPid, record.writerStarted))) throw new IOException("无法证明旧写入已结束。");
        if (!new [] {"prepared", "writing", "complete", "quarantined", "rollback-writing", "rollback-cleanup"}.Contains(record.stage)) throw new IOException("安装阶段无效。");
        if (record.stage == "rollback-cleanup" && !Directory.Exists(target) && !File.Exists(target)) {
          AssertOwnedRegistration(target); AssertOwnedShortcuts(target);
          using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Mizar"))
            if (key != null) throw new IOException("回滚登记仍存在。");
          File.Delete(path); return false;
        }
        if (record.stage == "prepared" && !Directory.Exists(target) && !File.Exists(target)) {
          File.Delete(path); return false; // Owner stopped before reserving a destination; no writer was launched.
        }
        string retained = target + ".incomplete-" + record.token;
        if (record.stage == "quarantined") {
          if (Directory.Exists(target) && !Directory.Exists(retained)) {
            AssertOwnedTarget(record, target); Directory.Move(target, retained);
          }
          AssertOwnedTarget(record, retained); // adjusted target checked below by paired token
          if (Directory.Exists(target) || File.Exists(target)) throw new IOException("修复目标已有未知文件。");
        } else {
          AssertOwnedTarget(record, target);
          if (record.stage == "prepared") {
            if (Directory.GetFileSystemEntries(target).Length != 1) throw new IOException("未开始事务中出现未知文件。");
            File.Delete(Path.Combine(target, OwnershipName)); Directory.Delete(target); File.Delete(path); return false;
          }
          try {
            if (record.stage.StartsWith("rollback-", StringComparison.Ordinal)) throw new IOException("继续修复已中断的回滚。");
            VerifiedRuntime(plan, target, false);
            File.Delete(path); return true;
          } catch (IOException) {
            // Preserve every byte, including unknown files. Repair uses a fresh
            // destination; no recursive delete and no unknown uninstaller execution.
            if (Directory.Exists(retained) || File.Exists(retained)) throw new IOException("保留目录已存在。");
            record.stage="quarantined"; SavePending(record, false);
            Directory.Move(target, retained);
          }
        }
        return false;
      } catch (Exception error) {
        throw new InstallerRecoveryRequired(target, "不能安全恢复该记录；现场保持原样。" + error.Message,error);
      }
    }
    static void AssertAllowedTarget(string target) {
      string local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Mizar");
      string qualification = Path.Combine(Path.GetTempPath(), "Mizar-WebInstaller-Qualification") + Path.DirectorySeparatorChar;
      if (target != Path.GetFullPath(target) ||
          (!String.Equals(target, local, StringComparison.OrdinalIgnoreCase) && !target.StartsWith(qualification, StringComparison.OrdinalIgnoreCase) && !IsRegisteredTarget(target) && !String.Equals(target,selectedDestination,StringComparison.OrdinalIgnoreCase)) ||
          target.IndexOfAny(new char[] {'"', '\r', '\n'}) >= 0) throw new IOException("安装位置不受允许。");
      if(String.Equals(target,selectedDestination,StringComparison.OrdinalIgnoreCase)) AssertSafeSelection(target);
      Downloader.NoReparse(target);
    }
    static bool IsRegisteredTarget(string target) {
      using(var key=Registry.CurrentUser.OpenSubKey(@"Software\Mizar"))
        return key!=null && String.Equals(Path.GetFullPath(Convert.ToString(key.GetValue("InstallDir"))).TrimEnd(Path.DirectorySeparatorChar),target.TrimEnd(Path.DirectorySeparatorChar),StringComparison.OrdinalIgnoreCase) && target!=Path.GetPathRoot(target);
    }
    static void AssertSafeSelection(string target) {
      string state=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Mizar");
      string windows=Environment.GetFolderPath(Environment.SpecialFolder.Windows);
      if(target==Path.GetPathRoot(target).TrimEnd(Path.DirectorySeparatorChar) || target.IndexOfAny(new[]{'"','\r','\n'})>=0 || target.StartsWith(@"\\",StringComparison.Ordinal) || String.Equals(target,state,StringComparison.OrdinalIgnoreCase) || target.StartsWith(state+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase) || String.Equals(target,windows,StringComparison.OrdinalIgnoreCase) || target.StartsWith(windows+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)) throw new InstallerActionRequired("请选择独立的安装目录，不能使用系统目录、磁盘根目录或 Mizar 数据目录。");
      Downloader.NoReparse(target);
    }
    internal static bool CanChooseDestination() {
      using(var key=Registry.CurrentUser.OpenSubKey(@"Software\Mizar")) return !HasPending() && (key==null || String.IsNullOrEmpty(Convert.ToString(key.GetValue("InstallDir"))));
    }
    internal static string SelectDestination(string directory) {
      if(!Path.IsPathRooted(directory)) throw new InstallerActionRequired("请选择完整的安装目录路径。");
      string target=Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar);AssertSafeSelection(target);
      using(var key=Registry.CurrentUser.OpenSubKey(@"Software\Mizar")) {
        string registered=key==null ? null : Convert.ToString(key.GetValue("InstallDir"));
        if(!String.IsNullOrEmpty(registered) && !String.Equals(Path.GetFullPath(registered).TrimEnd(Path.DirectorySeparatorChar),target,StringComparison.OrdinalIgnoreCase)) throw new InstallerActionRequired("升级将沿用原安装位置，请勿迁移已有安装。");
      }
      if(File.Exists(target) || (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length!=0 && !IsRegisteredTarget(target))) throw new InstallerActionRequired("该目录已有文件，请选择空目录。已有安装将沿用原位置。");
      selectedDestination=target;return target;
    }
    internal static string ResolveDestination(Plan plan=null) {
      if(plan!=null && HasPending()) {
        string path=PendingPath();
        if(new FileInfo(path).Length<=65536) {
          string raw=File.ReadAllText(path);var record=Serializer().Deserialize<PendingInstall>(raw);
          using(var process=Process.GetCurrentProcess()) {
            if(record!=null && raw==Serializer().Serialize(record) && record.schemaVersion=="mizar.bootstrap-pending.v1" && record.planSha256==PlanHash(plan) && record.bootstrapSha256==Hash(process.MainModule.FileName)) {
              // The original same-installer record authorizes its own selected destination; recovery still verifies ownership and stopped writers.
              selectedDestination=record.target;AssertAllowedTarget(record.target);return record.target;
            }
          }
        }
      }
      using(var key=Registry.CurrentUser.OpenSubKey(@"Software\Mizar")) {
        string value=key==null ? null : Convert.ToString(key.GetValue("InstallDir"));
        if(!String.IsNullOrEmpty(value)) {string target=Path.GetFullPath(value);AssertAllowedTarget(target);return target;}
      }
      return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Programs","Mizar");
    }
    internal static bool HasPending() { Downloader.NoReparse(PendingPath()); return File.Exists(PendingPath()); }
    static string PendingPath() {
      return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizar", "bootstrap-cache", "fresh-install.pending");
    }
    internal static void ValidateDestination(string directory, bool repairing = false) {
      string target = Path.GetFullPath(directory);
      AssertAllowedTarget(target);
      string pending = PendingPath(); Downloader.NoReparse(pending);
      if (File.Exists(pending) && !repairing) throw new InstallerRecoveryRequired(target,"前一次安装尚未确认停止，请使用原安装器恢复。");
      if (Directory.Exists(target) || File.Exists(target)) throw new InstallerActionRequired("安装位置已有文件。请使用既有更新或修复入口。");

      // Known same-target registration and orphan shortcuts can be repaired; other targets remain untouched.
      try { AssertOwnedRegistration(target); AssertOwnedShortcuts(target); }
      catch(IOException error) { throw new InstallerActionRequired("安装登记或快捷方式指向其他位置，请核对原安装位置后重试。",false,error); }
      if (Process.GetProcessesByName("Mizar").Length != 0) throw new InstallerActionRequired("请正常退出 Mizar 后再安装。",true);
    }
    static async Task<int> Wait(Process child, TimeSpan deadline, IProgress<string> progress, CancellationToken token) {
      var clock = Stopwatch.StartNew(); bool notified = false;
      while (!child.HasExited) {
        if (token.IsCancellationRequested && !notified) {
          notified = true; if (progress != null) progress.Report("waiting-for-installer");
          // Never terminate a writer in the middle of NSIS extraction. Cancellation
          // becomes rollback after the existing installer has safely stopped.
        }
        if (clock.Elapsed >= deadline) throw new TimeoutException("安装程序尚未退出；保留现场，禁止并发重试。");
        await Task.Delay(100).ConfigureAwait(false);
      }
      return child.ExitCode;
    }
    static void AssertOwnedRegistration(string target) {
      using (var uninstall = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar")) {
        if (uninstall != null && Convert.ToString(uninstall.GetValue("UninstallString")) != "\"" + Path.Combine(target, "Uninstall.exe") + "\"")
          throw new IOException("卸载登记已被其他安装更改，保留现场供修复。");
      }
      using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Mizar")) {
        if (key != null && !String.Equals(Path.GetFullPath(Convert.ToString(key.GetValue("InstallDir"))), target, StringComparison.OrdinalIgnoreCase))
          throw new IOException("安装登记已被其他安装更改，保留现场供修复。");
      }
    }
    static void AssertOwnedShortcuts(string target) {
      string menu=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu),"Programs","Mizar");
      Downloader.NoReparse(menu);
      if(Directory.Exists(menu) && Directory.GetFileSystemEntries(menu).Any(path=>!new[]{"Mizar.lnk","卸载 Mizar.lnk"}.Contains(Path.GetFileName(path)))) throw new IOException("开始菜单含有其他文件，保留现场。");
      var paths=new [] {Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),"Mizar.lnk"),Path.Combine(menu,"Mizar.lnk"),Path.Combine(menu,"卸载 Mizar.lnk")};
      foreach(string path in paths) {
        Downloader.NoReparse(path); if(!File.Exists(path)) continue;
        object shortcut=null;
        try {
          shortcut=Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046"),true));
          ((System.Runtime.InteropServices.ComTypes.IPersistFile)shortcut).Load(path,0);
          var raw=new System.Text.StringBuilder(32768);
          // Read the persisted target without Shell resolution, tracking or mutation.
          if(((ShellLinkPath)shortcut).GetPath(raw,raw.Capacity,IntPtr.Zero,4)!=0 || raw.Length==0) throw new IOException("无法核对原快捷方式目标，保留现场："+path);
          string destination=Environment.ExpandEnvironmentVariables(raw.ToString());
          string expected=Path.Combine(target,Path.GetFileName(path)=="卸载 Mizar.lnk" ? "Uninstall.exe" : "Mizar.exe");
          if(!Path.IsPathRooted(destination) || !String.Equals(Path.GetFullPath(destination),expected,StringComparison.OrdinalIgnoreCase)) throw new IOException("快捷方式已被其他安装更改，保留现场。");
        } finally {
          if(shortcut!=null) System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shortcut);
        }
      }
    }
    internal static async Task RollbackFreshExclusive(string target, PendingInstall record) {
      string leasePath = Path.Combine(Path.GetDirectoryName(PendingPath()), "fresh-install.lock");
      Downloader.NoReparse(leasePath);
      using (var lease = new FileStream(leasePath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
        string pending = PendingPath(); Downloader.NoReparse(pending);
        AssertOwnedTarget(record, target);
        record.stage = "rollback";
        using (var process = Process.GetCurrentProcess()) { record.ownerPid=process.Id; record.ownerStarted=process.StartTime.ToUniversalTime().Ticks; }
        SavePending(record, true);
        bool finished = false;
        try {
          await RollbackOwnedFresh(target, TimeSpan.FromMinutes(10), record);
          finished = true;
        } finally { if (finished) File.Delete(pending); }
      }
    }
    internal static async Task RollbackOwnedFresh(string target, TimeSpan deadline, PendingInstall record = null) {
      target = Path.GetFullPath(target); Downloader.NoReparse(target); AssertOwnedRegistration(target); AssertOwnedShortcuts(target);
      string uninstaller = Path.Combine(target, "Uninstall.exe"); Downloader.NoReparse(uninstaller);
      if (!File.Exists(uninstaller)) {
        if (!Directory.Exists(target)) return;
        throw new InstallerRecoveryRequired(target, "未生成原卸载器，保留未完成安装供修复。");
      }
      // This is the existing uninstaller generated by the authenticated NSIS into
      // the newly owned directory. Keep it locked against replacement while running.
      byte[] originalDigest;
      using (var locked = new FileStream(uninstaller, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        using (var hash = System.Security.Cryptography.SHA256.Create()) originalDigest = hash.ComputeHash(locked);
        if (record == null) record = Serializer().Deserialize<PendingInstall>(File.ReadAllText(PendingPath()));
        record.stage="rollback-launching"; SavePending(record, false);
        using (var child = Process.Start(new ProcessStartInfo {
          FileName = uninstaller, Arguments = "/S _?=" + target,
          UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = target,
        })) {
          record.writerPid=child.Id; record.writerStarted=child.StartTime.ToUniversalTime().Ticks; record.stage="rollback-writing"; SavePending(record, false);
          if (await Wait(child, deadline, null, CancellationToken.None) != 0)
            throw new InstallerRecoveryRequired(target, "原卸载器未完成，保留现场供修复。");
        }
      }
      record.stage="rollback-cleanup"; SavePending(record, false);
      // Process exit does not guarantee that Windows has released the executable
      // image (or its security scanner). Keep the pending marker and exclusive
      // installation lease until the same original file can be safely removed.
      var cleanupClock = Stopwatch.StartNew();
      while (File.Exists(uninstaller)) {
        Exception blocked = null;
        try {
          Downloader.NoReparse(uninstaller); AssertOwnedRegistration(target);
          using (var file = new FileStream(uninstaller, FileMode.Open, FileAccess.Read, FileShare.Read))
          using (var hash = System.Security.Cryptography.SHA256.Create())
            if (!hash.ComputeHash(file).SequenceEqual(originalDigest))
              throw new InstallerRecoveryRequired(target, "原卸载文件已变化；保留现场以便修复。");
          File.Delete(uninstaller);
        } catch (IOException error) { blocked = error; }
          catch (UnauthorizedAccessException error) { blocked = error; }
        if (blocked == null) break;
        int nativeError = blocked.HResult & 0xffff;
        if (blocked is InstallerRecoveryRequired || (nativeError != 5 && nativeError != 32 && nativeError != 33)) throw blocked;
        if (cleanupClock.Elapsed >= TimeSpan.FromSeconds(30))
          throw new InstallerRecoveryRequired(target, "系统尚未允许清理原卸载文件；保留现场以便修复。");
        await Task.Delay(100).ConfigureAwait(false);
      }
      string owner = Path.Combine(target, OwnershipName);
      if (File.Exists(owner)) {
        AssertOwnedTarget(record, target);
        if (Directory.GetFileSystemEntries(target).Length != 1) throw new InstallerRecoveryRequired(target, "仍有文件残留；保留所有权供重开修复。");
        File.Delete(owner);
      }
      if (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length == 0) Directory.Delete(target);
      AssertOwnedRegistration(target);
      using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Mizar"))
        if (key != null) throw new InstallerRecoveryRequired(target, "安装登记未清理。");
      // No recursive delete: NSIS alone owns payload removal; user assets remain outside.
      if (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length != 0)
        throw new InstallerRecoveryRequired(target, "仍有文件残留，保留现场供修复。");
    }
    // Data identity only: the fixed authenticated NSIS plan owns this Core digest.
    // Sigstore/catalog authorization remains exclusively in the installed shared SDK.
    static System.Collections.Generic.SortedDictionary<string,string> VerifiedRuntime(Plan plan, string target, bool requireBridge = true) {
      plan.Validate();
      if (!plan.allowExecute || plan.kind != "nsis-setup") throw new IOException("缺少固定核心授权。");
      return VerifiedPayload(target,plan.version,plan.gitSha,plan.contentDigest,requireBridge);
    }
    static System.Collections.Generic.SortedDictionary<string,string> VerifiedPayload(string target,string version,string gitSha,string contentDigest,bool requireBridge) {
      target=Path.GetFullPath(target); Downloader.NoReparse(target); AssertOwnedRegistration(target);
      if (!File.Exists(Path.Combine(target,"installed.flag"))) throw new IOException("核心尚未安装。");
      string artifactPath=Path.Combine(target,"resources","metadata","artifact.json"); Downloader.NoReparse(artifactPath);
      if(new FileInfo(artifactPath).Length>65536) throw new IOException("核心身份超限。");
      var artifact=Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(artifactPath));
      if(Convert.ToString(artifact["repository"])!="Starfie1d1272/Mizar" || Convert.ToString(artifact["appVersion"])!=version || Convert.ToString(artifact["gitSha"])!=gitSha || Convert.ToString(artifact["artifactSha256"])!=contentDigest) throw new IOException("核心身份不属于固定安装计划。");
      string sumsPath=Path.Combine(target,"resources","metadata","SHA256SUMS");
      Downloader.NoReparse(sumsPath);
      if (new FileInfo(sumsPath).Length>4*1024*1024) throw new IOException("核心清单超限。");
      var entries=new System.Collections.Generic.SortedDictionary<string,string>(StringComparer.Ordinal);
      foreach(string line in File.ReadAllLines(sumsPath)) {
        if(line.Length<67 || line.Substring(64,2)!="  " || !System.Text.RegularExpressions.Regex.IsMatch(line.Substring(0,64),"^[a-f0-9]{64}$")) throw new IOException("核心清单无效。");
        string name=line.Substring(66);
        if(Path.IsPathRooted(name) || name.Contains("\\") || name.Contains(":") || name.Split('/').Any(part=>part=="" || part=="." || part=="..") || entries.ContainsKey(name)) throw new IOException("核心路径无效。");
        entries.Add(name,line.Substring(0,64));
      }
      string digest;
      using(var hash=System.Security.Cryptography.SHA256.Create()) {
        foreach(var entry in entries) if(entry.Key!="resources/metadata/artifact.json") {
          var bytes=System.Text.Encoding.UTF8.GetBytes(entry.Key+"\0"+entry.Value+"\n");
          hash.TransformBlock(bytes,0,bytes.Length,bytes,0);
        }
        hash.TransformFinalBlock(new byte[0],0,0);
        digest=BitConverter.ToString(hash.Hash).Replace("-","").ToLowerInvariant();
      }
      if(digest!=contentDigest) throw new IOException("核心清单不属于固定安装计划。");
      const string entryName="resources/app/dist/web-installer/installed-entry.mjs";
      if(requireBridge && !entries.ContainsKey(entryName)) throw new IOException("此 Core 缺少在线安装入口，请使用完整离线安装或新版 Core。");
      foreach(string name in entries.Keys) {
        string expected;
        if(!entries.TryGetValue(name,out expected)) throw new IOException("核心缺少安装运行文件。");
        string path=Path.Combine(target,name.Replace('/',Path.DirectorySeparatorChar)); Downloader.NoReparse(path);
        using(var file=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.Read))
        using(var hash=System.Security.Cryptography.SHA256.Create())
          if(BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant()!=expected) throw new IOException("核心安装运行文件已改变。");
      }
      return entries;
    }
    static string NativeScript() { using(var input=System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("update-install.ps1")) {if(input==null) throw new IOException("缺少更新恢复入口。");using(var reader=new StreamReader(input)) return reader.ReadToEnd();} }
    static string NativeScriptHash() {using(var hash=System.Security.Cryptography.SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(new System.Text.UTF8Encoding(false).GetBytes(NativeScript()))).Replace("-","").ToLowerInvariant();}
    static async Task<string> Native(string script,string arguments,PendingInstall record=null,IProgress<string> progress=null,CancellationToken token=default(CancellationToken)) {
      var start=new ProcessStartInfo {FileName=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe"),Arguments="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+script+"\" "+arguments,UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
      start.EnvironmentVariables.Remove("PSModulePath");
      using(var scriptLock=new FileStream(script,FileMode.Open,FileAccess.Read,FileShare.Read)) {
      AssertLocked(scriptLock,NativeScriptHash());
      if(record!=null) {record.stage="update-launching";record.writerPid=0;record.writerStarted=0;SavePending(record,false);}
      using(var child=Process.Start(start)) {
        if(record!=null) {record.writerPid=child.Id;record.writerStarted=child.StartTime.ToUniversalTime().Ticks;record.stage="update-writing";SavePending(record,false);}
        var output=ReadBridgeOutput(child.StandardOutput);var errors=ReadBridgeOutput(child.StandardError);
        int code; try {code=await Wait(child,TimeSpan.FromMinutes(10),progress,token);} catch(TimeoutException error) {throw new InstallerRecoveryRequired(record==null ? script : record.target,error.Message);}
        string text=await output;string diagnostic=await errors;
        if(code==0 && diagnostic.Length>0) Window.SaveDiagnostic(new IOException("Native update warnings:\r\n"+diagnostic));
        if(code!=0) throw NativeFailure(arguments,diagnostic,new IOException("Exit code: "+code+"\r\nstdout:\r\n"+text+"\r\nstderr:\r\n"+diagnostic));
        return text.Trim().TrimStart('\uFEFF');
      }
      }
    }
    internal static InstallerActionRequired NativeFailure(string arguments,string diagnostic,Exception cause) {
      if(diagnostic.Contains("resource_path_unsafe")) return new InstallerActionRequired("素材目录安全检查未通过。请从正常桌面环境重新打开安装器；原程序和现场已保留。",false,cause);
      if(diagnostic.Contains("update_resources_incomplete")) return new InstallerActionRequired("素材准备未完成。请检查网络后重试；若反复失败，请导出诊断。",true,cause);
      if(diagnostic.Contains("update_process_remaining") || diagnostic.Contains("update_service_remaining") || diagnostic.Contains("update_host_exit_timeout")) return new InstallerActionRequired("Mizar 或原更新进程仍在运行。请正常退出后重新打开安装器。",true,cause);
      if(diagnostic.Contains("update_installer_corrupt")) return new InstallerActionRequired("安装文件验证未通过。请重新下载官方轻量安装器后重试。",false,cause);
      if(diagnostic.Contains("update_payload_") || diagnostic.Contains("update_reparse_point") || diagnostic.Contains("update_registration_snapshot_invalid")) return new InstallerActionRequired("原安装文件或恢复记录未通过验证。请保留安装目录并使用原恢复入口；需要协助时导出诊断。",false,cause);
      if(diagnostic.Contains("update_installer_cancelled")) return new InstallerActionRequired("安装程序已取消或失败。请导出诊断确认原因后重试。",true,cause);
      string phase=arguments.Contains("-Mode Prepare") ? "更新准备" : arguments.Contains("-Mode Install") ? "更新安装" : "安装恢复";
      return new InstallerActionRequired(phase+"未完成。请查看或导出诊断后处理；原程序与现场已保留。",false,cause);
    }
    static void AssertUpdate(PendingInstall record) {
      string root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Mizar","updates");
      Downloader.NoReparse(record.updateStage);
      var binding=Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(Path.Combine(record.updateStage,"plan.json")));
      if(Convert.ToString(binding["bundleRoot"])!=record.target || Convert.ToString(binding["stateRoot"])!=Path.GetDirectoryName(root)) throw new InstallerRecoveryRequired(record.target,"恢复计划目标不一致，保留现场。");
      if(Path.GetDirectoryName(record.updateStage)!=root || !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(record.updateStage),"^install-[a-f0-9]{32}$") || Hash(Path.Combine(record.updateStage,"plan.json"))!=record.updatePlanSha256 || Hash(Path.Combine(record.updateStage,"update-install.ps1"))!=record.updateScriptSha256 || record.updateScriptSha256!=NativeScriptHash()) throw new InstallerRecoveryRequired(record.target,"更新恢复记录不完整，保留现场。");
    }
    static bool RecoverUpdate(Plan plan,string target,PendingInstall record) {
      if(record.target!=target || ProcessStillActive(record.ownerPid,record.ownerStarted)) throw new InstallerRecoveryRequired(target,"前一次更新尚未确认结束，请关闭旧安装器后再试。");
      AssertUpdate(record);
      if(record.stage=="update-prepared" && record.writerPid==0 && record.writerStarted==0) {
        string journalPath=Path.Combine(record.updateStage,"journal.json");Downloader.NoReparse(journalPath);
        if(new FileInfo(journalPath).Length>65536 || Convert.ToString(Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(journalPath))["phase"])!="prepared") throw new InstallerRecoveryRequired(target,"准备记录与写入日志不一致，保留现场。");
        var original=Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(Path.Combine(record.updateStage,"plan.json")));
        var artifact=Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(Path.Combine(target,"resources","metadata","artifact.json")));
        VerifiedPayload(target,Convert.ToString(artifact["appVersion"]),Convert.ToString(artifact["gitSha"]),Convert.ToString(original["previousContentDigest"]),false);
        File.Delete(PendingPath());return false;
      }
      if(record.writerPid<=0 || ProcessStillActive(record.writerPid,record.writerStarted)) throw new InstallerRecoveryRequired(target,"更新启动或写入状态无法确认；请保留现场并导出诊断。");
      using(var process=Process.GetCurrentProcess()) {record.ownerPid=process.Id;record.ownerStarted=process.StartTime.ToUniversalTime().Ticks;}
      SavePending(record,false);
      Native(Path.Combine(record.updateStage,"update-install.ps1"),"-Mode Recover -StageRoot \""+record.updateStage+"\"",record).GetAwaiter().GetResult();
      File.Delete(PendingPath()); return false;
    }
    internal static async Task RollbackUpdate(PendingInstall record) {
      string leasePath=Path.Combine(Path.GetDirectoryName(PendingPath()),"fresh-install.lock");Downloader.NoReparse(leasePath);
      using(var lease=new FileStream(leasePath,FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)) {
        if(File.Exists(PendingPath())) throw new InstallerRecoveryRequired(record.target,"其他安装操作尚未结束，保留现场。");
        using(var process=Process.GetCurrentProcess()) {record.ownerPid=process.Id;record.ownerStarted=process.StartTime.ToUniversalTime().Ticks;}
        record.stage="update-rollback";SavePending(record,true);await RollbackUpdateOwned(record);
      }
    }
    static async Task RollbackUpdateOwned(PendingInstall record) {
      AssertUpdate(record);
      await Native(Path.Combine(record.updateStage,"update-install.ps1"),"-Mode Rollback -StageRoot \""+record.updateStage+"\"",record);
      if(File.Exists(PendingPath())) File.Delete(PendingPath());
    }
    static async Task<FreshInstallResult> UpdateInstalled(Plan plan,string installer,string target,IProgress<string> progress,CancellationToken token) {
      AssertOwnedRegistration(target);AssertOwnedShortcuts(target);
      if(Process.GetProcessesByName("Mizar").Length!=0) throw new InstallerActionRequired("请正常退出 Mizar 后重试更新。",true);
      string artifactPath=Path.Combine(target,"resources","metadata","artifact.json");Downloader.NoReparse(artifactPath);
      if(new FileInfo(artifactPath).Length>65536) throw new InstallerActionRequired("原安装身份无法确认，请使用完整安装包修复。");
      var artifact=Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(artifactPath));
      string version=Convert.ToString(artifact["appVersion"]),sha=Convert.ToString(artifact["gitSha"]),digest=Convert.ToString(artifact["artifactSha256"]);
      if(!System.Text.RegularExpressions.Regex.IsMatch(version??"","^\\d+\\.\\d+\\.\\d+$") || !System.Text.RegularExpressions.Regex.IsMatch(sha??"","^[a-f0-9]{40}$") || !System.Text.RegularExpressions.Regex.IsMatch(digest??"","^[a-f0-9]{64}$") || new Version(version)>new Version(plan.version)) throw new InstallerActionRequired("原安装版本无法确认或比安装器更新，请使用对应版本安装器。");
      var files=VerifiedPayload(target,version,sha,digest,false);
      foreach(string file in Directory.GetFiles(target,"*",SearchOption.AllDirectories)) {
        Downloader.NoReparse(file);string name=file.Substring(target.Length+1).Replace('\\','/');
        if(!files.ContainsKey(name) && name!="resources/metadata/SHA256SUMS" && name!="installed.flag" && name!="Uninstall.exe" && name!=OwnershipName && !name.StartsWith("state/",StringComparison.Ordinal)) throw new InstallerActionRequired("安装位置含有无法识别的文件，请先备份原安装目录后重试。");
      }
      if(progress!=null) progress.Report("preparing-update");
      string state=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Mizar"), work=Path.Combine(state,"updates","download-"+Guid.NewGuid().ToString("N"));
      Downloader.NoReparse(work);Directory.CreateDirectory(work);
      string backend=Path.Combine(work,plan.name);File.Copy(installer,backend,false);
      if(Hash(backend)!=plan.sha256) throw new IOException("安装文件已变化。");
      string script=Path.Combine(work,"update-install.ps1");File.WriteAllText(script,NativeScript(),new System.Text.UTF8Encoding(false));
      var nativePlan=new System.Collections.Generic.Dictionary<string,object> {{"schemaVersion",1},{"bundleRoot",target},{"stateRoot",state},{"installer",backend},{"installerSha256",plan.sha256},{"installerBytes",plan.bytes},{"previousContentDigest",digest},{"contentDigest",plan.contentDigest},{"version",plan.version},{"gitSha",plan.gitSha}};
      bool core=plan.name.EndsWith("-Core-Setup.exe",StringComparison.Ordinal);if(core) nativePlan.Add("coreArchiveSha256",plan.coreSha256);
      string path=Path.Combine(work,"plan.json");File.WriteAllText(path,Serializer().Serialize(nativePlan),new System.Text.UTF8Encoding(false));
      string prepared=await Native(script,"-Mode Prepare -PlanPath \""+path+"\"");
      var info=Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(prepared);
      var record=NewPending(plan,target,installer);record.updateStage=Convert.ToString(info["stageRoot"]);record.updatePlanSha256=Hash(Path.Combine(record.updateStage,"plan.json"));record.updateScriptSha256=Hash(Path.Combine(record.updateStage,"update-install.ps1"));record.stage="update-prepared";SavePending(record,true);
      Exception failure=null;
      try {
        if(progress!=null) progress.Report("installing-core");
        using(var stopped=Process.Start(new ProcessStartInfo {FileName="cmd.exe",Arguments="/c exit 0",UseShellExecute=false,CreateNoWindow=true})) {
          int pid=stopped.Id;stopped.WaitForExit();
          await Native(script,"-Mode Install -StageRoot \""+record.updateStage+"\" -HostProcessId "+pid+" -NoLaunch -KeepBackup",record,progress,token);
        }
        VerifiedRuntime(plan,target,false);record.coreResourcesReady=core;
        if(token.IsCancellationRequested) {await RollbackUpdateOwned(record);token.ThrowIfCancellationRequested();}
        File.Delete(PendingPath());return new FreshInstallResult(target,record);
      } catch(Exception original) {failure=original;}
      // The installed .NET Framework compiler is C# 5: recovery awaits belong outside catch.
      if(File.Exists(PendingPath()) && record.writerPid>0 && !ProcessStillActive(record.writerPid,record.writerStarted)) {
        try {await Native(Path.Combine(record.updateStage,"update-install.ps1"),"-Mode Recover -StageRoot \""+record.updateStage+"\"",record);File.Delete(PendingPath());}
        catch(Exception recovery) {throw new InstallerRecoveryRequired(target,"更新及自动恢复未完成。请保留现场，关闭旧安装器后重新打开以恢复。",new AggregateException(failure,recovery));}
      }
      System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
      throw new InvalidOperationException("Unreachable");
    }
    static async Task<string> ReadBridgeOutput(StreamReader reader) {
      var result=new System.Text.StringBuilder(); var buffer=new char[1024];
      for(;;) {
        int count=await reader.ReadAsync(buffer,0,buffer.Length);
        if(count==0) return result.ToString();
        if(result.Length+count>65536) throw new IOException("安装入口输出超限。");
        result.Append(buffer,0,count);
      }
    }
    internal static async Task RunResourceBridge(Plan plan,string target,CancellationToken token,IProgress<string> progress=null) {
      token.ThrowIfCancellationRequested();
      var expected=VerifyInstalledCore(plan,target);
      string entry=Path.Combine(target,"resources","app","dist","web-installer","installed-entry.mjs"), node=Path.Combine(target,"resources","runtime","node.exe");
      if(progress!=null) progress.Report("installing-resources");
      using(var nodeLock=new FileStream(node,FileMode.Open,FileAccess.Read,FileShare.Read))
      using(var entryLock=new FileStream(entry,FileMode.Open,FileAccess.Read,FileShare.Read))
      using(var controlLock=new FileStream(Path.Combine(target,"resources","app","dist","web-installer","cancel-control.mjs"),FileMode.Open,FileAccess.Read,FileShare.Read))
      using(var runtimeLock=new FileStream(Path.Combine(target,"resources","scripts","product-runtime.mjs"),FileMode.Open,FileAccess.Read,FileShare.Read))
      using(var logsLock=new FileStream(Path.Combine(target,"resources","scripts","product-logs.mjs"),FileMode.Open,FileAccess.Read,FileShare.Read)) {
        AssertLocked(nodeLock,expected["resources/runtime/node.exe"]);
        AssertLocked(entryLock,expected["resources/app/dist/web-installer/installed-entry.mjs"]);
        AssertLocked(controlLock,expected["resources/app/dist/web-installer/cancel-control.mjs"]);
        AssertLocked(runtimeLock,expected["resources/scripts/product-runtime.mjs"]);
        AssertLocked(logsLock,expected["resources/scripts/product-logs.mjs"]);
        var start=new ProcessStartInfo {
        FileName=node, Arguments="\""+entry+"\" "+plan.version+" "+plan.gitSha+" "+plan.contentDigest+" "+plan.coreSha256+" "+plan.sha256+" "+plan.bytes.ToString(System.Globalization.CultureInfo.InvariantCulture),
        UseShellExecute=false, CreateNoWindow=true, WorkingDirectory=target,
        RedirectStandardInput=true, RedirectStandardOutput=true, RedirectStandardError=true
        };
        start.EnvironmentVariables.Remove("NODE_OPTIONS"); start.EnvironmentVariables.Remove("NODE_PATH");
        using(var child=Process.Start(start)) {
        var stdout=ReadBridgeOutput(child.StandardOutput); var stderr=ReadBridgeOutput(child.StandardError);
        using(token.Register(()=>{try {child.StandardInput.WriteLine("cancel"); child.StandardInput.Flush();} catch(IOException) {} catch(InvalidOperationException) {}})) {
          try { await Wait(child,TimeSpan.FromMinutes(10),progress,token); }
          catch(TimeoutException e) { throw new InstallerRecoveryRequired(target,e.Message); }
        }
        string output=await stdout; string diagnostic=await stderr;
        if(child.ExitCode==0 && diagnostic.Length>0) Window.SaveDiagnostic(new IOException("Resource preparation warnings:\r\n"+diagnostic));
        token.ThrowIfCancellationRequested();
        if(child.ExitCode!=0) throw new IOException("默认 EPL 素材尚未就绪；核心已保留，可重试素材或使用完整离线安装。",new IOException("Exit code: "+child.ExitCode+"\r\nstdout:\r\n"+output+"\r\nstderr:\r\n"+diagnostic));
        var result=new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(output);
        var core=result["core"] as System.Collections.Generic.Dictionary<string,object>;
        if(Convert.ToString(result["schemaVersion"])!="mizar.bootstrap-result.v1" || !Object.Equals(result["coreInstalled"],true) || !Object.Equals(result["resourcesReady"],true) || core==null || Convert.ToString(core["version"])!=plan.version || Convert.ToString(core["gitSha"])!=plan.gitSha || Convert.ToString(core["contentDigest"])!=plan.contentDigest) throw new IOException("核心与素材完成身份不一致。");
        }
      }
    }
    internal static System.Collections.Generic.SortedDictionary<string,string> VerifyInstalledCore(Plan plan,string target) {
      string pending=PendingPath(); Downloader.NoReparse(pending);
      if(File.Exists(pending)) throw new InstallerRecoveryRequired(target,"前一次安装尚未确认停止，请使用原安装器恢复。");
      if(Process.GetProcessesByName("Mizar").Length!=0) throw new InstallerActionRequired("请正常退出 Mizar 后重试。",true);
      try {return VerifiedRuntime(plan,target);}
      catch(IOException error) {throw new InstallerActionRequired("已有安装无法安全继续。请使用完整离线安装包或原安装器修复。",false,error);}
    }
    static void AssertLocked(FileStream file,string expected) {
      file.Position=0;
      using(var hash=System.Security.Cryptography.SHA256.Create())
        if(BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant()!=expected) throw new IOException("安装执行文件已改变。");
    }
    internal static void StartVerifiedProduct(Plan plan,string target) {
      var expected=VerifiedRuntime(plan,target);
      string executable=Path.Combine(target,"Mizar.exe");
      using(var file=new FileStream(executable,FileMode.Open,FileAccess.Read,FileShare.Read)) {
        AssertLocked(file,expected["Mizar.exe"]);
        Process.Start(new ProcessStartInfo {FileName=executable,WorkingDirectory=target,UseShellExecute=false});
      }
    }
    public static async Task<FreshInstallResult> Install(Plan plan, string installer, string destination,
      CancellationToken token, IProgress<string> progress = null, TimeSpan? deadline = null) {
      plan.Validate();
      if (!plan.allowExecute || plan.kind != "nsis-setup") throw new IOException("缺少固定安装授权。");
      installer = Path.GetFullPath(installer); destination = Path.GetFullPath(destination);
      Downloader.NoReparse(installer); AssertAllowedTarget(destination); token.ThrowIfCancellationRequested();
      string leaseDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizar", "bootstrap-cache");
      Downloader.NoReparse(leaseDirectory); Directory.CreateDirectory(leaseDirectory);
      string leasePath = Path.Combine(leaseDirectory, "fresh-install.lock"); Downloader.NoReparse(leasePath);
      // File leases survive async continuations without thread-owned Mutex semantics.
      using (var lease = new FileStream(leasePath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
          bool hadPending = File.Exists(PendingPath());
          if (RecoverPending(plan, destination)) {
            var recovered = NewPending(plan, destination, installer);
            recovered.token=File.ReadAllText(Path.Combine(destination, OwnershipName));
            return new FreshInstallResult(destination, recovered);
          }
          if(Directory.Exists(destination) && Directory.GetFileSystemEntries(destination).Length==1 && File.Exists(Path.Combine(destination,OwnershipName))) {
            string marker=Path.Combine(destination,OwnershipName);Downloader.NoReparse(marker);
            AssertOwnedRegistration(destination);AssertOwnedShortcuts(destination);
            if(Process.GetProcessesByName("Mizar").Length!=0 || new FileInfo(marker).Length!=32 || !System.Text.RegularExpressions.Regex.IsMatch(File.ReadAllText(marker),"^[a-f0-9]{32}$")) throw new InstallerActionRequired("安装位置有无法确认的残留，请先备份该目录后重试。");
            Directory.Move(destination,destination+".retained-"+Guid.NewGuid().ToString("N"));
          }
          if(Directory.Exists(destination) && Directory.GetFileSystemEntries(destination).Length==0 && String.Equals(destination,selectedDestination,StringComparison.OrdinalIgnoreCase)) Directory.Delete(destination,false);
          if(Directory.Exists(destination)) return await UpdateInstalled(plan,installer,destination,progress,token);
          ValidateDestination(destination, hadPending);
          using (var locked = new FileStream(installer, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true)) {
            if (!await Downloader.MatchesStream(locked, plan, token)) throw new IOException("安装文件已变化。");
            token.ThrowIfCancellationRequested();
            string pending = PendingPath(); Downloader.NoReparse(pending);
            // A crash or timeout must not release the right to launch a second NSIS.
            // This marker is cleared only after the writer and required cleanup stop.
            var record = NewPending(plan, destination, installer);
            SavePending(record, !File.Exists(pending));
            string reservation=destination + ".preparing-" + record.token;
            Directory.CreateDirectory(reservation);
            using (var ownership = new FileStream(Path.Combine(reservation, OwnershipName), FileMode.CreateNew, FileAccess.Write, FileShare.None)) {
              byte[] value = System.Text.Encoding.ASCII.GetBytes(record.token); ownership.Write(value, 0, value.Length); ownership.Flush(true);
            }
            Directory.Move(reservation, destination); // Atomic refusal if an unknown destination appeared.
            bool finished = false;
            try {
            int code;
            record.stage="launching"; SavePending(record, false);
            using (var child = Process.Start(new ProcessStartInfo {
              FileName = installer, Arguments = "/S /MIZARUPDATE /D=" + destination,
              UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(installer),
            })) {
              record.writerPid=child.Id; record.writerStarted=child.StartTime.ToUniversalTime().Ticks; record.stage="writing"; SavePending(record, false);
              if (progress != null) progress.Report("installing-core");
              try { code = await Wait(child, deadline ?? TimeSpan.FromMinutes(10), progress, token); }
              catch (TimeoutException error) { throw new InstallerRecoveryRequired(destination, error.Message); }
            }
            if (code != 0 || token.IsCancellationRequested) {
              await RollbackOwnedFresh(destination, deadline ?? TimeSpan.FromMinutes(10));
              finished = true;
              token.ThrowIfCancellationRequested(); throw new IOException("核心安装未完成，原卸载器已清理本次安装。");
            }
            Exception validationFailure = null;
            try {
              AssertOwnedRegistration(destination);
              if (!File.Exists(Path.Combine(destination, "installed.flag"))) throw new IOException("核心安装未完成。");
              var json = new System.Web.Script.Serialization.JavaScriptSerializer();
              var artifact = json.Deserialize<System.Collections.Generic.Dictionary<string, object>>(File.ReadAllText(Path.Combine(destination, "resources", "metadata", "artifact.json")));
              if (Convert.ToString(artifact["repository"]) != "Starfie1d1272/Mizar" || Convert.ToString(artifact["appVersion"]) != plan.version ||
                  Convert.ToString(artifact["gitSha"]) != plan.gitSha || Convert.ToString(artifact["artifactSha256"]) != plan.contentDigest)
                throw new IOException("安装后的核心身份不匹配。");
              VerifiedRuntime(plan, destination, false);
            } catch (Exception error) { validationFailure = error; }
            if (validationFailure != null) {
              await RollbackOwnedFresh(destination, deadline ?? TimeSpan.FromMinutes(10));
              finished = true;
              throw validationFailure;
            }
            finished = true;
            return new FreshInstallResult(destination, record);
            } finally { if (finished) File.Delete(pending); }
          }
      }
    }
  }
}
