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
  // Observe existing production phases without changing scheduling or assertions.
  sealed class NativeUpdateTiming : IProgress<string> {
    readonly System.Diagnostics.Stopwatch clock=System.Diagnostics.Stopwatch.StartNew();
    string previous;
    public void Report(string phase) {
      if(phase==previous) return;
      previous=phase;
      Console.WriteLine("TIMING: native update phase "+phase+" at "+clock.Elapsed.TotalSeconds.ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+"s");
    }
  }
  static class NsisTests {
    static void Assert(bool value) { if (!value) throw new Exception("NSIS assertion failed"); }
    static string Hash(string path) {using(var file=File.OpenRead(path)) using(var hash=System.Security.Cryptography.SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(file)).Replace("-","").ToLowerInvariant();}
    static string timingOutput;
    static readonly System.Collections.Generic.List<string> cases = new System.Collections.Generic.List<string>();
    static void Passed(string name) { cases.Add(name); }
    static async Task Run(string group, string downloadCache) {
      Plan plan;
      using (var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("legacy-plan.json"))
      using (var reader=new StreamReader(stream)) plan=new JavaScriptSerializer().Deserialize<Plan>(reader.ReadToEnd());
      string root=Path.Combine(Path.GetTempPath(), "Mizar-WebInstaller-Qualification", Guid.NewGuid().ToString());
      string cache=downloadCache ?? Path.Combine(root,"downloads"); Directory.CreateDirectory(root);
      bool complete=false;
      try {
        string installer;
        var downloadClock=System.Diagnostics.Stopwatch.StartNew();
        using (var handler=new HttpClientHandler { AllowAutoRedirect=false, UseCookies=false })
        using (var client=new HttpClient(handler) { Timeout=Timeout.InfiniteTimeSpan })
          installer=await new Downloader(client).Download(plan,cache,new IgnoreProgress(),CancellationToken.None);
        Console.WriteLine("TIMING: verified installer acquisition "+downloadClock.Elapsed.TotalSeconds.ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+"s");
        string pending=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Mizar","bootstrap-cache","fresh-install.pending");
        int ownerPid=0;long ownerStarted=0;
        using(var exited=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo {FileName="cmd.exe",Arguments="/c exit 0",UseShellExecute=false,CreateNoWindow=true})) {
          ownerPid=exited.Id;ownerStarted=exited.StartTime.ToUniversalTime().Ticks;exited.WaitForExit();
        }
        if(group=="all" || group=="update") {
          Directory.CreateDirectory(Path.GetDirectoryName(pending));
          using (var marker=new FileStream(pending,FileMode.CreateNew,FileAccess.Write,FileShare.None)) { marker.Flush(true); }
          try {
            bool pendingRejected=false;
            string guardedTarget=Path.Combine(root,"pending recovery path");
            try { await Nsis.Install(plan,installer,guardedTarget,CancellationToken.None); }
            catch(InstallerRecoveryRequired) { pendingRejected=true; }
            Assert(pendingRejected && !Directory.Exists(guardedTarget) && File.Exists(pending));
            Console.WriteLine("PASS: persistent unfinished-install marker rejects a new writer and remains intact");
            Passed("pending-marker");
          } finally { File.Delete(pending); } // Only this test's exclusively created marker.
          string target=Path.Combine(Path.GetTempPath(),"Mizar selected install "+Guid.NewGuid().ToString("N"));
          Assert(Nsis.SelectDestination(target)==target);
          bool unsafeSelection=false;try {Nsis.SelectDestination(Environment.GetFolderPath(Environment.SpecialFolder.Windows));} catch(InstallerActionRequired) {unsafeSelection=true;}
          Assert(unsafeSelection);
          // Recover the real prepared transaction through Install, including the
          // deleted marker's recreation and subsequent NSIS installation.
          Directory.CreateDirectory(target);
          var prepared=Nsis.NewPending(plan,target,installer);
          prepared.ownerPid=ownerPid;prepared.ownerStarted=ownerStarted;
          File.WriteAllText(Path.Combine(target,".mizar-bootstrap-owner"),prepared.token);Nsis.SavePending(prepared,true);
          var installClock=System.Diagnostics.Stopwatch.StartNew();
          var result=await Nsis.Install(plan,installer,target,CancellationToken.None);
          Console.WriteLine("TIMING: prepared first installation "+installClock.Elapsed.TotalSeconds.ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+"s");
          Assert(!File.Exists(pending));
          Console.WriteLine("PASS: prepared owner-only transaction reopens and completes real NSIS installation");
          Passed("prepared-install");
          Assert(result.CoreInstalled && !result.ResourcesReady && File.Exists(Path.Combine(target,"Mizar.exe")));
          Assert(String.Equals(Nsis.ResolveDestination(),target,StringComparison.OrdinalIgnoreCase));
          bool relocation=false;try {Nsis.SelectDestination(Path.Combine(root,"different install"));} catch(InstallerActionRequired) {relocation=true;}
          Assert(relocation && String.Equals(Nsis.ResolveDestination(),target,StringComparison.OrdinalIgnoreCase));
          Console.WriteLine("PASS: authenticated fixed v1.1 NSIS installed into fresh qualification directory; resources completion false");
          Passed("destination-selection");
          // Re-enter the same lightweight installer against an already owned installation.
          string data=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Mizar","upgrade-sentinel.txt");
          if(File.Exists(data)) throw new IOException("Refusing to replace existing user sentinel");
          Directory.CreateDirectory(Path.GetDirectoryName(data));File.WriteAllText(data,"preserve user data");
          string priorTiming=Environment.GetEnvironmentVariable("MIZAR_MEASURE_UPDATE");
          Environment.SetEnvironmentVariable("MIZAR_MEASURE_UPDATE","1");
          try {
            var phaseClock=System.Diagnostics.Stopwatch.StartNew();
            var updated=await Nsis.Install(plan,installer,target,CancellationToken.None,new NativeUpdateTiming());
            Console.WriteLine("TIMING: same-version native update "+phaseClock.Elapsed.TotalSeconds.ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+"s");
            phaseClock.Restart();
            Assert(updated.CoreInstalled && File.ReadAllText(data)=="preserve user data");Passed("same-version-update");
            var committed=(PendingInstall)typeof(FreshInstallResult).GetField("record",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(updated);
            string timingFile=Path.Combine(committed.updateStage,"install-timings.json");
            string timingText=File.ReadAllText(timingFile);
            Console.WriteLine("NATIVE_UPDATE_TIMING "+timingText);
            File.WriteAllText(Path.Combine(timingOutput,"native-update-install-timings.json"),timingText);
            string script=Path.Combine(committed.updateStage,"update-install.ps1"),nativePlan=Path.Combine(committed.updateStage,"plan.json");
            string stage;
            using(var child=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo {FileName=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),@"WindowsPowerShell\v1.0\powershell.exe"),Arguments="-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \""+script+"\" -Mode Prepare -PlanPath \""+nativePlan+"\"",UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true})) {
              var stdout=child.StandardOutput.ReadToEndAsync();var stderr=child.StandardError.ReadToEndAsync();
              if(!child.WaitForExit(60000)) throw new IOException("Actual native Prepare timed out");
              string output=await stdout,errors=await stderr;if(child.ExitCode!=0) throw new IOException(errors);
              stage=Convert.ToString(new JavaScriptSerializer().Deserialize<System.Collections.Generic.Dictionary<string,object>>(output)["stageRoot"]);
            }
            Console.WriteLine("TIMING: separate native Prepare "+phaseClock.Elapsed.TotalSeconds.ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+"s");
            phaseClock.Restart();
            var unwritten=Nsis.NewPending(plan,target,installer);unwritten.updateStage=stage;unwritten.updatePlanSha256=Hash(Path.Combine(stage,"plan.json"));unwritten.updateScriptSha256=Hash(Path.Combine(stage,"update-install.ps1"));
            unwritten.ownerPid=prepared.ownerPid;unwritten.ownerStarted=prepared.ownerStarted;unwritten.stage="update-launching";Nsis.SavePending(unwritten,true);
            bool launchAmbiguity=false;try {Nsis.RecoverPending(plan,target);} catch(InstallerRecoveryRequired) {launchAmbiguity=true;}
            Assert(launchAmbiguity && File.Exists(pending) && File.Exists(Path.Combine(target,"Mizar.exe")));Passed("ambiguous-launch");
            unwritten.stage="update-prepared";Nsis.SavePending(unwritten,false);
            Assert(!Nsis.RecoverPending(plan,target) && !File.Exists(pending) && File.Exists(Path.Combine(target,"Mizar.exe")));
            Console.WriteLine("PASS: real native Prepare with no writer recovers; ambiguous launch with no writer retains the pending record");
          Passed("prepared-recovery");
            Console.WriteLine("TIMING: prepared recovery "+phaseClock.Elapsed.TotalSeconds.ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+"s");
            phaseClock.Restart();
            await updated.RollbackAsync();
            Console.WriteLine("TIMING: same-version rollback "+phaseClock.Elapsed.TotalSeconds.ToString("F3",System.Globalization.CultureInfo.InvariantCulture)+"s");
            Assert(Directory.Exists(Path.Combine(committed.updateStage,"previous")) && !Directory.Exists(target+".mizar-restore-"+Path.GetFileName(committed.updateStage)));
            Assert(File.Exists(Path.Combine(target,"Mizar.exe")) && File.ReadAllText(data)=="preserve user data");
            Console.WriteLine("PASS: real lightweight same-version repair/upgrade and rollback preserve the existing path and user data");
          Passed("update-rollback");
          } finally {Environment.SetEnvironmentVariable("MIZAR_MEASURE_UPDATE",priorTiming);File.Delete(data);}
          await result.RollbackAsync();
          Assert(!Directory.Exists(target));
        }
        if(group=="all" || group=="faults") {
          string residue=Path.Combine(root,"uninstalled owner-only path"),stamp=new string('a',32);
          Directory.CreateDirectory(residue);File.WriteAllText(Path.Combine(residue,".mizar-bootstrap-owner"),stamp);
          var resumedResidue=await Nsis.Install(plan,installer,residue,CancellationToken.None);
          string[] retained=Directory.GetDirectories(root,"uninstalled owner-only path.retained-*");
          Assert(retained.Length==1 && File.ReadAllText(Path.Combine(retained[0],".mizar-bootstrap-owner"))==stamp);
          // Exercise the real native production call: historical Core cannot supply
          // a new executable entry from an external qualification directory.
          bool missingEntry=false;
          try { await Nsis.RunResourceBridge(plan,residue,CancellationToken.None); }
          catch(InstallerActionRequired error) { missingEntry=error.InnerException!=null && error.InnerException.Message.Contains("缺少在线安装入口"); }
          Assert(missingEntry);
          Console.WriteLine("PASS: native production bridge refuses historical Core without its authenticated packaged entry");
          Passed("historical-bridge");
          // Separately verify current App/SDK integration against these real Core bytes.
          string bridgeScript=Environment.GetEnvironmentVariable("MIZAR_BRIDGE_SCRIPT");
          if (String.IsNullOrEmpty(bridgeScript)) throw new IOException("Qualification requires the deployed App bridge");
          {
            string bridgeModule=Environment.GetEnvironmentVariable("MIZAR_BRIDGE_MODULE");
            string planPath=Environment.GetEnvironmentVariable("MIZAR_BRIDGE_PLAN");
            string node=Environment.GetEnvironmentVariable("MIZAR_BRIDGE_NODE");
            foreach(string argument in new[]{bridgeScript,bridgeModule,planPath,node,residue})
              if(String.IsNullOrEmpty(argument) || argument.IndexOfAny(new char[]{'"','\r','\n'})>=0)
                throw new IOException("Invalid qualification bridge arguments");
            using(var bridge=System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo {
              FileName=node, Arguments="\""+bridgeScript+"\" \""+bridgeModule+"\" \""+residue+"\" \""+planPath+"\"", UseShellExecute=false, CreateNoWindow=true, RedirectStandardOutput=true, RedirectStandardError=true
            })) {
              var stdout=bridge.StandardOutput.ReadToEndAsync();
              var stderr=bridge.StandardError.ReadToEndAsync();
              if(!bridge.WaitForExit(120000)) throw new IOException("Real installed Core bootstrap boundary timed out");
              Console.WriteLine(await stdout);
              Console.Error.WriteLine(await stderr);
              if(bridge.ExitCode!=0) throw new IOException("Real installed Core bootstrap boundary failed (exit "+bridge.ExitCode+")");
            }
            Console.WriteLine("PASS: real NSIS-installed Core and deployed App bridge deny incomplete official resource installation");
          Passed("app-resource-boundary");
          }
          // A second fresh attempt must not overwrite this installation or user registration.
          string unknown=Path.Combine(residue,"unknown-user-file.txt");File.WriteAllText(unknown,"keep");
          bool refused=false; try { await Nsis.Install(plan,installer,residue,CancellationToken.None); } catch(IOException) { refused=true; }
          Assert(refused && File.ReadAllText(unknown)=="keep");File.Delete(unknown);Passed("unknown-existing-files");
          var completed=Nsis.NewPending(plan,residue,installer);
          completed.token=File.ReadAllText(Path.Combine(residue,".mizar-bootstrap-owner"));
          completed.ownerPid=ownerPid;completed.ownerStarted=ownerStarted;
          completed.writerPid=ownerPid;completed.writerStarted=ownerStarted;completed.stage="complete";
          Nsis.SavePending(completed,true);
          resumedResidue=await Nsis.Install(plan,installer,residue,CancellationToken.None);
          Assert(resumedResidue.CoreInstalled && !File.Exists(pending));
          Console.WriteLine("PASS: completed owned Core recovers without launching a second NSIS writer");
          Passed("completed-pending");
          await resumedResidue.RollbackAsync();
          Assert(!Directory.Exists(residue) && File.Exists(Path.Combine(retained[0],".mizar-bootstrap-owner")));
          Console.WriteLine("PASS: owner-only uninstall residue is preserved whole and fresh NSIS installation can resume");
          Passed("owned-residue");
          var badIdentity = new JavaScriptSerializer().Deserialize<Plan>(new JavaScriptSerializer().Serialize(plan));
          badIdentity.contentDigest = new string('0',64);
          string failedTarget=Path.Combine(root,"failed NSIS identity path");
          bool identityRejected=false;
          try { await Nsis.Install(badIdentity,installer,failedTarget,CancellationToken.None); } catch(IOException) { identityRejected=true; }
          Assert(identityRejected && !Directory.Exists(failedTarget));
          Console.WriteLine("PASS: post-install identity mismatch invokes original uninstaller and cleans the fresh target");
          Passed("post-install-identity");
          var progress=new CancelNsisProgress();
          bool cancelled=false;
          string cancelledTarget=Path.Combine(root,"cancelled NSIS path");
          try { await Nsis.Install(plan,installer,cancelledTarget,progress.Source.Token,progress); }
          catch(OperationCanceledException) { cancelled=true; }
          Assert(cancelled && progress.Waiting && !Directory.Exists(cancelledTarget));
          Console.WriteLine("PASS: cancellation waits for NSIS exit and existing uninstaller cleans fresh installation; waiting="+progress.Waiting);
          Passed("cancelled-install");
          string bad=Path.Combine(cache,"bad.exe"); File.WriteAllText(bad,"not an installer");
          bool rejected=false; try { await Nsis.Install(plan,bad,Path.Combine(root,"bad path"),CancellationToken.None); } catch(IOException) { rejected=true; }
          Assert(rejected);
          Console.WriteLine("PASS: mismatched installer never executed; existing installation never replaced");
          Passed("invalid-installer");
        }
        complete=true;
      } finally {
        // Cleanup only this explicitly isolated qualification root; production Nsis does no recursive delete.
        if(complete && Directory.Exists(root)) Directory.Delete(root,true);
      }
    }
    public static int Main(string[] args) {
      try {
        ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
        if(args.Length==2 && args[0]=="download") {
          Plan plan;
          using(var stream=Assembly.GetExecutingAssembly().GetManifestResourceStream("legacy-plan.json"))
          using(var reader=new StreamReader(stream)) plan=new JavaScriptSerializer().Deserialize<Plan>(reader.ReadToEnd());
          using(var handler=new HttpClientHandler {AllowAutoRedirect=false,UseCookies=false})
          using(var client=new HttpClient(handler) {Timeout=Timeout.InfiniteTimeSpan})
            new Downloader(client).Download(plan,args[1],new IgnoreProgress(),CancellationToken.None).GetAwaiter().GetResult();
          return 0;
        }
        if((args.Length!=2 && args.Length!=3) || (args[0]!="all" && args[0]!="update" && args[0]!="faults")) throw new IOException("Unknown NSIS qualification group");
        timingOutput=Path.GetDirectoryName(Path.GetFullPath(args[1]));
        Run(args[0],args.Length==3 ? args[2] : null).GetAwaiter().GetResult();
        var evidence=new { group=args[0], cases=cases.ToArray(), sourceSha=Environment.GetEnvironmentVariable("GITHUB_SHA"), runId=Environment.GetEnvironmentVariable("GITHUB_RUN_ID"), attempt=Environment.GetEnvironmentVariable("GITHUB_RUN_ATTEMPT") };
        using(var output=new FileStream(args[1],FileMode.CreateNew,FileAccess.Write,FileShare.None))
        using(var writer=new StreamWriter(output,new System.Text.UTF8Encoding(false))) writer.Write(new JavaScriptSerializer().Serialize(evidence));
        return 0;
      }
      catch(Exception e) { Console.Error.WriteLine(e); return 1; }
    }
  }
}
