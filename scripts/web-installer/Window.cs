using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Mizar.WebInstaller {
  sealed class Window : Form {
    readonly Plan plan;
    readonly Func<IProgress<long>, IProgress<string>, CancellationToken, Task<string>> install;
    readonly Action<string> launch;
    internal readonly Label heading = new Label(), detail = new Label(), amount = new Label();
    internal readonly ProgressBar bar = new ProgressBar();
    internal readonly Button action = new Button(), cancel = new Button();
    internal readonly CheckBox launchChoice = new CheckBox();
    readonly LinkLabel details = new LinkLabel();
    internal readonly LinkLabel offlineDownload = new LinkLabel();
    const string OfflineDownloads = "https://github.com/Starfie1d1272/Mizar/releases/latest";
    const string OfflineHint = "也可点击“下载完整离线包”，在 GitHub 发布页选择完整 Setup 或离线 ZIP。";
    internal readonly TextBox destination = new TextBox();
    internal readonly Button browse = new Button(), openLocation = new Button();
    readonly Label destinationLabel = new Label();
    readonly List<string> diagnosticLog = new List<string>();
    string selectedTarget;
    CancellationTokenSource cancellation;
    string installedCore, technicalDetails, activePhase = "checking-release";
    bool finished, downloading, launchFailed;

    public Window(Plan value) : this(value, null, null, false) { }

    internal Window(
      Plan value,
      Func<IProgress<long>, IProgress<string>, CancellationToken, Task<string>> operation,
      Action<string> start,
      bool demonstration
    ) {
      plan = value;
      selectedTarget = operation == null
        ? Nsis.ResolveDestination(value)
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Mizar");
      install = operation ?? ((bytes, stages, token) => Task.Run(() => Install(bytes, stages, token)));
      launch = start ?? (path => Nsis.StartProduct(path));
      Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
      Text = demonstration ? "Mizar 安装 · 界面演示（未执行安装）" : "Mizar 安装";
      AutoScaleMode = AutoScaleMode.Dpi;
      ClientSize = new Size(590, 330);
      MinimumSize = Size;
      MaximizeBox = false;
      StartPosition = FormStartPosition.CenterScreen;
      Font = new Font("Microsoft YaHei UI", 9F);
      BackColor = Color.White;

      var banner = new Panel { Dock = DockStyle.Top, Height = 80, BackColor = Color.FromArgb(14, 24, 41) };
      var logo = Icon.ToBitmap();
      using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("brand.png")) {
        if (stream != null) using (var image = Image.FromStream(stream)) { logo.Dispose(); logo = new Bitmap(image); }
      }
      banner.Controls.Add(new PictureBox { Image = logo, SizeMode = PictureBoxSizeMode.CenterImage, Location = new Point(32, 16), Size = new Size(48, 48) });
      Disposed += (s, e) => logo.Dispose();
      banner.Controls.Add(new Label { Text = "Mizar", ForeColor = Color.White, Font = new Font("Segoe UI", 24F), AutoSize = true, Location = new Point(96, 17) });
      Controls.Add(banner);

      heading.SetBounds(32, 104, 526, 32);
      heading.Font = new Font(Font.FontFamily, 15F);
      heading.Text = "安装 Mizar";
      detail.SetBounds(32, 148, 526, 32);
      detail.Text = "欢迎使用 Mizar，安装或更新后开始准备你的比赛。";
      destinationLabel.SetBounds(32, 184, 526, 20);
      destinationLabel.Text = "安装位置";
      destination.SetBounds(32, 207, 416, 24);
      destination.ReadOnly = !(Nsis.CanChooseDestination() && !Nsis.IsInstalledAt(selectedTarget));
      destination.TabStop = !destination.ReadOnly;
      destination.TabIndex = 0;
      destination.Text = selectedTarget;
      destination.AccessibleName = "安装位置";

      browse.SetBounds(458, 204, 100, 30);
      browse.Text = "更改";
      browse.Enabled = Nsis.CanChooseDestination() && !Nsis.IsInstalledAt(selectedTarget);
      browse.TabIndex = 1;
      browse.Click += (s, e) => {
        using (var dialog = new FolderBrowserDialog { Description = "选择 Mizar 安装目录", SelectedPath = selectedTarget }) {
          if (dialog.ShowDialog(this) == DialogResult.OK) {
            try {
              selectedTarget = Nsis.SelectDestination(dialog.SelectedPath);
              destination.Text = selectedTarget;
            } catch (Exception error) {
              offlineDownload.Visible = false;
              detail.Text = error.Message;
              technicalDetails = ErrorDetails(error);
            }
          }
        }
      };

      openLocation.SetBounds(428, 198, 130, 30);
      openLocation.Text = "打开安装位置";
      openLocation.Visible = false;
      openLocation.Click += (s, e) => {
        try {
          Downloader.NoReparse(installedCore);
          if (!Directory.Exists(installedCore)) throw new IOException("安装目录已移动。");
          System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo { FileName = installedCore, UseShellExecute = true });
        } catch (Exception error) {
          detail.Text = "无法打开安装位置，请查看诊断。";
          technicalDetails = ErrorDetails(error);
        }
      };

      bar.SetBounds(32, 212, 526, 10);
      bar.Visible = false;
      amount.SetBounds(32, 232, 526, 24);
      amount.ForeColor = Color.FromArgb(80, 92, 110);
      launchChoice.SetBounds(32, 200, 220, 28);
      launchChoice.Text = "启动 Mizar";
      launchChoice.Checked = true;
      launchChoice.Visible = false;
      launchChoice.CheckedChanged += (s, e) => {
        if (finished) action.Text = launchFailed && launchChoice.Checked ? "重试启动" : "完成";
      };

      action.SetBounds(347, 270, 100, 32);
      action.Text = "安装";
      action.TabIndex = 2;
      action.Click += async (s, e) => { if (finished) Finish(); else await Start(); };

      cancel.SetBounds(458, 270, 100, 32);
      cancel.Text = "关闭";
      cancel.TabIndex = 3;
      cancel.Click += (s, e) => { if (cancellation != null) RequestCancel(); else Close(); };

      details.SetBounds(32, 278, 80, 24);
      details.Text = "详情";
      details.TabIndex = 4;
      technicalDetails = "安装文件与必要数据来自官方发布源，并在使用前验证。";
      details.LinkClicked += (s, e) => ShowDetails();

      offlineDownload.SetBounds(120, 278, 136, 24);
      offlineDownload.Text = "下载完整离线包";
      offlineDownload.Visible = false;
      offlineDownload.TabIndex = 5;
      offlineDownload.Links.Add(0, offlineDownload.Text.Length, OfflineDownloads);
      offlineDownload.LinkClicked += (s, e) => {
        try {
          System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo { FileName = OfflineDownloads, UseShellExecute = true });
        } catch (Exception error) {
          detail.Text = "下载页面未能打开，请查看详情中的下载地址。";
          technicalDetails += "\r\n完整离线包：" + OfflineDownloads + "\r\n" + RedactText(error.ToString());
        }
      };

      Controls.AddRange(new Control[] {
        heading, detail, bar, amount, launchChoice, action, cancel,
        details, offlineDownload, destinationLabel, destination, browse, openLocation
      });

      if (demonstration) {
        var marker = new Label { Text = "界面演示：未执行安装", ForeColor = Color.DarkRed, BackColor = Color.White, AutoSize = true, Location = new Point(32, 83) };
        Controls.Add(marker);
        marker.BringToFront();
      }

      AcceptButton = action;
      CancelButton = cancel;
      FormClosing += (s, e) => {
        if (cancellation != null) {
          if (activePhase != "installing-core") RequestCancel();
          e.Cancel = true;
        }
      };
    }

    void RecordDiagnostic(string entry) {
      if (String.IsNullOrEmpty(entry)) return;
      string clean = RedactText(entry);
      lock (diagnosticLog) {
        diagnosticLog.Add("[" + DateTime.UtcNow.ToString("O") + "] " + clean);
      }
    }

    async Task<string> Install(IProgress<long> bytes, IProgress<string> stages, CancellationToken token) {
      lock (diagnosticLog) { diagnosticLog.Clear(); }
      stages.Report("checking-release");
      await Publication.Verify(plan, token, RecordDiagnostic).ConfigureAwait(false);
      stages.Report("checking-installation");
      string target = selectedTarget;
      stages.Report("downloading-core");
      string installer;
      using (var handler = new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
      using (var client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan }) {
        string cache = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizar", "bootstrap-cache");
        installer = await new Downloader(client, RecordDiagnostic).Download(plan, cache, bytes, token, stages).ConfigureAwait(false);
      }
      return await Nsis.Install(plan, installer, target, token, stages).ConfigureAwait(false);
    }

    internal void ShowStage(string phase) {
      if (phase != "waiting-for-installer") activePhase = phase;
      if (phase == "checking-cache" || phase == "connecting-download" || phase == "validating-download") {
        downloading = false;
        bar.Visible = true;
        bar.Style = ProgressBarStyle.Marquee;
        amount.Text = "";
        heading.Text = phase == "checking-cache" ? "正在检查已有下载" : phase == "validating-download" ? "正在验证下载文件" : "正在连接下载源";
        detail.Text = "请稍候。";
        return;
      }
      if (phase == "checking-installation" || phase == "preparing-update") {
        downloading = false;
        bar.Visible = true;
        bar.Style = ProgressBarStyle.Marquee;
        amount.Text = "";
        heading.Text = phase == "checking-installation" ? "正在检查安装位置" : "正在准备安装";
        detail.Text = "请稍候。";
        return;
      }
      if (phase == "downloading-core") {
        downloading = true;
        bar.Visible = true;
        bar.Style = ProgressBarStyle.Continuous;
        bar.Value = 0;
        amount.Text = "";
        heading.Text = "正在下载 Mizar";
        detail.Text = "请稍候。";
        return;
      }
      if (phase == "installing-core") {
        downloading = false;
        bar.Visible = true;
        bar.Style = ProgressBarStyle.Marquee;
        amount.Text = "";
        heading.Text = "正在安装 Mizar";
        detail.Text = "正在写入程序文件，即将完成，此时不可取消。";
        cancel.Enabled = false;
        return;
      }
      downloading = false;
      bar.Visible = true;
      bar.Style = ProgressBarStyle.Marquee;
      amount.Text = "";
      heading.Text = phase == "checking-release" ? "正在准备安装" : phase == "waiting-for-installer" ? "正在停止" : "正在安装";
      detail.Text = phase == "waiting-for-installer" ? "正在等待安装操作安全结束。" : "请稍候。";
    }

    internal void ShowCompleted(string path) {
      installedCore = path;
      SaveSuccessDiagnostic();
      finished = true;
      bar.Visible = false;
      amount.Text = "";
      heading.Text = "安装完成";
      detail.Text = "Mizar 已安装。";
      destinationLabel.Visible = false;
      destination.Visible = false;
      browse.Visible = false;
      openLocation.Visible = true;
      launchChoice.Visible = true;
      action.Text = "完成";
      action.Enabled = true;
      cancel.Text = "关闭";
    }

    internal void Finish() {
      if (!finished || cancellation != null) return;
      if (launchChoice.Checked) {
        try {
          launch(installedCore);
        } catch (Exception error) {
          launchFailed = true;
          heading.Text = "Mizar 未能启动";
          detail.Text = "安装已完成。可以重试启动，或取消勾选后结束。";
          technicalDetails = ErrorDetails(error);
          action.Text = "重试启动";
          return;
        }
      }
      Close();
    }

    internal static string RedactText(string text) {
      if (String.IsNullOrEmpty(text)) return "";
      var options = RegexOptions.IgnoreCase;
      text = Regex.Replace(text, @"\b(?:authorization|proxy-authorization|cookie|set-cookie)[""']?\s*[:=]\s*[^\r\n]+", "[redacted credential header]", options);
      text = Regex.Replace(text, @"rh_mizar_[a-zA-Z0-9_-]+", "[redacted]");
      text = Regex.Replace(text, @"\bBearer\s+[A-Za-z0-9._~+/-]+=*", "Bearer [redacted]", options);
      text = Regex.Replace(text, @"\b(auth|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|credential|client[_-]?secret|api[_-]?key)[""']?\s*[:=]\s*(?:""[^""]*""|'[^']*'|[^\s,;&""'<>]+)", "$1=[redacted]", options);
      text = Regex.Replace(text, @"(https?://)[^/\s@]+@", "$1[redacted]@", options);
      return Regex.Replace(text, @"(https?://[^\s?#]+)[?#][^\s]+", "$1?[redacted]", options);
    }

    internal static string DiagnosticText(Exception error) {
      return RedactText(error.ToString());
    }

    void ShowDetails() {
      using (var dialog = new Form { Text = "安装诊断", Width = 720, Height = 440, StartPosition = FormStartPosition.CenterParent }) {
        var content = new TextBox { Multiline = true, ReadOnly = true, ScrollBars = ScrollBars.Both, Dock = DockStyle.Fill, Text = technicalDetails };
        var buttons = new FlowLayoutPanel { Dock = DockStyle.Bottom, Height = 40 };
        var copy = new Button { Text = "复制诊断" };
        copy.Click += (s, e) => Clipboard.SetText(content.Text);
        var export = new Button { Text = "导出诊断" };
        export.Click += (s, e) => {
          using (var save = new SaveFileDialog { FileName = "Mizar-install-diagnostic.txt", Filter = "文本文件|*.txt" }) {
            if (save.ShowDialog(dialog) == DialogResult.OK)
              File.WriteAllText(save.FileName, content.Text, new UTF8Encoding(false));
          }
        };
        buttons.Controls.AddRange(new Control[] { copy, export });
        dialog.Controls.Add(content);
        dialog.Controls.Add(buttons);
        dialog.ShowDialog(this);
      }
    }

    void SaveSuccessDiagnostic() {
      var sb = new StringBuilder();
      sb.Append("安装完成\r\n");
      lock (diagnosticLog) {
        if (diagnosticLog.Count > 0) {
          sb.Append("下载诊断：\r\n");
          foreach (string line in diagnosticLog) sb.Append("  ").Append(line).Append("\r\n");
        }
      }
      SaveDiagnostic(null, sb.ToString());
    }

    string ErrorDetails(Exception error) {
      var sb = new StringBuilder();
      sb.Append("失败阶段：").Append(activePhase).Append("\r\n");
      lock (diagnosticLog) {
        if (diagnosticLog.Count > 0) {
          sb.Append("下载诊断：\r\n");
          foreach (string line in diagnosticLog) sb.Append("  ").Append(line).Append("\r\n");
        }
      }
      sb.Append(DiagnosticText(error)).Append("\r\n诊断日志：").Append(SaveDiagnostic(error, sb.ToString()));
      return sb.ToString();
    }

    internal static string SaveDiagnostic(Exception error, string extra = null) {
      try {
        string directory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizar", "logs");
        Downloader.NoReparse(directory);
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, "web-installer-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss") + "-" + Guid.NewGuid().ToString("N") + ".log");
        string content = String.IsNullOrEmpty(extra) ? (error != null ? DiagnosticText(error) : "") : RedactText(extra);
        File.WriteAllText(path, content, new UTF8Encoding(false));
        return path;
      } catch {
        return "无法保存，请复制当前提示。";
      }
    }

    internal void RequestCancel() {
      if (cancellation == null || activePhase == "installing-core") return;
      ShowStage("waiting-for-installer");
      cancellation.Cancel();
      cancel.Enabled = false;
    }

    internal async Task Start() {
      if (cancellation != null || finished) return;
      offlineDownload.Visible = false;
      action.Visible = true;
      if (!destination.ReadOnly) {
        activePhase = "checking-installation";
        try {
          selectedTarget = Nsis.SelectDestination(destination.Text);
          destination.Text = selectedTarget;
        } catch (Exception error) {
          heading.Text = "请修改安装位置";
          detail.Text = error.Message;
          technicalDetails = ErrorDetails(error);
          destination.Focus();
          return;
        }
      }
      destination.ReadOnly = true;
      activePhase = "checking-release";
      cancellation = new CancellationTokenSource();
      var current = cancellation;
      action.Enabled = false;
      cancel.Text = "取消";
      launchChoice.Visible = false;
      destinationLabel.Visible = false;
      destination.Visible = false;
      browse.Visible = false;
      downloading = true;
      bar.Visible = true;
      bar.Style = ProgressBarStyle.Continuous;
      bar.Value = 0;
      amount.Text = "";
      heading.Text = "正在准备安装";
      detail.Text = "请稍候。";
      bar.Style = ProgressBarStyle.Marquee;
      try {
        var progress = new Progress<long>(n => {
          if (cancellation != current || !downloading || current.IsCancellationRequested || finished) return;
          bar.Value = (int)Math.Min(100, n * 100 / plan.bytes);
          amount.Text = String.Format("{0:N0} / {1:N0} 字节", n, plan.bytes);
        });
        var stages = new Progress<string>(phase => {
          if (cancellation == current && !finished && !current.IsCancellationRequested) ShowStage(phase);
        });
        string path = await install(progress, stages, current.Token);
        ShowCompleted(path);
      } catch (OperationCanceledException error) {
        technicalDetails = ErrorDetails(error);
        heading.Text = current.IsCancellationRequested ? "已取消" : "操作超时";
        detail.Text = current.IsCancellationRequested
          ? "可以重新开始安装。"
          : (activePhase == "checking-release"
              ? "发布验证超时，请检查网络后重试。"
              : activePhase == "downloading-core" || activePhase == "connecting-download"
                ? "下载超时，请检查网络后重试。"
                : "当前操作超时，请查看诊断后重试。");
        action.Text = "重新开始";
        if (!current.IsCancellationRequested && (activePhase == "downloading-core" || activePhase == "connecting-download")) {
          offlineDownload.Visible = true;
          detail.Text += OfflineHint;
        }
      } catch (InstallerActionRequired error) {
        heading.Text = "无法继续安装";
        detail.Text = error.Message;
        technicalDetails = ErrorDetails(error);
        action.Text = "重试";
      } catch (UnauthorizedAccessException error) {
        heading.Text = "无法写入安装文件";
        detail.Text = "请检查安装位置的访问权限后重试。";
        technicalDetails = ErrorDetails(error);
        action.Text = "重试";
      } catch (Exception error) {
        heading.Text = "安装未完成";
        bool network = false, invalid = false, permission = false;
        var causes = new Stack<Exception>();
        causes.Push(error);
        while (causes.Count > 0) {
          Exception cause = causes.Pop();
          if (cause is HttpRequestException || ((activePhase == "downloading-core" || activePhase == "connecting-download") && cause is OperationCanceledException))
            network = true;
          if (cause is InvalidDataException) invalid = true;
          if (cause is UnauthorizedAccessException) permission = true;
          var aggregate = cause as AggregateException;
          if (aggregate != null) foreach (var inner in aggregate.InnerExceptions) causes.Push(inner);
          else if (cause.InnerException != null) causes.Push(cause.InnerException);
        }
        if (permission) heading.Text = "无法写入安装文件";
        detail.Text = permission
          ? "请检查安装位置的访问权限后重试。"
          : invalid
            ? "文件验证未通过。请重新下载或使用完整离线安装包。"
            : network
              ? "请检查网络后重试。"
              : installedCore != null
                ? "可以重试完成准备，或使用完整离线安装包。"
                : "请查看详情后重试，或使用原安装器修复。";
        if (network && !invalid && !permission) {
          offlineDownload.Visible = true;
          detail.Text += OfflineHint;
        }
        technicalDetails = ErrorDetails(error);
        action.Text = "重试";
      } finally {
        downloading = false;
        if (!finished) {
          bar.Visible = false;
          amount.Text = "";
          destinationLabel.Visible = true;
          destination.Visible = true;
          browse.Visible = true;
          browse.Enabled = installedCore == null && Nsis.CanChooseDestination() && !Nsis.IsInstalledAt(selectedTarget);
          destination.ReadOnly = !browse.Enabled;
          destination.TabStop = browse.Enabled;
        }
        current.Dispose();
        cancellation = null;
        action.Visible = true;
        action.Enabled = true;
        cancel.Enabled = true;
        cancel.Text = "关闭";
      }
    }
  }

  static class Program {
    [STAThread]
    static int Main(string[] args) {
      try {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        Plan plan;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("plan.json"))
        using (var reader = new StreamReader(stream)) {
          plan = new JavaScriptSerializer().Deserialize<Plan>(reader.ReadToEnd());
        }
        Publication.ValidatePlan(plan);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Window(plan));
        return 0;
      } catch (Exception error) {
        MessageBox.Show(
          "安装器无法启动。请保留当前版本，查看诊断：" + Window.SaveDiagnostic(error),
          "Mizar",
          MessageBoxButtons.OK,
          MessageBoxIcon.Error
        );
        return 1;
      }
    }
  }
}
