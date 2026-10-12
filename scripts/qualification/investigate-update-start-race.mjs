// Evidence only: original v1.3.0 updater, disposable Windows runner, synthetic EXE.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
assert.equal(process.platform, 'win32');
const root = await mkdtemp(join(tmpdir(), 'mizar-update-race-'));
const evidence = resolve('.agent-tmp/update-start-race');
await mkdir(evidence, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const literal = (s) => `'${s.replaceAll("'", "''")}'`;
const environment = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'psmodulepath'));
function ps(args) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (b) => { stdout += b; });
  child.stderr.on('data', (b) => { stderr += b; });
  return new Promise((done, reject) => { child.on('error', reject); child.on('close', (code) => done({ code, stdout, stderr })); });
}
const pristine = await ps(['-Command', "if ((Get-Process -Name Mizar -ErrorAction SilentlyContinue) -or (Test-Path 'HKCU:\\Software\\Mizar') -or (Test-Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mizar')) { exit 1 }"]);
assert.equal(pristine.code, 0, 'Disposable runner must have no existing Mizar');
const oldScript = execFileSync('git', ['show', 'v1.3.0:scripts/qualification/bundle/update-install.ps1'], { encoding: 'utf8' });
const script = join(root, 'original-update-install.ps1');
await writeFile(script, oldScript);
const compiler = join(root, 'compile.ps1');
await writeFile(compiler, String.raw`param([string]$Output)
Add-Type -OutputAssembly $Output -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
public class Fixture {
 static void Copy(string from, string to) { Directory.CreateDirectory(to); foreach(var p in Directory.GetFiles(from)) File.Copy(p,Path.Combine(to,Path.GetFileName(p)),true); foreach(var p in Directory.GetDirectories(from)) Copy(p,Path.Combine(to,Path.GetFileName(p))); }
 public static void Main(string[] args) {
  if(args.Length>0 && args[0]=="--host") { Console.WriteLine("ready"); Console.ReadLine(); return; }
  if(args.Length>0 && args[0]=="--hold") { File.WriteAllText(args[1],"ready"); Console.ReadLine(); System.Threading.Thread.Sleep(60000); return; }
  var exe=System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
  var target=String.Join(" ",args); target=target.Substring(target.IndexOf("/D=")+3);
  Copy(Path.Combine(Path.GetDirectoryName(exe),"new-payload"),target);
 }
}
'@
`);
const binaryPath = join(root, 'Stub.exe');
const compile = await ps(['-File', compiler, '-Output', binaryPath]);
assert.equal(compile.code, 0, compile.stderr);
const binary = await readFile(binaryPath);
async function payload(path, version) {
 const files = { 'LICENSE': Buffer.from('independent license fixture'), 'Mizar.exe': binary, 'resources/runtime/node.exe': Buffer.from('runtime'), 'resources/app/dist/server.js': Buffer.from(version), 'resources/web/dist/index.html': Buffer.from(version) };
 const contentDigest = sha(Buffer.from(Object.keys(files).sort().map((n) => `${n}\0${sha(files[n])}\n`).join('')));
 files['resources/metadata/artifact.json'] = Buffer.from(JSON.stringify({repository:'Starfie1d1272/Mizar',appVersion:version,gitSha:'a'.repeat(40),artifactSha256:contentDigest}));
 for (const [n,b] of Object.entries(files)) { await mkdir(dirname(join(path,n)),{recursive:true}); await writeFile(join(path,n),b); }
 await writeFile(join(path,'resources/metadata/SHA256SUMS'), Object.keys(files).sort().map((n)=>`${sha(files[n])}  ${n}\n`).join(''));
 await writeFile(join(path,'installed.flag'),'fixture');
 return contentDigest;
}
async function scenario(race) {
 const caseRoot=join(root,race?'race':'baseline'); const bundle=join(caseRoot,'program'); const state=join(caseRoot,'state');
 const previous=await payload(bundle,'1.3.0');
 const download=join(state,'updates/download-fixture'); await mkdir(download,{recursive:true});
 const installer=join(download,'Mizar-v1.3.1-Windows-x64-Setup.exe'); await writeFile(installer,binary);
 const next=await payload(join(caseRoot,'new-payload'),'1.3.1');
 const planPath=join(caseRoot,'plan.json');
 await writeFile(planPath,JSON.stringify({schemaVersion:1,version:'1.3.1',gitSha:'a'.repeat(40),bundleRoot:bundle,stateRoot:state,installer,installerSha256:sha(binary),installerBytes:binary.length,contentDigest:next,previousContentDigest:previous}));
 const prepare=await ps(['-File',script,'-Mode','Prepare','-PlanPath',planPath]); assert.equal(prepare.code,0,prepare.stderr);
 const stage=JSON.parse(prepare.stdout.trim().replace(/^\uFEFF/, '')).stageRoot;
 await payload(join(stage,'new-payload'),'1.3.1');
 let installScript=script;
 if(race) {
  const injection=String.raw`$race = Start-Process -FilePath (Join-Path $plan.bundleRoot 'Mizar.exe') -ArgumentList @('--hold', (Join-Path $StageRoot 'race-ready.txt')) -PassThru
  [IO.File]::WriteAllText((Join-Path $StageRoot 'race-pid.txt'), [string]$race.Id)
  $wait = [DateTime]::UtcNow.AddSeconds(10)
  while (!(Test-Path (Join-Path $StageRoot 'race-ready.txt'))) { if ([DateTime]::UtcNow -gt $wait) { throw 'fixture_start_timeout' }; Start-Sleep -Milliseconds 20 }
  # Observe exactly the DesktopMutex existence rule, without holding it.
  $created = $false
  $mutex = New-Object Threading.Mutex($false, 'Global\MizarDesktop', [ref]$created)
  [IO.File]::WriteAllText((Join-Path $StageRoot 'desktop-mutex-created.txt'), [string]$created)
  $mutex.Dispose()
  `;
  const needle="  Measure-UpdatePhase 'remove-previous-files' {";
  assert.equal(oldScript.split(needle).length,2);
  installScript=join(caseRoot,'scheduled-update-install.ps1'); await writeFile(installScript,oldScript.replace(needle,injection+needle));
 }
 const host=spawn(binaryPath,['--host'],{stdio:['pipe','pipe','pipe']});
 await new Promise((done,reject)=>{host.stdout.once('data',done);host.once('error',reject);});
 const ready=join(stage,'install-ready.txt');
 const install=ps(['-Command',`[IO.File]::WriteAllText(${literal(ready)}, 'ready'); & ${literal(installScript)} -Mode Install -StageRoot ${literal(stage)} -HostProcessId ${host.pid} -NoLaunch -KeepBackup; exit $LASTEXITCODE`]);
 for(let i=0;!(await readFile(ready).catch(()=>null));i++){assert(i<200);await delay(50);}
 const hostClosed=new Promise((done)=>host.once('close',done));host.stdin.end('exit\n');await hostClosed;
 const result=await install;
 const recorded=JSON.parse(await readFile(join(state,'updates/result.json'),'utf8'));
 const journal=JSON.parse(await readFile(join(stage,'journal.json'),'utf8'));
 const licensePresent=await readFile(join(bundle,'LICENSE')).then(()=>true,()=>false);
 const backupLicensePresent=await readFile(join(stage,'previous/LICENSE')).then(()=>true,()=>false);
 const report={scenario:race?'late Mizar startup':'baseline',exitCode:result.code,result:recorded,journal,licensePresent,backupLicensePresent};
 if(race){
  const pid=Number(await readFile(join(stage,'race-pid.txt'),'utf8'));
  report.desktopMutexCreated=(await readFile(join(stage,'desktop-mutex-created.txt'),'utf8')).trim();
  assert.equal(report.desktopMutexCreated,'True','Updater did not retain DesktopMutex');
  assert.equal(recorded.status,'recovery-required');assert.equal(journal.phase,'installing');assert.equal(licensePresent,false);assert.equal(backupLicensePresent,true);
  assert.equal(sha(await readFile(join(bundle,'Mizar.exe'))),sha(binary),'Original EXE survived failed removal');
  await ps(['-Command',`Stop-Process -Id ${pid} -Force`]);
  const recovered=await ps(['-File',join(stage,'update-install.ps1'),'-Mode','Recover','-StageRoot',stage]);
  assert.equal(recovered.code,0,recovered.stderr);
  report.afterClosingMizar=JSON.parse(await readFile(join(state,'updates/result.json'),'utf8'));
  assert.equal(report.afterClosingMizar.status,'restored');assert.equal(sha(await readFile(join(bundle,'LICENSE'))),sha(Buffer.from('independent license fixture')));
 }else {assert.equal(recorded.status,'installed');assert.equal(licensePresent,true);}
 report.restoreCommand=(await readFile(join(stage,'Restore-Mizar.cmd'),'utf8')).trim();
 await writeFile(join(evidence, race?'race.json':'baseline.json'),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
}
await scenario(false);await scenario(true);
console.log('Original v1.3.0 update late-start race reproduced; not a field-cause conclusion or real NSIS/GUI acceptance.');
