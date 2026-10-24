import { spawn, execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

if (process.platform !== 'win32') throw new Error('Windows owner verification requires Windows');
const root = resolve(import.meta.dirname, '../..');
const output = resolve(process.argv[3] ?? join(root, '.agent-tmp/observer-owner'));
const desktop = resolve(process.argv[2]);
await mkdir(output, { recursive: true });
execFileSync(
  'cargo',
  [
    'build',
    '--locked',
    '--profile',
    'ci',
    '--example',
    'observer-owner',
    '--manifest-path',
    join(root, 'apps/desktop/src-tauri/Cargo.toml'),
  ],
  { windowsHide: true },
);
const ownerExe = join(root, 'apps/desktop/src-tauri/target/ci/examples/observer-owner.exe');
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(check) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(25);
  }
  throw new Error('observer_owner_verification_timeout');
}
const results = [];
for (const mode of ['stop', 'relay-killed', 'desktop-killed']) {
  const host = spawn(ownerExe, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  let text = '';
  host.stdout.on('data', (chunk) => (text += chunk));
  const job = await until(() => text.includes('\n') && text.trim());
  const directory = join(output, mode);
  const relay = spawn(
    desktop,
    [
      '--observer-process',
      job,
      process.execPath,
      join(root, 'apps/companion/test/fixtures/observer-tree.mjs'),
      '--source-role',
      'ahead',
      '--source-id',
      'synthetic',
      '--output',
      directory,
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let stderr = '';
  relay.stderr.on('data', (chunk) => (stderr += chunk));
  relay.stdout.resume();
  const finished = new Promise((done) => relay.once('close', (code) => done(code)));
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
    windowsHide: true,
    stdio: 'ignore',
  });
  const owned = [relay.pid];
  try {
    relay.stdin.write('{"endpoint":"127.0.0.1:27020","password":"synthetic"}\n');
    const pids = await until(async () => {
      try {
        return JSON.parse(await readFile(join(directory, 'owned-pids.json'), 'utf8'));
      } catch {
        return false;
      }
    });
    owned.push(pids.driver, pids.worker);
    assert(owned.every(alive));
    const started = performance.now();
    if (mode === 'stop') relay.stdin.end();
    else if (mode === 'relay-killed') relay.kill();
    else host.kill();
    await until(() => owned.every((pid) => !alive(pid)));
    const code = await finished;
    assert(alive(unrelated.pid));
    if (mode === 'stop') {
      assert.equal(code, 2);
      assert.equal(JSON.parse(stderr.trim()).cleanupCompleted, true);
    }
    results.push({
      mode,
      ownedProcesses: owned.length,
      recoveryMs: Math.round(performance.now() - started),
      passed: true,
    });
  } finally {
    relay.stdin.destroy();
    relay.kill();
    host.kill();
    unrelated.kill();
  }
}
const report = { platform: process.platform, desktop, results, passed: true };
await writeFile(join(output, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
