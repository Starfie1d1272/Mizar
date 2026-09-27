import { setTimeout, clearTimeout } from 'node:timers';
// Runs the actual compiled Tauri host from the extracted exact-revision Windows artifact.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdir, readFile, writeFile, access, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(process.argv[2]);
const exe = join(root, 'Mizar.exe');
const artifact = JSON.parse(await readFile(join(root, 'resources/metadata/artifact.json'), 'utf8'));
const resources = join(root, 'resources');
const stateRoot = join(root, 'state');
const LEGACY_GSI_CFG_NAME = 'gamestate_integration_rivalhub_broadcast.cfg';
const MIZAR_GSI_CFG_NAME = 'gamestate_integration_mizar.cfg';
let active;
function command(file, args, timeout = 60000) {
  const env = { ...process.env, MIZAR_STATE_ROOT: stateRoot };
  // Node must not pass PowerShell 7 module search paths into Windows PowerShell 5.1.
  if (file === 'powershell.exe') delete env.PSModulePath;
  const child = spawn(file, args, {
    cwd: root,
    windowsHide: true,
    stdio: 'inherit',
    env,
  });
  const done = new Promise((resolveDone, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`command timeout: ${file}`));
    }, timeout);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveDone(code);
    });
  });
  done.catch(() => {});
  return { child, done };
}
async function health() {
  try {
    return await (
      await globalThis.fetch('http://127.0.0.1:3000/health', {
        signal: globalThis.AbortSignal.timeout(1000),
      })
    ).json();
  } catch {
    return null;
  }
}
async function start() {
  active = command(exe, ['--no-browser'], 120000);
  const deadline = performance.now() + 45000;
  while (performance.now() < deadline) {
    const current = await health();
    if (current?.product?.artifactSha256 === artifact.artifactSha256) return current;
    if (active.child.exitCode !== null) {
      const stderrPath = join(stateRoot, 'logs/companion.stderr.log');
      const stderr = await readFile(stderrPath, 'utf8').catch((error) => String(error));
      const stdout = await readFile(join(stateRoot, 'logs/companion.log'), 'utf8').catch((error) =>
        String(error),
      );
      const logEntries = await readdir(join(stateRoot, 'logs')).catch((error) => [String(error)]);
      const stateEntries = await readdir(stateRoot, { withFileTypes: true })
        .then((entries) => entries.map((entry) => entry.name))
        .catch((error) => [String(error)]);
      assert.fail(
        `launcher exited before health (code ${active.child.exitCode}); state=${stateEntries.join(',')}; logs=${logEntries.join(',')}; companion stderr: ${stderr.slice(-6000)}; companion stdout: ${stdout.slice(-6000)}`,
      );
    }
    await delay(200);
  }
  throw new Error('launcher did not become ready');
}
async function stop() {
  assert.equal(await command(exe, ['--stop', '--no-browser']).done, 0);
  assert.equal(await active.done, 0);
  active = undefined;
  assert.equal(await health(), null);
}
async function powershell(script, extra = []) {
  assert.equal(
    await command('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(resources, 'scripts', script),
      ...extra,
    ]).done,
    0,
  );
}
try {
  // Use an isolated cfg directory; this does not imply real CS2 acceptance.
  const cfgDirectory = join(stateRoot, 'gsi-migration-test', 'cfg');
  const legacyCfgPath = join(cfgDirectory, LEGACY_GSI_CFG_NAME);
  const mizarCfgPath = join(cfgDirectory, MIZAR_GSI_CFG_NAME);
  const legacyContents = 'legacy GSI migration regression fixture\n';
  const installationPath = join(stateRoot, 'data/gsi-install/install.json');
  await mkdir(cfgDirectory, { recursive: true });
  await mkdir(join(stateRoot, 'data/gsi-install'), { recursive: true });
  await writeFile(legacyCfgPath, legacyContents, 'utf8');
  await writeFile(
    installationPath,
    JSON.stringify({ schemaVersion: 1, cfgPath: legacyCfgPath, cfgFingerprint: 'pre-release' }),
    'utf8',
  );
  await powershell('install-gsi.ps1', ['-Product', '-Cs2Root', cfgDirectory]);
  const installed = await readFile(installationPath, 'utf8');
  await assert.rejects(access(legacyCfgPath));
  assert.deepEqual(
    (await readdir(cfgDirectory)).filter((name) =>
      [LEGACY_GSI_CFG_NAME, MIZAR_GSI_CFG_NAME].includes(name),
    ),
    [MIZAR_GSI_CFG_NAME],
    'legacy and Mizar GSI configs must not both remain active',
  );
  assert.doesNotMatch(installed, /legacy(?:Cfg|Backup)|hadLegacyConfig/i);
  await access(mizarCfgPath);
  await writeFile(legacyCfgPath, legacyContents, 'utf8');
  await powershell('install-gsi.ps1', ['-Product']);
  await assert.rejects(access(legacyCfgPath));
  assert.equal(
    await readFile(installationPath, 'utf8'),
    installed,
    'reinstall changed original backup',
  );
  const first = await start();
  // Give the EXE supervisor time to observe its own health probe before the smoke drives stop.
  await delay(1000);
  assert.equal(active.child.exitCode, null, 'launcher exited after readiness');
  assert.equal(
    await command(exe, ['--no-browser']).done,
    0,
    'duplicate launcher did not reuse runtime',
  );
  assert.equal((await health()).product.instanceId, first.product.instanceId);
  for (const route of [
    '/operator',
    '/operator/hud',
    '/workspace',
    '/workspace/left',
    '/workspace/dock',
    '/program',
    '/program/waiting',
    '/program/matchup',
    '/program/bp',
    '/program/halftime',
    '/program/map-result',
    '/program/intermap',
    '/program/match-result',
    '/debug',
  ]) {
    assert.equal((await globalThis.fetch(`http://127.0.0.1:3000${route}`)).status, 200);
  }
  const shellStyles = await globalThis.fetch('http://127.0.0.1:3000/product-shell.css');
  assert.equal(shellStyles.status, 200, 'shared product shell stylesheet is missing');
  assert.match(await shellStyles.text(), /\.product-topbar\s*\{/);
  const token = await readFile(join(stateRoot, 'data/gsi-token.txt'), 'utf8');
  const healthText = JSON.stringify(await health());
  assert.ok(!healthText.includes(token));
  assert.equal(
    (
      await globalThis.fetch('http://127.0.0.1:3000/operator/runtime/stop', {
        method: 'POST',
        headers: { 'x-runtime-token': 'wrong' },
      })
    ).status,
    403,
  );
  await stop();
  const second = await start();
  assert.notEqual(second.product.instanceId, first.product.instanceId);
  assert.equal(await readFile(join(stateRoot, 'data/gsi-token.txt'), 'utf8'), token);
  await stop();
  await powershell('restore-gsi.ps1', ['-Product']);
  await assert.rejects(access(installationPath));
  await assert.rejects(access(legacyCfgPath));
  await assert.rejects(access(mizarCfgPath));
  await rm(join(stateRoot, 'gsi-migration-test'), { recursive: true, force: true });
  const occupied = createServer((socket) => socket.destroy());
  await new Promise((done) => occupied.listen(3000, '127.0.0.1', done));
  try {
    assert.notEqual(
      await command(exe, ['--no-browser']).done,
      0,
      'unknown port occupant was accepted',
    );
  } finally {
    await new Promise((done) => occupied.close(done));
  }
  const web = join(resources, 'web/dist/index.html');
  const original = await readFile(web);
  try {
    await writeFile(web, 'corrupt');
    assert.notEqual(await command(exe, ['--no-browser']).done, 0, 'corrupt payload was accepted');
    assert.equal(await health(), null);
  } finally {
    await writeFile(web, original);
  }
  console.log(
    'Windows portable EXE smoke passed: startup, reuse, shutdown, restart, collision, integrity, GSI restore. Real CS2/OBS acceptance: NOT RUN.',
  );
} finally {
  if (active) {
    await command(exe, ['--stop', '--no-browser']).done.catch(() => {});
    active.child.kill();
  }
}
