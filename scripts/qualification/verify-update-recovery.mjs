// Windows filesystem/process recovery with a stub installer; not a real NSIS upgrade or login recovery acceptance.
import { setTimeout } from 'node:timers';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { safeLogText } from './product-logs.mjs';

if (process.platform !== 'win32') throw new Error('此验证需要 Windows PowerShell 与真实文件系统');
const root = await mkdtemp(join(tmpdir(), 'mizar 更新 recovery '));
const script = resolve(dirname(fileURLToPath(import.meta.url)), 'bundle/update-install.ps1');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let ownsRegistration = false;
async function run(args, overrides = {}) {
  // The Host also removes an inherited PowerShell 7 module path before
  // launching Windows PowerShell 5.1, so its built-in modules load normally.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
  );
  Object.assign(env, overrides);
  const directTransaction = args.includes('-Mode');
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      ...args,
      ...(directTransaction ? ['-NoStatusWindow', '-NoLaunch'] : []),
    ],
    {
      env,
      cwd: overrides.MIZAR_UPDATE_TEST_CWD,
      windowsHide: overrides.MIZAR_UPDATE_TEST_UI !== '1',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    },
  );
  let output = '',
    errors = '';
  child.stdout.on('data', (b) => {
    output += b;
  });
  child.stderr.on('data', (b) => {
    errors += b;
    if (overrides.MIZAR_UPDATE_TEST_UI === '1') process.stderr.write(safeLogText(b.toString()));
  });
  const code = await new Promise((done, reject) => {
    child.on('error', reject);
    // exit can precede the final stdout/stderr chunks; close follows stream closure.
    child.once('close', done);
  });
  return { code, output: output.replace(/^\uFEFF/, '').trim(), errors, pid: child.pid };
}
async function windowProbe(stage, action, name) {
  const helperPid = (await readFile(join(stage, 'ui-helper-pid.txt'), 'utf8')).trim();
  assert.match(helperPid, /^[1-9][0-9]*$/);
  const output = resolve('.agent-tmp/update-window');
  await mkdir(output, { recursive: true });
  const result = await run([
    '-File',
    resolve('scripts/qualification/probe-update-window.ps1'),
    '-ProcessId',
    helperPid,
    '-Action',
    action,
    '-OutputPath',
    join(output, `${name}.png`),
  ]);
  if (result.output) console.log(result.output);
  return result;
}
async function installWithHost(binaryPath, stage, env = {}) {
  // Keep a fresh, exact Host alive while Install starts; never reuse an old PID.
  const host = spawn(binaryPath, ['--host'], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise((done, reject) => {
    host.once('exit', done);
    host.once('error', reject);
  });
  let output = '';
  let installation;
  let settled = false;
  try {
    const started = new Promise((done, reject) => {
      host.stdout.on('data', (bytes) => {
        output += bytes;
        if (output.includes('\n')) done();
      });
      host.once('error', reject);
      host.once('exit', () => reject(new Error('Host fixture exited before ready')));
    });
    await started;
    assert.match(output.trim(), /^\d+$/, 'Host must report its actual creation time');
    await writeFile(join(stage, 'host.txt'), `${host.pid}\n${output.trim()}\n`);
    const readyPath = join(stage, 'install-script-ready.txt');
    const readyEvent = `Global\\MizarUpdateReady-${host.pid}-${Date.now()}`;
    const literal = (value) => `'${value.replace(/'/g, "''")}'`;
    installation = run(
      [
        '-Command',
        `$ready = New-Object Threading.EventWaitHandle($false, [Threading.EventResetMode]::ManualReset, ${literal(readyEvent)}); [IO.File]::WriteAllText(${literal(readyPath)}, 'ready'); [IO.File]::WriteAllText(${literal(join(stage, 'ui-helper-pid.txt'))}, [string]$PID); try { & ${literal(env.MIZAR_UPDATE_TEST_SCRIPT ?? script)} -Mode Install -StageRoot ${literal(stage)} -HostProcessId ${host.pid} -ReadyEvent ${literal(readyEvent)} -NoStatusWindow:${env.MIZAR_UPDATE_TEST_UI === '1' ? '$false' : '$true'}; exit $LASTEXITCODE } finally { $ready.Dispose() }`,
      ],
      env,
    ).then((result) => {
      settled = true;
      return result;
    });
    const deadline = Date.now() + 10000;
    while (!(await readFile(readyPath, 'utf8').catch(() => ''))) {
      assert(Date.now() < deadline && !settled, 'Install PowerShell did not become ready');
      await new Promise((done) => setTimeout(done, 50));
    }
    console.log('Native update: awaiting helper handoff');
    const acknowledged = await run([
      '-Command',
      `$event = [Threading.EventWaitHandle]::OpenExisting(${literal(readyEvent)}); try { if (!$event.WaitOne(10000)) { exit 1 } } finally { $event.Dispose() }`,
    ]);
    assert.equal(acknowledged.code, 0, acknowledged.errors);
    console.log('Native update: helper acknowledged');
    const desktopBlocked = await run([
      '-Command',
      `$created = $false; $mutex = New-Object Threading.Mutex($false, 'Global\\MizarDesktop', [ref]$created); try { if ($created) { exit 1 }; $active = [Threading.EventWaitHandle]::OpenExisting('Global\\MizarUpdateActive'); $active.Dispose() } finally { $mutex.Dispose() }`,
    ]);
    assert.equal(
      desktopBlocked.code,
      0,
      'Writer must retain the desktop handle and active state before Host exit',
    );

    assert.equal(host.exitCode, null, 'Host stays alive until explicitly released');
    assert.equal(settled, false, 'Install must wait for the live Host');
    if (env.MIZAR_UPDATE_TEST_UI === '1' && env.MIZAR_UPDATE_TEST_HOLD === '1') {
      const waiting = await windowProbe(stage, 'capture', 'waiting');
      assert.equal(waiting.code, 0, waiting.errors);
    }
    if (env.MIZAR_UPDATE_TEST_CANCEL_UI === '1') {
      const cancelled = await windowProbe(stage, 'cancel', 'waiting-cancel');
      assert.equal(cancelled.code, 0, cancelled.errors);
    }
    console.log('Native update: releasing original Host');
    host.stdin.end('exit\n');
    assert.equal(await exited, 0, 'Host exits normally, without killing a writer');
    if (env.MIZAR_UPDATE_TEST_HOLD === '1') {
      console.log('Native update: awaiting controlled installer');
      const writerReady = join(stage, 'writer-ready.txt');
      for (let count = 0; !(await readFile(writerReady, 'utf8').catch(() => '')); count++) {
        assert(
          count < 200 && !settled,
          'Controlled installer did not reach its protected interval',
        );
        await new Promise((done) => setTimeout(done, 50));
      }
      const restart = await run([
        '-Command',
        `& ${literal(join(JSON.parse(await readFile(join(stage, 'plan.json'), 'utf8')).bundleRoot, 'Mizar.exe'))} --try-start`,
      ]);
      assert.equal(
        restart.output,
        'blocked',
        'Original desktop existence rule must prevent early restart',
      );
      if (env.MIZAR_UPDATE_TEST_UI === '1') {
        const preparing = await windowProbe(stage, 'capture', 'preparing');
        assert.equal(preparing.code, 0, preparing.errors);
        assert.equal(settled, false, 'Preparation must wait for its installer to exit');
      }
      for (const mode of ['Install', 'Recover', 'Rollback']) {
        const duplicate = await run([
          '-File',
          script,
          '-Mode',
          mode,
          '-StageRoot',
          stage,
          '-HostProcessId',
          String(host.pid),
        ]);
        assert.equal(duplicate.code, 1);
        assert.match(duplicate.errors, /update_transaction_busy/);
      }
      assert.equal(
        JSON.parse(await readFile(join(stage, 'journal.json'), 'utf8')).phase,
        'prepared',
      );
      assert.equal(
        await readFile(
          join(JSON.parse(await readFile(join(stage, 'plan.json'), 'utf8')).bundleRoot, 'LICENSE'),
          'utf8',
        ),
        'independent product license',
      );
      await writeFile(join(stage, 'writer-release.txt'), 'release');
    }
    if (env.MIZAR_UPDATE_TEST_RECOVERY_UI === '1') {
      let blockerPid = '';
      for (let count = 0; !blockerPid; count++) {
        assert(count < 200, 'Recovery blocker did not start');
        blockerPid = (
          await readFile(join(stage, 'blocker-pid.txt'), 'utf8').catch(() => '')
        ).trim();
        if (!blockerPid) await new Promise((done) => setTimeout(done, 50));
      }
      assert.match(blockerPid, /^[1-9][0-9]*$/);
      const plan = JSON.parse(await readFile(join(stage, 'plan.json'), 'utf8'));
      for (let count = 0; ; count++) {
        const outcome = await readFile(join(plan.stateRoot, 'updates/result.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => null);
        if (outcome?.status === 'recovery-required') break;
        assert(count < 200, 'Expected recovery-required outcome before user action');
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.equal(
        await readFile(
          join(plan.bundleRoot + '.mizar-restore-' + stage.split(/[\\/]/).at(-1), 'LICENSE'),
          'utf8',
        ),
        'independent product license',
      );
      assert.deepEqual(
        await readFile(
          join(plan.bundleRoot + '.mizar-restore-' + stage.split(/[\\/]/).at(-1), 'Mizar.exe'),
        ),
        await readFile(binaryPath),
      );
      const rejected = await windowProbe(stage, 'restore', 'recovery-required');
      assert.equal(rejected.code, 0, rejected.errors);
      for (let count = 0; ; count++) {
        const activity = await readFile(join(stage, 'update-activity.ndjson'), 'utf8');
        const result = JSON.parse(await readFile(join(stage, 'journal.json'), 'utf8'));
        if (
          activity.includes('restore-requested') &&
          activity.includes('update_process_remaining')
        ) {
          assert.equal(result.phase, 'installing');
          break;
        }
        assert(count < 200, 'Occupied recovery did not reject safely');
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.equal(
        await readFile(
          join(plan.bundleRoot + '.mizar-restore-' + stage.split(/[\\/]/).at(-1), 'LICENSE'),
          'utf8',
        ),
        'independent product license',
      );
      const busyWindow = await windowProbe(stage, 'capture-result', 'recovery-blocked');
      assert.equal(busyWindow.code, 0, busyWindow.errors);
      const stopped = await run([
        '-Command',
        `Stop-Process -Id ${blockerPid} -Force; Wait-Process -Id ${blockerPid} -ErrorAction SilentlyContinue`,
      ]);
      assert.equal(stopped.code, 0, stopped.errors);
      const recovery = await windowProbe(stage, 'restore', 'recovery-required');
      assert.equal(recovery.code, 0, recovery.errors);
    }
    if (env.MIZAR_UPDATE_TEST_UI === '1' && env.MIZAR_UPDATE_TEST_HOLD !== '1') {
      const completed = await windowProbe(
        stage,
        'close-completed',
        env.MIZAR_UPDATE_TEST_CANCEL_UI === '1' ? 'cancelled' : 'restored',
      );
      assert.equal(completed.code, 0, completed.errors);
    }
    const result = await installation;
    assert.notEqual(
      result.code,
      null,
      `Update helper exceeded its fixture deadline: ${result.errors}`,
    );
    if (env.MIZAR_UPDATE_TEST_LAUNCH_EVIDENCE) {
      for (
        let count = 0;
        !(await readFile(env.MIZAR_UPDATE_TEST_LAUNCH_EVIDENCE, 'utf8').catch(() => ''));
        count++
      ) {
        assert(count < 200, 'Committed product did not relaunch after writer lock release');
        await new Promise((done) => setTimeout(done, 50));
      }
      assert.equal(await readFile(env.MIZAR_UPDATE_TEST_LAUNCH_EVIDENCE, 'utf8'), 'allowed');
    }
    // The fixture acknowledges startup, then exits normally. Do not carry it
    // into the next case's real process exclusion check.
    await run([
      '-Command',
      'Get-Process -Name Mizar -ErrorAction SilentlyContinue | Wait-Process -Timeout 10',
    ]);
    return result;
  } catch (error) {
    console.error('Native update original failure before cleanup:', error);
    for (const file of ['journal.json', 'update-activity.ndjson']) {
      const text = await readFile(join(stage, file), 'utf8').catch(() => '[unavailable]');
      console.error(file, safeLogText(text.slice(-8192)));
    }
    throw error;
  } finally {
    host.stdin.end();
    await exited;
    // Release only this fixture's scheduling gates; never stop a production writer.
    await writeFile(join(stage, 'writer-release.txt'), 'release');
    if (installation && !settled && env.MIZAR_UPDATE_TEST_UI === '1') {
      const close = await windowProbe(stage, 'close-completed', 'cleanup-result').catch(
        (error) => ({ code: 1, errors: String(error) }),
      );
      if (close.code !== 0)
        console.error('Native cleanup could not close a terminal window:', close.errors);
    }
    await installation;
  }
}
async function payload(path, version, binary) {
  const files = {
    LICENSE: Buffer.from('independent product license'),
    'Mizar.exe': binary,
    'resources/runtime/node.exe': Buffer.from('fixture runtime'),
    'resources/app/dist/server.js': Buffer.from(`fixture ${version}`),
    'resources/web/dist/index.html': Buffer.from(`fixture ${version}`),
  };
  let identity = '';
  for (const name of Object.keys(files).sort()) identity += `${name}\0${hash(files[name])}\n`;
  const contentDigest = hash(Buffer.from(identity));
  files['resources/metadata/artifact.json'] = Buffer.from(
    JSON.stringify({
      repository: 'Starfie1d1272/Mizar',
      appVersion: version,
      gitSha: 'a'.repeat(40),
      artifactSha256: contentDigest,
    }),
  );
  let sums = '';
  for (const [name, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(path, name)), { recursive: true });
    await writeFile(join(path, name), bytes);
    sums += `${hash(bytes)}  ${name}\n`;
  }
  await writeFile(join(path, 'resources/metadata/SHA256SUMS'), sums);
  await writeFile(join(path, 'installed.flag'), 'fixture installed');
  return contentDigest;
}
try {
  // Refuse to touch another installation's registration or shortcuts when this
  // verification is run outside the clean Windows runner.
  const pristine = await run([
    '-Command',
    "if ((Test-Path 'HKCU:\\Software\\Mizar') -or (Test-Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mizar') -or (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mizar.lnk')) -or (Test-Path (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\\Mizar'))) { exit 1 }",
  ]);
  assert.equal(
    pristine.code,
    0,
    'Native recovery verification requires no existing Mizar installation',
  );
  ownsRegistration = true;
  const compiler = join(root, 'compile.ps1'),
    binaryPath = join(root, 'Stub.exe');
  await writeFile(
    compiler,
    String.raw`param([string]$Output)
Add-Type -OutputAssembly $Output -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
using Microsoft.Win32;
public class UpdateFixture {
  static void Copy(string source, string target) {
    Directory.CreateDirectory(target);
    foreach (var path in Directory.GetFiles(source)) File.Copy(path, Path.Combine(target, Path.GetFileName(path)), true);
    foreach (var path in Directory.GetDirectories(source)) Copy(path, Path.Combine(target, Path.GetFileName(path)));
  }
  [STAThread]
  public static int Main(string[] args) {
    try { Run(args); return 0; }
    catch(Exception error) { Console.Error.WriteLine(error); return 2; }
  }
  static void Run(string[] args) {
    if (args.Length > 0 && args[0] == "--host") { using (var desktop = new Mutex(false, @"Global\MizarDesktop")) { Console.WriteLine(System.Diagnostics.Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks); Console.ReadLine(); } return; }
    var exe = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
    if (Path.GetFileName(exe).Equals("Mizar.exe", StringComparison.OrdinalIgnoreCase)) {
      if (args.Length > 0 && args[0] == "--hold") { Thread.Sleep(30000); return; }
      bool created;
      using(var desktop = new Mutex(false, @"Global\MizarDesktop", out created)) {
        var evidence = Environment.GetEnvironmentVariable("MIZAR_UPDATE_TEST_LAUNCH_EVIDENCE");
        if (!String.IsNullOrEmpty(evidence)) File.WriteAllText(evidence, created ? "allowed" : "blocked");
        if (args.Length > 0 && args[0] == "--try-start") { Console.WriteLine(created ? "allowed" : "blocked"); }
        else {
          var ready = Environment.GetEnvironmentVariable("MIZAR_UPDATE_READY_EVENT");
          if (created && !String.IsNullOrEmpty(ready)) {
            using(var signal = EventWaitHandle.OpenExisting(ready)) signal.Set();
            Thread.Sleep(1000);
          }
        }
      }
      return;
    }
    var stage = Path.GetDirectoryName(exe);
    if (args.Length > 0 && args[0] == "--hold") { File.WriteAllText(Path.Combine(stage, "running.txt"), "ready"); Thread.Sleep(30000); return; }
    var mode = File.ReadAllText(Path.Combine(stage, "mode.txt"));
    // Independent lifecycle oracle: NSIS must never execute while that exact Host lives.
    var host = File.ReadAllLines(Path.Combine(stage, "host.txt"));
    try {
      using (var process = System.Diagnostics.Process.GetProcessById(Int32.Parse(host[0])))
        if (!process.HasExited && process.StartTime.ToUniversalTime().Ticks == Int64.Parse(host[1])) throw new InvalidOperationException("Installer ran before Host exit");
    } catch (ArgumentException) { } // The Host exited and its PID is no longer allocated.
    var command = String.Join(" ", args);
    var target = command.Substring(command.IndexOf("/D=") + 3);
    if (Array.IndexOf(args, "/MIZARPREPARE") < 0) throw new InvalidOperationException("Expected extraction only");
    if (!File.Exists(Path.Combine(target, "Mizar.exe"))) throw new InvalidOperationException("Old program was removed before preparation");
    target += ".mizar-candidate-" + Path.GetFileName(stage);
    if (mode == "success" || mode == "collision") {
      Copy(Path.Combine(stage, "new-payload"), target);
      if (mode == "collision") File.WriteAllText(Path.Combine(target, "user-note.txt"), "new payload collision");
      File.WriteAllText(Path.Combine(target, "installed.flag"), "mizar.install.v1:" + Path.GetFileName(stage));
      if (Environment.GetEnvironmentVariable("MIZAR_UPDATE_TEST_HOLD") == "1") {
        File.WriteAllText(Path.Combine(stage, "writer-ready.txt"), "ready");
        var deadline = DateTime.UtcNow.AddSeconds(20);
        while (!File.Exists(Path.Combine(stage, "writer-release.txt"))) { if (DateTime.UtcNow > deadline) throw new TimeoutException("fixture writer release timeout"); Thread.Sleep(20); }
      }
      return;
    }
    if (mode == "failure") {
      Copy(Path.Combine(stage, "new-payload"), target);
      File.WriteAllText(Path.Combine(target, "Mizar.exe"), "broken installation"); File.WriteAllText(Path.Combine(target, "unknown-user-file.txt"), "preserve unknown content");
    }
    Environment.Exit(mode == "cancel" ? 1 : 2);
  }
}
'@
`,
  );
  const compiled = await run(['-File', compiler, '-Output', binaryPath]);
  assert.equal(compiled.code, 0, compiled.errors);
  const binary = await readFile(binaryPath);
  // Independent filesystem facts for the exact compiled operations used above.
  const ioFixture = join(root, 'file operations');
  await mkdir(ioFixture);
  const ioFile = join(ioFixture, '只读内容.bin');
  const ioBytes = Buffer.from('independent file operation fixture');
  await writeFile(ioFile, ioBytes);
  const psLiteral = (text) => `'${text.replaceAll("'", "''")}'`;
  const checkedIo = await run([
    '-Command',
    `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile(${psLiteral(script)}, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$definition = $ast.EndBlock.Statements | Where-Object { $_.Extent.Text.StartsWith('Add-Type -TypeDefinition') }
Invoke-Expression $definition.Extent.Text
$file = ${psLiteral(ioFile)}
if ([MizarUpdateFiles]::Hash($file) -ne '${hash(ioBytes)}') { throw 'SHA mismatch' }
$lock = [IO.File]::Open($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {
  $rejected = $false
  try { [MizarUpdateFiles]::Hash($file) | Out-Null } catch { $rejected = $true }
  if (!$rejected) { throw 'Locked writer was read' }
} finally { $lock.Dispose() }
$rejected = $false
try { [MizarUpdateFiles]::PlainPath('relative-file') } catch { $rejected = $_.Exception.GetBaseException().Message -eq 'update_path_invalid' }
if (!$rejected) { throw 'Relative path accepted' }
$outside = ${psLiteral(join(ioFixture, 'retained'))}
$link = ${psLiteral(join(ioFixture, 'junction'))}
[IO.Directory]::CreateDirectory($outside) | Out-Null
[IO.File]::WriteAllText((Join-Path $outside 'unknown.txt'), 'preserve')
cmd.exe /c mklink /J $link $outside | Out-Null
if ($LASTEXITCODE) { throw 'Junction fixture creation failed' }
$rejected = $false
try { [MizarUpdateFiles]::Hash((Join-Path $link 'unknown.txt')) | Out-Null } catch { $rejected = $_.Exception.GetBaseException().Message -eq 'update_reparse_point' }
if (!$rejected -or [IO.File]::ReadAllText((Join-Path $outside 'unknown.txt')) -ne 'preserve') { throw 'Reparse path touched unknown content' }
[IO.Directory]::Delete($link)
# Execute the exact timing wrapper against an unwritable report path. Warning
# preference Stop must not turn this optional diagnostic into a transaction failure.
$functions = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)
foreach ($function in $functions) { Invoke-Expression $function.Extent.Text }
$env:LOCALAPPDATA = ${psLiteral(ioFixture)}
$state = Join-Path $env:LOCALAPPDATA 'Mizar'
$target = Join-Path $env:LOCALAPPDATA 'program'
[IO.Directory]::CreateDirectory($state) | Out-Null
[IO.Directory]::CreateDirectory($target) | Out-Null
$state = Handoff-Path $state; $target = Handoff-Path $target
$writer = [Threading.Mutex]::new($false, 'Global\\MizarUpdateWriter')
$owned = $false
try {
  $owned = $writer.WaitOne(0)
  if (!$owned) { throw 'Another update is running' }
  $script:handoffHandles = [Collections.Generic.List[IDisposable]]::new()
  function Get-CimInstance { throw 'Unrelated processes must not be scanned without a legacy stage' }
  if ((Invoke-LegacyHandoff $target $state) -ne $state) { throw 'Empty legacy handoff failed' }
  $refused = $false
  try { Assert-HandoffProcessEnded ([int]$PID) ([long][Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks) } catch { $refused = $_.Exception.Message -eq 'update_handoff_process_active' }
  if (!$refused) { throw 'Named recovery owner was ignored' }
} finally { if ($owned) { $writer.ReleaseMutex() }; $writer.Dispose() }
$StageRoot = ${psLiteral(ioFixture)}; $Mode = 'Install'; $plan = @{}
[IO.Directory]::CreateDirectory((Join-Path $StageRoot 'install-timings.json.tmp')) | Out-Null
$env:MIZAR_MEASURE_UPDATE = '1'; $WarningPreference = 'Stop'
$script:updatePhases = [Collections.Generic.List[object]]::new()
$script:operations = 0
$output = @(Measure-UpdatePhase 'success-fixture' { $script:operations++; 'operation-result' } 3>&1)
$diagnostics = @($output | Where-Object { $_ -is [Management.Automation.WarningRecord] })
$result = @($output | Where-Object { $_ -isnot [Management.Automation.WarningRecord] })
if ($result -ne 'operation-result' -or $script:operations -ne 1) { throw 'Timing failure changed successful operation' }
if ($diagnostics.Count -ne 1 -or $diagnostics[0].Message -notmatch 'update_timing_write_failed') { throw 'Timing failure lacked explicit diagnostic' }
$original = [IO.IOException]::new('original-operation-failure')
$preserved = $false
$diagnostics = @(& {
  try { Measure-UpdatePhase 'failure-fixture' { $script:operations++; throw $original } }
  catch { $script:preserved = [object]::ReferenceEquals($_.Exception, $original) }
} 3>&1)
if (!$preserved -or $script:operations -ne 2) { throw 'Timing failure replaced original exception' }
if ($diagnostics.Count -ne 1 -or $diagnostics[0].Message -notmatch 'update_timing_write_failed') { throw 'Original failure lacked timing diagnostic' }
`,
  ]);
  assert.equal(checkedIo.code, 0, checkedIo.errors);
  console.log(
    'Native file operations and non-fatal timing write failures preserve verification and original outcomes: PASS',
  );
  for (const scenario of [
    'success',
    'success-no-shortcut',
    'cancel',
    'cancel-before-install',
    'failure',
    'recovery-blocked',
    'interrupted',
    'collision',
    'committed-corrupt',
  ]) {
    console.log(`Native update scenario: ${scenario}`);
    const success = scenario.startsWith('success');
    const area = join(root, scenario),
      installed = join(area, 'installed path'),
      state = join(area, 'user state');
    await mkdir(join(state, 'updates/download-test'), { recursive: true });
    await writeFile(join(state, 'user-data.json'), 'untouched match and settings');
    const previousDigest = await payload(installed, '1.11.6', binary);
    if (scenario === 'success-no-shortcut') {
      const readOnly = await run([
        '-Command',
        `[IO.File]::SetAttributes(${psLiteral(join(installed, 'resources/web/dist/index.html'))}, [IO.FileAttributes]::ReadOnly)`,
      ]);
      assert.equal(readOnly.code, 0, readOnly.errors);
    }
    const registered = await run([
      '-Command',
      `New-Item 'HKCU:\\Software\\Mizar' -Force | Out-Null; New-ItemProperty 'HKCU:\\Software\\Mizar' -Name InstallDir -Value '${installed.replace(/'/g, "''")}' -PropertyType String -Force | Out-Null; New-Item 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mizar' -Force | Out-Null; New-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mizar' -Name DisplayVersion -Value '1.11.6' -PropertyType String -Force | Out-Null`,
    ]);
    assert.equal(registered.code, 0, registered.errors);
    const desktop = await run(['-Command', "[Environment]::GetFolderPath('Desktop')"]);
    assert.equal(desktop.code, 0, desktop.errors);
    const shortcut = join(desktop.output, 'Mizar.lnk');
    await rm(shortcut, { force: true });
    let originalShortcut;
    if (scenario !== 'success-no-shortcut') {
      // Updates never write links: even an unreadable user link must remain unchanged.
      await writeFile(shortcut, 'user-owned shortcut bytes');
      originalShortcut = await readFile(shortcut);
    }
    const nextPath = join(area, 'next payload'),
      next = await payload(nextPath, '1.11.7', binary);
    const installer = join(state, 'updates/download-test/Mizar-v1.11.7-Windows-x64-Setup.exe');
    await writeFile(installer, binary);
    const plan = {
      schemaVersion: 1,
      bundleRoot: installed,
      stateRoot: state,
      installer,
      installerSha256: hash(binary),
      installerBytes: binary.length,
      previousContentDigest: previousDigest,
      contentDigest: next,
      version: '1.11.7',
      gitSha: 'a'.repeat(40),
    };
    const planPath = join(area, 'plan.json');
    await writeFile(planPath, JSON.stringify(plan));
    console.log(`Native recovery ${scenario}: preparing`);
    const prepared = await run(['-File', script, '-Mode', 'Prepare', '-PlanPath', planPath]);
    assert.equal(prepared.code, 0, prepared.errors);
    const stage = JSON.parse(prepared.output).stageRoot;
    const stageId = stage.split(/[\\/]/).at(-1);
    const previous = installed + '.mizar-restore-' + stageId;
    await writeFile(join(installed, 'user-note.txt'), 'keep user content');
    await cp(nextPath, join(stage, 'new-payload'), { recursive: true });
    await writeFile(
      join(stage, 'mode.txt'),
      success || scenario === 'recovery-blocked' ? 'success' : scenario,
    );
    // An actual timing write failure must preserve both a successful commit and
    // the original installer cancellation/rollback, using these existing cases.
    const timingFault = scenario === 'success-no-shortcut' || scenario === 'failure';
    if (timingFault) await mkdir(join(stage, 'install-timings.json.tmp'));
    let result;
    if (scenario === 'committed-corrupt') {
      await rename(installed, previous);
      await cp(nextPath, installed, { recursive: true });
      await writeFile(join(previous, '.mizar-update-owner'), stageId);
      await writeFile(
        join(installed, 'installed.flag'),
        `mizar.install.v1:${stage.split(/[\\/]/).at(-1)}`,
      );
      await writeFile(join(stage, 'journal.json'), JSON.stringify({ phase: 'committed' }));
      await writeFile(join(installed, 'resources/app/dist/server.js'), 'corrupt committed payload');
      await writeFile(join(previous, 'LICENSE'), 'unverified backup license');
      const literal = (text) => `'${text.replaceAll("'", "''")}'`;
      const recovering = run(
        [
          '-Command',
          `[IO.File]::WriteAllText(${literal(join(stage, 'ui-helper-pid.txt'))}, [string]$PID); & ${literal(script)} -Mode Recover -StageRoot ${literal(stage)}; exit $LASTEXITCODE`,
        ],
        { MIZAR_UPDATE_TEST_UI: '1' },
      );
      for (
        let count = 0;
        !(await readFile(join(stage, 'ui-helper-pid.txt'), 'utf8').catch(() => ''));
        count++
      ) {
        assert(count < 200);
        await new Promise((done) => setTimeout(done, 50));
      }
      const unavailable = await windowProbe(stage, 'backup-unavailable', 'backup-unavailable');
      assert.equal(unavailable.code, 0, unavailable.errors);
      const close = await windowProbe(stage, 'close-completed', 'backup-unavailable-result');
      assert.equal(close.code, 0, close.errors);
      result = await recovering;
      const diagnostic = (registration) => {
        const summarize = (value) =>
          value && {
            code: value.code,
            pid: value.pid,
            stdout: safeLogText(value.output, [process.env.GH_TOKEN, process.env.GITHUB_TOKEN]),
            stderr: safeLogText(value.errors, [process.env.GH_TOKEN, process.env.GITHUB_TOKEN]),
          };
        return JSON.stringify(
          { scenario, recovery: summarize(result), registration: summarize(registration) },
          null,
          2,
        );
      };
      assert.equal(result.code, 1, diagnostic());
      const report = JSON.parse(await readFile(join(state, 'updates/result.json'), 'utf8'));
      assert.equal(report.status, 'recovery-required');
      assert.equal(report.code, 'update_committed_payload_invalid');
      const recovery = await run([
        '-Command',
        `$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $expected = [IO.Path]::GetFullPath('${stage.replace(/'/g, "''")}').TrimEnd('\\'); $entry = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce' -Name '!MizarUpdateRecovery' -ErrorAction Continue).'!MizarUpdateRecovery'; @{ present = [bool]$entry; targetsStage = [bool]($entry -and $entry.Contains(' -File "' + (Join-Path $expected 'update-install.ps1') + '" -Mode Recover -StageRoot "' + $expected + '"')) } | ConvertTo-Json -Compress`,
      ]);
      assert.equal(recovery.code, 0, diagnostic(recovery));
      // Compare the actual command with the OS-normalized target: Framework
      // GetFullPath can expand the runner's RUNNER~1 temporary directory alias.
      assert.deepEqual(
        JSON.parse(recovery.output),
        { present: true, targetsStage: true },
        diagnostic(recovery),
      );
      assert.deepEqual(await readFile(join(previous, 'Mizar.exe')), binary);
      assert.equal(
        await readFile(join(state, 'user-data.json'), 'utf8'),
        'untouched match and settings',
      );
      await rm(shortcut, { force: true });
      process.stdout.write(`Stub-installer recovery ${scenario}: PASS\n`);
      continue;
    } else if (scenario === 'interrupted') {
      await rename(installed, previous);
      const candidate = installed + '.mizar-candidate-' + stageId;
      await cp(nextPath, candidate, { recursive: true });
      await writeFile(join(previous, '.mizar-update-owner'), stageId);
      await writeFile(join(candidate, '.mizar-update-owner'), stageId);
      await writeFile(join(candidate, 'installed.flag'), 'mizar.install.v1:' + stageId);
      // Independent expectations for the original installation registration.
      await writeFile(
        join(stage, 'registration.json'),
        JSON.stringify([
          {
            key: 'HKCU:\\Software\\Mizar',
            exists: true,
            values: [{ name: 'InstallDir', kind: 'String', value: installed }],
          },
          {
            key: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mizar',
            exists: true,
            values: [{ name: 'DisplayVersion', kind: 'String', value: '1.11.6' }],
          },
        ]),
      );
      await writeFile(join(stage, 'journal.json'), JSON.stringify({ phase: 'installing' }));
      // Installation started but no PID was persisted: recovery must leave
      // the installation untouched while that exact staged executable is alive.
      const installer = spawn(join(stage, 'Installer.exe'), ['--hold'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      try {
        const deadline = Date.now() + 10000;
        while (!(await readFile(join(stage, 'running.txt'), 'utf8').catch(() => ''))) {
          assert(Date.now() < deadline, 'installer did not start');
          await new Promise((done) => setTimeout(done, 50));
        }
        const blocked = await run(['-File', script, '-Mode', 'Recover', '-StageRoot', stage]);
        const processEvidence = await run([
          '-Command',
          `Get-CimInstance Win32_Process -Filter "ProcessId = ${installer.pid}" | Select-Object ProcessId, Name, ExecutablePath | ConvertTo-Json -Compress`,
        ]);
        assert.equal(
          blocked.code,
          1,
          `running installer must block recovery without a journal PID: ${processEvidence.output}; ${blocked.errors}`,
        );
        await assert.rejects(readFile(join(installed, 'Mizar.exe')), { code: 'ENOENT' });
      } finally {
        const exited = new Promise((done) => installer.once('exit', done));
        installer.kill();
        await exited;
      }
      // Pause only scheduling in an isolated copy of the real recovery function.
      const recoveryScript = join(stage, 'scheduled-recovery.ps1');
      const production = await readFile(script, 'utf8');
      const gate = `function Restore-Previous {\n  [IO.File]::WriteAllText((Join-Path $StageRoot 'recovery-ready.txt'), 'ready')\n  $deadline = [DateTime]::UtcNow.AddSeconds(20)\n  while (!(Test-Path (Join-Path $StageRoot 'recovery-release.txt'))) { if ([DateTime]::UtcNow -gt $deadline) { throw 'fixture_recovery_release_timeout' }; Start-Sleep -Milliseconds 20 }`;
      assert.equal(production.split('function Restore-Previous {').length, 2);
      await writeFile(recoveryScript, production.replace('function Restore-Previous {', gate));
      const restoring = run(['-File', recoveryScript, '-Mode', 'Recover', '-StageRoot', stage]);
      for (
        let count = 0;
        !(await readFile(join(stage, 'recovery-ready.txt'), 'utf8').catch(() => ''));
        count++
      ) {
        assert(count < 200, 'Recovery did not reach its protected interval');
        await new Promise((done) => setTimeout(done, 50));
      }
      const protectedDesktop = await run([
        '-Command',
        "$created = $false; $desktop = New-Object Threading.Mutex($false, 'Global\\MizarDesktop', [ref]$created); try { if ($created) { exit 1 }; $active = [Threading.EventWaitHandle]::OpenExisting('Global\\MizarUpdateActive'); $active.Dispose() } finally { $desktop.Dispose() }",
      ]);
      assert.equal(protectedDesktop.code, 0, protectedDesktop.errors);
      const duplicate = await run(['-File', script, '-Mode', 'Recover', '-StageRoot', stage]);
      assert.equal(duplicate.code, 1);
      assert.match(duplicate.errors, /update_transaction_busy/);
      assert.deepEqual(await readFile(join(previous, 'Mizar.exe')), binary);
      await writeFile(join(stage, 'recovery-release.txt'), 'release');
      result = await restoring;
      assert.equal(
        result.code,
        0,
        `${result.errors}\n${await readFile(join(state, 'updates/result.json'), 'utf8').catch(() => 'No recovery result was written')}`,
      );
    } else {
      let recoveryScript;
      if (scenario === 'recovery-blocked') {
        // Inject a real external file user only after the directory switch.
        // Extraction refusal no longer reaches the rollback branch.
        recoveryScript = join(stage, 'scheduled-install.ps1');
        const production = (await readFile(script, 'utf8')).replace(/\r\n/g, '\n');
        const call = '\n  Install-Registration\n';
        assert.equal(production.split(call).length, 2);
        await writeFile(
          recoveryScript,
          production.replace(
            call,
            '\n  $blocker = Start-Process -FilePath (Join-Path $plan.bundleRoot "Mizar.exe") -ArgumentList "--hold" -WindowStyle Hidden -PassThru\n' +
              '  [IO.File]::WriteAllText((Join-Path $StageRoot "blocker-pid.txt"), [string]$blocker.Id)\n' +
              '  throw "update_registration_failed"\n',
          ),
        );
      }
      result = await installWithHost(
        binaryPath,
        stage,
        scenario === 'success'
          ? {
              MIZAR_UPDATE_TEST_HOLD: '1',
              MIZAR_UPDATE_TEST_UI: '1',
              MIZAR_UPDATE_TEST_LAUNCH_EVIDENCE: join(stage, 'launch-evidence.txt'),
            }
          : scenario === 'recovery-blocked'
            ? {
                MIZAR_UPDATE_TEST_UI: '1',
                MIZAR_UPDATE_TEST_RECOVERY_UI: '1',
                MIZAR_UPDATE_TEST_SCRIPT: recoveryScript,
              }
            : scenario === 'cancel-before-install'
              ? { MIZAR_UPDATE_TEST_UI: '1', MIZAR_UPDATE_TEST_CANCEL_UI: '1' }
              : timingFault
                ? {
                    MIZAR_MEASURE_UPDATE: '1',
                    ...(scenario === 'failure'
                      ? { MIZAR_UPDATE_TEST_UI: '1', MIZAR_UPDATE_TEST_CWD: installed }
                      : {}),
                  }
                : {},
      );
      assert.equal(result.code, success || scenario === 'recovery-blocked' ? 0 : 1, result.errors);
      if (timingFault) {
        assert.match(result.output, /update_timing_write_failed/);
        if (!success) assert.match(result.errors, /update_installer_failed/);
      }
    }
    const report = JSON.parse(
      (await readFile(join(state, 'updates/result.json'), 'utf8')).replace(/^\uFEFF/, ''),
    );
    assert.notEqual(report.code, 'update_host_exit_timeout', JSON.stringify(report));
    if (timingFault)
      assert.equal(report.code, success ? 'update_completed' : 'update_installer_failed');
    if (scenario === 'cancel' || scenario === 'failure') {
      const activity = (await readFile(join(stage, 'update-activity.ndjson'), 'utf8'))
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line));
      assert.equal(
        activity.find((entry) => entry.phase === 'installer-exit').detail,
        scenario === 'cancel' ? '1' : '2',
      );
      assert.match(
        activity.find((entry) => entry.phase === 'failure').detail,
        scenario === 'cancel' ? /update_installer_cancelled/ : /update_installer_failed/,
      );
    }
    assert.equal(
      report.status,
      success
        ? 'installed'
        : ['cancel', 'cancel-before-install'].includes(scenario)
          ? 'cancelled'
          : ['failure', 'collision'].includes(scenario)
            ? 'failed'
            : 'restored',
      JSON.stringify(report),
    );
    const identity = JSON.parse(
      await readFile(join(installed, 'resources/metadata/artifact.json'), 'utf8'),
    );
    assert.equal(identity.appVersion, success ? '1.11.7' : '1.11.6');
    assert.equal(
      await readFile(join(state, 'user-data.json'), 'utf8'),
      'untouched match and settings',
    );
    assert.deepEqual(await readFile(join(installed, 'Mizar.exe')), binary);
    assert.equal(await readFile(join(installed, 'user-note.txt'), 'utf8'), 'keep user content');
    if (scenario === 'collision') assert.equal(report.code, 'update_user_file_conflict');
    if (scenario === 'failure')
      assert.equal(
        await readFile(
          join(
            `${installed}.mizar-candidate-${stage.split(/[\\/]/).at(-1)}`,
            'unknown-user-file.txt',
          ),
          'utf8',
        ),
        'preserve unknown content',
      );
    const registration = await run([
      '-Command',
      "$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); @{ directory = (Get-ItemProperty 'HKCU:\\Software\\Mizar').InstallDir; version = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mizar').DisplayVersion } | ConvertTo-Json -Compress",
    ]);
    assert.equal(registration.code, 0, registration.errors);
    const registeredInstallation = JSON.parse(registration.output);
    assert.equal(registeredInstallation.version, success ? '1.11.7' : '1.11.6');
    // The registry can store the expanded Windows path rather than RUNNER~1.
    // Independently resolve both paths instead of comparing alias spelling.
    assert.equal(await realpath(registeredInstallation.directory), await realpath(installed));
    if (success) {
      for (const removed of [
        `${installed}.mizar-restore-${stageId}`,
        join(stage, 'Installer.exe'),
        installer,
      ]) {
        await assert.rejects(realpath(removed), { code: 'ENOENT' });
      }
    }
    if (scenario === 'success-no-shortcut')
      await assert.rejects(readFile(shortcut), { code: 'ENOENT' });
    else assert.deepEqual(await readFile(shortcut), originalShortcut);
    await rm(shortcut, { force: true });
    process.stdout.write(`Stub-installer recovery ${scenario}: PASS\n`);
  }
} finally {
  if (ownsRegistration) {
    await run([
      '-Command',
      "Remove-Item -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mizar.lnk') -Force -ErrorAction SilentlyContinue",
    ]);
    await run([
      '-Command',
      "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce' -Name '!MizarUpdateRecovery' -ErrorAction SilentlyContinue",
    ]);
    await run([
      '-Command',
      "Remove-Item 'HKCU:\\Software\\Mizar', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mizar' -Recurse -Force -ErrorAction SilentlyContinue",
    ]);
  }
  await rm(root, { force: true, recursive: true });
}
