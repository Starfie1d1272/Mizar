using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace Mizar.WebInstaller {
  sealed class CancelNsisProgress : IProgress<string> {
    public readonly CancellationTokenSource Source = new CancellationTokenSource();
    public bool Waiting;
    public void Report(string phase) {
      if (phase == "installing-core") Source.CancelAfter(100);
      if (phase == "waiting-for-installer") Waiting = true;
    }
  }
  static class NsisTests {
    static void Assert(bool value) { if (!value) throw new Exception("NSIS assertion failed"); }
    static async Task Run() {
      Plan plan;
      using (var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("legacy-plan.json"))
      using (var reader=new StreamReader(stream)) plan=new JavaScriptSerializer().Deserialize<Plan>(reader.ReadToEnd());
      string root=Path.Combine(Path.GetTempPath(), "Mizar-WebInstaller-Qualification", Guid.NewGuid().ToString());
      string cache=Path.Combine(root,"downloads"); Directory.CreateDirectory(root);
      bool complete=false;
      try {
        string installer;
        using (var handler=new HttpClientHandler { AllowAutoRedirect=false, UseCookies=false })
        using (var client=new HttpClient(handler) { Timeout=Timeout.InfiniteTimeSpan })
          installer=await new Downloader(client).Download(plan,cache,new IgnoreProgress(),CancellationToken.None);
        string pending=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Mizar","bootstrap-cache","fresh-install.pending");
        Directory.CreateDirectory(Path.GetDirectoryName(pending));
        using (var marker=new FileStream(pending,FileMode.CreateNew,FileAccess.Write,FileShare.None)) { marker.Flush(true); }
        try {
          bool pendingRejected=false;
          string guardedTarget=Path.Combine(root,"pending recovery path");
          try { await Nsis.Install(plan,installer,guardedTarget,CancellationToken.None); }
          catch(InstallerRecoveryRequired) { pendingRejected=true; }
          Assert(pendingRejected && !Directory.Exists(guardedTarget) && File.Exists(pending));
          Console.WriteLine("PASS: persistent unfinished-install marker rejects a new writer and remains intact");
        } finally { File.Delete(pending); } // Only this test's exclusively created marker.
        string target=Path.Combine(root,"real NSIS path");
        // Recover the real prepared transaction through Install, including the
        // deleted marker's recreation and subsequent NSIS installation.
        Directory.CreateDirectory(target);
        var prepared=Nsis.NewPending(plan,target,installer);
        using(var exited=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo {FileName="cmd.exe",Arguments="/c exit 0",UseShellExecute=false,CreateNoWindow=true})) {
          prepared.ownerPid=exited.Id;prepared.ownerStarted=exited.StartTime.ToUniversalTime().Ticks;exited.WaitForExit();
        }
        File.WriteAllText(Path.Combine(target,".mizar-bootstrap-owner"),prepared.token);Nsis.SavePending(prepared,true);
        var result=await Nsis.Install(plan,installer,target,CancellationToken.None);
        Assert(!File.Exists(pending));
        Console.WriteLine("PASS: prepared owner-only transaction reopens and completes real NSIS installation");
        Assert(result.CoreInstalled && !result.ResourcesReady && File.Exists(Path.Combine(target,"Mizar.exe")));
        Console.WriteLine("PASS: authenticated fixed v1.1 NSIS installed into fresh qualification directory; resources completion false");
        // Exercise the real native production call: historical Core cannot supply
        // a new executable entry from an external qualification directory.
        bool missingEntry=false;
        try { await Nsis.RunResourceBridge(plan,target,CancellationToken.None); }
        catch(InstallerActionRequired error) { missingEntry=error.InnerException!=null && error.InnerException.Message.Contains("缺少在线安装入口"); }
        Assert(missingEntry);
        Console.WriteLine("PASS: native production bridge refuses historical Core without its authenticated packaged entry");
        // Separately verify current App/SDK integration against these real Core bytes.
        string bridgeScript=Environment.GetEnvironmentVariable("MIZAR_BRIDGE_SCRIPT");
        if (!String.IsNullOrEmpty(bridgeScript)) {
          string bridgeModule=Environment.GetEnvironmentVariable("MIZAR_BRIDGE_MODULE");
          string planPath=Environment.GetEnvironmentVariable("MIZAR_BRIDGE_PLAN");
          string node=Environment.GetEnvironmentVariable("MIZAR_BRIDGE_NODE");
          foreach(string argument in new[]{bridgeScript,bridgeModule,planPath,node,target})
            if(String.IsNullOrEmpty(argument) || argument.IndexOfAny(new char[]{'"','\r','\n'})>=0)
              throw new IOException("Invalid qualification bridge arguments");
          using(var bridge=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo {
            FileName=node, Arguments="\""+bridgeScript+"\" \""+bridgeModule+"\" \""+target+"\" \""+planPath+"\"", UseShellExecute=false, CreateNoWindow=true, RedirectStandardOutput=true, RedirectStandardError=true
          })) {
            var stdout=bridge.StandardOutput.ReadToEndAsync();
            var stderr=bridge.StandardError.ReadToEndAsync();
            if(!bridge.WaitForExit(120000)) throw new IOException("Real installed Core bootstrap boundary timed out");
            Console.WriteLine(await stdout);
            Console.Error.WriteLine(await stderr);
            if(bridge.ExitCode!=0) throw new IOException("Real installed Core bootstrap boundary failed (exit "+bridge.ExitCode+")");
          }
          Console.WriteLine("PASS: real NSIS-installed Core and deployed App bridge deny incomplete official resource installation");
        }
        // A second fresh attempt must not overwrite this installation or user registration.
        bool refused=false; try { await Nsis.Install(plan,installer,target,CancellationToken.None); } catch(IOException) { refused=true; }
        Assert(refused);
        var completed=Nsis.NewPending(plan,target,installer);
        completed.token=File.ReadAllText(Path.Combine(target,".mizar-bootstrap-owner"));
        completed.ownerPid=prepared.ownerPid;completed.ownerStarted=prepared.ownerStarted;
        completed.writerPid=prepared.ownerPid;completed.writerStarted=prepared.ownerStarted;completed.stage="complete";
        Nsis.SavePending(completed,true);
        result=await Nsis.Install(plan,installer,target,CancellationToken.None);
        Assert(result.CoreInstalled && !File.Exists(pending));
        Console.WriteLine("PASS: completed owned Core recovers without launching a second NSIS writer");
        await result.RollbackAsync();
        Assert(!Directory.Exists(target));
        var badIdentity = new JavaScriptSerializer().Deserialize<Plan>(new JavaScriptSerializer().Serialize(plan));
        badIdentity.contentDigest = new string('0',64);
        string failedTarget=Path.Combine(root,"failed NSIS identity path");
        bool identityRejected=false;
        try { await Nsis.Install(badIdentity,installer,failedTarget,CancellationToken.None); } catch(IOException) { identityRejected=true; }
        Assert(identityRejected && !Directory.Exists(failedTarget));
        Console.WriteLine("PASS: post-install identity mismatch invokes original uninstaller and cleans the fresh target");
        var progress=new CancelNsisProgress();
        bool cancelled=false;
        string cancelledTarget=Path.Combine(root,"cancelled NSIS path");
        try { await Nsis.Install(plan,installer,cancelledTarget,progress.Source.Token,progress); }
        catch(OperationCanceledException) { cancelled=true; }
        Assert(cancelled && progress.Waiting && !Directory.Exists(cancelledTarget));
        Console.WriteLine("PASS: cancellation waits for NSIS exit and existing uninstaller cleans fresh installation; waiting="+progress.Waiting);
        string bad=Path.Combine(cache,"bad.exe"); File.WriteAllText(bad,"not an installer");
        bool rejected=false; try { await Nsis.Install(plan,bad,Path.Combine(root,"bad path"),CancellationToken.None); } catch(IOException) { rejected=true; }
        Assert(rejected);
        Console.WriteLine("PASS: mismatched installer never executed; existing installation never replaced");
        complete=true;
      } finally {
        // Cleanup only this explicitly isolated qualification root; production Nsis does no recursive delete.
        if(complete && Directory.Exists(root)) Directory.Delete(root,true);
      }
    }
    public static int Main() {
      try { ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12; Run().GetAwaiter().GetResult(); return 0; }
      catch(Exception e) { Console.Error.WriteLine(e); return 1; }
    }
  }
}
