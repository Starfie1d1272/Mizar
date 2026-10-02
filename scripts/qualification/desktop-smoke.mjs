// Normal GUI cold start of the extracted exact-revision Windows artifact.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { sameRuntime, verifyPayload } from './product-runtime.mjs';

export function assertNoNodeConsole(snapshot) {
  for (const node of snapshot.processes.filter((process) => process.packagedNode)) {
    const console = snapshot.consoles.find((entry) => entry.pid === node.pid);
    assert.ok(console, `packaged Node ${node.pid} was not inspected for a console`);
    // ERROR_INVALID_HANDLE means no console; ERROR_INVALID_PARAMETER means the
    // process exited between the process snapshot and AttachConsole.
    assert.ok(
      [0, 6, 87].includes(console.attachError),
      `cannot inspect Node ${node.pid} console: Win32 ${console.attachError}`,
    );
    assert.equal(console.visible, false, `packaged Node ${node.pid} has a visible console`);
  }
}

function isMainWindow(window) {
  return (
    ['Mizar', 'Mizar · 托盘不可用，关闭主窗口将退出'].includes(window.title) &&
    window.className !== '#32770' &&
    window.hwnd !== 0 &&
    window.width > 0 &&
    window.height > 0
  );
}

export function assertDesktopReady(snapshot, pid) {
  assert.ok(
    snapshot.processes.some((process) => process.pid === pid),
    'Desktop Host exited',
  );
  assert.ok(
    snapshot.windows.some(isMainWindow),
    'Desktop Host has no visible main HWND with a nonzero client area',
  );
  assertNoNodeConsole(snapshot);
}

export function assertDesktopLog(entries, { pid, artifact, stage, result, startupSessionId }) {
  const entry = entries.find(
    (entry) => entry.pid === pid && entry.stage === stage && entry.result === result,
  );
  assert.ok(entry, `desktop log missing ${stage}/${result} for Host ${pid}`);
  assert.equal(entry.schemaVersion, 1);
  assert.equal(entry.gitSha, artifact.gitSha);
  assert.equal(entry.artifactSha256, artifact.artifactSha256);
  assert.equal(entry.os, 'windows');
  assert.equal(entry.arch, 'x86_64');
  assert.ok(typeof entry.startupSessionId === 'string' && entry.startupSessionId.length > 0);
  if (startupSessionId !== undefined) assert.equal(entry.startupSessionId, startupSessionId);
  assert.ok(Number.isFinite(Date.parse(entry.time)), 'desktop log time must be an ISO timestamp');
  if (result === 'failure') assert.ok(entry.error, 'desktop failure lost its original error');
  return entry;
}

async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function launch(file, args, options) {
  const child = spawn(file, args, { stdio: 'ignore', ...options });
  const done = new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => accept({ code, signal }));
  });
  done.catch(() => {});
  return { child, done };
}

async function createProbe(nodePath) {
  const env = { ...process.env };
  delete env.PSModulePath;
  const probe = launch(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(import.meta.dirname, 'desktop-probe.ps1'),
      '-NodePath',
      nodePath,
      '-DriverProcessId',
      String(process.pid),
    ],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env },
  );
  let stderr = '';
  let closed = false;
  const waiting = [];
  const buffered = [];
  // The process completion/response path reports a closed probe; an EPIPE must
  // not bypass the report and cleanup in run().
  probe.child.stdin.on('error', () => {});
  probe.child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-6000);
  });
  const lines = createInterface({ input: probe.child.stdout });
  lines.on('line', (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else buffered.push(line);
  });
  probe.done
    .finally(() => {
      closed = true;
      for (const done of waiting.splice(0)) done(null);
    })
    .catch(() => {});
  async function response() {
    const line = await bounded(
      buffered.length
        ? Promise.resolve(buffered.shift())
        : closed
          ? Promise.resolve(null)
          : new Promise((done) => waiting.push(done)),
      15000,
      `Win32 probe did not respond; ${stderr}`,
    );
    assert.notEqual(line, null, `Win32 probe exited; ${stderr}`);
    return JSON.parse(line);
  }
  try {
    assert.equal((await response()).ready, true);
  } catch (error) {
    probe.child.kill();
    throw error;
  }
  return {
    async snapshot(rootProcessId, action = 'snapshot') {
      probe.child.stdin.write(JSON.stringify({ rootProcessId, action }) + '\n');
      return response();
    },
    async close() {
      probe.child.stdin.end();
      await bounded(probe.done, 5000, 'Win32 probe did not exit').catch(() => probe.child.kill());
      lines.close();
    },
  };
}

async function health() {
  try {
    const response = await globalThis.fetch('http://127.0.0.1:3000/health', {
      signal: globalThis.AbortSignal.timeout(800),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function desktopLog(stateRoot) {
  const logs = join(stateRoot, 'logs');
  const names = (await readdir(logs).catch(() => [])).filter((name) =>
    /^desktop(?:\.\d+)?\.ndjson$/.test(name),
  );
  assert.ok(names.length <= 4, 'desktop log exceeded the four-file rotation bound');
  const entries = [];
  for (const name of names) {
    assert.match(name, /^desktop(?:\.[123])?\.ndjson$/);
    const path = join(logs, name);
    assert.ok((await stat(path)).size <= 256 * 1024, `${name} exceeded 256 KiB`);
    const contents = await readFile(path, 'utf8');
    // The active writer may not yet have terminated its final JSONL record.
    for (const line of contents.split('\n').slice(0, -1).filter(Boolean)) {
      entries.push(JSON.parse(line));
    }
  }
  return entries;
}

async function run(root, reportPath) {
  assert.equal(process.platform, 'win32', 'Desktop smoke requires Windows');
  const artifact = await verifyPayload(root);
  const exe = join(root, 'Mizar.exe');
  const stateBase = join(root, 'state', `desktop-smoke-${Date.now()}`);
  await mkdir(dirname(reportPath), { recursive: true });
  const report = {
    schemaVersion: 1,
    gitSha: artifact.gitSha,
    artifactSha256: artifact.artifactSha256,
    desktopBuildProfile: artifact.desktopBuildProfile,
    automatedEnvironment: 'Windows runner; no CS2 or OBS',
    realEnvironmentAcceptance: 'NOT RUN',
    scenarios: [],
    result: 'FAIL',
  };
  let probe;
  let active;
  let stateRoot;
  let current;
  const observedNodes = new Set();

  async function sample(action) {
    const snapshot = await probe.snapshot(active.child.pid, action);
    for (const process of snapshot.processes) {
      if (process.packagedNode) observedNodes.add(process.pid);
    }
    current.samples.push({
      elapsedMs: Math.round(performance.now() - current.started),
      ...snapshot,
    });
    // Keep failure diagnostics bounded even if readiness never arrives.
    if (current.samples.length > 120) current.samples.splice(0, 1);
    assertNoNodeConsole(snapshot);
    return snapshot;
  }

  function start(name, env = {}) {
    stateRoot = join(stateBase, name);
    observedNodes.clear();
    current = { name, started: performance.now(), samples: [], result: 'FAIL' };
    report.scenarios.push(current);
    // No --no-browser, no hidden-window launch option: this is the user GUI path.
    active = launch(exe, [], {
      cwd: root,
      windowsHide: false,
      env: { ...process.env, MIZAR_STATE_ROOT: stateRoot, ...env },
    });
  }

  async function waitFor(predicate, message, milliseconds = 45000) {
    const until = performance.now() + milliseconds;
    while (performance.now() < until) {
      const snapshot = await sample();
      if (await predicate(snapshot)) return snapshot;
      await delay(250);
    }
    throw new Error(message);
  }

  async function assertStopped(expectedCode) {
    await waitFor(
      (snapshot) => snapshot.processes.length === 0,
      'Desktop or a tracked child survived controlled shutdown',
      15000,
    );
    const exit = await bounded(active.done, 5000, 'Desktop process exit was not observed');
    if (expectedCode === 0) {
      assert.equal(exit.code, 0);
      const entries = await desktopLog(stateRoot);
      const context = {
        pid: active.child.pid,
        artifact,
        stage: 'shutdown',
        startupSessionId: current.pageLoad.startupSessionId,
      };
      current.shutdownStarted = assertDesktopLog(entries, { ...context, result: 'begin' });
      current.shutdown = assertDesktopLog(entries, { ...context, result: 'success' });
      assert.ok(Date.parse(current.shutdownStarted.time) <= Date.parse(current.shutdown.time));
    } else assert.ok(exit.code !== null && exit.code !== 0, 'startup failure must exit nonzero');
    assert.equal(await health(), null, 'Companion health survived controlled shutdown');
    current.exit = exit;
    current.observedNodePids = [...observedNodes];
    active = undefined;
  }

  try {
    assert.equal(await health(), null, 'GUI cold start requires no running Companion');
    probe = await createProbe(join(root, 'resources/runtime/node.exe'));
    start('normal');
    await waitFor(async (snapshot) => {
      assert.equal(active.child.exitCode, null, 'Desktop exited during normal cold start');
      const live = await health();
      if (!sameRuntime(live, artifact)) return false;
      const entries = await desktopLog(stateRoot);
      if (
        !snapshot.windows.some(isMainWindow) ||
        !entries.some(
          (entry) =>
            entry.pid === active.child.pid &&
            entry.stage === 'main_page_load' &&
            entry.result === 'success',
        )
      )
        return false;
      assertDesktopReady(snapshot, active.child.pid);
      current.instanceId = live.product.instanceId;
      return true;
    }, 'Normal Desktop did not reach health, a visible main window, and page-load completion');
    // Health alone cannot pass: require the same visible Host to remain alive.
    const stableUntil = performance.now() + 3000;
    while (performance.now() < stableUntil) {
      assertDesktopReady(await sample(), active.child.pid);
      assert.ok(sameRuntime(await health(), artifact, current.instanceId));
      await delay(250);
    }
    assert.ok(observedNodes.size >= 2, 'did not observe the packaged supervisor and Companion');
    current.pageLoad = assertDesktopLog(await desktopLog(stateRoot), {
      pid: active.child.pid,
      artifact,
      stage: 'main_page_load',
      result: 'success',
    });
    const stop = launch(exe, ['--stop', '--no-browser'], {
      cwd: root,
      windowsHide: true,
      env: { ...process.env, MIZAR_STATE_ROOT: stateRoot },
    });
    try {
      assert.equal((await bounded(stop.done, 45000, 'controlled stop timed out')).code, 0);
    } finally {
      if (stop.child.exitCode === null) stop.child.kill();
    }
    await assertStopped(0);
    current.result = 'PASS';

    // Use the real WebView2 override to reproduce a startup prerequisite failure;
    // no product-only test switch and no mutation of the exact artifact payload.
    start('missing-webview2', {
      WEBVIEW2_BROWSER_EXECUTABLE_FOLDER: join(stateBase, 'missing WebView2 runtime'),
    });
    const failure = await waitFor(async (snapshot) => {
      assert.equal(
        active.child.exitCode,
        null,
        'startup failure exited without its visible dialog',
      );
      const visible = snapshot.windows.some(
        (window) => window.className === '#32770' && window.title === 'Mizar 启动失败',
      );
      if (!visible) return false;
      const entries = await desktopLog(stateRoot);
      current.runtimeReady = assertDesktopLog(entries, {
        pid: active.child.pid,
        artifact,
        stage: 'runtime_ready',
        result: 'success',
      });
      current.failure = assertDesktopLog(entries, {
        pid: active.child.pid,
        artifact,
        stage: 'webview2_preflight',
        result: 'failure',
        startupSessionId: current.runtimeReady.startupSessionId,
      });
      current.rollback = assertDesktopLog(entries, {
        pid: active.child.pid,
        artifact,
        stage: 'startup_rollback',
        result: 'success',
        startupSessionId: current.runtimeReady.startupSessionId,
      });
      return snapshot.processes.every((process) => process.pid === active.child.pid);
    }, 'WebView2 failure did not show its error, preserve diagnostics, and roll back children');
    assert.equal(await health(), null, 'failed Desktop left Companion running');
    current.failureWindow = failure.windows.find((window) => window.className === '#32770');
    await sample('dismiss-failure');
    await assertStopped(1);
    current.result = 'PASS';
    report.result = 'PASS';
    console.log(
      'Windows GUI smoke passed: exact artifact, normal visible Desktop, page load, hidden Node consoles, controlled stop, WebView2 failure diagnostics and rollback. Real CS2/OBS acceptance: NOT RUN.',
    );
  } catch (error) {
    report.error = String(error);
    throw error;
  } finally {
    if (active) {
      // Recovery only, after FAIL: never count forced cleanup as passing evidence.
      await probe?.snapshot(active.child.pid, 'dismiss-failure').catch(() => {});
      const stop = launch(exe, ['--stop', '--no-browser'], {
        cwd: root,
        windowsHide: true,
        env: { ...process.env, MIZAR_STATE_ROOT: stateRoot },
      });
      await bounded(stop.done, 10000, 'cleanup stop timed out').catch(() => {});
      if (stop.child.exitCode === null) stop.child.kill();
      const kill = launch('taskkill.exe', ['/PID', String(active.child.pid), '/T', '/F'], {
        windowsHide: true,
      });
      await bounded(kill.done, 10000, 'cleanup taskkill timed out').catch(() => {});
      if (kill.child.exitCode === null) kill.child.kill();
    }
    await probe?.close();
    for (const scenario of report.scenarios) delete scenario.started;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, reportPath] = process.argv.slice(2);
  if (!root || !reportPath) throw new Error('Usage: desktop-smoke.mjs <bundle-root> <report.json>');
  await run(resolve(root), resolve(reportPath));
}
