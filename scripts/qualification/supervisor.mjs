import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createWriteStream, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BUNDLE_ROOT = resolve(MODULE_DIR, '..');
const FINALIZATION_SCHEMA_VERSION = 1;
const FINALIZATION_WAIT_TIMEOUT_MS = 60_000;

function loadQualificationContract() {
  for (const path of [
    join(MODULE_DIR, 'qualification-contract.json'),
    resolve(MODULE_DIR, '../../apps/companion/src/qualification/contract.json'),
  ]) {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // Try the next repository or bundle location.
    }
  }
  throw new Error('缺少现场验收契约');
}

const QUALIFICATION_RESULT_VALUES = new Set(loadQualificationContract().resultValues);

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

function runCommand(command, args, { cwd, logPath }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', async (code, signal) => {
      const output = `${stdout}${stderr}`;
      if (output.length > 0) await appendFile(logPath, output, 'utf8').catch(() => undefined);
      if (code === 0) resolvePromise();
      else
        reject(new Error(`${command} 执行失败（${signal ?? `退出码 ${code}`}）\n${stderr.trim()}`));
    });
  });
}

function waitForChild(child) {
  return new Promise((resolvePromise) => {
    child.once('error', (error) => resolvePromise({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => resolvePromise({ code, signal }));
  });
}

function waitForStream(stream) {
  if (stream.closed || stream.destroyed) return Promise.resolve();
  return new Promise((resolvePromise) => {
    stream.once('close', resolvePromise);
    stream.once('error', resolvePromise);
  });
}

function relativeBundlePath(bundleRoot, path) {
  return relative(bundleRoot, path).replaceAll('\\', '/');
}

function scheduleStateCleanup(nodePath, stateRoot) {
  const cleanupSource = `
import { rm } from 'node:fs/promises';
const parentPid = Number(process.argv[1]);
const target = process.argv[2];
const poll = () => {
  try {
    process.kill(parentPid, 0);
    setTimeout(poll, 250);
  } catch {
    void rm(target, { recursive: true, force: true }).finally(() => process.exit(0));
  }
};
poll();
`;
  const cleanup = spawn(
    nodePath,
    ['--input-type=module', '-e', cleanupSource, String(process.pid), stateRoot],
    { stdio: 'ignore', detached: true, windowsHide: true },
  );
  cleanup.unref();
}

function tokenMatches(request, expected) {
  const provided = request.headers['x-qualification-token'];
  if (typeof provided !== 'string') return false;
  const actualBytes = Buffer.from(provided, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function sendJson(response, statusCode, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return entities[character];
  });
}

function resultLabel(result) {
  if (result === 'PASS') return '通过';
  if (result === 'FAIL') return '失败';
  return '证据不足';
}

export function completionPage(completion) {
  const result = escapeHtml(resultLabel(completion.result));
  const reportPath = escapeHtml(completion.reportPath ?? 'evidence/<runId>/REPORT.md');
  const verification =
    completion.verification === 'passed' ? '核心验收证据已验证' : '核心验收证据验证失败';
  const cleanup =
    completion.cleanup === 'failed'
      ? '环境恢复失败，请人工检查 GSI 配置'
      : completion.cleanup === 'passed'
        ? '环境已恢复'
        : '环境恢复状态待确认';
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>现场验收结果</title></head>
<body><main><h1>现场验收结果：${result}</h1><p>${escapeHtml(verification)}</p><p>${escapeHtml(cleanup)}</p><p>报告：<code>${reportPath}</code></p></main></body></html>`;
}

async function listenCompletionServer({ port, controlToken, getCompletion }) {
  const server = createServer((request, response) => {
    if (
      request.method === 'GET' &&
      (request.url === '/qualification' || request.url === '/qualification/')
    ) {
      const body = completionPage(getCompletion());
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    if (!tokenMatches(request, controlToken)) {
      sendJson(response, 401, { error: 'qualification_unauthorized' });
      return;
    }
    if (request.method === 'GET' && request.url === '/qualification/finalization') {
      sendJson(response, 200, getCompletion());
      return;
    }
    if (request.method === 'GET' && request.url === '/qualification/status') {
      sendJson(response, 200, getCompletion());
      return;
    }
    if (request.method === 'POST' && request.url === '/qualification/finalization/ack') {
      sendJson(response, 200, { ok: true });
      setTimeout(() => server.close(), 100).unref();
      return;
    }
    sendJson(response, 404, { error: 'not_found' });
  });

  let lastError;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      await new Promise((resolvePromise, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolvePromise();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ host: '127.0.0.1', port });
      });
      return server;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EADDRINUSE') throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw lastError ?? new Error('完成状态服务未能启动');
}

export async function finalizeQualificationRun({
  nodePath,
  evidenceScript,
  runDir,
  bundleRoot,
  logPath,
}) {
  await runCommand(nodePath, [evidenceScript, '--finish', runDir], { cwd: bundleRoot, logPath });
  await runCommand(nodePath, [evidenceScript, '--verify', runDir], { cwd: bundleRoot, logPath });
  const qualification = await readJson(join(runDir, 'qualification.json'));
  return {
    result: QUALIFICATION_RESULT_VALUES.has(qualification.result)
      ? qualification.result
      : 'INCONCLUSIVE',
    verification: 'passed',
    reportPath: relativeBundlePath(bundleRoot, join(runDir, 'REPORT.md')),
    qualificationPath: relativeBundlePath(bundleRoot, join(runDir, 'qualification.json')),
  };
}

export function markCleanupFailure(completion) {
  return {
    ...completion,
    cleanup: 'failed',
    error: '现场验收 GSI 配置恢复失败',
  };
}

export function shouldCleanupQualificationState(completion) {
  return completion.verification === 'passed' && completion.cleanup === 'passed';
}

async function restoreGsiConfig(statePath) {
  const state = await readJson(statePath);
  if (state.gsiRestored === true) return;
  const cfgPath = typeof state.cfgPath === 'string' ? state.cfgPath : undefined;
  if (cfgPath === undefined) throw new Error('缺少现场验收配置路径');
  if (state.hadExistingConfig === true) {
    if (typeof state.backupPath !== 'string') throw new Error('缺少现场验收配置备份');
    await copyFile(state.backupPath, cfgPath);
    await rm(state.backupPath, { force: true });
  } else {
    await rm(cfgPath, { force: true });
  }
  await writeJson(statePath, { ...state, gsiRestored: true });
}

export async function runCompanionLifecycle({
  nodePath,
  appRoot,
  statePath,
  companionStdoutPath,
  companionStderrPath,
  supervisorLogPath,
  spawnProcess = spawn,
  restartExitCode = 75,
}) {
  let restartCount = 0;
  while (true) {
    const child = spawnProcess(nodePath, ['dist/server.js'], {
      cwd: appRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    const exitPromise = waitForChild(child);
    const companionStdout = createWriteStream(companionStdoutPath, { flags: 'a' });
    const companionStderr = createWriteStream(companionStderrPath, { flags: 'a' });
    child.stdout.pipe(companionStdout);
    child.stderr.pipe(companionStderr);

    const runState = await readJson(statePath);
    await writeJson(statePath, { ...runState, processId: child.pid });

    const exitResult = await exitPromise;
    await Promise.all([waitForStream(companionStdout), waitForStream(companionStderr)]);

    if (exitResult.code === restartExitCode) {
      restartCount++;
      await appendFile(
        supervisorLogPath,
        `[supervisor] 捕获到受控重启退出码 ${restartExitCode}，正在重新拉起制播进程（保持相同 runId 与凭据，重启次数: ${restartCount}）...\n`,
        'utf8',
      ).catch(() => undefined);
      continue;
    }
    return { exitResult, restartCount };
  }
}

async function main() {
  const bundleRoot = resolve(process.env.QUALIFICATION_BUNDLE_ROOT ?? DEFAULT_BUNDLE_ROOT);
  const appRoot = resolve(process.env.QUALIFICATION_APP_ROOT ?? join(bundleRoot, 'app'));
  const nodePath = resolve(
    process.env.QUALIFICATION_NODE_PATH ?? join(bundleRoot, 'runtime', 'node.exe'),
  );
  const runDir = resolve(process.env.QUALIFICATION_RUN_DIR);
  const statePath = resolve(process.env.QUALIFICATION_RUN_STATE_PATH);
  const finalizationStatePath = resolve(
    process.env.QUALIFICATION_FINALIZATION_PATH ?? join(dirname(statePath), 'finalization.json'),
  );
  const controlToken = process.env.QUALIFICATION_CONTROL_TOKEN;
  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('现场验收端口无效');
  if (controlToken === undefined || controlToken.length === 0)
    throw new Error('缺少现场验收控制令牌');

  const logsDir = join(runDir, 'logs');
  await mkdir(logsDir, { recursive: true });
  const companionStdoutPath = join(logsDir, 'companion.log');
  const companionStderrPath = join(logsDir, 'companion.stderr.log');
  const supervisorLogPath = join(dirname(statePath), 'supervisor.log');

  await runCompanionLifecycle({
    nodePath,
    appRoot,
    statePath,
    companionStdoutPath,
    companionStderrPath,
    supervisorLogPath,
  });

  const runState = await readJson(statePath);
  const reportPath = relativeBundlePath(bundleRoot, join(runDir, 'REPORT.md'));
  let completion = {
    schemaVersion: FINALIZATION_SCHEMA_VERSION,
    status: 'finalizing',
    runId: typeof runState.runId === 'string' ? runState.runId : 'unknown',
    result: 'INCONCLUSIVE',
    verification: 'pending',
    cleanup: 'pending',
    reportPath,
    diagnosticsPath: relativeBundlePath(bundleRoot, supervisorLogPath),
  };
  await writeJson(finalizationStatePath, completion);
  let completionServer;
  try {
    completionServer = await listenCompletionServer({
      port,
      controlToken,
      getCompletion: () => completion,
    });
  } catch (error) {
    await appendFile(supervisorLogPath, `完成状态服务启动失败：${String(error)}\n`, 'utf8').catch(
      () => undefined,
    );
  }

  let exitCode = 1;
  try {
    const finalization = await finalizeQualificationRun({
      nodePath,
      evidenceScript: join(bundleRoot, 'scripts', 'verify-evidence.mjs'),
      runDir,
      bundleRoot,
      logPath: supervisorLogPath,
    });
    completion = { ...completion, ...finalization, status: 'complete' };
    exitCode = finalization.result === 'PASS' ? 0 : 2;
  } catch (error) {
    completion = {
      ...completion,
      status: 'complete',
      result: 'INCONCLUSIVE',
      verification: 'failed',
      error: '验收证据完成失败',
    };
    await appendFile(supervisorLogPath, `验收证据完成失败：${String(error)}\n`, 'utf8').catch(
      () => undefined,
    );
  }

  try {
    await restoreGsiConfig(statePath);
    completion = { ...completion, cleanup: 'passed' };
  } catch (error) {
    completion = markCleanupFailure(completion);
    exitCode = 1;
    await appendFile(supervisorLogPath, `GSI 配置恢复失败：${String(error)}\n`, 'utf8').catch(
      () => undefined,
    );
  }
  await writeJson(finalizationStatePath, completion);

  if (completionServer !== undefined) {
    const closed = new Promise((resolvePromise) => completionServer.once('close', resolvePromise));
    const timeout = setTimeout(() => completionServer.close(), FINALIZATION_WAIT_TIMEOUT_MS);
    await closed;
    clearTimeout(timeout);
  }
  if (completionServer !== undefined && shouldCleanupQualificationState(completion)) {
    try {
      scheduleStateCleanup(nodePath, dirname(statePath));
    } catch (error) {
      await appendFile(
        supervisorLogPath,
        `现场验收状态清理未能安排：${String(error)}\n`,
        'utf8',
      ).catch(() => undefined);
      exitCode = 1;
    }
  }
  process.exitCode = exitCode;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `QUALIFICATION_SUPERVISOR_ERROR: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
