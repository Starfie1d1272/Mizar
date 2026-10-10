// Temporary isolated Windows evidence only. Never operate on a user's installation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyPayload } from './product-runtime.mjs';
const [product, installed, lane] = process.argv.slice(2).map((x, i) => i < 2 ? resolve(x) : x);
assert.equal(process.platform, 'win32');
assert.equal(process.env.CI, 'true');
assert.ok(installed.toLowerCase().startsWith(resolve(process.env.RUNNER_TEMP).toLowerCase() + '\\'));
const literal = (s) => `'${s.replace(/'/g, "''")}'`;
const script = resolve('scripts/qualification/bundle/update-install.ps1');
const json = async (p) => JSON.parse(await readFile(p, 'utf8'));
const manifest = await json(join(product, lane === 'setup' ? 'release-manifest.json' : 'core-release-manifest.json'));
const distribution = await json(join(product, lane === 'setup' ? 'distribution-manifest.json' : 'core-distribution-manifest.json'));
await verifyPayload(installed);
const state = await mkdtemp(join(process.env.RUNNER_TEMP, 'zlib-recovery-'));
await writeFile(join(state, 'user-sentinel.txt'), 'preserve user state');
const download = join(state, 'updates/download-real');
await mkdir(download, { recursive: true });
const installer = join(download, distribution.archive);
await cp(join(product, distribution.archive), installer);
const plan = { schemaVersion: 1, bundleRoot: installed, stateRoot: state, installer,
  installerSha256: distribution.archiveSha256, installerBytes: distribution.archiveBytes,
  previousContentDigest: manifest.contentDigest, contentDigest: manifest.contentDigest,
  version: manifest.appVersion, gitSha: manifest.gitSha,
  ...(lane === 'core-setup' ? { coreArchiveSha256: manifest.archiveSha256 } : {}) };
const planPath = join(state, 'plan.json');
await writeFile(planPath, JSON.stringify(plan));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
function launch(args) {
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', b => { stdout += b; });
  child.stderr.on('data', b => { stderr += b; });
  const done = new Promise((ok, bad) => { child.on('error', bad); child.on('exit', code => ok({ code, stdout: stdout.replace(/^\uFEFF/, '').trim(), stderr })); });
  return { child, done };
}
const run = async args => launch(args).done;
async function prepare() {
  const result = await run(['-File', script, '-Mode', 'Prepare', '-PlanPath', planPath]);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout).stageRoot;
}
// Cancellation before any real writer starts, followed by a fresh recovery process.
const cancelled = await prepare();
assert.equal((await run(['-File', script, '-Mode', 'Recover', '-StageRoot', cancelled])).code, 0);
assert.equal((await json(join(state, 'updates/result.json'))).status, 'cancelled');
await verifyPayload(installed);
const stage = await prepare();
const host = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::WriteLine("host-ready"); [Console]::ReadLine() | Out-Null; exit 0'], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const hostDone = new Promise((ok, bad) => { host.on('error', bad); host.on('exit', ok); });
await new Promise((ok, bad) => { host.stdout.once('data', ok); host.once('error', bad); });
const writer = launch(['-File', script, '-Mode', 'Install', '-StageRoot', stage, '-HostProcessId', String(host.pid)]);
await delay(500);
host.stdin.end('exit\n');
assert.equal(await hostDone, 0, 'Controlled Host exits normally');
await delay(1000);
const deadline = Date.now() + 180000;
let installerPid;
let nextDiagnostic = 0;
while (Date.now() < deadline && writer.child.exitCode === null) {
  const probe = await run(['-Command', `$p = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${literal(join(stage, 'Installer.exe'))} }; @($p | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`]);
  assert.equal(probe.code, 0, probe.stderr);
  if (probe.stdout) {
    const pids = JSON.parse(probe.stdout);
    installerPid = Array.isArray(pids) ? pids[0] : pids;
    if (installerPid) break;
  }
  if (Date.now() > nextDiagnostic) {
    console.log('REAL_WRITER_WAIT ' + JSON.stringify({ hostPid: host.pid, writerPid: writer.child.pid, journal: await json(join(stage, 'journal.json')).catch(() => null), result: await json(join(stage, 'result.json')).catch(() => null) }));
    nextDiagnostic = Date.now() + 10000;
  }
  await delay(50);
}
if (!installerPid) {
  const phase = await json(join(stage, 'journal.json')).catch(() => null);
  console.log('REAL_WRITER_NOT_OBSERVED ' + JSON.stringify({ hostPid: host.pid, writerPid: writer.child.pid, writerExit: writer.child.exitCode, phase, result: await json(join(stage, 'result.json')).catch(() => null) }));
  if (writer.child.exitCode === null) await run(['-Command', `& taskkill.exe /PID ${writer.child.pid} /T /F; exit $LASTEXITCODE`]);
  console.log('REAL_WRITER_EXIT ' + JSON.stringify(await writer.done));
}
assert.ok(installerPid, 'A real staged NSIS writer must be observed, not a stub');
assert.equal((await json(join(stage, 'journal.json'))).phase, 'installing');
// Stop only the isolated update process and its own actual NSIS children.
const stopped = await run(['-Command', `& taskkill.exe /PID ${writer.child.pid} /T /F; exit $LASTEXITCODE`]);
assert.equal(stopped.code, 0, stopped.stderr);
await writer.done;
await delay(250);
const remaining = await run(['-Command', `@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq ${literal(join(stage, 'Installer.exe'))} }).Count`]);
assert.equal(remaining.stdout, '0', 'Real NSIS writer must be fully stopped');
assert.equal((await json(join(stage, 'journal.json'))).phase, 'installing', 'Cannot relabel a completed installation as interruption');
// A deterministic partial payload fault proves repair, irrespective of how far NSIS copied.
await writeFile(join(installed, 'Mizar.exe'), 'isolated interrupted payload fault');
const recovered = await run(['-File', script, '-Mode', 'Recover', '-StageRoot', stage]);
assert.equal(recovered.code, 0, recovered.stderr);
const result = await json(join(state, 'updates/result.json'));
assert.equal(result.status, 'restored');
assert.equal(result.code, 'update_rolled_back');
await verifyPayload(installed);
assert.equal(await readFile(join(state, 'user-sentinel.txt'), 'utf8'), 'preserve user state');
await writeFile(join(product, 'real-zlib-recovery.json'), JSON.stringify({ sourceSha: process.env.GITHUB_SHA,
  payloadSourceSha: manifest.gitSha, lane, realInstallerSha256: distribution.archiveSha256,
  realWriterObserved: true, writerFullyStopped: true, preparedCancellation: true,
  interruptedPartialPayloadRestored: true, userStatePreserved: true, promotable: false }, null, 2));
console.log(`Real Zlib ${lane}: prepared cancellation and actual writer interruption/partial payload recovery PASS`);
