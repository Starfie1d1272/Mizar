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
    public Task RollbackAsync() { return Nsis.RollbackFreshExclusive(Directory, record); }
    // Core installation is never the Core + default resource completion signal.
    public bool CoreInstalled { get; private set; }
    public bool ResourcesReady { get { return false; } }
  }
  public sealed class InstallerRecoveryRequired : IOException {
    public readonly string InstallDirectory;
    public InstallerRecoveryRequired(string directory, string reason) : base(reason) { InstallDirectory = directory; }
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
    public string schemaVersion, target, token, planSha256, bootstrapSha256, installer, stage;
    public int ownerPid, writerPid;
    public long ownerStarted, writerStarted;
  }
  public static class Nsis {
    const string OwnershipName = ".mizar-bootstrap-owner";
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
        if (record.target != target || ProcessStillActive(record.ownerPid, record.ownerStarted)) throw new IOException("旧安装操作仍活跃或目标不同。");
        if ((new [] {"writing", "complete", "quarantined"}.Contains(record.stage) && (record.writerPid <= 0 || record.writerStarted <= 0)) || record.stage == "launching" || (record.writerPid > 0 && ProcessStillActive(record.writerPid, record.writerStarted))) throw new IOException("无法证明旧写入已结束。");
        if (!new [] {"prepared", "writing", "complete", "quarantined"}.Contains(record.stage)) throw new IOException("安装阶段无效。");
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
        throw new InstallerRecoveryRequired(target, "不能安全恢复该记录；现场保持原样。" + error.Message);
      }
    }
    static void AssertAllowedTarget(string target) {
      string local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Mizar");
      string qualification = Path.Combine(Path.GetTempPath(), "Mizar-WebInstaller-Qualification") + Path.DirectorySeparatorChar;
      if (target != Path.GetFullPath(target) ||
          (!String.Equals(target, local, StringComparison.OrdinalIgnoreCase) && !target.StartsWith(qualification, StringComparison.OrdinalIgnoreCase)) ||
          target.IndexOfAny(new char[] {'"', '\r', '\n'}) >= 0) throw new IOException("安装位置不受允许。");
      Downloader.NoReparse(target);
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
      if (repairing) { AssertOwnedRegistration(target); AssertOwnedShortcuts(target); }
      if (!repairing) using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Mizar"))
        if (key != null) throw new InstallerActionRequired("检测到已有 Mizar，请使用应用内更新。");
      if (!repairing) using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar"))
        if (key != null) throw new InstallerActionRequired("检测到已有安装登记。请使用原安装器修复。");
      if (!repairing && (Directory.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Mizar")) ||
          File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Mizar.lnk"))))
        throw new InstallerActionRequired("检测到已有 Mizar 快捷方式，请先使用原安装器修复。");
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
          await RollbackOwnedFresh(target, TimeSpan.FromMinutes(10));
          finished = true;
        } finally { if (finished) File.Delete(pending); }
      }
    }
    internal static async Task RollbackOwnedFresh(string target, TimeSpan deadline) {
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
        using (var child = Process.Start(new ProcessStartInfo {
          FileName = uninstaller, Arguments = "/S _?=" + target,
          UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = target,
        })) {
          if (await Wait(child, deadline, null, CancellationToken.None) != 0)
            throw new InstallerRecoveryRequired(target, "原卸载器未完成，保留现场供修复。");
        }
      }
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
        var record = Serializer().Deserialize<PendingInstall>(File.ReadAllText(PendingPath()));
        AssertOwnedTarget(record, target); File.Delete(owner);
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
      target=Path.GetFullPath(target); Downloader.NoReparse(target); AssertOwnedRegistration(target);
      if (!File.Exists(Path.Combine(target,"installed.flag"))) throw new IOException("核心尚未安装。");
      string artifactPath=Path.Combine(target,"resources","metadata","artifact.json"); Downloader.NoReparse(artifactPath);
      if(new FileInfo(artifactPath).Length>65536) throw new IOException("核心身份超限。");
      var artifact=Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(artifactPath));
      if(Convert.ToString(artifact["repository"])!="Starfie1d1272/Mizar" || Convert.ToString(artifact["appVersion"])!=plan.version || Convert.ToString(artifact["gitSha"])!=plan.gitSha || Convert.ToString(artifact["artifactSha256"])!=plan.contentDigest) throw new IOException("核心身份不属于固定安装计划。");
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
      if(digest!=plan.contentDigest) throw new IOException("核心清单不属于固定安装计划。");
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
        string output=await stdout; await stderr;
        token.ThrowIfCancellationRequested();
        if(child.ExitCode!=0) throw new IOException("默认 EPL 素材尚未就绪；核心已保留，可重试素材或使用完整离线安装。");
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
          ValidateDestination(destination, hadPending);
          using (var locked = new FileStream(installer, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true)) {
            if (!await Downloader.MatchesStream(locked, plan, token)) throw new IOException("安装文件已变化。");
            token.ThrowIfCancellationRequested();
            string pending = PendingPath(); Downloader.NoReparse(pending);
            // A crash or timeout must not release the right to launch a second NSIS.
            // This marker is cleared only after the writer and required cleanup stop.
            var record = NewPending(plan, destination, installer);
            SavePending(record, !hadPending);
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
