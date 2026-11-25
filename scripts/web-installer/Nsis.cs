using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

namespace Mizar.WebInstaller {
  public sealed class InstallerRecoveryRequired : IOException {
    public readonly string InstallDirectory;
    public InstallerRecoveryRequired(string directory, string reason, Exception cause = null) : base(reason, cause) { InstallDirectory = directory; }
  }
  public sealed class InstallerActionRequired : IOException {
    public readonly bool CanRetry;
    public InstallerActionRequired(string message, bool canRetry = false, Exception cause = null) : base(message, cause) { CanRetry = canRetry; }
  }

  public static class Nsis {
    static string selectedDestination;

    internal static bool IsInstalledAt(string target) {
      if (String.IsNullOrEmpty(target) || !Directory.Exists(target)) return false;
      return File.Exists(Path.Combine(target, "current.json")) || File.Exists(Path.Combine(target, "installed.flag"));
    }

    static string ActiveInstallDir() {
      using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Mizar")) {
        string value = key == null ? null : Convert.ToString(key.GetValue("InstallDir"));
        if (String.IsNullOrEmpty(value)) return null;
        string target = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar);
        if (!Directory.Exists(target)) return null;
        if (!IsInstalledAt(target) && Directory.GetFileSystemEntries(target).Length == 0) return null;
        return target;
      }
    }

    static bool IsRegisteredTarget(string target) {
      using (var key = Registry.CurrentUser.OpenSubKey(@"Software\Mizar")) {
        if (key == null) return false;
        string val = Convert.ToString(key.GetValue("InstallDir"));
        if (String.IsNullOrEmpty(val)) return false;
        return String.Equals(Path.GetFullPath(val).TrimEnd(Path.DirectorySeparatorChar), target.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase) && target != Path.GetPathRoot(target);
      }
    }

    static void AssertSafeSelection(string target) {
      string state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizar");
      string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
      if (target == Path.GetPathRoot(target).TrimEnd(Path.DirectorySeparatorChar) ||
          target.IndexOfAny(new[] { '"', '\r', '\n' }) >= 0 ||
          target.StartsWith(@"\\", StringComparison.Ordinal) ||
          String.Equals(target, state, StringComparison.OrdinalIgnoreCase) ||
          target.StartsWith(state + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) ||
          String.Equals(target, windows, StringComparison.OrdinalIgnoreCase) ||
          target.StartsWith(windows + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) {
        throw new InstallerActionRequired("请选择独立的安装目录，不能使用系统目录、磁盘根目录或 Mizar 数据目录。");
      }
      Downloader.NoReparse(target);
    }

    static void AssertAllowedTarget(string target) {
      string local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Mizar");
      string qualification = Path.Combine(Path.GetTempPath(), "Mizar-WebInstaller-Qualification") + Path.DirectorySeparatorChar;
      if (target != Path.GetFullPath(target) ||
          (!String.Equals(target, local, StringComparison.OrdinalIgnoreCase) &&
           !target.StartsWith(qualification, StringComparison.OrdinalIgnoreCase) &&
           !IsRegisteredTarget(target) &&
           !String.Equals(target, selectedDestination, StringComparison.OrdinalIgnoreCase)) ||
          target.IndexOfAny(new char[] { '"', '\r', '\n' }) >= 0) {
        throw new IOException("安装位置不受允许。");
      }
      if (String.Equals(target, selectedDestination, StringComparison.OrdinalIgnoreCase)) AssertSafeSelection(target);
      Downloader.NoReparse(target);
    }

    internal static bool CanChooseDestination() {
      return ActiveInstallDir() == null;
    }



    internal static string SelectDestination(string directory) {
      directory = (directory ?? "").Trim();
      if (!System.Text.RegularExpressions.Regex.IsMatch(directory, @"^[A-Za-z]:[\\/]"))
        throw new InstallerActionRequired("请输入含盘符的完整安装路径，例如 D:\\Mizar；不支持相对路径或网络目录。");
      if (System.Text.RegularExpressions.Regex.IsMatch(directory, @"%[^%]+%"))
        throw new InstallerActionRequired("请填写实际安装路径，不支持环境变量；也可点击「更改」选择目录。");
      string target;
      try { target = Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar); }
      catch (Exception error) {
        if (!(error is ArgumentException) && !(error is NotSupportedException) && !(error is PathTooLongException)) throw;
        throw new InstallerActionRequired("安装路径格式有误，请删除非法字符或缩短路径后重试。", true, error);
      }
      AssertSafeSelection(target);
      string active = ActiveInstallDir();
      if (active != null && !String.Equals(active, target, StringComparison.OrdinalIgnoreCase))
        throw new InstallerActionRequired("升级将沿用原安装位置，请勿迁移已有安装。");
      if (File.Exists(target) || (Directory.Exists(target) && Directory.GetFileSystemEntries(target).Length != 0 && !IsRegisteredTarget(target)))
        throw new InstallerActionRequired("该目录已有文件，请选择空目录。已有安装将沿用原位置。");
      selectedDestination = target;
      return target;
    }

    internal static string ResolveDestination(Plan plan = null) {
      string active = ActiveInstallDir();
      if (active != null) { AssertAllowedTarget(active); return active; }
      return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Mizar");
    }

    internal static void StartProduct(string target) {
      string executable = Path.Combine(target, "Mizar.exe");
      Downloader.NoReparse(executable);
      Process.Start(new ProcessStartInfo { FileName = executable, WorkingDirectory = target, UseShellExecute = false });
    }

    static string Timestamp() { return DateTime.UtcNow.ToString("yyyyMMddTHHmmssZ"); }

    static string ArchiveDirectory(string path, string suffix) {
      string dest = path + "-" + suffix + "-" + Timestamp();
      if (Directory.Exists(dest) || File.Exists(dest)) dest += "-" + Guid.NewGuid().ToString("N").Substring(0, 8);
      Directory.Move(path, dest);
      return dest;
    }

    static void AssertNoActiveMizarOrWriter(Action action) {
      if (Process.GetProcessesByName("Mizar").Length != 0) throw new InstallerActionRequired("请先正常退出 Mizar 后再试。", true);
      using (var writer = new Mutex(false, @"Global\MizarUpdateWriter")) {
        bool owned = false;
        try {
          try { owned = writer.WaitOne(0); } catch (AbandonedMutexException) { owned = true; }
          if (!owned) throw new InstallerActionRequired("另一个安装或更新操作正在进行，请先关闭后重试。", true);
          action();
        } finally { if (owned) writer.ReleaseMutex(); }
      }
    }

    internal static void RetireUpdateState() {
      AssertNoActiveMizarOrWriter(() => {
        string state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizar");
        Downloader.NoReparse(state);
        string updates = Path.Combine(state, "updates");
        if (Directory.Exists(updates)) ArchiveDirectory(updates, "retired");
        if (ActiveInstallDir() == null) Registry.CurrentUser.DeleteSubKeyTree(@"Software\Mizar", false);
      });
    }

    internal static void ResetMizarState(string target) {
      AssertNoActiveMizarOrWriter(() => {
        string state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizar");
        Downloader.NoReparse(state);
        Registry.CurrentUser.DeleteSubKeyTree(@"Software\Mizar", false);
        Registry.CurrentUser.DeleteSubKeyTree(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar", false);
        if (Directory.Exists(state)) ArchiveDirectory(state, "reset");
        if (!String.IsNullOrEmpty(target) && Directory.Exists(target) && IsInstalledAt(target)) {
          AssertSafeSelection(target);
          ArchiveDirectory(target, "mizar-reset");
        }
        selectedDestination = null;
      });
    }

    static async Task<int> RunProcessAsync(ProcessStartInfo psi, TimeSpan timeout, CancellationToken token, bool cancellable) {
      using (var child = Process.Start(psi)) {
        if (child == null) throw new IOException("无法启动安装子进程：" + psi.FileName);
        var clock = Stopwatch.StartNew();
        while (!child.HasExited) {
          if (cancellable) token.ThrowIfCancellationRequested();
          if (clock.Elapsed >= timeout) throw new TimeoutException("安装程序执行超时。");
          await Task.Delay(100).ConfigureAwait(false);
        }
        return child.ExitCode;
      }
    }

    public static async Task<string> Install(Plan plan, string installer, string destination,
      CancellationToken token, IProgress<string> progress = null) {
      plan.Validate();
      if (!plan.allowExecute || plan.kind != "nsis-setup") throw new IOException("缺少固定安装授权。");
      installer = Path.GetFullPath(installer);
      destination = Path.GetFullPath(destination);
      Downloader.NoReparse(installer);
      AssertAllowedTarget(destination);
      token.ThrowIfCancellationRequested();

      string state = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizar");
      string updatesDir = Path.Combine(state, "updates");
      Downloader.NoReparse(updatesDir);
      Directory.CreateDirectory(updatesDir);
      string extractDir = Path.Combine(updatesDir, "extract-" + Guid.NewGuid().ToString("N"));
      string resultPath = Path.Combine(updatesDir, "result-" + Guid.NewGuid().ToString("N") + ".json");
      Directory.CreateDirectory(extractDir);

      try {
        if (progress != null) progress.Report("preparing-update");
        int extractCode = await RunProcessAsync(new ProcessStartInfo {
          FileName = installer,
          Arguments = "/S /MIZAREXTRACT=\"" + extractDir + "\"",
          UseShellExecute = false,
          CreateNoWindow = true,
        }, TimeSpan.FromMinutes(5), token, true).ConfigureAwait(false);
        if (extractCode != 0) throw new InstallerActionRequired("安装包解包失败（退出码：" + extractCode + "）。", true);

        string applier = Path.Combine(extractDir, "mizar-applier.exe");
        Downloader.NoReparse(applier);
        if (!File.Exists(applier)) throw new InstallerActionRequired("安装包缺少 mizar-applier.exe，请重新下载。", false);

        if (progress != null) progress.Report("installing-core");
        string args = "install --payload-dir \"" + extractDir + "\" --install-dir \"" + destination + "\" --expected-content-digest " + plan.contentDigest + " --no-launch --result-file \"" + resultPath + "\"";
        if (plan.name.EndsWith("-Core-Setup.exe", StringComparison.Ordinal)) {
          args += " --core-archive-sha256 " + plan.coreSha256 + " --installer-sha256 " + plan.sha256 + " --installer-bytes " + plan.bytes.ToString(System.Globalization.CultureInfo.InvariantCulture);
        }

        // Applier's native window owns cancellation once launched; wait for process exit before cleanup.
        int applyCode = await RunProcessAsync(new ProcessStartInfo {
          FileName = applier,
          Arguments = args,
          UseShellExecute = false,
          CreateNoWindow = true,
        }, TimeSpan.FromMinutes(10), token, false).ConfigureAwait(false);

        if (applyCode == 0) return destination;

        string message = null;
        try {
          if (File.Exists(resultPath)) {
            var res = new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(resultPath));
            if (res != null && res.ContainsKey("message")) message = Convert.ToString(res["message"]);
          }
        } catch { }

        switch (applyCode) {
          case 10: throw new InstallerActionRequired(message ?? "另一个安装或更新操作正在进行，请稍后重试。", true);
          case 11: throw new InstallerActionRequired(message ?? "请先正常退出 Mizar 后重试安装。", true);
          case 12: throw new InstallerActionRequired(message ?? "安装包校验未通过，请重新下载官方安装包。", false);
          case 13: throw new InstallerActionRequired(message ?? "素材准备未完成。请核对网络、缓存目录权限与剩余空间，或使用正式完整离线包。", true);
          case 15: throw new InstallerActionRequired("安装已取消，可以重新开始。", true);
          default: throw new InstallerActionRequired(message ?? ("安装未完成（退出码：" + applyCode + "），请查看日志后重试。"), false);
        }
      } finally {
        try { if (Directory.Exists(extractDir)) Directory.Delete(extractDir, true); } catch { }
        try { if (File.Exists(resultPath)) File.Delete(resultPath); } catch { }
      }
    }
  }
}
