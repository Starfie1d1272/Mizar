// One-time hosted acceptance; use original real release bytes, never build or publish.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyPayload } from './product-runtime.mjs';
import { assertQualificationRun, verifyReleaseAttestations } from './release-identity.mjs';
import { verifyCandidate } from './verify-candidate.mjs';
assert.equal(process.platform, 'win32');
const oldSha = 'd7206962d0d33b3889f8c89cd3d79aea01f6f4ab';
const nextSha = '427cfdecffcbaf170cb67c62be5d8268608f1a1e';
const qualificationRun = '38309501102';
const area = resolve(process.env.RUNNER_TEMP, 'Mizar real upgrade acceptance');
const evidence = resolve('.agent-tmp/real-upgrade-evidence');
const old = join(area, 'published old'),
  next = join(area, 'qualified new');
const installed = join(area, 'installed path with spaces', 'Mizar');
const state = join(process.env.LOCALAPPDATA, 'Mizar');
const report = {
  schemaVersion: 1,
  classification: 'real released EXE / original old helper / real new NSIS',
  oldVersion: '1.3.2',
  oldSha,
  newVersion: '1.3.3',
  nextSha,
  qualificationRun,
  applicationState: 'default installed LOCALAPPDATA/Mizar; disposable hosted runner',
  helperOptions: ['NoLaunch', 'NoStatusWindow', 'KeepBackup'],
  limits: [
    'no physical user machine, CS2 or OBS',
    'no fault injection or failed-upgrade recovery claim',
  ],
  checks: [],
  result: 'FAIL',
};
let active, updater, stage;
const json = async (file) => JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const quote = (value) => `'${value.replaceAll("'", "''")}'`;
const exists = async (file) =>
  access(file).then(
    () => true,
    () => false,
  );
function record(name, facts = {}) {
  report.checks.push({ name, result: 'PASS', ...facts });
  console.log(`PASS: ${name}`);
}
function processCommand(file, args, product = false) {
  const env = { ...process.env };
  for (const key of Object.keys(env))
    if (
      key.toLowerCase() === 'psmodulepath' ||
      (product && /token|credential|secret|password/i.test(key))
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
  child.stdout.on('data', (part) => {
    stdout = (stdout + part).slice(-128 * 1024);
  });
  child.stderr.on('data', (part) => {
    stderr = (stderr + part).slice(-128 * 1024);
  });
  const done = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => accept({ code, stdout, stderr }));
  });
  done.catch(() => {});
  return { child, done };
}
async function command(file, args, product = false) {
  const result = await processCommand(file, args, product).done;
  assert.equal(result.code, 0, `${file} failed: ${result.stderr}`);
  return result.stdout.trim();
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
  const response = await fetch(`http://127.0.0.1:3000${path}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  const result = await response.json();
  assert.ok(response.ok, `${path}: ${response.status} ${JSON.stringify(result)}`);
  return result;
}
async function start(version, sha, digest) {
  active = processCommand(join(installed, 'Mizar.exe'), ['--no-browser'], true);
  const until = Date.now() + 60000;
  while (Date.now() < until) {
    const health = await api('/health').catch(() => null);
    if (health?.product?.artifactSha256 === digest) {
      assert.equal(health.product.appVersion, version);
      assert.equal(health.product.gitSha, sha);
      await delay(1000);
      assert.equal(active.child.exitCode, null);
      return health;
    }
    if (active.child.exitCode !== null)
      assert.fail(`Native host exited: ${JSON.stringify(await active.done)}`);
    await delay(200);
  }
  assert.fail('Native product readiness timed out');
}
async function stop() {
  await command(join(installed, 'Mizar.exe'), ['--stop', '--no-browser'], true);
  assert.equal((await active.done).code, 0, 'Original native host must exit normally');
  active = undefined;
}
async function snapshot() {
  return {
    match: (await api('/local/v1/tournament')).matches.find(
      (match) => match.matchId === report.matchId,
    ),
    theme: (await api('/operator/hud-config')).document.customThemes.find(
      (theme) => theme.id === report.themeId,
    ),
    obs: await json(join(state, 'data/obs.json')),
    updates: await json(join(state, 'updates/settings.json')),
  };
}
await mkdir(area, { recursive: false });
await mkdir(evidence, { recursive: true });
try {
  assert.equal(await exists(state), false, 'Refuse any pre-existing user state');
  assert.equal(
    await ps(
      "if ((Test-Path 'HKCU:\\Software\\Mizar') -or (Test-Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Mizar')) { 'existing' } else { 'clean' }",
    ),
    'clean',
  );
  await mkdir(old);
  await mkdir(next);
  await command('gh', [
    'release',
    'download',
    'v1.3.2',
    '--repo',
    'Starfie1d1272/Mizar',
    '--pattern',
    'machine-metadata.json',
    '--pattern',
    'Mizar-v1.3.2-Windows-x64-Setup.exe',
    '--dir',
    old,
  ]);
  const carrier = await json(join(old, 'machine-metadata.json'));
  for (const name of [
    'release-manifest.json',
    'distribution-manifest.json',
    'qualification-provenance.json',
    'update-index.json',
  ]) {
    const entry = carrier.files.find((item) => item.name === name);
    assert.ok(entry, `Published original metadata missing ${name}`);
    await writeFile(join(old, name), Buffer.from(entry.bytesBase64, 'base64'));
  }
  assertQualificationRun(
    JSON.parse(
      await command('gh', ['api', `repos/Starfie1d1272/Mizar/actions/runs/${qualificationRun}`]),
    ),
    nextSha,
  );
  await command('gh', [
    'run',
    'download',
    qualificationRun,
    '--repo',
    'Starfie1d1272/Mizar',
    '--name',
    'release-portable-product',
    '--dir',
    next,
  ]);
  const oldRelease = await json(join(old, 'release-manifest.json')),
    oldDistribution = await json(join(old, 'distribution-manifest.json'));
  const nextRelease = await json(join(next, 'release-manifest.json')),
    nextDistribution = await json(join(next, 'distribution-manifest.json'));
  for (const [manifest, version, sha] of [
    [oldRelease, '1.3.2', oldSha],
    [nextRelease, '1.3.3', nextSha],
  ]) {
    assert.equal(manifest.appVersion, version);
    assert.equal(manifest.gitSha, sha);
    assert.equal(manifest.desktopBuildProfile, 'release');
    assert.equal(manifest.developmentOnly, false);
    assert.equal(manifest.resourceMode, 'full');
  }
  const subjects = [];
  for (const [folder, release, distribution] of [
    [old, oldRelease, oldDistribution],
    [next, nextRelease, nextDistribution],
  ]) {
    assert.equal(distribution.gitSha, release.gitSha);
    assert.equal(distribution.appVersion, release.appVersion);
    assert.equal(distribution.contentDigest, release.contentDigest);
    assert.equal(distribution.originalArchiveSha256, release.archiveSha256);
    assert.equal(await hash(join(folder, distribution.archive)), distribution.archiveSha256);
    for (const name of [
      distribution.archive,
      'release-manifest.json',
      'distribution-manifest.json',
    ])
      subjects.push({
        file: join(folder, name),
        sourceSha: release.gitSha,
        bundle: join(folder, 'qualification-provenance.json'),
      });
  }
  await verifyReleaseAttestations(subjects);
  await verifyCandidate(next, nextSha, nextRelease.archiveSha256);
  record(
    'both original Full NSIS and manifests authenticate to their exact main Qualification sources',
  );
  await mkdir(join(area, 'installed path with spaces'));
  await ps(
    `$p=Start-Process -FilePath ${quote(join(old, oldDistribution.archive))} -ArgumentList @('/S', ${quote('/D=' + installed)}) -PassThru -Wait; if ($p.ExitCode -ne 0) { throw 'old_nsis_failed' }`,
  );
  const previous = await verifyPayload(installed);
  assert.equal(previous.artifactSha256, oldRelease.contentDigest);
  assert.equal(previous.appVersion, '1.3.2');
  assert.equal(previous.gitSha, oldSha);
  assert.equal(await command(join(installed, 'Mizar.exe'), ['--app-version'], true), '1.3.2');
  assert.ok(await exists(join(installed, 'installed.flag')));
  record(
    'released 1.3.2 real NSIS installs in space-containing path; full payload and native version verified',
    { installed, contentDigest: previous.artifactSha256 },
  );
  await start('1.3.2', oldSha, oldRelease.contentDigest);
  const deadline = Date.now() + 90000;
  while ((await api('/local/v1/updates')).phase === 'checking') {
    assert.ok(Date.now() < deadline);
    await delay(250);
  }
  await api('/operator/updates', { action: 'automatic', enabled: false });
  report.matchId = (
    await api('/operator/local-match/create', {
      teamA: 'Upgrade sentinel A',
      teamB: 'Upgrade sentinel B',
      format: 'bo3',
    })
  ).matchId;
  const editor = await api('/operator/hud-config');
  const { getBuiltinTheme } = await import(
    pathToFileURL(join(installed, 'resources/app/node_modules/@mizar/hud-config/dist/index.js'))
      .href
  );
  const saved = await api('/operator/hud-config', {
    kind: 'save-as',
    resource: 'theme',
    value: { ...getBuiltinTheme(), id: 'upgrade-sentinel', name: 'Upgrade sentinel HUD' },
    expectedEditorRevision: editor.revision,
  });
  report.themeId = saved.command.resourceId;
  await api('/operator/obs/configure', { executablePath: null, port: 4457, password: '' });
  const before = await snapshot();
  assert.ok(before.match);
  assert.ok(before.theme);
  assert.equal(before.obs.port, 4457);
  assert.equal(before.updates.automatic, false);
  record('old product API saves local match, HUD theme, OBS config and disabled automatic check');
  const download = join(state, 'updates/download-real-upgrade');
  await mkdir(download);
  const installer = join(download, nextDistribution.archive);
  await copyFile(join(next, nextDistribution.archive), installer);
  const oldHelper = join(installed, 'resources/scripts/update-install.ps1'),
    helperHash = await hash(oldHelper);
  const plan = {
    schemaVersion: 1,
    bundleRoot: installed,
    stateRoot: state,
    installer,
    installerSha256: nextDistribution.archiveSha256,
    installerBytes: nextDistribution.archiveBytes,
    previousContentDigest: oldRelease.contentDigest,
    contentDigest: nextRelease.contentDigest,
    version: '1.3.3',
    gitSha: nextSha,
  };
  const planPath = join(area, 'real-plan.json');
  await writeFile(planPath, JSON.stringify(plan));
  stage = JSON.parse(
    await command(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        oldHelper,
        '-Mode',
        'Prepare',
        '-PlanPath',
        planPath,
      ],
      true,
    ),
  ).stageRoot;
  const stagedHelper = join(stage, 'update-install.ps1');
  assert.equal(await hash(stagedHelper), helperHash);
  assert.equal(await hash(join(stage, 'Installer.exe')), nextDistribution.archiveSha256);
  assert.deepEqual(await json(join(stage, 'plan.json')), plan);
  record('old production Prepare stages original old helper and real new installer bytes', {
    helperSha256: helperHash,
    installerSha256: nextDistribution.archiveSha256,
  });
  const oldPid = active.child.pid,
    readyEvent = `Global\\MizarUpdateReady-${oldPid}-${Date.now()}`;
  const wrapper = `$ErrorActionPreference='Stop'; $ready=New-Object Threading.EventWaitHandle($false,[Threading.EventResetMode]::ManualReset,${quote(readyEvent)}); try { & ${quote(stagedHelper)} -Mode Install -StageRoot ${quote(stage)} -HostProcessId ${oldPid} -ReadyEvent ${quote(readyEvent)} -NoLaunch -NoStatusWindow -KeepBackup; exit $LASTEXITCODE } finally { $ready.Dispose() }`;
  updater = processCommand(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapper],
    true,
  );
  const handoffDeadline = Date.now() + 30000;
  while (
    !(await readFile(join(stage, 'update-activity.ndjson'), 'utf8').catch(() => '')).includes(
      'waiting-host',
    )
  ) {
    assert.equal(updater.child.exitCode, null);
    assert.ok(Date.now() < handoffDeadline, 'old helper handoff timeout');
    await delay(100);
  }
  assert.equal(
    await ps(
      `$e=[Threading.EventWaitHandle]::OpenExisting(${quote(readyEvent)}); try { $e.WaitOne(0).ToString() } finally { $e.Dispose() }`,
    ),
    'True',
  );
  const duplicate = await processCommand(join(installed, 'Mizar.exe'), ['--no-browser'], true).done;
  assert.equal(duplicate.code, 1);
  assert.match(duplicate.stderr, /正在安装更新或恢复旧版/);
  assert.equal(active.child.exitCode, null);
  assert.equal((await api('/health')).product.artifactSha256, oldRelease.contentDigest);
  record(
    'real native repeated start rejected during ready handoff; original host remains healthy',
    { oldHostPid: oldPid, helperPid: updater.child.pid, readyEvent, duplicateExit: duplicate.code },
  );
  await stop();
  record('original Mizar --stop --no-browser completes normal shutdown; original host exits zero');
  let duringMutation;
  const installDeadline = Date.now() + 240000;
  while (updater.child.exitCode === null) {
    assert.ok(Date.now() < installDeadline, 'real NSIS transaction timed out');
    const journal = await json(join(stage, 'journal.json')).catch(() => null);
    if (
      !duringMutation &&
      journal?.phase === 'installing' &&
      (await exists(join(installed, 'Mizar.exe')))
    ) {
      const probe = await processCommand(
        join(installed, 'Mizar.exe'),
        ['--no-browser'],
        true,
      ).done.catch(() => null);
      if (probe?.code === 1 && /正在安装更新或恢复旧版/.test(probe.stderr))
        duringMutation = { exit: probe.code, journalPhase: journal.phase };
    }
    await delay(25);
  }
  const updated = await updater.done;
  await writeFile(join(evidence, 'helper.log'), updated.stdout + '\n' + updated.stderr);
  assert.equal(updated.code, 0, updated.stderr);
  assert.ok(duringMutation, 'Must observe real image rejection while journal is installing');
  record('real native repeated start rejected during installation mutation', duringMutation);
  const result = await json(join(state, 'updates/result.json'));
  assert.equal(result.status, 'installed');
  assert.equal(result.code, 'update_completed');
  assert.equal((await json(join(stage, 'journal.json'))).phase, 'committed');
  const current = await verifyPayload(installed);
  assert.equal(current.artifactSha256, nextRelease.contentDigest);
  assert.equal(current.gitSha, nextSha);
  assert.equal(current.appVersion, '1.3.3');
  assert.equal(await command(join(installed, 'Mizar.exe'), ['--app-version'], true), '1.3.3');
  assert.equal(
    (await verifyPayload(join(stage, 'previous'))).artifactSha256,
    oldRelease.contentDigest,
  );
  record(
    'real old helper commits actual 1.3.3 Full NSIS; full new payload and retained original backup match',
    { result, newContentDigest: current.artifactSha256 },
  );
  assert.equal(await hash(stagedHelper), helperHash);
  await start('1.3.3', nextSha, nextRelease.contentDigest);
  const after = await snapshot();
  assert.deepEqual(after, before);
  assert.equal((await api('/local/v1/updates')).automatic, false);
  assert.equal((await api('/local/v1/updates')).currentVersion, '1.3.3');
  record(
    'new real product starts and reads identical local match, HUD, OBS and disabled automatic-check preferences',
  );
  report.sentinelSha256 = createHash('sha256').update(JSON.stringify(before)).digest('hex');
  await stop();
  record('new product also shuts down normally');
  for (const name of ['plan.json', 'journal.json', 'update-activity.ndjson'])
    await copyFile(join(stage, name), join(evidence, name));
  await copyFile(join(state, 'updates/result.json'), join(evidence, 'result.json'));
  report.result = 'PASS';
} catch (error) {
  report.failure = { name: error.name, message: error.message, stack: error.stack };
  throw error;
} finally {
  if (active && (!updater || updater.child.exitCode !== null)) await stop().catch(() => {});
  await writeFile(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}
