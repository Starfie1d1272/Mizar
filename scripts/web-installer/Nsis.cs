using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Mizar.WebInstaller {
  public sealed class FreshInstallResult {
    internal FreshInstallResult(string directory) { Directory = directory; CoreInstalled = true; }
    public string Directory { get; private set; }
    public Task RollbackAsync() { return Nsis.RollbackFreshExclusive(Directory); }
    // Core installation is never the Core + default resource completion signal.
    public bool CoreInstalled { get; private set; }
    public bool ResourcesReady { get { return false; } }
  }
  public sealed class InstallerRecoveryRequired : IOException {
    public readonly string InstallDirectory;
    public InstallerRecoveryRequired(string directory, string reason) : base(reason) { InstallDirectory = directory; }
  }
  public static class Nsis {
    static string PendingPath() {
      return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizar", "bootstrap-cache", "fresh-install.pending");
    }
    static void ValidateDestination(string directory) {
      string target = Path.GetFullPath(directory);
      string local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs") + Path.DirectorySeparatorChar;
      string qualification = Path.Combine(Path.GetTempPath(), "Mizar-WebInstaller-Qualification") + Path.DirectorySeparatorChar;
      if ((!(target.StartsWith(local, StringComparison.OrdinalIgnoreCase) || target.StartsWith(qualification, StringComparison.OrdinalIgnoreCase))) ||
          target.IndexOfAny(new char[] { '"', '\r', '\n' }) >= 0)
        throw new IOException("安装位置不受允许。");
      Downloader.NoReparse(target);
      string pending = PendingPath(); Downloader.NoReparse(pending);
      if (File.Exists(pending)) throw new IOException("前一次安装尚未确认停止，请先使用原安装器恢复；禁止并发重试。");
      if (Directory.Exists(target) || File.Exists(target)) throw new IOException("安装位置已存在，请使用既有更新或修复入口。");
      using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Mizar"))
        if (key != null) throw new IOException("检测到已有 Mizar，请使用应用内更新。");
      using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar"))
        if (key != null) throw new IOException("检测到已有 Mizar 安装登记。");
      if (Directory.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.StartMenu), "Programs", "Mizar")) ||
          File.Exists(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "Mizar.lnk")))
        throw new IOException("检测到已有 Mizar 快捷方式，请先使用原安装器修复。");
      if (Process.GetProcessesByName("Mizar").Length != 0) throw new IOException("请正常退出 Mizar 后再安装。");
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
    internal static async Task RollbackFreshExclusive(string target) {
      string leasePath = Path.Combine(Path.GetDirectoryName(PendingPath()), "fresh-install.lock");
      Downloader.NoReparse(leasePath);
      using (var lease = new FileStream(leasePath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
        string pending = PendingPath(); Downloader.NoReparse(pending);
        using (var marker = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        using (var writer = new StreamWriter(marker)) { writer.WriteLine(target); writer.Flush(); marker.Flush(true); }
        bool finished = false;
        try {
          await RollbackOwnedFresh(target, TimeSpan.FromMinutes(10));
          finished = true;
        } finally { if (finished) File.Delete(pending); }
      }
    }
    internal static async Task RollbackOwnedFresh(string target, TimeSpan deadline) {
      target = Path.GetFullPath(target); Downloader.NoReparse(target); AssertOwnedRegistration(target);
      string uninstaller = Path.Combine(target, "Uninstall.exe"); Downloader.NoReparse(uninstaller);
      if (!File.Exists(uninstaller)) {
        if (!Directory.Exists(target)) return;
        throw new InstallerRecoveryRequired(target, "未生成原卸载器，保留未完成安装供修复。");
      }
      // This is the existing uninstaller generated by the authenticated NSIS into
      // the newly owned directory. Keep it locked against replacement while running.
      using (var locked = new FileStream(uninstaller, FileMode.Open, FileAccess.Read, FileShare.Read))
      using (var child = Process.Start(new ProcessStartInfo {
        FileName = uninstaller, Arguments = "/S _?=" + target,
        UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = target,
      })) {
        if (await Wait(child, deadline, null, CancellationToken.None) != 0)
          throw new InstallerRecoveryRequired(target, "原卸载器未完成，保留现场供修复。");
      }
      // _?= runs in place, so Windows may keep the generated uninstaller itself.
      if (File.Exists(uninstaller)) File.Delete(uninstaller);
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
    static System.Collections.Generic.SortedDictionary<string,string> VerifiedRuntime(Plan plan, string target) {
      plan.Validate();
      if (!plan.allowExecute || plan.kind != "nsis-setup") throw new IOException("缺少固定核心授权。");
      target=Path.GetFullPath(target); Downloader.NoReparse(target); AssertOwnedRegistration(target);
      if (!File.Exists(Path.Combine(target,"installed.flag"))) throw new IOException("核心尚未安装。");
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
      if(!entries.ContainsKey(entryName)) throw new IOException("此 Core 缺少在线安装入口，请使用完整离线安装或新版 Core。");
      foreach(string name in new[]{"resources/runtime/node.exe",entryName,"resources/app/dist/web-installer/cancel-control.mjs","resources/scripts/product-runtime.mjs","resources/scripts/product-logs.mjs","Mizar.exe"}) {
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
      if(Process.GetProcessesByName("Mizar").Length!=0) throw new IOException("请正常退出 Mizar 后再准备素材。");
      var expected=VerifiedRuntime(plan,target);
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
        FileName=node, Arguments="\""+entry+"\" "+plan.version+" "+plan.gitSha+" "+plan.contentDigest,
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
      Downloader.NoReparse(installer); ValidateDestination(destination); token.ThrowIfCancellationRequested();
      string leaseDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizar", "bootstrap-cache");
      Downloader.NoReparse(leaseDirectory); Directory.CreateDirectory(leaseDirectory);
      string leasePath = Path.Combine(leaseDirectory, "fresh-install.lock"); Downloader.NoReparse(leasePath);
      // File leases survive async continuations without thread-owned Mutex semantics.
      using (var lease = new FileStream(leasePath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
          ValidateDestination(destination);
          using (var locked = new FileStream(installer, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true)) {
            if (!await Downloader.MatchesStream(locked, plan, token)) throw new IOException("安装文件已变化。");
            token.ThrowIfCancellationRequested();
            string pending = PendingPath(); Downloader.NoReparse(pending);
            // A crash or timeout must not release the right to launch a second NSIS.
            // This marker is cleared only after the writer and required cleanup stop.
            using (var marker = new FileStream(pending, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (var writer = new StreamWriter(marker)) { writer.WriteLine(destination); writer.Flush(); marker.Flush(true); }
            bool finished = false;
            try {
            int code;
            using (var child = Process.Start(new ProcessStartInfo {
              FileName = installer, Arguments = "/S /MIZARUPDATE /D=" + destination,
              UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(installer),
            })) {
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
            } catch (Exception error) { validationFailure = error; }
            if (validationFailure != null) {
              await RollbackOwnedFresh(destination, deadline ?? TimeSpan.FromMinutes(10));
              finished = true;
              throw validationFailure;
            }
            finished = true;
            return new FreshInstallResult(destination);
            } finally { if (finished) File.Delete(pending); }
          }
      }
    }
  }
}
