// Windows-only native recovery evidence; never a simulated Linux PASS.
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
async function run(args) {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
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
    "if ((Test-Path 'HKCU:\\Software\\Mizar') -or (Test-Path (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Mizar.lnk')) -or (Test-Path (Join-Path ([Environment]::GetFolderPath('StartMenu')) 'Programs\\Mizar'))) { exit 1 }",
  ]);
  assert.equal(
    pristine.code,
    0,
    'Native recovery verification requires no existing Mizar installation',
  );
  const compiler = join(root, 'compile.ps1'),
    binaryPath = join(root, 'Stub.exe');
  await writeFile(
    compiler,
    String.raw`param([string]$Output)
Add-Type -OutputAssembly $Output -OutputType ConsoleApplication -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public class UpdateFixture {
  static void Copy(string source, string target) {
    Directory.CreateDirectory(target);
    foreach (var path in Directory.GetFiles(source)) File.Copy(path, Path.Combine(target, Path.GetFileName(path)), true);
    foreach (var path in Directory.GetDirectories(source)) Copy(path, Path.Combine(target, Path.GetFileName(path)));
  }
  public static void Main(string[] args) {
    var exe = System.Diagnostics.Process.GetCurrentProcess().MainModule.FileName;
    if (Path.GetFileName(exe).Equals("Mizar.exe", StringComparison.OrdinalIgnoreCase)) { Thread.Sleep(30000); return; }
    var stage = Path.GetDirectoryName(exe);
    var mode = File.ReadAllText(Path.Combine(stage, "mode.txt"));
    var command = String.Join(" ", args);
    var target = command.Substring(command.IndexOf("/D=") + 3);
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
  for (const scenario of ['success', 'cancel', 'failure', 'interrupted', 'remaining-process']) {
    const area = join(root, scenario),
      installed = join(area, 'installed path'),
      state = join(area, 'user state');
    await mkdir(join(state, 'updates/download-test'), { recursive: true });
    await writeFile(join(state, 'user-data.json'), 'untouched match and settings');
    const previous = await payload(installed, '1.0.0', binary);
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
    await writeFile(join(stage, 'mode.txt'), scenario);
    let result;
    if (scenario === 'interrupted') {
      await cp(installed, join(stage, 'previous'), { recursive: true });
      await writeFile(join(stage, 'registration.json'), '[]');
      await writeFile(join(stage, 'journal.json'), JSON.stringify({ phase: 'installing' }));
      await rm(installed, { recursive: true });
      result = await run(['-File', script, '-Mode', 'Recover', '-StageRoot', stage]);
      assert.equal(result.code, 0, result.errors);
    } else if (scenario === 'remaining-process') {
      const owned = spawn(join(installed, 'Mizar.exe'), [], { windowsHide: true, stdio: 'ignore' });
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
      assert.equal(result.code, scenario === 'success' ? 0 : 1, result.errors);
    }
    const report = JSON.parse(
      (await readFile(join(state, 'updates/result.json'), 'utf8')).replace(/^\uFEFF/, ''),
    );
    assert.equal(
      report.status,
      scenario === 'success'
        ? 'installed'
        : scenario === 'remaining-process'
          ? 'cancelled'
          : 'restored',
    );
    const identity = JSON.parse(
      await readFile(join(installed, 'resources/metadata/artifact.json'), 'utf8'),
    );
    assert.equal(identity.appVersion, scenario === 'success' ? '1.1.0' : '1.0.0');
    assert.equal(
      await readFile(join(state, 'user-data.json'), 'utf8'),
      'untouched match and settings',
    );
    assert.deepEqual(await readFile(join(installed, 'Mizar.exe')), binary);
    process.stdout.write(`Native update ${scenario}: PASS\n`);
  }
} finally {
  await run([
    '-Command',
    "Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce' -Name '!MizarUpdateRecovery' -ErrorAction SilentlyContinue",
  ]);
  await rm(root, { force: true, recursive: true });
}
