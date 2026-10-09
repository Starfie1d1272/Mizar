// Windows filesystem/process recovery with a stub installer; not a real NSIS upgrade or login recovery acceptance.
import { setTimeout } from 'node:timers';
import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

if (process.platform !== 'win32') throw new Error('此验证需要 Windows PowerShell 与真实文件系统');
const root = await mkdtemp(join(tmpdir(), 'mizar 更新 recovery '));
const script = resolve(dirname(fileURLToPath(import.meta.url)), 'bundle/update-install.ps1');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let ownsRegistration = false;
async function run(args) {
  // The Host also removes an inherited PowerShell 7 module path before
  // launching Windows PowerShell 5.1, so its built-in modules load normally.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.toLowerCase() !== 'psmodulepath'),
  );
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
    { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '',
    errors = '';
  child.stdout.on('data', (b) => {
    output += b;
  });
  child.stderr.on('data', (b) => {
    errors += b;
  });
  const code = await new Promise((done, reject) => {
    child.on('error', reject);
    child.on('exit', done);
  });
  return { code, output: output.replace(/^\uFEFF/, '').trim(), errors, pid: child.pid };
}
async function payload(path, version, binary) {
  const files = {
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
  public static void Main(string[] args) {
    var exe = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
    if (Path.GetFileName(exe).Equals("Mizar.exe", StringComparison.OrdinalIgnoreCase)) { if (args.Length > 0 && args[0] == "--hold") Thread.Sleep(30000); return; }
    var stage = Path.GetDirectoryName(exe);
    if (args.Length > 0 && args[0] == "--hold") { File.WriteAllText(Path.Combine(stage, "running.txt"), "ready"); Thread.Sleep(30000); return; }
    var mode = File.ReadAllText(Path.Combine(stage, "mode.txt"));
    var shortcut = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Desktop), "Mizar.lnk");
    if (File.Exists(shortcut)) File.Delete(shortcut);
    var command = String.Join(" ", args);
    var target = command.Substring(command.IndexOf("/D=") + 3);
    using (var app = Registry.CurrentUser.CreateSubKey(@"Software\Mizar")) app.SetValue("InstallDir", target);
    using (var uninstall = Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall\Mizar")) uninstall.SetValue("DisplayVersion", "1.1.0");
    if (mode == "success") { Copy(Path.Combine(stage, "new-payload"), target); return; }
    if (mode == "failure") File.WriteAllText(Path.Combine(target, "Mizar.exe"), "broken installation");
    Environment.Exit(2);
  }
}
'@
`,
  );
  const compiled = await run(['-File', compiler, '-Output', binaryPath]);
  assert.equal(compiled.code, 0, compiled.errors);
  const binary = await readFile(binaryPath);
  const exited = await run(['-Command', 'exit 0']);
  for (const scenario of [
    'success',
    'success-no-shortcut',
    'cancel',
    'failure',
    'interrupted',
    'remaining-process',
    'committed-valid',
    'committed-corrupt',
  ]) {
    const success = scenario.startsWith('success') || scenario === 'committed-valid';
    const area = join(root, scenario),
      installed = join(area, 'installed path'),
      state = join(area, 'user state');
    await mkdir(join(state, 'updates/download-test'), { recursive: true });
    await writeFile(join(state, 'user-data.json'), 'untouched match and settings');
    const previous = await payload(installed, '1.0.0', binary);
    const registered = await run([
      '-Command',
      `New-Item 'HKCU:\\Software\\Mizar' -Force | Out-Null; New-ItemProperty 'HKCU:\\Software\\Mizar' -Name InstallDir -Value '${installed.replace(/'/g, "''")}' -PropertyType String -Force | Out-Null; New-Item 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mizar' -Force | Out-Null; New-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mizar' -Name DisplayVersion -Value '1.0.0' -PropertyType String -Force | Out-Null`,
    ]);
    assert.equal(registered.code, 0, registered.errors);
    const desktop = await run(['-Command', "[Environment]::GetFolderPath('Desktop')"]);
    assert.equal(desktop.code, 0, desktop.errors);
    const shortcut = join(desktop.output, 'Mizar.lnk');
    await rm(shortcut, { force: true });
    if (scenario !== 'success-no-shortcut') await writeFile(shortcut, 'existing user shortcut');
    const nextPath = join(area, 'next payload'),
      next = await payload(nextPath, '1.1.0', binary);
    const installer = join(state, 'updates/download-test/Mizar-v1.1.0-Windows-x64-Setup.exe');
    await writeFile(installer, binary);
    const plan = {
      schemaVersion: 1,
      bundleRoot: installed,
      stateRoot: state,
      installer,
      installerSha256: hash(binary),
      installerBytes: binary.length,
      previousContentDigest: previous,
      contentDigest: next,
      version: '1.1.0',
      gitSha: 'a'.repeat(40),
    };
    const planPath = join(area, 'plan.json');
    await writeFile(planPath, JSON.stringify(plan));
    const prepared = await run(['-File', script, '-Mode', 'Prepare', '-PlanPath', planPath]);
    assert.equal(prepared.code, 0, prepared.errors);
    const stage = JSON.parse(prepared.output).stageRoot;
    await cp(nextPath, join(stage, 'new-payload'), { recursive: true });
    await writeFile(join(stage, 'mode.txt'), success ? 'success' : scenario);
    let result;
    if (scenario.startsWith('committed-')) {
      await cp(installed, join(stage, 'previous'), { recursive: true });
      await cp(nextPath, installed, { recursive: true });
      await writeFile(join(stage, 'journal.json'), JSON.stringify({ phase: 'committed' }));
      if (scenario === 'committed-corrupt')
        await writeFile(
          join(installed, 'resources/app/dist/server.js'),
          'corrupt committed payload',
        );
      result = await run(['-File', script, '-Mode', 'Recover', '-StageRoot', stage]);
      assert.equal(result.code, success ? 0 : 1, result.errors);
      const report = JSON.parse(await readFile(join(state, 'updates/result.json'), 'utf8'));
      assert.equal(report.status, success ? 'installed' : 'recovery-required');
      assert.equal(report.code, success ? 'update_completed' : 'update_committed_payload_invalid');
      const recovery = await run([
        '-Command',
        `$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce' -Name '!MizarUpdateRecovery' -ErrorAction SilentlyContinue).'!MizarUpdateRecovery'`,
      ]);
      assert.equal(recovery.output.includes(stage), !success);
      assert.deepEqual(await readFile(join(stage, 'previous/Mizar.exe')), binary);
      assert.equal(
        await readFile(join(state, 'user-data.json'), 'utf8'),
        'untouched match and settings',
      );
      await rm(shortcut, { force: true });
      process.stdout.write(`Stub-installer recovery ${scenario}: PASS\n`);
      continue;
    } else if (scenario === 'interrupted') {
      await cp(installed, join(stage, 'previous'), { recursive: true });
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
            values: [{ name: 'DisplayVersion', kind: 'String', value: '1.0.0' }],
          },
        ]),
      );
      await writeFile(join(stage, 'journal.json'), JSON.stringify({ phase: 'installing' }));
      await rm(installed, { recursive: true });
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
      result = await run(['-File', script, '-Mode', 'Recover', '-StageRoot', stage]);
      assert.equal(
        result.code,
        0,
        `${result.errors}\n${await readFile(join(state, 'updates/result.json'), 'utf8').catch(() => 'No recovery result was written')}`,
      );
    } else if (scenario === 'remaining-process') {
      const owned = spawn(join(installed, 'Mizar.exe'), ['--hold'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      try {
        result = await run([
          '-File',
          script,
          '-Mode',
          'Install',
          '-StageRoot',
          stage,
          '-HostProcessId',
          String(exited.pid),
        ]);
      } finally {
        owned.kill();
        await new Promise((done) => owned.once('exit', done));
      }
      assert.equal(result.code, 1, 'An existing Mizar process must prevent any installation');
    } else {
      result = await run([
        '-File',
        script,
        '-Mode',
        'Install',
        '-StageRoot',
        stage,
        '-HostProcessId',
        String(exited.pid),
      ]);
      assert.equal(result.code, success ? 0 : 1, result.errors);
    }
    const report = JSON.parse(
      (await readFile(join(state, 'updates/result.json'), 'utf8')).replace(/^\uFEFF/, ''),
    );
    assert.equal(
      report.status,
      success ? 'installed' : scenario === 'remaining-process' ? 'cancelled' : 'restored',
    );
    const identity = JSON.parse(
      await readFile(join(installed, 'resources/metadata/artifact.json'), 'utf8'),
    );
    assert.equal(identity.appVersion, success ? '1.1.0' : '1.0.0');
    assert.equal(
      await readFile(join(state, 'user-data.json'), 'utf8'),
      'untouched match and settings',
    );
    assert.deepEqual(await readFile(join(installed, 'Mizar.exe')), binary);
    const registration = await run([
      '-Command',
      "$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); @{ directory = (Get-ItemProperty 'HKCU:\\Software\\Mizar').InstallDir; version = (Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mizar').DisplayVersion } | ConvertTo-Json -Compress",
    ]);
    assert.equal(registration.code, 0, registration.errors);
    assert.deepEqual(JSON.parse(registration.output), {
      directory: installed,
      version: success ? '1.1.0' : '1.0.0',
    });
    if (scenario === 'success-no-shortcut')
      await assert.rejects(readFile(shortcut), { code: 'ENOENT' });
    else if (scenario !== 'interrupted')
      assert.equal(await readFile(shortcut, 'utf8'), 'existing user shortcut');
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
