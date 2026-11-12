using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Mizar.WebInstaller {
  public sealed class InstallerRecoveryRequired : IOException {
    public readonly string InstallDirectory;
    public InstallerRecoveryRequired(string directory, string reason, Exception cause=null) : base(reason,cause) { InstallDirectory = directory; }
  }
  public sealed class InstallerActionRequired : IOException {
    public readonly bool CanRetry;
    public InstallerActionRequired(string message,bool canRetry=false,Exception cause=null) : base(message,cause) { CanRetry=canRetry; }
  }
  internal sealed class PendingInstall {
    public string schemaVersion, target, planSha256, bootstrapSha256, stage, updateStage, updatePlanSha256, updateScriptSha256;
    public int ownerPid, writerPid;
    public long ownerStarted, writerStarted;
  }
  public static class Nsis {
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
    internal static PendingInstall NewPending(Plan plan, string target) {
      using (var process = Process.GetCurrentProcess()) return new PendingInstall {
        schemaVersion="mizar.bootstrap-pending.v1", target=target,
        planSha256=PlanHash(plan), bootstrapSha256=Hash(process.MainModule.FileName),
        ownerPid=process.Id, ownerStarted=process.StartTime.ToUniversalTime().Ticks, stage="prepared",
      };
    }
    internal static bool ProcessStillActive(int pid, long started) {
      if (pid <= 0 || started <= 0) throw new IOException("安装进程记录损坏，保留现场。");
      try { using (var process = Process.GetProcessById(pid)) return !process.HasExited && process.StartTime.ToUniversalTime().Ticks == started; }
      catch (ArgumentException) { return false; }
      // Access failure is unknown, never evidence that a writer has stopped.
    }
    internal static PendingInstall RecoverPending(Plan plan, string target, FileStream lease) {
      string path = PendingPath(); Downloader.NoReparse(path);
      if (!File.Exists(path)) return null;
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
        return RecoverUpdate(target,record,lease);
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
      directory=(directory ?? "").Trim();
      if(!System.Text.RegularExpressions.Regex.IsMatch(directory,@"^[A-Za-z]:[\\/]")) throw new InstallerActionRequired("请输入含盘符的完整安装路径，例如 D:\\Mizar；不支持相对路径或网络目录。");
      if(System.Text.RegularExpressions.Regex.IsMatch(directory,@"%[^%]+%")) throw new InstallerActionRequired("请填写实际安装路径，不支持环境变量；也可点击「更改」选择目录。");
      string target;
      try {target=Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar);}
      catch(Exception error) {if(!(error is ArgumentException) && !(error is NotSupportedException) && !(error is PathTooLongException)) throw;throw new InstallerActionRequired("安装路径格式有误，请删除非法字符或缩短路径后重试。",true,error);}
      AssertSafeSelection(target);
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
    static string NativeScript() { using(var input=System.Reflection.Assembly.GetExecutingAssembly().GetManifestResourceStream("update-install.ps1")) {if(input==null) throw new IOException("缺少更新恢复入口。");using(var bytes=new MemoryStream()) {input.CopyTo(bytes);return new System.Text.UTF8Encoding(false,true).GetString(bytes.ToArray());}} }
    static string NativeScriptHash() {using(var hash=System.Security.Cryptography.SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(new System.Text.UTF8Encoding(false).GetBytes(NativeScript()))).Replace("-","").ToLowerInvariant();}
    static async Task<string> Native(string script,string arguments,FileStream lease=null,PendingInstall record=null,IProgress<string> progress=null,CancellationToken token=default(CancellationToken)) {
      if(lease!=null) arguments+=" -BootstrapLease "+lease.SafeFileHandle.DangerousGetHandle().ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture);
      var start=new ProcessStartInfo {FileName=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe"),Arguments="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+script+"\" "+arguments+" -NoStatusWindow",UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true};
      start.EnvironmentVariables.Remove("PSModulePath");
      using(var scriptLock=new FileStream(script,FileMode.Open,FileAccess.Read,FileShare.Read)) {
      AssertLocked(scriptLock,NativeScriptHash());
      if(record!=null) {record.stage="update-launching";record.writerPid=0;record.writerStarted=0;SavePending(record,false);}
      using(var child=Process.Start(start)) {
        if(record!=null) {record.writerPid=child.Id;record.writerStarted=child.StartTime.ToUniversalTime().Ticks;record.stage="update-writing";SavePending(record,false);}
        var output=child.StandardOutput.ReadToEndAsync();var errors=child.StandardError.ReadToEndAsync();
        int code; try {code=await Wait(child,TimeSpan.FromMinutes(10),progress,token);} catch(TimeoutException error) {throw new InstallerRecoveryRequired(record==null ? script : record.target,error.Message,error);}
        string text=await output;string diagnostic=await errors;
        if(code==0 && diagnostic.Length>0) Window.SaveDiagnostic(new IOException("Native update warnings:\r\n"+diagnostic));
        if(code!=0) throw NativeFailure(arguments,diagnostic,new IOException("Exit code: "+code+"\r\nstdout:\r\n"+text+"\r\nstderr:\r\n"+diagnostic));
        return text.Trim().TrimStart('\uFEFF');
      }
      }
    }
    internal static InstallerActionRequired NativeFailure(string arguments,string diagnostic,Exception cause) {
      if(diagnostic.Contains("update_handoff_")) return new InstallerActionRequired("旧安装恢复入口尚未安全交接。请保留恢复资料，正常退出旧工具和轻量安装器后，使用正式完整安装包。",false,cause);
      if(diagnostic.Contains("resource_path_unsafe")) return new InstallerActionRequired("素材目录安全检查未通过。请从正常桌面环境重新打开安装器；原程序和现场已保留。",false,cause);
      if(diagnostic.Contains("update_resources_incomplete")) return new InstallerActionRequired("素材准备未完成。请查看或导出诊断，核对网络、缓存目录权限与剩余空间；也可使用正式完整离线包。",true,cause);
      if(diagnostic.Contains("update_process_remaining") || diagnostic.Contains("update_service_remaining") || diagnostic.Contains("update_host_exit_timeout")) return new InstallerActionRequired("Mizar 或原更新进程仍在运行。请正常退出后重新打开安装器。",true,cause);
      if(diagnostic.Contains("update_installer_corrupt")) return new InstallerActionRequired("安装文件验证未通过。请重新下载官方轻量安装器后重试。",false,cause);
      if(diagnostic.Contains("update_payload_") || diagnostic.Contains("update_reparse_point") || diagnostic.Contains("update_registration_snapshot_invalid")) return new InstallerActionRequired("原安装文件或恢复记录未通过验证。请保留安装目录并使用原恢复入口；需要协助时导出诊断。",false,cause);
      if(diagnostic.Contains("update_installer_cancelled")) return new InstallerActionRequired("安装已取消，可以重新开始。",true,cause);
      string phase=arguments.Contains("-Mode Prepare") ? "安装准备" : arguments.Contains("-Mode Install") ? "安装" : arguments.Contains("-Mode Finalize") ? "安装清理" : "安装恢复";
      return new InstallerActionRequired(phase+"未完成。请查看或导出诊断后处理；"+(arguments.Contains("-Mode Finalize") ? "安装状态须重新核对，剩余恢复资料已保留。" : "原程序与现场已保留。"),false,cause);
    }
    static void AssertUpdate(PendingInstall record) {
      string root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Mizar","updates");
      Downloader.NoReparse(record.updateStage);
      var binding=Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(Path.Combine(record.updateStage,"plan.json")));
      if(Convert.ToString(binding["bundleRoot"])!=record.target || Convert.ToString(binding["stateRoot"])!=Path.GetDirectoryName(root)) throw new InstallerRecoveryRequired(record.target,"恢复计划目标不一致，保留现场。");
      if(Path.GetDirectoryName(record.updateStage)!=root || !System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(record.updateStage),"^install-[a-f0-9]{32}$") || Hash(Path.Combine(record.updateStage,"plan.json"))!=record.updatePlanSha256 || Hash(Path.Combine(record.updateStage,"update-install.ps1"))!=record.updateScriptSha256 || record.updateScriptSha256!=NativeScriptHash()) throw new InstallerRecoveryRequired(record.target,"更新恢复记录不完整，保留现场。");
    }
    static PendingInstall RecoverUpdate(string target,PendingInstall record,FileStream lease) {
      if(record.target!=target || ProcessStillActive(record.ownerPid,record.ownerStarted)) throw new InstallerRecoveryRequired(target,"前一次更新尚未确认结束，请关闭旧安装器后再试。");
      AssertUpdate(record);
      bool notStarted=record.stage=="update-prepared" && record.writerPid==0 && record.writerStarted==0;
      if(!notStarted && (record.writerPid<=0 || ProcessStillActive(record.writerPid,record.writerStarted))) throw new InstallerRecoveryRequired(target,"前一次安装仍在写入或状态无法确认，请保留现场并导出诊断。");
      using(var process=Process.GetCurrentProcess()) {record.ownerPid=process.Id;record.ownerStarted=process.StartTime.ToUniversalTime().Ticks;}
      SavePending(record,false);
      Native(Path.Combine(record.updateStage,"update-install.ps1"),"-Mode Recover -StageRoot \""+record.updateStage+"\" -NoLaunch -KeepBackup",lease,record).GetAwaiter().GetResult();
      var journal=Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(Path.Combine(record.updateStage,"journal.json")));
      if(Convert.ToString(journal["phase"])=="committed") return record;
      File.Delete(PendingPath()); return null;
    }
    static async Task RollbackUpdateOwned(PendingInstall record,FileStream lease) {
      AssertUpdate(record);
      await Native(Path.Combine(record.updateStage,"update-install.ps1"),"-Mode Rollback -StageRoot \""+record.updateStage+"\"",lease,record);
      if(File.Exists(PendingPath())) File.Delete(PendingPath());
    }
    static async Task FinalizeUpdate(Plan plan,PendingInstall record,FileStream lease) {
        if(record.planSha256!=PlanHash(plan) || record.writerPid<=0 || ProcessStillActive(record.writerPid,record.writerStarted)) throw new InstallerRecoveryRequired(record.target,"安装清理条件无法确认，保留恢复资料。");
        AssertUpdate(record);
        using(var process=Process.GetCurrentProcess()) {record.ownerPid=process.Id;record.ownerStarted=process.StartTime.ToUniversalTime().Ticks;}
        record.stage="update-finalizing";SavePending(record,false);
        await Native(Path.Combine(record.updateStage,"update-install.ps1"),"-Mode Finalize -StageRoot \""+record.updateStage+"\"",lease,record);
        File.Delete(PendingPath());
    }
    static async Task<PendingInstall> InstallPayload(Plan plan,string installer,string target,IProgress<string> progress,CancellationToken token,FileStream lease) {
      if(Process.GetProcessesByName("Mizar").Length!=0) throw new InstallerActionRequired("请正常退出 Mizar 后重试安装。",true);
      string digest=null;
      if(File.Exists(Path.Combine(target,"installed.flag"))) {
        string artifactPath=Path.Combine(target,"resources","metadata","artifact.json");Downloader.NoReparse(artifactPath);
        if(new FileInfo(artifactPath).Length>65536) throw new InstallerActionRequired("原安装身份无法确认，请使用完整安装包修复。");
        var artifact=Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(artifactPath));
        string version=Convert.ToString(artifact["appVersion"]);
        digest=Convert.ToString(artifact["artifactSha256"]);
        if(!System.Text.RegularExpressions.Regex.IsMatch(version??"",@"^\d+\.\d+\.\d+$") || !System.Text.RegularExpressions.Regex.IsMatch(digest??"","^[a-f0-9]{64}$") || new Version(version)>new Version(plan.version)) throw new InstallerActionRequired("原安装版本无法确认或比安装器更新，请使用对应版本安装器。");
      } else if(File.Exists(target) || (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length!=0)) throw new InstallerActionRequired("该目录已有文件，请选择空目录。",true);
      if(progress!=null) progress.Report("preparing-update");
      string state=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Mizar"), work=Path.Combine(state,"updates","download-"+Guid.NewGuid().ToString("N"));
      Downloader.NoReparse(work);Directory.CreateDirectory(work);
      string backend=Path.Combine(work,plan.name);File.Copy(installer,backend,false);
      string script=Path.Combine(work,"update-install.ps1");File.WriteAllText(script,NativeScript(),new System.Text.UTF8Encoding(false));
      var nativePlan=new System.Collections.Generic.Dictionary<string,object> {{"schemaVersion",1},{"bundleRoot",target},{"stateRoot",state},{"installer",backend},{"installerSha256",plan.sha256},{"installerBytes",plan.bytes},{"previousContentDigest",digest},{"contentDigest",plan.contentDigest},{"version",plan.version},{"gitSha",plan.gitSha}};
      bool core=plan.name.EndsWith("-Core-Setup.exe",StringComparison.Ordinal);if(core) nativePlan.Add("coreArchiveSha256",plan.coreSha256);
      string path=Path.Combine(work,"plan.json");File.WriteAllText(path,Serializer().Serialize(nativePlan),new System.Text.UTF8Encoding(false));
      string prepared=await Native(script,"-Mode Prepare -PlanPath \""+path+"\"");
      var info=Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(prepared);
      var record=NewPending(plan,target);record.updateStage=Convert.ToString(info["stageRoot"]);record.updatePlanSha256=Hash(Path.Combine(record.updateStage,"plan.json"));record.updateScriptSha256=Hash(Path.Combine(record.updateStage,"update-install.ps1"));record.stage="update-prepared";SavePending(record,true);
      Exception failure=null;
      try {
        if(progress!=null) progress.Report("installing-core");
        await Native(script,"-Mode Install -StageRoot \""+record.updateStage+"\" -NoLaunch -KeepBackup",lease,record,progress,token);
        if(token.IsCancellationRequested) {await RollbackUpdateOwned(record,lease);token.ThrowIfCancellationRequested();}
        return record;
      } catch(Exception original) {failure=original;}
      // The installed .NET Framework compiler is C# 5: recovery awaits belong outside catch.
      if(File.Exists(PendingPath()) && record.writerPid>0 && !ProcessStillActive(record.writerPid,record.writerStarted)) {
        try {
          string resultPath=Path.Combine(record.updateStage,"result.json");Downloader.NoReparse(resultPath);
          var result=File.Exists(resultPath) ? Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(resultPath)) : null;
          if(result==null || Convert.ToString(result["status"])=="recovery-required") await Native(Path.Combine(record.updateStage,"update-install.ps1"),"-Mode Recover -StageRoot \""+record.updateStage+"\" -NoLaunch",lease,record);
          var journal=Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(File.ReadAllText(Path.Combine(record.updateStage,"journal.json")));
          if(Convert.ToString(journal["phase"])!="committed") File.Delete(PendingPath());
        }
        catch(Exception recovery) {throw new InstallerRecoveryRequired(target,"更新及自动恢复未完成。请保留现场，关闭旧安装器后重新打开以恢复。",new AggregateException(failure,recovery));}
      }
      System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(failure).Throw();
      throw new InvalidOperationException("Unreachable");
    }
    static void AssertLocked(FileStream file,string expected) {
      file.Position=0;
      using(var hash=System.Security.Cryptography.SHA256.Create())
        if(BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant()!=expected) throw new IOException("安装执行文件已改变。");
    }
    internal static void StartProduct(string target) {
      string executable=Path.Combine(target,"Mizar.exe");Downloader.NoReparse(executable);
      Process.Start(new ProcessStartInfo {FileName=executable,WorkingDirectory=target,UseShellExecute=false});
    }
    public static async Task<string> Install(Plan plan, string installer, string destination,
      CancellationToken token, IProgress<string> progress = null) {
      plan.Validate();
      if (!plan.allowExecute || plan.kind != "nsis-setup") throw new IOException("缺少固定安装授权。");
      installer = Path.GetFullPath(installer); destination = Path.GetFullPath(destination);
      Downloader.NoReparse(installer); AssertAllowedTarget(destination); token.ThrowIfCancellationRequested();
      string leaseDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizar", "bootstrap-cache");
      Downloader.NoReparse(leaseDirectory); Directory.CreateDirectory(leaseDirectory);
      string leasePath = Path.Combine(leaseDirectory, "fresh-install.lock"); Downloader.NoReparse(leasePath);
      // The helper and NSIS retain this same file lease until their writers exit.
      using (var lease = new FileStream(leasePath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
        var record=RecoverPending(plan,destination,lease) ?? await InstallPayload(plan,installer,destination,progress,token,lease);
        await FinalizeUpdate(plan,record,lease);
        return destination;
      }
    }
  }
}
