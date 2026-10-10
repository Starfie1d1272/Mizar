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
    [STAThread] public static int Main() { try { Run().GetAwaiter().GetResult(); WindowTests.Run(); Console.WriteLine("PASS: bounded download, hash, truncation, redirect, cancellation, fallback, cache and execution denial"); return 0; } catch(Exception e) { Console.Error.WriteLine(e); return 1; } }
  }
}
