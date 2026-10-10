using System;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
namespace Mizar.WebInstaller {
  // UI behavior fixtures only: no download, NSIS, Store or production trust success.
  static class WindowTests {
    internal static Plan UiPlan() { return new Plan {allowExecute=true,bytes=100}; }
    static void Assert(bool value,string reason) {if(!value) throw new Exception(reason);}
    static void Pump(Task task) {
      var deadline=DateTime.UtcNow.AddSeconds(10);
      while(!task.IsCompleted) {Application.DoEvents();Thread.Sleep(10);if(DateTime.UtcNow>deadline) throw new Exception("UI fixture timed out");}
      task.GetAwaiter().GetResult(); Application.DoEvents();
    }
    static Task<string> Complete(IProgress<long> bytes,IProgress<string> stages,CancellationToken token) {return Task.FromResult("UI-only-not-installed");}
    internal static void Run() {
      Application.EnableVisualStyles();
      string diagnostic=Window.DiagnosticText(new Exception("resource_path_unsafe https://example.com/file?token=secret access_token=hidden",new Exception("exit code 7 stderr source failure")));
      Assert(diagnostic.Contains("resource_path_unsafe") && diagnostic.Contains("exit code 7") && !diagnostic.Contains("token=secret") && !diagnostic.Contains("hidden"),"Diagnostic retains cause and exit evidence while redacting credentials");
      int launches=0, installs=0;
      Func<IProgress<long>,IProgress<string>,CancellationToken,Task<string>> operation=(bytes,stages,token)=>{installs++;return Complete(bytes,stages,token);};
      using(var window=new Window(UiPlan(),operation,path=>launches++,true)) {
        window.Show(); Application.DoEvents();
        Assert(!window.detail.Text.Contains("网络"),"Welcome does not preemptively warn about network");
        Assert(!window.bar.Visible && !window.launchChoice.Visible,"Initial window must hide progress and launch choice");
        Pump(window.Start());
        Assert(window.heading.Text=="安装完成" && window.launchChoice.Visible && window.launchChoice.Checked,"Completion has checked launch choice");
        Assert(launches==0,"Reaching completion must not launch");
        window.action.PerformClick(); Assert(launches==1 && window.IsDisposed,"Checked Finish launches once and closes");
      }
      using(var window=new Window(UiPlan(),operation,path=>launches++,true)) {
        window.Show(); Pump(window.Start()); window.launchChoice.Checked=false; window.action.PerformClick();
        Assert(launches==1 && window.IsDisposed,"Unchecked Finish closes without launch");
      }
      using(var window=new Window(UiPlan(),operation,path=>launches++,true)) {
        window.Show(); Pump(window.Start()); window.Close();
        Assert(launches==1,"Closing X must not launch");
      }
      int attempts=0;
      using(var window=new Window(UiPlan(),operation,path=>{if(++attempts==1) throw new Exception("UI fixture start failure");},true)) {
        window.Show(); Pump(window.Start()); int installed=installs;
        window.action.PerformClick();
        Assert(window.heading.Text=="Mizar 未能启动" && window.launchChoice.Visible && window.action.Text=="重试启动","Launch failure retains installed state");
        window.launchChoice.Checked=false; Assert(window.action.Text=="完成","Opting out after launch failure offers Finish");
        window.launchChoice.Checked=true; window.action.PerformClick();
        Assert(attempts==2 && installs==installed && window.IsDisposed,"Retry only launches, never reinstalls");
      }
      var stopped=new TaskCompletionSource<string>();
      int starts=0;
      using(var window=new Window(UiPlan(),(bytes,stages,token)=>{starts++;return starts==1 ? stopped.Task : Complete(bytes,stages,token);},path=>launches++,true)) {
        window.Show(); var pending=window.Start(); Application.DoEvents();
        Assert(window.bar.Visible && !window.action.Enabled,"Working state shows progress and blocks duplicate Install");
        window.ShowStage("validating-download"); Assert(window.bar.Style==ProgressBarStyle.Marquee && window.heading.Text.Contains("验证"),"Hash validation shows actual stage without invented percent");
        window.ShowStage("installing-core"); Assert(window.bar.Style==ProgressBarStyle.Marquee,"Unknown installation progress is indeterminate");
        window.Close(); Assert(!window.IsDisposed && window.heading.Text=="正在停止","X during installation waits for safe cancellation");
        Assert(!pending.IsCompleted,"Cancellation cannot pretend writer has stopped");
        stopped.SetCanceled(); Pump(pending);
        Assert(window.heading.Text=="已取消" && window.action.Enabled && !window.bar.Visible,"Cancelled state can retry after writer stops");
        Pump(window.Start()); Assert(starts==2,"Retry re-enters the operation after safe stop");
      }
      using(var window=new Window(UiPlan(),(bytes,stages,token)=>{throw new InstallerActionRequired("请使用原安装器修复。");},path=>launches++,true)) {
        window.Show(); Pump(window.Start()); Assert(window.detail.Text=="请使用原安装器修复。" && !window.action.Enabled,"Existing installation error gives repair, not network advice");
      }
      Console.WriteLine("PASS: real Native UI initial/progress/Finish choice/X/start retry/safe cancellation and repair behavior (UI fixtures only)");
    }
  }
  // Separate executable only. Production Program has no demonstration command line.
  static class UiDemo {
    [STAThread] static void Main(string[] args) {
      Application.EnableVisualStyles();
      var window=new Window(WindowTests.UiPlan(),async (bytes,stages,token)=>{stages.Report("installing-core");await Task.Delay(Timeout.Infinite,token);return "UI-only-not-installed";},path=>{throw new Exception("界面演示，不启动产品。");},true);
      window.Shown += async (s,e)=>{
        if(args.Length>0 && args[0]=="installing") {await window.Start();window.Close();}
        else {window.ShowCompleted("UI-only-not-installed");if(args.Length>0 && args[0]=="start-failed") window.action.PerformClick();}
      };
      Application.Run(window);
    }
  }
}
