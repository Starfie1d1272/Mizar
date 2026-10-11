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
  // Real HTTP/1.1 sockets, with test-only routing of the approved HTTPS origin
  // to loopback. Production URL/TLS policy has no loopback exemption.
  sealed class RangeServer : IDisposable {
    internal sealed class Reply {
      public int status=200;
      public string headers="";
      public byte[] body;
      public long length;
      public bool hold;
    }
    readonly System.Net.Sockets.TcpListener listener;
    readonly Task serving;
    Exception failure;
    public Func<System.Collections.Generic.Dictionary<string,string>, Reply> Respond;
    public int Calls;
    public readonly TaskCompletionSource<bool> Release = new TaskCompletionSource<bool>();
    public readonly Uri Address;
    public RangeServer() {
      listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback, 0); listener.Start();
      Address = new Uri("http://127.0.0.1:" + ((IPEndPoint)listener.LocalEndpoint).Port + "/fixture");
      serving = Task.Run(async () => {
        while (true) {
          System.Net.Sockets.TcpClient connection;
          try { connection = await listener.AcceptTcpClientAsync(); }
          catch (ObjectDisposedException) { return; }
          catch (System.Net.Sockets.SocketException) { return; }
          catch (InvalidOperationException) { return; }
          using (connection) using (var stream = connection.GetStream()) {
            var headers = new System.Collections.Generic.Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
            var reader = new StreamReader(stream, System.Text.Encoding.ASCII, false, 1024, true);
            headers["request"] = await reader.ReadLineAsync();
            if (headers["request"] == null) continue;
            string line;
            while (!String.IsNullOrEmpty(line = await reader.ReadLineAsync())) {
              int colon = line.IndexOf(':');
              if (colon > 0) headers[line.Substring(0,colon)] = line.Substring(colon+1).Trim();
            }
            Calls++;
            Reply reply;
            try { reply = Respond(headers); }
            catch (Exception error) { failure=error; reply=new Reply {status=500,length=0}; }
            byte[] head = System.Text.Encoding.ASCII.GetBytes("HTTP/1.1 " + reply.status + " Fixture\r\nContent-Length: " + reply.length + "\r\nConnection: close\r\n" + reply.headers + "\r\n");
            try {
              await stream.WriteAsync(head,0,head.Length);
              if (reply.body != null) await stream.WriteAsync(reply.body,0,reply.body.Length);
              if (reply.hold) await Release.Task;
            } catch (IOException) { /* A cancelled client may close the socket. */ }
          }
        }
      });
    }
    public void Dispose() { Release.TrySetResult(true); listener.Stop(); serving.GetAwaiter().GetResult(); if(failure!=null) throw new Exception("HTTP fixture assertion failed",failure); }
  }
  sealed class LoopbackRoute : HttpMessageHandler {
    readonly HttpClient wire = new HttpClient(new HttpClientHandler {AllowAutoRedirect=false, UseProxy=false, UseCookies=false}) {Timeout=Timeout.InfiniteTimeSpan};
    readonly Uri address;
    public LoopbackRoute(Uri value) { address=value; }
    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
      using (var routed = new HttpRequestMessage(request.Method, address)) {
        foreach (var header in request.Headers) routed.Headers.TryAddWithoutValidation(header.Key,header.Value);
        routed.Headers.Add("X-Fixture-Source",request.RequestUri.AbsoluteUri);
        return await wire.SendAsync(routed,HttpCompletionOption.ResponseHeadersRead,token);
      }
    }
    protected override void Dispose(bool disposing) { if (disposing) wire.Dispose(); base.Dispose(disposing); }
  }
  sealed class ObserveProgress : IProgress<long> {
    public readonly System.Collections.Generic.List<long> Values = new System.Collections.Generic.List<long>();
    public CancellationTokenSource Cancel;
    public Action<long> Observe;
    public void Report(long value) { if(Observe!=null) Observe(value); Values.Add(value); if (Cancel != null && value > 0) Cancel.Cancel(); }
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
    static void RecoveryContracts() {
      string pending=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Mizar","bootstrap-cache","fresh-install.pending");
      Directory.CreateDirectory(Path.GetDirectoryName(pending));
      if(File.Exists(pending)) throw new IOException("Refusing to replace an existing recovery record");
      string root=Path.Combine(Path.GetTempPath(),"Mizar-WebInstaller-Qualification",Guid.NewGuid().ToString("N"));
      string target=Path.Combine(root,"owned fresh install"); Directory.CreateDirectory(target);
      var plan=Good(); var record=Nsis.NewPending(plan,target,"unused-fixture-installer");
      File.WriteAllText(Path.Combine(target,".mizar-bootstrap-owner"),record.token);
      string retained=target+".incomplete-"+record.token;
      try {
        Nsis.SavePending(record,true);
        bool rejected=false;try {Nsis.RecoverPending(plan,target);} catch(InstallerRecoveryRequired) {rejected=true;}
        Assert(rejected && Directory.Exists(target) && File.Exists(pending));
        long endedAt; int endedPid;
        using(var child=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo {FileName="cmd.exe",Arguments="/c exit 0",UseShellExecute=false,CreateNoWindow=true})) {
          endedPid=child.Id;endedAt=child.StartTime.ToUniversalTime().Ticks;child.WaitForExit();
        }
        Assert(!Nsis.ProcessStillActive(endedPid,endedAt));
        using(var current=System.Diagnostics.Process.GetCurrentProcess()) {
          record.ownerPid=endedPid;record.ownerStarted=endedAt;record.writerPid=current.Id;record.writerStarted=current.StartTime.ToUniversalTime().Ticks;record.stage="writing";
          Nsis.SavePending(record,false);
          rejected=false;try {Nsis.RecoverPending(plan,target);} catch(InstallerRecoveryRequired) {rejected=true;}
          Assert(rejected && Directory.Exists(target) && File.Exists(pending));
        }
        foreach(string invalid in new[]{target,"{broken","{}"}) {
          File.WriteAllText(pending,invalid);
          rejected=false;try {Nsis.RecoverPending(plan,target);} catch(InstallerRecoveryRequired) {rejected=true;}
          Assert(rejected && File.ReadAllText(pending)==invalid && Directory.Exists(target));
        }
        record.writerPid=0; record.writerStarted=0; record.stage="prepared"; Nsis.SavePending(record,false);
        Assert(!Nsis.RecoverPending(plan,target) && !Directory.Exists(target) && !File.Exists(pending));
        // The next transaction creates the deleted marker, rather than replacing it.
        Directory.CreateDirectory(target); File.WriteAllText(Path.Combine(target,".mizar-bootstrap-owner"),record.token);
        Nsis.SavePending(record,!File.Exists(pending)); Assert(File.Exists(pending));
        record.writerPid=endedPid;record.writerStarted=endedAt;record.stage="rollback-writing"; Nsis.SavePending(record,false);
        File.WriteAllText(Path.Combine(target,"unknown-user-file"),"preserve exactly");
        Assert(!Nsis.RecoverPending(plan,target));
        Assert(!Directory.Exists(target) && File.ReadAllText(Path.Combine(retained,"unknown-user-file"))=="preserve exactly" && File.Exists(pending));
        Assert(!Nsis.RecoverPending(plan,target)); // Restart after quarantine also preserves the original bytes.
        Assert(File.ReadAllText(Path.Combine(retained,"unknown-user-file"))=="preserve exactly");
        Console.WriteLine("PASS: legacy/corrupt pending records and live writers stay intact; owned partial installation is retained across recovery restart");
      } finally {
        File.Delete(pending);
        // Only the fixture's new GUID root, never a user's installation.
        if(Directory.Exists(root)) Directory.Delete(root,true);
      }
    }
    static RangeServer.Reply WireReply(int status, string headers, byte[] bytes) {
      return new RangeServer.Reply {status=status, headers=headers, body=bytes, length=bytes.Length};
    }
    static byte[] RangePayload() {
      byte[] payload=new byte[256*1024]; for(int i=0;i<payload.Length;i++) payload[i]=(byte)(i*17+3);
      return payload;
    }
    static Plan RangePlan() {
      var plan=Good(); byte[] payload=RangePayload(); plan.bytes=payload.Length;
      using(var hash=SHA256.Create()) plan.sha256=BitConverter.ToString(hash.ComputeHash(payload)).Replace("-","").ToLowerInvariant();
      return plan;
    }
    static async Task CancelRange(Uri address, string root) {
      using(var cancelled=new CancellationTokenSource())
      using(var client=new HttpClient(new LoopbackRoute(address))) {
        try { await new Downloader(client).Download(RangePlan(),root,new ObserveProgress {Cancel=cancelled},cancelled.Token); throw new Exception("Cancellation was ignored"); }
        catch(OperationCanceledException) { Assert(cancelled.IsCancellationRequested); }
      }
    }
    static async Task SeedPartial(RangeServer server, Plan plan, byte[] payload, string validator, string root, string target) {
      string part=target+".part";
      if(File.Exists(target)) File.Delete(target);
      server.Respond=h=> {Assert(!h.ContainsKey("Range"));return WireReply(200,validator,payload);};
      await CancelRange(server.Address,root);
      Assert(!File.Exists(target) && File.Exists(part) && File.Exists(part+".json"));
      Assert(new FileInfo(part).Length>0 && new FileInfo(part).Length<plan.bytes);
    }
    static async Task RangeContracts() {
      byte[] payload=RangePayload(); var plan=RangePlan();
      string root=Path.Combine(Path.GetTempPath(),"mizar-range-"+Guid.NewGuid().ToString("N"));
      string target=Path.Combine(root,plan.sha256+"-"+plan.name), part=target+".part";
      string validator="ETag: \"qualified-transport\"\r\n";
      try {
        using(var server=new RangeServer()) {
          Func<System.Collections.Generic.Dictionary<string,string>,RangeServer.Reply> remaining=h=> {
            long offset=new FileInfo(part).Length;
            Assert(h["Range"]=="bytes="+offset+"-" && h["If-Range"]=="\"qualified-transport\"");
            Assert(h["Accept-Encoding"]=="identity" && !h.ContainsKey("Authorization"));
            var suffix=new byte[payload.Length-(int)offset];Array.Copy(payload,(int)offset,suffix,0,suffix.Length);
            return WireReply(206,validator+"Content-Range: bytes "+offset+"-"+(payload.Length-1)+"/"+payload.Length+"\r\n",suffix);
          };
          // New clients/downloaders have no in-memory state from the cancelled run.
          Console.WriteLine("Range: cancelled download and persistent suffix");
          await SeedPartial(server,plan,payload,validator,root,target); long retained=new FileInfo(part).Length; int calls=server.Calls;
          server.Respond=remaining;
          var progress=new ObserveProgress();
          using(var client=new HttpClient(new LoopbackRoute(server.Address))) {
            string result=await new Downloader(client).Download(plan,root,progress,CancellationToken.None);
            Assert(result==target && Downloader.Matches(result,plan) && server.Calls==calls+1);
            Assert(progress.Values[0]==retained && progress.Values[progress.Values.Count-1]==plan.bytes);
            for(int i=1;i<progress.Values.Count;i++) Assert(progress.Values[i]>=progress.Values[i-1] && progress.Values[i]<=plan.bytes);
          }
          Assert(!File.Exists(part) && !File.Exists(part+".json"));
          // Cancel while the server keeps the body open without further bytes.
          // This verifies actual socket-read cancellation, rather than only a
          // token checked between already-buffered reads.
          File.Delete(target);
          byte[] stalledPrefix=new byte[65536];Array.Copy(payload,stalledPrefix,stalledPrefix.Length);
          server.Respond=h=>new RangeServer.Reply {headers=validator,body=stalledPrefix,length=payload.Length,hold=true};
          using(var stopped=new CancellationTokenSource())
          using(var client=new HttpClient(new LoopbackRoute(server.Address))) {
            var written=new TaskCompletionSource<bool>();
            var pending=new Downloader(client).Download(plan,root,new ObserveProgress {Observe=value=> {if(value==stalledPrefix.Length) written.TrySetResult(true);}},stopped.Token);
            Assert(await Task.WhenAny(written.Task,Task.Delay(10000))==written.Task);
            await Task.Delay(100);stopped.Cancel();
            Assert(await Task.WhenAny(pending,Task.Delay(10000))==pending);
            try {await pending;throw new Exception("Blocked download ignored cancellation");} catch(OperationCanceledException) {}
          }
          Assert(new FileInfo(part).Length==stalledPrefix.Length && !File.Exists(target));
          server.Release.TrySetResult(true);server.Respond=remaining;
          using(var client=new HttpClient(new LoopbackRoute(server.Address))) await new Downloader(client).Download(plan,root,new IgnoreProgress(),CancellationToken.None);
          Assert(Downloader.Matches(target,plan));
          // The partial also survives exit of a separate native test process.
          File.Delete(target);
          server.Respond=h=> {Assert(!h.ContainsKey("Range"));return WireReply(200,validator,payload);};
          string executable=System.Reflection.Assembly.GetExecutingAssembly().Location;
          string arguments="--range-cancel \""+server.Address.AbsoluteUri+"\" \""+root+"\"";
          using(var current=System.Diagnostics.Process.GetCurrentProcess()) {
            if(Path.GetFileName(current.MainModule.FileName).StartsWith("mono",StringComparison.Ordinal)) {
              arguments="\""+executable+"\" "+arguments;executable=current.MainModule.FileName;
            }
          }
          using(var child=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo {FileName=executable,Arguments=arguments,UseShellExecute=false,CreateNoWindow=true})) {
            // Keep accepting fixture requests while the child downloads/cancels.
            bool exited=await Task.Run(()=>child.WaitForExit(30000));
            if(!exited) {child.Kill();child.WaitForExit();throw new Exception("Range cancellation fixture process did not exit");}
            Assert(child.ExitCode==0 && File.Exists(part));
          }
          server.Respond=remaining;
          using(var client=new HttpClient(new LoopbackRoute(server.Address))) await new Downloader(client).Download(plan,root,new IgnoreProgress(),CancellationToken.None);
          Assert(Downloader.Matches(target,plan));
          // Range ignored (or If-Range failed): consume 200 from zero, never append.
          await SeedPartial(server,plan,payload,validator,root,target);server.Respond=h=> {Assert(h.ContainsKey("Range"));return WireReply(200,"ETag: \"changed\"\r\n",payload);};
          using(var client=new HttpClient(new LoopbackRoute(server.Address))) {
            await new Downloader(client).Download(plan,root,new IgnoreProgress(),CancellationToken.None);
            Assert(Downloader.Matches(target,plan));
          }
          // Malformed/resized/changed/encoded ranges must never enter the cache;
          // an independent next full response recovers within the bounded retry.
          foreach(string fault in new[]{"start","end","total","missing","etag","weak","416","length","encoding","endpoint"}) {
            Console.WriteLine("Range response fault: "+fault);
            await SeedPartial(server,plan,payload,validator,root,target);calls=server.Calls;int ranged=0;
            server.Respond=h=> {
              if(!h.ContainsKey("Range")) return WireReply(200,validator,payload);
              ranged++;
              var response=remaining(h);
              long offset=new FileInfo(part).Length;
              if(fault=="start") response.headers=response.headers.Replace("bytes "+offset+"-","bytes 0-");
              if(fault=="end") response.headers=response.headers.Replace("-"+(payload.Length-1)+"/","-"+(payload.Length-2)+"/");
              if(fault=="total") response.headers=response.headers.Replace("/"+payload.Length,"/"+(payload.Length+1));
              if(fault=="missing") response.headers=validator;
              if(fault=="etag") response.headers=response.headers.Replace("qualified-transport","different");
              if(fault=="weak") response.headers=response.headers.Replace("ETag: ","ETag: W/");
              if(fault=="416") response=WireReply(416,"Content-Range: bytes */"+payload.Length+"\r\n",new byte[0]);
              if(fault=="length") response.length++;
              if(fault=="encoding") response.headers+="Content-Encoding: gzip\r\n";
              return response;
            };
            if(fault=="endpoint") {
              string record=File.ReadAllText(part+".json");
              // source must remain identical; only the redirect endpoint changes.
              var serializer=new System.Web.Script.Serialization.JavaScriptSerializer();
              var data=serializer.Deserialize<System.Collections.Generic.Dictionary<string,object>>(record);
              data["endpoint"]=plan.urls[0].Replace("fixture.bin","different.bin");
              File.WriteAllText(part+".json",serializer.Serialize(data));
            }
            using(var client=new HttpClient(new LoopbackRoute(server.Address))) {
              if(fault=="length" || fault=="encoding") {
                await Reject(()=>new Downloader(client).Download(plan,root,new IgnoreProgress(),CancellationToken.None));
                Assert(!File.Exists(target) && !File.Exists(part) && !File.Exists(part+".json"));
              } else {
                await new Downloader(client).Download(plan,root,new IgnoreProgress(),CancellationToken.None);
                Assert(Downloader.Matches(target,plan) && server.Calls==calls+2);
              }
            }
            Assert(ranged==1);
          }
          // Local partial tampering and a same-length corrupt response still fail
          // the independently pinned complete hash, regardless of ETag agreement.
          foreach(bool local in new[]{false,true}) {
            await SeedPartial(server,plan,payload,validator,root,target);
            if(local) {var bytes=File.ReadAllBytes(part);bytes[0]^=255;File.WriteAllBytes(part,bytes);}
            server.Respond=h=> {var response=remaining(h);if(!local) response.body[0]^=255;return response;};
            using(var client=new HttpClient(new LoopbackRoute(server.Address))) await Reject(()=>new Downloader(client).Download(plan,root,new IgnoreProgress(),CancellationToken.None));
            Assert(!File.Exists(target) && !File.Exists(part) && !File.Exists(part+".json"));
          }
          // Identity and mirror changes, torn metadata and unsafe local paths
          // never reuse prior bytes, even when the expected payload hash is equal.
          foreach(string change in new[]{"identity","mirror","record","orphan","oversize"}) {
            await SeedPartial(server,plan,payload,validator,root,target);string version=plan.version, source=plan.urls[0];
            if(change=="identity") plan.version="different-qualified-version";
            if(change=="mirror") plan.urls=new[]{"https://box.nju.edu.cn/seafhttp/files/mirror/fixture.bin"};
            if(change=="record") File.WriteAllText(part+".json","{torn");
            if(change=="orphan") File.Delete(part+".json");
            if(change=="oversize") using(var file=new FileStream(part,FileMode.Open)) file.SetLength(plan.bytes+1);
            server.Respond=h=> {Assert(!h.ContainsKey("Range"));return WireReply(200,validator,payload);};
            using(var client=new HttpClient(new LoopbackRoute(server.Address))) await new Downloader(client).Download(plan,root,new IgnoreProgress(),CancellationToken.None);
            Assert(Downloader.Matches(target,plan));plan.version=version;plan.urls=new[]{source};
          }
          // A short real response retains its validated transport identity and
          // retries only the suffix; absent/weak ETags restart with a full GET.
          foreach(string tag in new[]{validator,"","ETag: W/\"weak\"\r\n"}) {
            File.Delete(target);int first=server.Calls;
            server.Respond=h=> {
              if(server.Calls==first+1) {var prefix=new byte[65536];Array.Copy(payload,prefix,prefix.Length);return new RangeServer.Reply {headers=tag,body=prefix,length=payload.Length};}
              if(tag==validator) return remaining(h);
              Assert(!h.ContainsKey("Range"));return WireReply(200,tag,payload);
            };
            using(var client=new HttpClient(new LoopbackRoute(server.Address))) await new Downloader(client).Download(plan,root,new IgnoreProgress(),CancellationToken.None);
            Assert(Downloader.Matches(target,plan) && server.Calls==first+2);
          }
          // A real allowed redirect endpoint change also restarts instead of
          // combining bytes from two signed download URLs, even with equal ETag.
          await SeedPartial(server,plan,payload,validator,root,target);
          int redirectedRanges=0;
          server.Respond=h=> {
            if(h["X-Fixture-Source"]==plan.urls[0]) return WireReply(302,"Location: https://release-assets.githubusercontent.com/changed-fixture\r\n",new byte[0]);
            if(h.ContainsKey("Range")) {redirectedRanges++;return remaining(h);}
            return WireReply(200,validator,payload);
          };
          using(var client=new HttpClient(new LoopbackRoute(server.Address))) await new Downloader(client).Download(plan,root,new IgnoreProgress(),CancellationToken.None);
          Assert(redirectedRanges==1 && Downloader.Matches(target,plan));
          // All bytes written before cancellation are still untrusted until the
          // next process verifies them; no network or executable admission shortcut.
          await SeedPartial(server,plan,payload,validator,root,target);
          File.WriteAllBytes(part,payload);calls=server.Calls;
          using(var client=new HttpClient(new LoopbackRoute(server.Address))) await new Downloader(client).Download(plan,root,new IgnoreProgress(),CancellationToken.None);
          Assert(Downloader.Matches(target,plan) && server.Calls==calls);
          // An unavailable original source must clear its bytes before fallback.
          await SeedPartial(server,plan,payload,validator,root,target);
          string primary=plan.urls[0];plan.urls=new[]{primary,"https://box.nju.edu.cn/seafhttp/files/mirror/fixture.bin"};
          int transient=0;
          server.Respond=h=> {
            if(h.ContainsKey("Range")) {transient++;return WireReply(503,"",new byte[0]);}
            Assert(!File.Exists(part));return WireReply(200,validator,payload);
          };
          using(var client=new HttpClient(new LoopbackRoute(server.Address))) await new Downloader(client).Download(plan,root,new IgnoreProgress(),CancellationToken.None);
          Assert(transient==2 && Downloader.Matches(target,plan));plan.urls=new[]{primary};
          Console.WriteLine("PASS: real HTTP Range/If-Range restart, cancellation, truncation, validators, invalid 206/416, mirror/identity isolation, progress and pinned hash");
        }
      } finally {if(Directory.Exists(root)) Directory.Delete(root,true);}
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
          // Cross-run transport caches must reject same-length byte tampering,
          // acquire correct bytes, then keep the normal zero-network reuse path.
          File.WriteAllBytes(result,new byte[]{9,9,9,9});
          int beforeRepair=handler.Calls;
          result=await downloader.Download(plan,root,new IgnoreProgress(),CancellationToken.None);
          Assert(handler.Calls==beforeRepair+1 && Downloader.Matches(result,plan));
          await downloader.Download(plan,root,new IgnoreProgress(),CancellationToken.None);
          Assert(handler.Calls==beforeRepair+1);
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
    [STAThread] public static int Main(string[] args) { try { if(args.Length==3 && args[0]=="--range-cancel") {CancelRange(new Uri(args[1]),args[2]).GetAwaiter().GetResult();return 0;} PublicationContract(); RecoveryContracts(); BoxOnly().GetAwaiter().GetResult(); Run().GetAwaiter().GetResult(); RangeContracts().GetAwaiter().GetResult(); WindowTests.Run(); Console.WriteLine("PASS: bounded download, hash, truncation, redirect, cancellation, fallback, cache and execution denial"); return 0; } catch(Exception e) { Console.Error.WriteLine(e); return 1; } }
  }
}
