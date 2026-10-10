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
    public string version, name, sha256, kind, gitSha, contentDigest;
    public long bytes;
    public string[] urls;
    public bool allowExecute, publicationRequired;
    public string coreName, coreSha256, boxReadToken, updateManifestSha256;
    public long coreBytes;
    public void Validate() {
      if (schemaVersion != 1 || String.IsNullOrEmpty(version) ||
          String.IsNullOrEmpty(name) || name != Path.GetFileName(name) ||
          !System.Text.RegularExpressions.Regex.IsMatch(name, @"^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$") ||
          bytes < 1 || bytes > 512L * 1024 * 1024 ||
          sha256 == null || !System.Text.RegularExpressions.Regex.IsMatch(sha256, "^[a-f0-9]{64}$") ||
          urls == null || urls.Length < 1 || urls.Length > 4)
        throw new InvalidDataException("引导计划无效，或缺少正式安装授权。");
      if (allowExecute && (kind != "nsis-setup" ||
          !System.Text.RegularExpressions.Regex.IsMatch(version, @"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$") ||
          (name != "Mizar-v" + version + "-Windows-x64-Setup.exe" && name != "Mizar-v" + version + "-Windows-x64-Core-Setup.exe") ||
          gitSha == null || !System.Text.RegularExpressions.Regex.IsMatch(gitSha, "^[a-f0-9]{40}$") ||
          contentDigest == null || !System.Text.RegularExpressions.Regex.IsMatch(contentDigest, "^[a-f0-9]{64}$")))
        throw new InvalidDataException("固定 NSIS 安装授权不完整。");
      foreach (string url in urls) if (!Downloader.Allowed(new Uri(url)))
        throw new InvalidDataException("下载地址不受信任。");
    }
  }
  // This only checks public availability of already-qualified pins. Publisher
  // authentication remains the existing Qualification and SDK trust chain.
  static class Publication {
    internal static void ValidatePlan(Plan plan) {
      plan.Validate();
      if(plan.updateManifestSha256!=null && (!System.Text.RegularExpressions.Regex.IsMatch(plan.updateManifestSha256,"^[a-f0-9]{64}$") || plan.name!="Mizar-v"+plan.version+"-Windows-x64-Core-Setup.exe" || plan.coreName!="Mizar-v"+plan.version+"-Windows-x64-Core.zip")) throw new InvalidDataException("Core qualification pins are invalid");
      if (!plan.allowExecute || !plan.publicationRequired ||
          (plan.coreName != "Mizar-v" + plan.version + "-Windows-x64.zip" && plan.coreName != "Mizar-v" + plan.version + "-Windows-x64-Core.zip") ||
          plan.coreBytes < 1 || plan.coreSha256 == null ||
          !System.Text.RegularExpressions.Regex.IsMatch(plan.coreSha256,"^[a-f0-9]{64}$") ||
          plan.urls.Length != 1 || plan.urls[0] != "https://github.com/Starfie1d1272/Mizar/releases/download/v" + plan.version + "/" + plan.name)
        throw new InvalidDataException("正式安装身份不完整。");
    }
    internal static void Check(string json, Plan plan) {
      ValidatePlan(plan);
      var serializer=new JavaScriptSerializer {MaxJsonLength=2*1024*1024};
      var release=serializer.Deserialize<System.Collections.Generic.Dictionary<string,object>>(json);
      DateTimeOffset published;
      if (release==null || !release.ContainsKey("draft") || !(release["draft"] is bool) || (bool)release["draft"] ||
          !release.ContainsKey("prerelease") || !(release["prerelease"] is bool) || (bool)release["prerelease"] ||
          !release.ContainsKey("tag_name") || !Object.Equals(release["tag_name"],"v"+plan.version) ||
          !release.ContainsKey("published_at") || !(release["published_at"] is string) ||
          !DateTimeOffset.TryParse((string)release["published_at"],System.Globalization.CultureInfo.InvariantCulture,System.Globalization.DateTimeStyles.None,out published) || published> DateTimeOffset.UtcNow ||
          !release.ContainsKey("assets") || !(release["assets"] is System.Collections.ArrayList))
        throw new InvalidDataException("对应版本尚未正式公开发布。");
      var assets=(System.Collections.ArrayList)release["assets"];
      CheckAsset(assets,plan.name,plan.bytes,plan.sha256,plan.version);
      if(plan.updateManifestSha256==null) CheckAsset(assets,plan.coreName,plan.coreBytes,plan.coreSha256,plan.version);
    }
    static void CheckAsset(System.Collections.ArrayList assets,string name,long bytes,string sha,string version) {
      int matches=0;
      foreach(object item in assets) {
        var asset=item as System.Collections.Generic.Dictionary<string,object>;
        if(asset==null || !asset.ContainsKey("name") || !Object.Equals(asset["name"],name)) continue;
        matches++;
        if(!asset.ContainsKey("size") || !(asset["size"] is int || asset["size"] is long) || Convert.ToInt64(asset["size"])!=bytes ||
           !asset.ContainsKey("digest") || !Object.Equals(asset["digest"],"sha256:"+sha) ||
           !asset.ContainsKey("browser_download_url") || !Object.Equals(asset["browser_download_url"],"https://github.com/Starfie1d1272/Mizar/releases/download/v"+version+"/"+name))
          throw new InvalidDataException("公开资产与固定资格身份不一致。");
      }
      if(matches!=1) throw new InvalidDataException("公开资产缺失或重复。");
    }
    internal static async Task Verify(Plan plan,CancellationToken token) {
      using(var handler=new HttpClientHandler {AllowAutoRedirect=false,UseCookies=false})
      using(var client=new HttpClient(handler) {Timeout=Timeout.InfiniteTimeSpan}) await Verify(plan,client,token);
    }
    internal static async Task Verify(Plan plan,HttpClient client,CancellationToken token) {
      ValidatePlan(plan);
      try {
        using(var deadline=CancellationTokenSource.CreateLinkedTokenSource(token)) {
          deadline.CancelAfter(15000); await Mirror.Resolve(plan,client,deadline.Token);
        }
        return;
      } catch {token.ThrowIfCancellationRequested();}
      await VerifyGithub(plan,client,token);
    }
    static async Task VerifyGithub(Plan plan,HttpClient client,CancellationToken token) {
      ValidatePlan(plan);
      using(var deadline=CancellationTokenSource.CreateLinkedTokenSource(token)) {
        deadline.CancelAfter(45000);
        using(var request=new HttpRequestMessage(HttpMethod.Get,"https://api.github.com/repos/Starfie1d1272/Mizar/releases/tags/v"+plan.version)) {
          request.Headers.TryAddWithoutValidation("User-Agent","Mizar-WebInstaller");
          request.Headers.TryAddWithoutValidation("Accept","application/vnd.github+json");
          using(var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,deadline.Token).ConfigureAwait(false)) {
            response.EnsureSuccessStatusCode();
            using(var input=await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
            using(var output=new MemoryStream()) {
              var buffer=new byte[16384];
              for(;;) {
                int count=await input.ReadAsync(buffer,0,buffer.Length,deadline.Token).ConfigureAwait(false);
                if(count==0) break;
                if(output.Length+count>2*1024*1024) throw new InvalidDataException("公开版本响应过大。");
                output.Write(buffer,0,count);
              }
              deadline.Token.ThrowIfCancellationRequested();
              Check(new System.Text.UTF8Encoding(false,true).GetString(output.ToArray()),plan);
            }
          }
        }
      }
    }
  }
  // Box public-state checks compare only immutable Qualification pins. The
  // installed original SDK alone authenticates the dual-signed publication.
  static class Mirror {
    static JavaScriptSerializer Serializer() { return new JavaScriptSerializer {MaxJsonLength=2*1024*1024}; }
    static async Task<string> Read(HttpClient client,string url,string token,CancellationToken cancel) {
      using(var request=new HttpRequestMessage(HttpMethod.Get,url)) {
        if(token!=null) request.Headers.TryAddWithoutValidation("Authorization","Token "+token);
        using(var response=await client.SendAsync(request,HttpCompletionOption.ResponseHeadersRead,cancel).ConfigureAwait(false)) {
          response.EnsureSuccessStatusCode();
          using(var input=await response.Content.ReadAsStreamAsync().ConfigureAwait(false))
          using(var output=new MemoryStream()) {
            var buffer=new byte[16384];
            for(;;) {int count=await input.ReadAsync(buffer,0,buffer.Length,cancel).ConfigureAwait(false);if(count==0) break;if(output.Length+count>2*1024*1024) throw new InvalidDataException("镜像响应超限。");output.Write(buffer,0,count);}
            return new System.Text.UTF8Encoding(false,true).GetString(output.ToArray());
          }
        }
      }
    }
    static async Task<System.Collections.Generic.Dictionary<string,object>> Directory(HttpClient client,Plan plan,string folder,CancellationToken token) {
      var value=Serializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(await Read(client,"https://box.nju.edu.cn/api/v2.1/via-repo-token/dir/?path="+Uri.EscapeDataString(folder),plan.boxReadToken,token));
      if(value==null || !value.ContainsKey("repo_name") || !Object.Equals(value["repo_name"],"Mizar") || !value.ContainsKey("user_perm") || !Object.Equals(value["user_perm"],"r")) throw new InvalidDataException("镜像只读资料库不匹配。");
      return value;
    }
    static async Task<string> Link(HttpClient client,Plan plan,string path,CancellationToken token) {
      string url=Serializer().Deserialize<string>(await Read(client,"https://box.nju.edu.cn/api/v2.1/via-repo-token/download-link/?path="+Uri.EscapeDataString(path),plan.boxReadToken,token));
      if(url==null || url.Length>8192 || !Downloader.Allowed(new Uri(url)) || new Uri(url).Host!="box.nju.edu.cn") throw new InvalidDataException("镜像下载链接无效。");
      return url;
    }
    internal static void CheckIndex(string json,Plan plan) {
      var serializer=Serializer();var index=serializer.Deserialize<System.Collections.Generic.Dictionary<string,object>>(json);
      if(!Object.Equals(index["schemaVersion"],"mizar.update-index.v2") || !index.ContainsKey("provenance") || !index.ContainsKey("publicationProvenance")) throw new InvalidDataException("镜像发布资料不完整。");
      byte[] original=Convert.FromBase64String((string)index["manifestBase64"]), published=Convert.FromBase64String((string)index["publicationBase64"]);
      if(original.Length>65536 || published.Length>65536) throw new InvalidDataException("镜像元数据超限。");
      var manifest=serializer.Deserialize<System.Collections.Generic.Dictionary<string,object>>(System.Text.Encoding.UTF8.GetString(original));
      var publication=serializer.Deserialize<System.Collections.Generic.Dictionary<string,object>>(System.Text.Encoding.UTF8.GetString(published));
      var installer=(System.Collections.Generic.Dictionary<string,object>)manifest["installer"];
      bool corePlan=plan.updateManifestSha256!=null;
      string digest;using(var sha=SHA256.Create()) digest=BitConverter.ToString(sha.ComputeHash(original)).Replace("-","").ToLowerInvariant();
      DateTimeOffset time;
      if(!Object.Equals(manifest["repository"],"Starfie1d1272/Mizar") || !Object.Equals(manifest["schemaVersion"],"mizar.update.v1") || !Object.Equals(manifest["channel"],"stable") || !Object.Equals(manifest["version"],plan.version) || !Object.Equals(manifest["gitSha"],plan.gitSha) || (corePlan ? !Object.Equals(plan.updateManifestSha256,digest) : !Object.Equals(installer["name"],plan.name) || Convert.ToInt64(installer["bytes"])!=plan.bytes || !Object.Equals(installer["sha256"],plan.sha256) || !Object.Equals(installer["contentDigest"],plan.contentDigest)) || !Object.Equals(publication["schemaVersion"],"mizar.update-publication.v1") || !Object.Equals(publication["repository"],"Starfie1d1272/Mizar") || !Object.Equals(publication["version"],plan.version) || !Object.Equals(publication["gitSha"],plan.gitSha) || !Object.Equals(publication["manifestSha256"],digest) || Convert.ToInt64(publication["releaseId"])<1 || !DateTimeOffset.TryParse((string)publication["publishedAt"],out time) || time>DateTimeOffset.UtcNow) throw new InvalidDataException("镜像与固定资格版本不一致。");
    }
    internal static async Task<string> Resolve(Plan plan,HttpClient client,CancellationToken token) {
      if(String.IsNullOrEmpty(plan.boxReadToken)) throw new IOException("镜像只读合同缺失。");
      await Directory(client,plan,"/Updates",token);
      string index=await Link(client,plan,"/Updates/latest.json",token);
      CheckIndex(await Read(client,index,null,token),plan);
      string folder=plan.updateManifestSha256!=null ? "/Runtime/v"+plan.version : "/Stable";
      var entries=await Directory(client,plan,folder,token);int count=0;
      foreach(var item in (System.Collections.ArrayList)entries["dirent_list"]) {
        var entry=(System.Collections.Generic.Dictionary<string,object>)item;
        if(Object.Equals(entry["name"],plan.name)) {count++;if(!Object.Equals(entry["type"],"file") || Convert.ToInt64(entry["size"])!=plan.bytes) throw new InvalidDataException("镜像安装包不匹配。");}
      }
      if(count!=1) throw new IOException("镜像尚未同步该版本。");
      return await Link(client,plan,folder+"/"+plan.name,token);
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
    internal static void NoReparse(string path) {
      for (string p = Path.GetFullPath(path); p != null; p = Path.GetDirectoryName(p)) {
        if ((Directory.Exists(p) || File.Exists(p)) &&
            (File.GetAttributes(p) & FileAttributes.ReparsePoint) != 0)
          throw new IOException("缓存路径不能包含链接。");
      }
    }
    public static bool Matches(string path, Plan plan) {
      return MatchesAsync(path, plan, CancellationToken.None).GetAwaiter().GetResult();
    }
    static async Task<bool> MatchesAsync(string path, Plan plan, CancellationToken token) {
      NoReparse(path); token.ThrowIfCancellationRequested();
      if (!File.Exists(path)) return false;
      using (var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, true))
        return await MatchesStream(input, plan, token).ConfigureAwait(false);
    }
    internal static async Task<bool> MatchesStream(FileStream input, Plan plan, CancellationToken token) {
      if (input.Length != plan.bytes) return false;
      input.Position = 0;
      using (var sha = SHA256.Create()) {
        var buffer = new byte[65536];
        for (;;) {
          int count = await input.ReadAsync(buffer, 0, buffer.Length, token).ConfigureAwait(false);
          if (count == 0) break;
          sha.TransformBlock(buffer, 0, count, buffer, 0);
        }
        token.ThrowIfCancellationRequested();
        sha.TransformFinalBlock(new byte[0], 0, 0);
        return BitConverter.ToString(sha.Hash).Replace("-", "").ToLowerInvariant() == plan.sha256;
      }
    }
    async Task<HttpResponseMessage> Request(string url, CancellationToken token) {
      Uri current = new Uri(url);
      for (int n = 0; n < 5; n++) {
        if (!Allowed(current)) throw new InvalidDataException("下载重定向地址不受信任。");
        using (var request = new HttpRequestMessage(HttpMethod.Get, current)) {
          request.Headers.TryAddWithoutValidation("User-Agent", "Mizar-WebInstaller");
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
            response.Dispose();
            if(status==408 || status==429 || status>=500) throw new HttpRequestException("下载源暂时不可用。");
            throw new IOException("下载源不可用。");
          }
          return response;
        }
      }
      throw new IOException("下载重定向次数超限。");
    }
    public async Task<string> Download(Plan plan, string cache, IProgress<long> progress, CancellationToken token, IProgress<string> stages=null) {
      if(stages!=null) stages.Report("checking-cache");
      plan.Validate(); token.ThrowIfCancellationRequested();
      cache = Path.GetFullPath(cache); NoReparse(cache);
      Directory.CreateDirectory(cache); NoReparse(cache);
      string target = Path.Combine(cache, plan.sha256 + "-" + plan.name);
      // A lock bounds concurrent writes and disk consumption per authenticated identity.
      NoReparse(target + ".lock");
      using (var gate = new FileStream(target + ".lock", FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None)) {
        if (await MatchesAsync(target, plan, token)) { token.ThrowIfCancellationRequested(); progress.Report(plan.bytes); return target; }
        string staging = target + ".part";
        NoReparse(staging);
        Exception last = null;
        var sources=new System.Collections.Generic.List<string>(plan.urls);
        if(plan.publicationRequired) {
          try {using(var lookup=CancellationTokenSource.CreateLinkedTokenSource(token)) {lookup.CancelAfter(15000);sources.Insert(0,await Mirror.Resolve(plan,client,lookup.Token));}} catch {token.ThrowIfCancellationRequested();}
        }
        foreach (string url in sources) {
          token.ThrowIfCancellationRequested();
          using (var deadline = CancellationTokenSource.CreateLinkedTokenSource(token)) {
            deadline.CancelAfter(TimeSpan.FromMinutes(5));
            for(int attempt=0;attempt<2;attempt++) {
            bool retry=false;
            try {
              if(stages!=null) stages.Report("connecting-download");
              using (var response = await Request(url, deadline.Token)) {
                if (response.Content.Headers.ContentLength.HasValue && response.Content.Headers.ContentLength.Value != plan.bytes)
                  throw new InvalidDataException("下载文件大小不匹配。");
                using (var input = await response.Content.ReadAsStreamAsync())
                using (var output = new FileStream(staging, FileMode.Create, FileAccess.Write, FileShare.None, 65536, true)) {
                  if(stages!=null) stages.Report("downloading-core");
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
              if(stages!=null) stages.Report("validating-download");
              if (!await MatchesAsync(staging, plan, deadline.Token)) throw new InvalidDataException("文件校验失败。");
              token.ThrowIfCancellationRequested();
              NoReparse(target);
              if (File.Exists(target)) File.Delete(target);
              File.Move(staging, target);
              return target;
            } catch (Exception error) {
              if (File.Exists(staging)) File.Delete(staging);
              token.ThrowIfCancellationRequested();
              last = error;
              retry=attempt==0 && error is HttpRequestException && !deadline.IsCancellationRequested;
            }
            if(!retry) break;
            await Task.Delay(500,token);
            }
          }
        }
        throw new IOException("所有下载源均未通过验证。请重试或使用完整离线安装包。", last);
      }
    }
  }
  sealed class Window : Form {
    readonly Plan plan;
    readonly Func<IProgress<long>,IProgress<string>,CancellationToken,Task<string>> install;
    readonly Action<string> launch;
    internal readonly Label heading = new Label(), detail = new Label(), amount = new Label();
    internal readonly ProgressBar bar = new ProgressBar();
    internal readonly Button action = new Button(), cancel = new Button();
    internal readonly CheckBox launchChoice = new CheckBox();
    readonly LinkLabel details = new LinkLabel();
    CancellationTokenSource cancellation;
    string installedCore, technicalDetails, activePhase="checking-release";
    bool finished, recoveryRequired, downloading, launchFailed;
    public Window(Plan value) : this(value,null,null,false) { }
    internal Window(Plan value,Func<IProgress<long>,IProgress<string>,CancellationToken,Task<string>> operation,Action<string> start,bool demonstration) {
      plan=value; install=operation ?? ((bytes,stages,token)=>Task.Run(()=>Install(bytes,stages,token))); launch=start ?? (path=>Nsis.StartVerifiedProduct(plan,path));
      Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);
      Text=demonstration ? "Mizar 安装 · 界面演示（未执行安装）" : "Mizar 安装";
      AutoScaleMode=AutoScaleMode.Dpi; ClientSize=new Size(590,330); MinimumSize=Size; MaximizeBox=false;
      StartPosition=FormStartPosition.CenterScreen; Font=new Font("Microsoft YaHei UI",9F); BackColor=Color.White;
      var banner=new Panel {Dock=DockStyle.Top,Height=80,BackColor=Color.FromArgb(14,24,41)};
      var logo=Icon.ToBitmap();
      using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("brand.png")) {
        if(stream!=null) using(var image=Image.FromStream(stream)) {logo.Dispose();logo=new Bitmap(image);}
      }
      banner.Controls.Add(new PictureBox {Image=logo,SizeMode=PictureBoxSizeMode.CenterImage,Location=new Point(32,16),Size=new Size(48,48)});
      Disposed += (s,e)=>logo.Dispose();
      banner.Controls.Add(new Label {Text="Mizar",ForeColor=Color.White,Font=new Font("Segoe UI",24F),AutoSize=true,Location=new Point(96,17)});
      Controls.Add(banner);
      heading.SetBounds(32,104,526,32); heading.Font=new Font(Font.FontFamily,15F);
      heading.Text="安装 Mizar";
      detail.SetBounds(32,148,526,48);
      detail.Text="欢迎使用 Mizar，安装或更新后开始准备你的比赛。";
      bar.SetBounds(32,212,526,10); bar.Visible=false;
      amount.SetBounds(32,232,526,24); amount.ForeColor=Color.FromArgb(80,92,110);
      launchChoice.SetBounds(32,200,220,28); launchChoice.Text="启动 Mizar"; launchChoice.Checked=true; launchChoice.Visible=false;
      launchChoice.CheckedChanged += (s,e)=>{if(finished) action.Text=launchFailed && launchChoice.Checked ? "重试启动" : "完成";};
      action.SetBounds(347,270,100,32); action.Text=Nsis.HasPending() ? "恢复安装" : "安装";
      action.Click += async (s,e)=>{if(finished) Finish(); else await Start();};
      cancel.SetBounds(458,270,100,32); cancel.Text="关闭";
      cancel.Click += (s,e)=>{if(cancellation!=null) RequestCancel(); else Close();};
      details.SetBounds(32,278,120,24); details.Text="详情";
      technicalDetails="安装文件与必要数据来自官方发布源，并在使用前验证。";
      details.LinkClicked += (s,e)=>ShowDetails();
      Controls.AddRange(new Control[]{heading,detail,bar,amount,launchChoice,action,cancel,details});
      if(demonstration) {
        var marker=new Label {Text="界面演示：未执行安装",ForeColor=Color.DarkRed,BackColor=Color.White,AutoSize=true,Location=new Point(32,83)};
        Controls.Add(marker); marker.BringToFront();
      }
      AcceptButton=action; CancelButton=cancel;
      FormClosing += (s,e)=>{if(cancellation!=null){RequestCancel();e.Cancel=true;}};
    }
    async Task<string> Install(IProgress<long> bytes,IProgress<string> stages,CancellationToken token) {
      stages.Report("checking-release");
      await Publication.Verify(plan,token);
      stages.Report("checking-installation");
      string target=Nsis.ResolveDestination();
      if(installedCore==null) {
        if(!Nsis.HasPending() && !Directory.Exists(target)) Nsis.ValidateDestination(target);
        stages.Report("downloading-core");
        string installer;
        using(var handler=new HttpClientHandler {AllowAutoRedirect=false,UseCookies=false})
        using(var client=new HttpClient(handler) {Timeout=Timeout.InfiniteTimeSpan})
          installer=await new Downloader(client).Download(plan,Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Mizar","bootstrap-cache"),bytes,token,stages);
        var core=await Nsis.Install(plan,installer,target,token,stages);
        installedCore=core.Directory;
        if(core.ResourcesReady) return installedCore;
      }
      await Nsis.RunResourceBridge(plan,installedCore,token,stages);
      token.ThrowIfCancellationRequested(); return installedCore;
    }
    internal void ShowStage(string phase) {
      if(phase!="waiting-for-installer") activePhase=phase;
      if(phase=="checking-cache" || phase=="connecting-download" || phase=="validating-download") {downloading=false;bar.Visible=true;bar.Style=ProgressBarStyle.Marquee;amount.Text="";heading.Text=phase=="checking-cache" ? "正在检查已有下载" : phase=="validating-download" ? "正在验证下载文件" : "正在连接下载源";detail.Text="请稍候。";return;}
      if(phase=="checking-installation" || phase=="preparing-update") {downloading=false;bar.Visible=true;bar.Style=ProgressBarStyle.Marquee;amount.Text="";heading.Text=phase=="checking-installation" ? "正在检查安装位置" : "正在备份原程序";detail.Text="请稍候。";return;}
      if(phase=="downloading-core") {downloading=true;bar.Visible=true;bar.Style=ProgressBarStyle.Continuous;bar.Value=0;amount.Text="";heading.Text="正在下载 Mizar";detail.Text="请稍候。";return;}
      downloading=false; bar.Visible=true; bar.Style=ProgressBarStyle.Marquee; amount.Text="";
      heading.Text=phase=="checking-release" ? "正在准备安装" : phase=="installing-resources" ? "正在完成准备" : phase=="waiting-for-installer" ? "正在停止" : "正在安装";
      detail.Text=phase=="waiting-for-installer" ? "正在等待安装操作安全结束。" : "请稍候。";
    }
    internal void ShowCompleted(string path) {
      installedCore=path; finished=true; bar.Visible=false; amount.Text="";
      heading.Text="安装完成"; detail.Text="Mizar 已安装。";
      launchChoice.Visible=true; action.Text="完成"; action.Enabled=true; cancel.Text="关闭";
    }
    internal void Finish() {
      if(!finished || cancellation!=null) return;
      if(launchChoice.Checked) {
        try {launch(installedCore);}
        catch(Exception error) {
          launchFailed=true;
          heading.Text="Mizar 未能启动"; detail.Text="安装已完成。可以重试启动，或取消勾选后结束。";
          technicalDetails=ErrorDetails(error); action.Text="重试启动"; return;
        }
      }
      Close();
    }
    internal static string DiagnosticText(Exception error) {
      // Match the established capture sanitizer's credential names and bare Bearer values.
      var options=System.Text.RegularExpressions.RegexOptions.IgnoreCase;
      string text=error.ToString();
      text=System.Text.RegularExpressions.Regex.Replace(text,@"\b(?:authorization|proxy-authorization|cookie|set-cookie)[""']?\s*[:=]\s*[^\r\n]+","[redacted credential header]",options);
      text=System.Text.RegularExpressions.Regex.Replace(text,@"\bBearer\s+[A-Za-z0-9._~+/-]+=*","Bearer [redacted]",options);
      text=System.Text.RegularExpressions.Regex.Replace(text,@"\b(auth|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret|api[_-]?key)[""']?\s*[:=]\s*(?:""[^""]*""|'[^']*'|[^\s,;&""'<>]+)","$1=[redacted]",options);
      text=System.Text.RegularExpressions.Regex.Replace(text,@"(https?://)[^/\s@]+@","$1[redacted]@",options);
      return System.Text.RegularExpressions.Regex.Replace(text,@"(https?://[^\s?#]+)[?#][^\s]+","$1?[redacted]",options);
    }
    void ShowDetails() {
      using(var dialog=new Form {Text="安装诊断",Width=720,Height=440,StartPosition=FormStartPosition.CenterParent}) {
        var content=new TextBox {Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Both,Dock=DockStyle.Fill,Text=technicalDetails};
        var buttons=new FlowLayoutPanel {Dock=DockStyle.Bottom,Height=40};
        var copy=new Button {Text="复制诊断"};copy.Click+=(s,e)=>Clipboard.SetText(content.Text);
        var export=new Button {Text="导出诊断"};export.Click+=(s,e)=>{using(var save=new SaveFileDialog {FileName="Mizar-install-diagnostic.txt",Filter="文本文件|*.txt"}) {if(save.ShowDialog(dialog)==DialogResult.OK) File.WriteAllText(save.FileName,content.Text,new System.Text.UTF8Encoding(false));}};
        buttons.Controls.AddRange(new Control[]{copy,export});dialog.Controls.Add(content);dialog.Controls.Add(buttons);dialog.ShowDialog(this);
      }
    }
    string ErrorDetails(Exception error) {return "失败阶段："+activePhase+"\r\n"+DiagnosticText(error)+"\r\n诊断日志："+SaveDiagnostic(error);}
    internal static string SaveDiagnostic(Exception error) {
      try {
        string directory=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Mizar","logs");
        Downloader.NoReparse(directory);Directory.CreateDirectory(directory);
        string path=Path.Combine(directory,"web-installer-"+DateTime.UtcNow.ToString("yyyyMMdd-HHmmss")+"-"+Guid.NewGuid().ToString("N")+".log");
        File.WriteAllText(path,DiagnosticText(error),new System.Text.UTF8Encoding(false));return path;
      } catch {return "无法保存，请复制当前提示。";}
    }
    internal void RequestCancel() {
      if(cancellation==null) return;
      ShowStage("waiting-for-installer"); cancellation.Cancel(); cancel.Enabled=false;
    }
    internal async Task Start() {
      if(cancellation!=null || finished || recoveryRequired) return;
      cancellation=new CancellationTokenSource(); var current=cancellation;
      action.Enabled=false; cancel.Text="取消"; launchChoice.Visible=false;
      downloading=true; bar.Visible=true; bar.Style=ProgressBarStyle.Continuous; bar.Value=0; amount.Text="";
      heading.Text="正在准备安装"; detail.Text="请稍候。"; bar.Style=ProgressBarStyle.Marquee;
      try {
        var progress=new Progress<long>(n=>{
          if(cancellation!=current || !downloading || current.IsCancellationRequested || finished) return;
          bar.Value=(int)Math.Min(100,n*100/plan.bytes); amount.Text=String.Format("{0:N0} / {1:N0} 字节",n,plan.bytes);
        });
        var stages=new Progress<string>(phase=>{
          if(cancellation==current && !finished && !current.IsCancellationRequested) ShowStage(phase);
        });
        string path=await install(progress,stages,current.Token);
        current.Token.ThrowIfCancellationRequested(); ShowCompleted(path);
      } catch(OperationCanceledException error) {
        technicalDetails=ErrorDetails(error);
        heading.Text=current.IsCancellationRequested ? "已取消" : "操作超时";
        detail.Text=current.IsCancellationRequested ? installedCore==null ? "可以重新开始安装。" : "已安装部分保持不变，可以继续完成准备。" : (activePhase=="checking-release" ? "发布验证超时，请检查网络后重试。" : activePhase=="downloading-core" || activePhase=="connecting-download" ? "下载超时，请检查网络后重试。" : "当前操作超时，请查看诊断后重试。"); action.Text="重新开始";
      } catch(InstallerRecoveryRequired error) {
        recoveryRequired=true; heading.Text="需要恢复安装"; detail.Text="已保留安装现场。请查看详情，确认旧安装操作已结束后重新打开此安装器。"; technicalDetails=ErrorDetails(error);
      } catch(InstallerActionRequired error) {
        recoveryRequired=!error.CanRetry; heading.Text="无法继续安装"; detail.Text=error.Message; technicalDetails=ErrorDetails(error); action.Text="重试";
      } catch(UnauthorizedAccessException error) {
        heading.Text="无法写入安装文件"; detail.Text="请检查安装位置的访问权限后重试。"; technicalDetails=ErrorDetails(error); action.Text="重试";
      } catch(Exception error) {
        heading.Text="安装未完成";
        bool network=false, invalid=false;
        for(Exception cause=error;cause!=null;cause=cause.InnerException) {if(cause is HttpRequestException || cause is OperationCanceledException) network=true; if(cause is InvalidDataException) invalid=true;}
        detail.Text=invalid ? "文件验证未通过。请重新下载或使用完整离线安装包。" : network ? "请检查网络后重试，或使用完整离线安装包。" : installedCore!=null ? "可以重试完成准备，或使用完整离线安装包。" : "请查看详情后重试，或使用原安装器修复。";
        technicalDetails=ErrorDetails(error); action.Text="重试";
      } finally {
        downloading=false; if(!finished) {bar.Visible=false;amount.Text="";}
        current.Dispose(); cancellation=null; action.Enabled=!recoveryRequired; cancel.Enabled=true; cancel.Text="关闭";
      }
    }
  }
  static class Program {
    [STAThread] static int Main(string[] args) {
      try {
        ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
        Plan plan;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("plan.json"))
        using (var reader = new StreamReader(stream)) plan = new JavaScriptSerializer().Deserialize<Plan>(reader.ReadToEnd());
        Publication.ValidatePlan(plan);
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new Window(plan)); return 0;
      } catch { MessageBox.Show("安装器无法启动。", "Mizar", MessageBoxButtons.OK, MessageBoxIcon.Error); return 1; }
    }
  }
}
