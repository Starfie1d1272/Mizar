// Read-only published sources and a fresh hosted Windows installation; never build or publish.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyPayload } from './product-runtime.mjs';
import { verifyReleaseAttestations } from './release-identity.mjs';
const sha = '427cfdecffcbaf170cb67c62be5d8268608f1a1e';
const area = join(process.env.RUNNER_TEMP, 'Mizar published cold chain');
const downloads = join(area, 'published');
const installed = join(area, 'fresh core with spaces');
const state = join(process.env.LOCALAPPDATA, 'Mizar');
const evidence = resolve('.agent-tmp/published-chain-evidence');
const pack = 'official:epl-default';
const report = {
  schemaVersion: 1,
  acceptanceSourceSha: process.env.GITHUB_SHA,
  acceptanceRunId: process.env.GITHUB_RUN_ID,
  productSha: sha,
  version: '1.3.3',
  checks: [],
  result: 'FAIL',
  limits: [
    'hosted Windows without CS2 or OBS',
    'no old updater automatic relaunch, updater status window or fault rollback acceptance',
  ],
};
let active;
const firewall = 'Mizar-published-chain-' + process.env.GITHUB_RUN_ID;
let firewallAdded = false;
const json = async (p) => JSON.parse((await readFile(p, 'utf8')).replace(/^\uFEFF/, ''));
const hash = (b) => createHash('sha256').update(b).digest('hex');
const exists = async (p) =>
  access(p).then(
    () => true,
    () => false,
  );
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
function record(name, facts = {}) {
  report.checks.push({ name, result: 'PASS', ...facts });
  console.log('PASS: ' + name);
}
function startCommand(file, args, product = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.toLowerCase() === 'psmodulepath' ||
      (product && /token|credential|password|secret/i.test(key))
    )
      delete env[key];
  const child = spawn(file, args, {
    cwd: area,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (p) => {
    stdout = (stdout + p).slice(-128 * 1024);
  });
  child.stderr.on('data', (p) => {
    stderr = (stderr + p).slice(-128 * 1024);
  });
  const done = new Promise((ok, no) => {
    child.once('error', no);
    child.once('exit', (code) => ok({ code, stdout, stderr }));
  });
  done.catch(() => {});
  return { child, done };
}
async function command(file, args, product = false) {
  const r = await startCommand(file, args, product).done;
  assert.equal(r.code, 0, r.stderr);
  return r.stdout.trim();
}
const ps = (code) =>
  command(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `$ErrorActionPreference='Stop'; ${code}`,
    ],
    true,
  );
async function api(path, body) {
  const r = await fetch('http://127.0.0.1:3000' + path, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  assert.ok(r.ok, path + ': ' + r.status);
  return r.json();
}
async function start() {
  active = startCommand(join(installed, 'Mizar.exe'), ['--no-browser'], true);
  const end = Date.now() + 60000;
  while (Date.now() < end) {
    const h = await api('/health').catch(() => null);
    if (h?.product?.artifactSha256 === report.coreContentDigest) {
      assert.equal(h.product.appVersion, '1.3.3');
      assert.equal(h.product.gitSha, sha);
      await delay(1000);
      assert.equal(active.child.exitCode, null);
      return;
    }
    if (active.child.exitCode !== null) assert.fail(JSON.stringify(await active.done));
    await delay(200);
  }
  assert.fail('Actual Core readiness timeout');
}
async function stop() {
  await command(join(installed, 'Mizar.exe'), ['--stop', '--no-browser'], true);
  assert.equal((await active.done).code, 0);
  active = undefined;
}
async function resources() {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    const s = await api('/local/v1/resources/' + encodeURIComponent(pack));
    if (s.phase === 'ready') {
      assert.equal(s.activeVersion, '1.0.0');
      assert.equal(s.failure, null);
      return s;
    }
    await delay(200);
  }
  assert.fail('Product resource Store did not reach ready');
}
async function epl() {
  for (const id of ['epl-inferno-video', 'epl-inferno-opening', 'epl-inferno-final-round']) {
    const r = await fetch(`http://127.0.0.1:3000/fixtures/${id}/replay/manifest.json`);
    assert.equal(r.status, 200);
    assert.ok(await r.json());
  }
  const r = await fetch('http://127.0.0.1:3000/fixtures/epl-inferno-video/replay/background.mp4', {
    headers: { range: 'bytes=0-31' },
  });
  assert.equal(r.status, 206);
  assert.equal((await r.arrayBuffer()).byteLength, 32);
}
await mkdir(area);
await mkdir(downloads);
await mkdir(evidence, { recursive: true });
try {
  assert.equal(process.platform, 'win32');
  assert.equal(
    await exists(state),
    false,
    'Fresh runner must have no product state or resource cache',
  );
  assert.equal(
    await ps("if(Test-Path 'HKCU:\\Software\\Mizar'){'existing'}else{'clean'}"),
    'clean',
  );
  await command('gh', [
    'release',
    'download',
    'v1.3.3',
    '--repo',
    'Starfie1d1272/Mizar',
    '--pattern',
    'machine-metadata.json',
    '--pattern',
    'Mizar-v1.3.3-Windows-x64-WebInstaller.exe',
    '--dir',
    downloads,
  ]);
  const release = JSON.parse(
    await command('gh', ['api', 'repos/Starfie1d1272/Mizar/releases/tags/v1.3.3']),
  );
  assert.equal(release.draft, false);
  assert.equal(release.prerelease, false);
  assert.ok(release.published_at);
  assert.equal(release.target_commitish, sha);
  const carrier = await json(join(downloads, 'machine-metadata.json'));
  for (const name of [
    'qualification-provenance.json',
    'release-manifest.json',
    'distribution-manifest.json',
    'core-release-manifest.json',
    'core-distribution-manifest.json',
    'update-index.json',
  ]) {
    const file = carrier.files.find((x) => x.name === name);
    assert.ok(file);
    await writeFile(join(downloads, name), Buffer.from(file.bytesBase64, 'base64'));
  }
  const core = await json(join(downloads, 'core-release-manifest.json')),
    distribution = await json(join(downloads, 'core-distribution-manifest.json'));
  assert.equal(core.gitSha, sha);
  assert.equal(core.appVersion, '1.3.3');
  assert.equal(core.resourceMode, 'core');
  assert.equal(core.developmentOnly, false);
  const installer = join(downloads, 'Mizar-v1.3.3-Windows-x64-WebInstaller.exe');
  assert.equal(
    hash(await readFile(installer)),
    '404bf8c59e8b5856c1bd85cb84141db9b415fc4601e8b5e94e8ceb3762dee759',
  );
  await verifyReleaseAttestations(
    [
      'Mizar-v1.3.3-Windows-x64-WebInstaller.exe',
      'release-manifest.json',
      'distribution-manifest.json',
      'core-release-manifest.json',
      'core-distribution-manifest.json',
    ].map((name) => ({
      file: join(downloads, name),
      sourceSha: sha,
      bundle: join(downloads, 'qualification-provenance.json'),
    })),
  );
  record(
    'actual public Stable and original lightweight EXE/four manifests authenticate to frozen main source',
    { releaseId: release.id, publishedAt: release.published_at },
  );
  await command(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      resolve('scripts/qualification/drive-published-installer.ps1'),
      '-Installer',
      installer,
      '-Destination',
      installed,
      '-Evidence',
      evidence,
    ],
    true,
  );
  report.installerUi = await json(join(evidence, 'installer-ui.json'));
  assert.equal(report.installerUi.fixture, false);
  assert.equal(report.installerUi.completionObserved, true);
  const payload = await verifyPayload(installed);
  assert.equal(payload.gitSha, sha);
  assert.equal(payload.appVersion, '1.3.3');
  assert.equal(payload.resourceMode, 'core');
  assert.equal(payload.artifactSha256, core.contentDigest);
  report.coreContentDigest = payload.artifactSha256;
  assert.equal(await command(join(installed, 'Mizar.exe'), ['--app-version'], true), '1.3.3');
  record(
    'real published native EXE completes cold first Core NSIS plus production SDK/App/Store resources',
    { coreContentDigest: payload.artifactSha256 },
  );
  const { authenticatePublishedBootstrap } = await import(
    pathToFileURL(join(installed, 'resources/app/dist/web-installer/published-bootstrap.mjs')).href
  );
  const { getResourceAuthorization } = await import(
    pathToFileURL(
      join(installed, 'resources/app/node_modules/@mizar/resource-pack-contract/dist/runtime.js'),
    ).href
  );
  const bootstrap = await authenticatePublishedBootstrap({
    version: '1.3.3',
    tufCachePath: join(state, 'updates/trust'),
    expectedCore: {
      version: '1.3.3',
      gitSha: sha,
      contentDigest: core.contentDigest,
      sha256: distribution.archiveSha256,
      bytes: distribution.archiveBytes,
      coreSha256: core.archiveSha256,
    },
  });
  const policy = getResourceAuthorization(bootstrap.authorization);
  assert.equal(bootstrap.corePlan.gitSha, sha);
  assert.equal(policy.core.gitSha, sha);
  assert.equal(policy.core.archiveSha256, core.archiveSha256);
  assert.equal(
    policy.archive.sha256,
    '5c1f891c2997e1db2dff18c5618179380d2fbea6a2ab708569d438c4417e95d4',
  );
  record(
    'deployed SDK authenticates real Stable dual signatures, selected Core and resource dual-proof policy',
    {
      coreInstaller: bootstrap.corePlan.name,
      coreInstallerSha256: bootstrap.corePlan.sha256,
      coreArchiveSha256: policy.core.archiveSha256,
      resourceArchiveSha256: policy.archive.sha256,
    },
  );
  await start();
  report.onlineResources = await resources();
  await epl();
  await api('/operator/updates', { action: 'automatic', enabled: false });
  record(
    'installed actual Core starts with ready official resource Store and serves all default EPL manifests/video Range',
  );
  await stop();
  const node = join(installed, 'resources/runtime/node.exe');
  await command(
    node,
    [
      '-e',
      "fetch('https://api.github.com/repos/Starfie1d1272/Mizar',{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(0),()=>process.exit(1))",
    ],
    true,
  );
  await ps(
    `New-NetFirewallRule -Name ${quote(firewall)} -DisplayName ${quote(firewall)} -Direction Outbound -Program ${quote(node)} -Action Block -Profile Any | Out-Null`,
  );
  firewallAdded = true;
  await command(
    node,
    [
      '-e',
      "fetch('https://api.github.com/repos/Starfie1d1272/Mizar',{signal:AbortSignal.timeout(5000)}).then(()=>process.exit(1),()=>{console.log('network blocked');process.exit(0)})",
    ],
    true,
  );
  await start();
  report.offlineResources = await resources();
  await epl();
  assert.equal((await api('/local/v1/updates')).automatic, false);
  record(
    'real packaged Node outbound block confirmed; persisted authorized cache restarts offline and serves default EPL',
  );
  await stop();
  report.result = 'PASS';
} catch (error) {
  report.failure = { name: error.name, message: error.message, stack: error.stack };
  throw error;
} finally {
  if (active) await stop().catch(() => {});
  if (firewallAdded)
    await ps(`Remove-NetFirewallRule -Name ${quote(firewall)}`).catch((error) => {
      report.environmentCleanupFailure = error.message;
    });
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
