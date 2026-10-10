using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
namespace Mizar.WebInstaller {
  sealed class FixtureHandler : HttpMessageHandler {
    public Func<HttpRequestMessage, HttpResponseMessage> Reply;
    public int Calls;
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
      Calls++; token.ThrowIfCancellationRequested(); return Task.FromResult(Reply(request));
    }
  }
  sealed class IgnoreProgress : IProgress<long> { public void Report(long value) {} }
  sealed class CancelProgress : IProgress<long> {
    public CancellationTokenSource Source;
    public void Report(long value) { Source.Cancel(); }
  }
  static class Tests {
    static readonly byte[] body = new byte[] { 1, 2, 3, 4 };
    static Plan Good() {
      string sha; using (var hash = SHA256.Create()) sha = BitConverter.ToString(hash.ComputeHash(body)).Replace("-", "").ToLowerInvariant();
      return new Plan { schemaVersion=1, version="test", name="fixture.bin", bytes=4, sha256=sha,
        urls=new [] { "https://github.com/Starfie1d1272/Mizar/releases/download/test/fixture.bin" } };
    }
    static HttpResponseMessage Response(byte[] bytes) { return new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) }; }
    static void Assert(bool condition) { if (!condition) throw new Exception("Assertion failed"); }
    static async Task Reject(Func<Task> action) { try { await action(); } catch { return; } throw new Exception("Expected rejection"); }
    static void PublicationContract() {
      // Public-state fixtures only: these are not publisher authentication evidence.
      var plan=new Plan {schemaVersion=1,kind="nsis-setup",version="9.0.0",name="Mizar-v9.0.0-Windows-x64-Setup.exe",bytes=4,sha256=new string('a',64),gitSha=new string('b',40),contentDigest=new string('c',64),allowExecute=true,publicationRequired=true,coreName="Mizar-v9.0.0-Windows-x64.zip",coreBytes=8,coreSha256=new string('d',64),urls=new[]{"https://github.com/Starfie1d1272/Mizar/releases/download/v9.0.0/Mizar-v9.0.0-Windows-x64-Setup.exe"}};
      string json="{\"draft\":false,\"prerelease\":false,\"tag_name\":\"v9.0.0\",\"published_at\":\"2020-01-01T00:00:00Z\",\"assets\":[{\"name\":\""+plan.name+"\",\"size\":4,\"digest\":\"sha256:"+plan.sha256+"\",\"browser_download_url\":\""+plan.urls[0]+"\"},{\"name\":\""+plan.coreName+"\",\"size\":8,\"digest\":\"sha256:"+plan.coreSha256+"\",\"browser_download_url\":\"https://github.com/Starfie1d1272/Mizar/releases/download/v9.0.0/"+plan.coreName+"\"}]}";
      Publication.Check(json,plan);
      foreach(string bad in new[]{json.Replace("\"draft\":false","\"draft\":true"),json.Replace("\"prerelease\":false","\"prerelease\":true"),json.Replace("2020-01-01","2999-01-01"),json.Replace("\"tag_name\":\"v9.0.0\"","\"tag_name\":\"v8.0.0\""),json.Replace("\"size\":4","\"size\":5"),json.Replace("sha256:"+plan.sha256,"sha256:"+new string('e',64)),json.Replace("sha256:"+plan.coreSha256,"sha256:"+new string('e',64)),json.Replace("github.com/Starfie1d1272/Mizar/releases/download","evil.invalid/download"),json.Replace("\"assets\":[","\"assets\":[] ,\"ignored\":[")}) {
        bool rejected=false; try {Publication.Check(bad,plan);} catch {rejected=true;} Assert(rejected);
      }
      string firstAsset=json.Substring(json.IndexOf("[{",StringComparison.Ordinal)+1,json.IndexOf("},{",StringComparison.Ordinal)-json.IndexOf("[{",StringComparison.Ordinal));
      bool duplicateDenied=false; try {Publication.Check(json.Replace("[{","["+firstAsset+",{"),plan);} catch {duplicateDenied=true;} Assert(duplicateDenied);
      var corePlan=new System.Web.Script.Serialization.JavaScriptSerializer().Deserialize<Plan>(new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(plan));
      corePlan.name="Mizar-v9.0.0-Windows-x64-Core-Setup.exe";corePlan.coreName="Mizar-v9.0.0-Windows-x64-Core.zip";
      corePlan.urls=new[]{"https://github.com/Starfie1d1272/Mizar/releases/download/v9.0.0/"+corePlan.name};corePlan.updateManifestSha256=new string('f',64);
      Publication.Check(json.Replace(plan.name,corePlan.name),corePlan); // Core ZIP is not a consumer download.
      corePlan.updateManifestSha256="invalid";
      bool coreDenied=false;try{Publication.ValidatePlan(corePlan);}catch{coreDenied=true;}Assert(coreDenied);
      plan.publicationRequired=false;
      bool denied=false; try {Publication.ValidatePlan(plan);} catch {denied=true;} Assert(denied);
    }
    static async Task BoxOnly() {
      // Original v1.1 production manifest and both original signatures, unchanged.
      // This tests Native public-state transport. SDK cryptography is covered by
      // updates-source.test.ts; no installer is executed by this test.
      var serializer=new System.Web.Script.Serialization.JavaScriptSerializer();
      var plan=serializer.Deserialize<Plan>(File.ReadAllText("scripts/web-installer/legacy-stable-plan.json"));
      plan.publicationRequired=true;plan.coreName="Mizar-v1.1.0-Windows-x64.zip";plan.coreBytes=100070763;plan.coreSha256="1d3f0c98545718784e95792ce752efc3494ceec4816c7aa2d5f4e902a4160253";plan.boxReadToken="public-read-transport-test";
      string index=File.ReadAllText("apps/companion/test/fixtures/updates/update-index-v2.json");
      var handler=new FixtureHandler {Reply=request=>{
        Assert(request.RequestUri.Host=="box.nju.edu.cn"); // GitHub is unavailable.
        if(request.RequestUri.AbsolutePath.StartsWith("/api/")) {
          Assert(request.Headers.Contains("Authorization"));
          string path=Uri.UnescapeDataString(request.RequestUri.Query);
          if(request.RequestUri.AbsolutePath.EndsWith("/dir/")) return Response(System.Text.Encoding.UTF8.GetBytes(serializer.Serialize(new{repo_name="Mizar",user_perm="r",dirent_list=new[]{new{name=plan.name,size=plan.bytes,type="file"}}})));
          return Response(System.Text.Encoding.UTF8.GetBytes(serializer.Serialize("https://box.nju.edu.cn/seafhttp/files/original/"+(path.Contains("latest.json")?"latest.json":plan.name))));
        }
        Assert(request.Headers.Authorization==null);
        Assert(request.RequestUri.AbsolutePath.EndsWith("latest.json"));
        return Response(System.Text.Encoding.UTF8.GetBytes(index));
      }};
      using(var client=new HttpClient(handler)) {
        await Publication.Verify(plan,client,CancellationToken.None);
        string url=await Mirror.Resolve(plan,client,CancellationToken.None);
        Assert(new Uri(url).Host=="box.nju.edu.cn"&&url.EndsWith(plan.name));
      }
    }
    static async Task Run() {
      string root=Path.Combine(Path.GetTempPath(), "mizar-bootstrap-test-" + Guid.NewGuid());
      try {
        var handler=new FixtureHandler { Reply = r => { Assert(r.Headers.Authorization == null); return Response(body); } };
        using (var client=new HttpClient(handler)) {
          var downloader=new Downloader(client); var plan=Good();
          string result=await downloader.Download(plan, root, new IgnoreProgress(), CancellationToken.None);
          Assert(File.Exists(result) && handler.Calls==1);
          await downloader.Download(plan, root, new IgnoreProgress(), CancellationToken.None);
          Assert(handler.Calls==1); // persistent verified cache requires no network
          File.WriteAllText(result,"bad");
          handler.Reply=r=>Response(new byte[]{9,9,9,9});
          await Reject(()=>downloader.Download(plan,root,new IgnoreProgress(),CancellationToken.None));
          Assert(!File.Exists(result+".part"));
          handler.Reply=r=>Response(new byte[]{1,2});
          await Reject(()=>downloader.Download(plan,root,new IgnoreProgress(),CancellationToken.None));
          handler.Reply=r=>Response(new byte[]{1,2,3,4,5});
          await Reject(()=>downloader.Download(plan,root,new IgnoreProgress(),CancellationToken.None));
          handler.Reply=r=>new HttpResponseMessage(HttpStatusCode.Redirect) { Headers={Location=new Uri("https://evil.invalid/file")} };
          int before=handler.Calls;
          await Reject(()=>downloader.Download(plan,root,new IgnoreProgress(),CancellationToken.None));
          Assert(handler.Calls==before+1);
          handler.Reply=r=> { throw new HttpRequestException("offline"); };
          await Reject(()=>downloader.Download(plan,root,new IgnoreProgress(),CancellationToken.None));
          plan.urls=new[]{plan.urls[0],plan.urls[0].Replace("fixture.bin","fallback.bin")};
          handler.Reply=r=>r.RequestUri.AbsolutePath.EndsWith("fallback.bin") ? Response(body) : new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
          result=await downloader.Download(plan,root,new IgnoreProgress(),CancellationToken.None);
          Assert(Downloader.Matches(result,plan));
          File.Delete(result);
          int retryCalls=0;
          handler.Reply=r=>++retryCalls==1 ? new HttpResponseMessage(HttpStatusCode.ServiceUnavailable) : Response(body);
          result=await downloader.Download(plan,root,new IgnoreProgress(),CancellationToken.None);
          Assert(retryCalls==2 && Downloader.Matches(result,plan));
          var cancelled=new CancellationTokenSource(); cancelled.Cancel();
          await Reject(()=>downloader.Download(plan,root,new IgnoreProgress(),cancelled.Token));
          File.Delete(result);
          handler.Reply=r=>Response(body);
          var during=new CancellationTokenSource();
          await Reject(()=>downloader.Download(plan,root,new CancelProgress { Source=during },during.Token));
          Assert(!File.Exists(result) && !File.Exists(result+".part"));
          plan.name="../fixture.bin";
          await Reject(()=>downloader.Download(plan,root,new IgnoreProgress(),CancellationToken.None));
          plan=Good(); plan.allowExecute=true;
          await Reject(()=>downloader.Download(plan,root,new IgnoreProgress(),CancellationToken.None));
          Assert(!Downloader.Allowed(new Uri("http://github.com/Starfie1d1272/Mizar/releases/download/test/a")));
          Assert(!Downloader.Allowed(new Uri("https://github.com:444/Starfie1d1272/Mizar/releases/download/test/a")));
        }
      } finally { if(Directory.Exists(root)) Directory.Delete(root,true); }
    }
    [STAThread] public static int Main() { try { PublicationContract(); BoxOnly().GetAwaiter().GetResult(); Run().GetAwaiter().GetResult(); WindowTests.Run(); Console.WriteLine("PASS: bounded download, hash, truncation, redirect, cancellation, fallback, cache and execution denial"); return 0; } catch(Exception e) { Console.Error.WriteLine(e); return 1; } }
  }
}
