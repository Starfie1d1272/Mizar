using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using System.Drawing;
using System.Reflection;
using System.Web.Script.Serialization;

namespace Mizar.WebInstaller {
  public sealed class Plan {
    public int schemaVersion;
    public string version, name, sha256;
    public long bytes;
    public string[] urls;
    public bool allowExecute;
    public void Validate() {
      if (schemaVersion != 1 || String.IsNullOrEmpty(version) ||
          String.IsNullOrEmpty(name) || name != Path.GetFileName(name) ||
          !System.Text.RegularExpressions.Regex.IsMatch(name, @"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$") ||
          bytes < 1 || bytes > 512L * 1024 * 1024 ||
          sha256 == null || !System.Text.RegularExpressions.Regex.IsMatch(sha256, "^[a-f0-9]{64}$") ||
          urls == null || urls.Length < 1 || urls.Length > 4 || allowExecute)
        throw new InvalidDataException("引导计划无效，或缺少正式安装授权。");
      foreach (string url in urls) if (!Downloader.Allowed(new Uri(url)))
        throw new InvalidDataException("下载地址不受信任。");
    }
  }
  public sealed class Downloader {
    readonly HttpClient client;
    public Downloader(HttpClient value) { client = value; }
    public static bool Allowed(Uri u) {
      return u.Scheme == "https" && u.IsDefaultPort && u.UserInfo == "" && u.Fragment == "" &&
        ((u.Host == "github.com" && u.AbsolutePath.StartsWith("/Starfie1d1272/Mizar/releases/download/", StringComparison.Ordinal)) ||
         u.Host == "release-assets.githubusercontent.com" ||
         (u.Host == "box.nju.edu.cn" && u.AbsolutePath.StartsWith("/seafhttp/files/", StringComparison.Ordinal)));
    }
    static void NoReparse(string path) {
      for (string p = Path.GetFullPath(path); p != null; p = Path.GetDirectoryName(p)) {
        if ((Directory.Exists(p) || File.Exists(p)) &&
            (File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0)
          throw new IOException("缓存路径不能包含链接。");
      }
    }
    public static bool Matches(string path, Plan plan) {
      NoReparse(path);
      if (!File.Exists(path)) return false;
      using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
        if (input.Length != plan.bytes) return false;
        using (var sha = SHA256.Create())
          return BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant() == plan.sha256;
      }
    }
    async Task<HttpResponseMessage> Request(string url, CancellationToken token) {
      Uri current = new Uri(url);
      for (int n = 0; n < 5; n++) {
        if (!Allowed(current)) throw new InvalidDataException("下载重定向地址不受信任。");
        using (var request = new HttpRequestMessage(HttpMethod.Get, current)) {
          request.Headers.TryAddWithoutValidation("User-Agent", "Mizar-WebInstaller-POC");
          var response = await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, token);
          int status = (int)response.StatusCode;
          if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
            var location = response.Headers.Location;
            response.Dispose();
            if (location == null) throw new InvalidDataException("下载重定向无效。");
            current = location.IsAbsoluteUri ? location : new Uri(current, location);
            continue;
          }
          if (status != 200 || response.Content.Headers.ContentEncoding.Count != 0) {
            response.Dispose(); throw new IOException("下载源不可用。");
          }
          return response;
        }
      }
      throw new IOException("下载重定向次数超限。");
    }
    public async Task<string> Download(Plan plan, string cache, IProgress<long> progress, CancellationToken token) {
      plan.Validate(); token.ThrowIfCancellationRequested();
      cache = Path.GetFullPath(cache); NoReparse(cache);
      Directory.CreateDirectory(cache); NoReparse(cache);
      string target = Path.Combine(cache, plan.sha256 + "-" + plan.name);
      // A lock bounds concurrent writes and disk consumption per authenticated identity.
      NoReparse(target + ".lock");
      using (var gate = new FileStream(target + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
        if (Matches(target, plan)) { token.ThrowIfCancellationRequested(); progress.Report(plan.bytes); return target; }
        string staging = target + ".part";
        NoReparse(staging);
        Exception last = null;
        foreach (string url in plan.urls) {
          token.ThrowIfCancellationRequested();
          using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(token)) {
            deadline.CancelAfter(TimeSpan.FromMinutes(5));
            try {
              using (var response = await Request(url, deadline.Token)) {
                if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value != plan.bytes)
                  throw new InvalidDataException("下载文件大小不匹配。");
                using (var input = await response.Content.ReadAsStreamAsync())
                using (var output = new FileStream(staging, FileMode.Create, FileAccess.Write, FileShare.None, 65536, true)) {
                  var buffer = new byte[65536]; long total = 0;
                  for (;;) {
                    int count = await input.ReadAsync(buffer, 0, buffer.Length, deadline.Token);
                    if (count == 0) break;
                    total += count;
                    if (total > plan.bytes) throw new InvalidDataException("下载文件超过大小上限。");
                    await output.WriteAsync(buffer, 0, count, deadline.Token);
                    progress.Report(total);
                  }
                  output.Flush(true);
                  if (total != plan.bytes) throw new InvalidDataException("下载文件不完整。");
                }
              }
              deadline.Token.ThrowIfCancellationRequested();
              if (!Matches(staging, plan)) throw new InvalidDataException("文件校验失败。");
              token.ThrowIfCancellationRequested();
              NoReparse(target);
              if (File.Exists(target)) File.Delete(target);
              File.Move(staging, target);
              return target;
            } catch (Exception error) {
              if (File.Exists(staging)) File.Delete(staging);
              token.ThrowIfCancellationRequested();
              last = error;
            }
          }
        }
        throw new IOException("所有下载源均未通过验证。请重试或使用完整离线安装包。", last);
      }
    }
  }
  sealed class Window : Form {
    readonly Plan plan;
    readonly Label heading = new Label(), detail = new Label(), amount = new Label();
    readonly ProgressBar bar = new ProgressBar();
    readonly Button action = new Button(), cancel = new Button();
    CancellationTokenSource cancellation;
    public Window(Plan value) {
      plan = value; Text = "Mizar 在线安装 · 验证预览"; AutoScaleMode = AutoScaleMode.Dpi;
      ClientSize = new Size(590, 380); MinimumSize = Size; MaximizeBox = false;
      StartPosition = FormStartPosition.CenterScreen; Font = new Font("Microsoft YaHei UI", 9F);
      BackColor = Color.White;
      var banner = new Panel { Dock = DockStyle.Top, Height = 88, BackColor = Color.FromArgb(14, 24, 41) };
      var brand = new Label { Text = "Mizar", ForeColor = Color.White, Font = new Font("Segoe UI", 24F), AutoSize = true, Location = new Point(32, 20) };
      banner.Controls.Add(brand);
      using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("header.bmp")) {
        if (stream != null) {
          var picture = new PictureBox { Image = new Bitmap(stream), SizeMode = PictureBoxSizeMode.Zoom, Location = new Point(400, 8), Size = new Size(160, 72) };
          banner.Controls.Add(picture);
        }
      }
      Controls.Add(banner);
      heading.SetBounds(32, 112, 526, 32); heading.Font = new Font(Font.FontFamily, 15F);
      heading.Text = "准备验证下载";
      detail.SetBounds(32, 157, 526, 55);
      detail.Text = "本预览仅下载并校验公开许可文件，不会修改已安装的 Mizar。\n正式在线安装将在核心与默认 EPL 素材都就绪后完成。";
      bar.SetBounds(32, 231, 526, 10); bar.Style = ProgressBarStyle.Continuous;
      amount.SetBounds(32, 250, 526, 28); amount.ForeColor = Color.FromArgb(80, 92, 110);
      action.SetBounds(347, 321, 100, 32); action.Text = "开始验证"; action.Click += async (s,e) => await Start();
      cancel.SetBounds(458, 321, 100, 32); cancel.Text = "关闭";
      cancel.Click += (s,e) => { if (cancellation != null) cancellation.Cancel(); else Close(); };
      Controls.AddRange(new Control[] { heading, detail, bar, amount, action, cancel });
      AcceptButton = action; CancelButton = cancel;
      FormClosing += (s,e) => { if (cancellation != null) { cancellation.Cancel(); e.Cancel = true; } };
    }
    async Task Start() {
      cancellation = new CancellationTokenSource(); action.Enabled = false; cancel.Text = "取消";
      heading.Text = "正在下载与校验"; detail.Text = "只使用受限 HTTPS 地址。校验通过前不会使用下载内容。";
      bar.Value = 0;
      try {
        var progress = new Progress<long>(n => { bar.Value = (int)Math.Min(100, n * 100 / plan.bytes); amount.Text = String.Format("{0:N0} / {1:N0} 字节", n, plan.bytes); });
        using (var handler = new HttpClientHandler { AllowAutoRedirect = false, UseCookies = false })
        using (var client = new HttpClient(handler) { Timeout = Timeout.InfiniteTimeSpan }) {
          await new Downloader(client).Download(plan, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizar", "bootstrap-cache"), progress, cancellation.Token);
        }
        heading.Text = "下载验证完成"; detail.Text = "公开文件的大小与固定 SHA-256 一致。\n这是下载验证预览，尚未安装核心或默认 EPL 素材。"; action.Text = "再次验证";
      } catch (OperationCanceledException) {
        heading.Text = "已取消"; detail.Text = "未完成的下载已清理。可以重新开始。"; action.Text = "重新开始";
      } catch {
        heading.Text = "下载未完成"; detail.Text = "网络或文件验证失败。请检查网络后重试。\n正式版本将提供完整离线安装入口。"; action.Text = "重试";
      } finally { cancellation.Dispose(); cancellation = null; action.Enabled = true; cancel.Text = "关闭"; }
    }
  }
  static class Program {
    [STAThread] static int Main(string[] args) {
      try {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        Plan plan;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("plan.json"))
        using (var reader = new StreamReader(stream)) plan = new JavaScriptSerializer().Deserialize<Plan>(reader.ReadToEnd());
        plan.Validate();
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Window(plan)); return 0;
      } catch { MessageBox.Show("安装验证预览无法启动。", "Mizar", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
    }
  }
}
