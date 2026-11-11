using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using Mizar.WebInstaller;

class WriterLockProbe {
  const string WriterName = @"Global\MizarUpdateWriter";
  static readonly string PendingPath = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Mizar", "bootstrap-cache", "fresh-install.pending");
  static readonly string Root = Path.Combine(Path.GetTempPath(), "Mizar-WebInstaller-Qualification", "writer-lock-" + Guid.NewGuid().ToString("N"));
  static Plan plan;
  static int passed;
  static bool ownsPending;
  static FileStream lease;
  static void Check(bool ok, string label) { if(!ok) throw new Exception(label); passed++; Console.WriteLine("PASS " + label); }
  static void Reject(Action action, string label) { try { action(); } catch(IOException) { Check(true,label); return; } throw new Exception("Expected refusal: "+label); }
  static void ClearPending() { if(File.Exists(PendingPath)) File.Delete(PendingPath); }
  static PendingInstall Record(string target, string stage) {
    ClearPending();
    Directory.CreateDirectory(target);
    var record = Nsis.NewPending(plan,target,"fixture.exe");
    record.ownerPid = Int32.MaxValue; record.ownerStarted = 1;
    if(stage != "prepared") { record.writerPid = Int32.MaxValue; record.writerStarted = 1; }
    record.stage = stage;
    File.WriteAllText(Path.Combine(target,".mizar-bootstrap-owner"),record.token);
    Nsis.SavePending(record,true);
    return record;
  }
  static void HoldWriter(Action body) {
    Exception failure=null;
    using(var ready=new ManualResetEvent(false)) using(var release=new ManualResetEvent(false)) {
      var thread=new Thread(()=> {
        try { using(var writer=new Mutex(false,WriterName)) { writer.WaitOne(); ready.Set(); release.WaitOne(); writer.ReleaseMutex(); } }
        catch(Exception e) {failure=e;ready.Set();}
      });
      thread.Start(); ready.WaitOne();
      try {if(failure!=null)throw failure;body();} finally {release.Set();thread.Join();}
      if(failure!=null)throw failure;
    }
  }
  static int Main(string[] args) {
    if(args.Length>0 && args[0]=="/S") return UninstallStub(args);
    try {
      if(File.Exists(PendingPath)) throw new Exception("Runner already has an installation transaction");
      using(var reg=Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Mizar")) if(reg!=null)throw new Exception("Runner already has Mizar");
      ownsPending=true;
      Directory.CreateDirectory(Path.GetDirectoryName(PendingPath));
      lease=new FileStream(Path.Combine(Path.GetDirectoryName(PendingPath),"fresh-install.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None);
      plan=new Plan {schemaVersion=1,version="1.0.0",name="Mizar-v1.0.0-Windows-x64-Setup.exe",bytes=1,sha256=new string('a',64),kind="nsis-setup",gitSha=new string('b',40),contentDigest=new string('c',64),allowExecute=true,urls=new[]{"https://github.com/Starfie1d1272/Mizar/releases/download/v1.0.0/Mizar-v1.0.0-Windows-x64-Setup.exe"}};
      string target=Path.Combine(Root,"prepared"); Record(target,"prepared");
      string pending=File.ReadAllText(PendingPath);
      HoldWriter(()=>Reject(()=>Nsis.RecoverPending(plan,target,lease),"competing writer blocks prepared recovery"));
      Check(Directory.Exists(target)&&File.ReadAllText(PendingPath)==pending,"blocked recovery preserves target and pending");
      Check(!Nsis.RecoverPending(plan,target,lease)&&!Directory.Exists(target)&&!File.Exists(PendingPath),"prepared cleanup resumes after writer release");

      target=Path.Combine(Root,"partial");var record=Record(target,"writing");
      File.WriteAllText(Path.Combine(target,"unknown.bin"),"keep every byte");pending=File.ReadAllText(PendingPath);
      HoldWriter(()=>Reject(()=>Nsis.RecoverPending(plan,target,lease),"competing writer blocks quarantine"));
      Check(File.Exists(Path.Combine(target,"unknown.bin"))&&File.ReadAllText(PendingPath)==pending,"blocked quarantine is non-mutating");
      string retained=target+".incomplete-"+record.token;
      Check(!Nsis.RecoverPending(plan,target,lease)&&!Directory.Exists(target)&&File.ReadAllText(Path.Combine(retained,"unknown.bin"))=="keep every byte","quarantine preserves exact incomplete payload");
      Directory.CreateDirectory(target);File.WriteAllText(Path.Combine(target,"successor.bin"),"later installation");
      Reject(()=>Nsis.RecoverPending(plan,target,lease),"quarantine reentry refuses a successor destination");
      Check(File.ReadAllText(Path.Combine(target,"successor.bin"))=="later installation"&&Directory.Exists(retained),"quarantine reentry preserves both generations");

      target=Path.Combine(Root,"successor");Record(target,"writing");File.WriteAllText(Path.Combine(target,"installed.flag"),"mizar.install.v1:successor");
      Reject(()=>Nsis.RecoverPending(plan,target,lease),"changed instance blocks recovery");
      bool available=false;
      var checkThread=new Thread(()=>{using(var writer=new Mutex(false,WriterName)) {available=writer.WaitOne(0);if(available)writer.ReleaseMutex();}});
      checkThread.Start();checkThread.Join();Check(available,"exception releases writer for another thread");

      target=Path.Combine(Root,"abandoned");Record(target,"prepared");
      using(var abandoned=new Mutex(false,WriterName)) {
        var thread=new Thread(()=>abandoned.WaitOne());thread.Start();thread.Join();
        Check(!Nsis.RecoverPending(plan,target,lease)&&!Directory.Exists(target),"abandoned writer is acquired and safely released");
      }
      target=Path.Combine(Root,"rollback");record=Record(target,"writing");
      string exe=Path.Combine(target,"Uninstall.exe");File.Copy(Process.GetCurrentProcess().MainModule.FileName,exe);
      HoldWriter(()=>Reject(()=>Nsis.RollbackOwnedFresh(target,TimeSpan.FromSeconds(10),lease,record).GetAwaiter().GetResult(),"competing writer blocks rollback preflight"));
      Check(File.Exists(exe)&&File.Exists(Path.Combine(target,".mizar-bootstrap-owner")),"blocked rollback never launches uninstaller");
      File.WriteAllText(Path.Combine(target,"stub-mode.txt"),"successor");
      Reject(()=>Nsis.RollbackOwnedFresh(target,TimeSpan.FromSeconds(10),lease,record).GetAwaiter().GetResult(),"cleanup refuses successor with identical uninstaller bytes");
      Check(File.Exists(exe)&&File.ReadAllText(Path.Combine(target,"installed.flag"))=="mizar.install.v1:successor","same-package successor executable and instance survive cleanup");

      target=Path.Combine(Root,"rollback-retry");record=Record(target,"writing");
      exe=Path.Combine(target,"Uninstall.exe");File.Copy(Process.GetCurrentProcess().MainModule.FileName,exe);
      System.Threading.Tasks.Task rollback;
      using(var held=new FileStream(exe,FileMode.Open,FileAccess.Read,FileShare.Read)) {
        rollback=Nsis.RollbackOwnedFresh(target,TimeSpan.FromSeconds(10),lease,record);
        var clock=Stopwatch.StartNew();
        while(!File.ReadAllText(PendingPath).Contains("rollback-cleanup")) {if(clock.Elapsed>TimeSpan.FromSeconds(10))throw new Exception("cleanup not reached");Thread.Sleep(25);}
        Thread.Sleep(150);
        Check(!rollback.IsCompleted,"sharing violation keeps cleanup pending");
        using(var writer=new Mutex(false,WriterName)) {
          bool taken=writer.WaitOne(0);Check(taken,"async cleanup delay releases common writer");
          if(taken) {try {File.WriteAllText(Path.Combine(target,"installed.flag"),"mizar.install.v1:successor");}finally {writer.ReleaseMutex();}}
        }
      }
      Reject(()=>rollback.GetAwaiter().GetResult(),"cleanup retry rechecks successor instance");
      Check(File.Exists(exe),"cleanup retry preserves same-byte successor uninstaller");

      target=Path.Combine(Root,"rollback-clean");record=Record(target,"writing");
      File.Copy(Process.GetCurrentProcess().MainModule.FileName,Path.Combine(target,"Uninstall.exe"));
      Nsis.RollbackOwnedFresh(target,TimeSpan.FromSeconds(10),lease,record).GetAwaiter().GetResult();
      Check(!Directory.Exists(target),"original rollback removes only its empty target");
      ClearPending(); Console.WriteLine("PASS total="+passed);return 0;
    } catch(Exception error) {Console.Error.WriteLine(error);return 1;}
    finally {if(ownsPending)ClearPending();if(lease!=null)lease.Dispose();if(Directory.Exists(Root))Directory.Delete(Root,true);}
  }
  static int UninstallStub(string[] args) {
    int index=Array.FindIndex(args,value=>value.StartsWith("_?=",StringComparison.Ordinal));
    string target=String.Join(" ",args.Skip(index)).Substring(3);
    using(var writer=new Mutex(false,WriterName)) {
      if(!writer.WaitOne(0))return 2;
      try {
        long leaseHandle;
        if(!Int64.TryParse(args.Single(value=>value.StartsWith("/MIZARLEASE=",StringComparison.Ordinal)).Substring(12),out leaseHandle) || leaseHandle<=0)return 4;
        string owner=args.Single(value=>value.StartsWith("/MIZAROWNER=",StringComparison.Ordinal)).Substring(12);
        if(owner!="bootstrap-"+File.ReadAllText(Path.Combine(target,".mizar-bootstrap-owner")))return 3;
        File.Delete(Path.Combine(target,".mizar-bootstrap-owner"));
        string mode=Path.Combine(target,"stub-mode.txt");
        if(File.Exists(mode)) {File.Delete(mode);File.WriteAllText(Path.Combine(target,"installed.flag"),"mizar.install.v1:successor");}
        return 0;
      } finally {writer.ReleaseMutex();}
    }
  }
}
