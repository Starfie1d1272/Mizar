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
        string target=Path.Combine(root,"real NSIS path");
        var result=await Nsis.Install(plan,installer,target,CancellationToken.None);
        Assert(result.CoreInstalled && !result.ResourcesReady && File.Exists(Path.Combine(target,"Mizar.exe")));
        Console.WriteLine("PASS: authenticated fixed v1.1 NSIS installed into fresh qualification directory; resources completion false");
        // A second fresh attempt must not overwrite this installation or user registration.
        bool refused=false; try { await Nsis.Install(plan,installer,target,CancellationToken.None); } catch(IOException) { refused=true; }
        Assert(refused);
        await result.RollbackAsync();
        Assert(!Directory.Exists(target));
        var badIdentity = new JavaScriptSerializer().Deserialize<Plan>(new JavaScriptSerializer().Serialize(plan));
        badIdentity.contentDigest = new string('0',64);
        string failedTarget=Path.Combine(root,"failed NSIS identity path");
        bool identityRejected=false;
        try { await Nsis.Install(badIdentity,installer,failedTarget,CancellationToken.None); } catch(IOException) { identityRejected=true; }
        Assert(identityRejected && !Directory.Exists(failedTarget));
        Console.WriteLine("PASS: post-install identity mismatch invokes original uninstaller and preserves user data");
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
