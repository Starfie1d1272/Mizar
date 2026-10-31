import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm, rename, readdir, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import {
  awaitDesktopStart,
  createCompanionLog,
  createSupervisorLog,
  safeLogText,
  startupSessionId,
} from './product-logs.mjs';

export const PRODUCT_REPOSITORY = 'Starfie1d1272/Mizar';
export const PRODUCT_PORT = 3000;
const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function writableRoot(root, override) {
  if (override !== undefined && !isAbsolute(override))
    throw new Error('运行数据目录必须是绝对路径');
  const installed = existsSync(join(root, 'installed.flag'));
  if (installed && !override && !process.env.LOCALAPPDATA) throw new Error('用户数据目录不可用');
  const state = resolve(
    override ?? (installed ? join(process.env.LOCALAPPDATA, 'Mizar') : join(root, 'state')),
  );
  const payload = resolve(root, 'resources');
  const rel = relative(payload, state);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) {
    throw new Error('运行数据目录不能位于程序资源目录内');
  }
  return state;
}

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function verifyPayload(root, { onProgress = () => {} } = {}) {
  const manifestPath = join(root, 'resources/metadata/artifact.json');
  const artifact = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    artifact.repository !== PRODUCT_REPOSITORY ||
    artifact.productSchemaVersion !== 1 ||
    artifact.desktopHost !== 'tauri2' ||
    artifact.platform !== 'win32-x64' ||
    artifact.developmentOnly ||
    !/^[a-f0-9]{40}$/.test(artifact.gitSha) ||
    !/^[a-f0-9]{64}$/.test(artifact.artifactSha256)
  ) {
    throw new Error('程序版本信息不完整，请重新解压完整产品包');
  }
  const sums = await readFile(join(root, 'resources/metadata/SHA256SUMS'), 'utf8');
  const paths = new Set();
  const digest = createHash('sha256');
  const entries = [];
  for (const line of sums
    .trim()
    .split(/\r?\n/)
    .sort((a, b) => (a.slice(66) < b.slice(66) ? -1 : a.slice(66) > b.slice(66) ? 1 : 0))) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(line);
    if (!match) throw new Error('程序校验清单无效');
    const name = match[2];
    if (
      name.includes('\\') ||
      name.split('/').some((part) => part === '..' || part === '') ||
      isAbsolute(name) ||
      paths.has(name) ||
      name.startsWith('state/')
    )
      throw new Error('程序校验路径无效');
    paths.add(name);
    entries.push({ name, expected: match[1] });
  }
  onProgress({ completed: 0, total: entries.length });
  let lastProgress = performance.now();
  // Bound open files and stream buffers, while avoiding one-at-a-time disk reads.
  for (let offset = 0; offset < entries.length; offset += 8) {
    const batch = entries.slice(offset, offset + 8);
    await Promise.all(
      batch.map(async ({ name, expected }) => {
        let actual;
        try {
          actual = await sha256(join(root, name));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          throw new Error(`程序包缺少文件：${name}。请等待解压完成后启动，或重新解压完整产品包。`, {
            cause: error,
          });
        }
        if (actual !== expected) throw new Error(`程序文件校验失败：${name}。请重新解压产品包。`);
      }),
    );
    for (const { name, expected } of batch) {
      if (name !== 'resources/metadata/artifact.json') digest.update(`${name}\0${expected}\n`);
    }
    const completed = offset + batch.length;
    if (completed === entries.length || performance.now() - lastProgress >= 1000) {
      onProgress({ completed, total: entries.length });
      lastProgress = performance.now();
    }
  }
  for (const name of [
    'Mizar.exe',
    'resources/runtime/node.exe',
    'resources/app/dist/server.js',
    'resources/web/dist/index.html',
    'resources/scripts/product-runtime.mjs',
    'resources/scripts/product-logs.mjs',
    'resources/metadata/artifact.json',
  ]) {
    if (!paths.has(name)) throw new Error(`程序包缺少必要文件：${name}`);
  }
  if (digest.digest('hex') !== artifact.artifactSha256)
    throw new Error('程序资源摘要不一致，请重新解压产品包');
  return artifact;
}

export function sameRuntime(health, artifact, instanceId) {
  return (
    health?.product?.repository === PRODUCT_REPOSITORY &&
    health.product.artifactSha256 === artifact.artifactSha256 &&
    health.product.mode === 'product' &&
    typeof health.product.instanceId === 'string' &&
    (instanceId === undefined || health.product.instanceId === instanceId)
  );
}

async function healthAt(port) {
  try {
    const response = await globalThis.fetch(`http://127.0.0.1:${port}/health`, {
      signal: globalThis.AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function portAvailable(port) {
  const server = createServer();
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  await new Promise((done) => server.close(done));
}

async function conflictMessage(health, stateRoot, artifact) {
  try {
    const state = JSON.parse(await readFile(join(stateRoot, 'data/runtime.json'), 'utf8'));
    if (
      state.repository === PRODUCT_REPOSITORY &&
      /^[a-f0-9]{64}$/.test(state.artifactSha256) &&
      /^[a-f0-9]{64}$/.test(state.controlToken) &&
      typeof state.instanceId === 'string' &&
      sameRuntime(health, state, state.instanceId)
    ) {
      if (state.artifactSha256 === artifact.artifactSha256)
        return '已有同版本 Mizar 服务正在运行，请重新启动 Mizar；如仍无法打开，请查看启动日志。';
      return '3000 端口上的 Mizar 服务与本机运行记录匹配，但程序版本不同。请打开原版本 Mizar，完成游戏与制作收尾并从托盘退出，再启动当前版本；若原版本不可用，请查看启动日志并联系支持。';
    }
  } catch {
    // Missing or unreadable state cannot establish a local runtime identity.
  }
  return '3000 端口已被占用，无法确认占用程序。请检查端口占用和运行日志；制播服务不会切换端口';
}

async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

function exitReceiptPath(stateRoot, instanceId) {
  if (typeof instanceId !== 'string' || !/^[a-f0-9-]{36}$/.test(instanceId))
    throw new Error('本地运行实例身份无效');
  return join(stateRoot, 'data', `runtime-exit-${instanceId}.json`);
}

async function exitReceipt(stateRoot, state) {
  try {
    const receipt = JSON.parse(
      await readFile(exitReceiptPath(stateRoot, state.instanceId), 'utf8'),
    );
    if (
      receipt.instanceId !== state.instanceId ||
      receipt.pid !== state.pid ||
      receipt.artifactSha256 !== state.artifactSha256
    )
      throw new Error('运行实例退出记录不匹配');
    return receipt;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function stopProduct(
  root,
  {
    port = PRODUCT_PORT,
    stateRoot = writableRoot(root, process.env.MIZAR_STATE_ROOT),
    artifact,
    expectedInstance,
  } = {},
) {
  const state = JSON.parse(await readFile(join(stateRoot, 'data/runtime.json'), 'utf8'));
  if (
    state.repository !== PRODUCT_REPOSITORY ||
    !/^[a-f0-9]{64}$/.test(state.artifactSha256) ||
    !/^[a-f0-9]{64}$/.test(state.controlToken) ||
    !Number.isSafeInteger(state.pid) ||
    state.pid <= 0 ||
    (artifact && state.artifactSha256 !== artifact.artifactSha256) ||
    (expectedInstance && state.instanceId !== expectedInstance)
  )
    throw new Error('本地运行记录无效，未停止任何进程');
  exitReceiptPath(stateRoot, state.instanceId);
  const deadline = performance.now() + 35000;
  let receipt = await exitReceipt(stateRoot, state);
  const health = await healthAt(port);
  if (!receipt && sameRuntime(health, state, state.instanceId)) {
    try {
      const response = await globalThis.fetch(`http://127.0.0.1:${port}/operator/runtime/stop`, {
        method: 'POST',
        headers: { 'x-runtime-token': state.controlToken },
        signal: globalThis.AbortSignal.timeout(15000),
      });
      if (!response.ok && sameRuntime(await healthAt(port), state, state.instanceId))
        throw new Error('停止请求未被接受，请检查运行日志');
    } catch (error) {
      if (sameRuntime(await healthAt(port), state, state.instanceId)) throw error;
      // A concurrent stop may already have closed HTTP; wait for the original instance.
    }
  } else if (!receipt && health !== null) {
    throw new Error('当前端口不是此目录启动的制播服务，未停止任何进程');
  }
  while (!receipt && performance.now() < deadline) {
    await delay(200);
    receipt = await exitReceipt(stateRoot, state);
  }
  if (!receipt) {
    const error = new Error('未能确认制播进程在 35 秒内完成退出，请检查运行日志');
    error.code = 'RUNTIME_STOP_TIMEOUT';
    throw error;
  }
  if (receipt.code !== 0 || receipt.signal !== null || receipt.error || !receipt.localComplete)
    throw new Error('制播进程异常退出，本地收尾未确认，请检查运行日志');
}

/** Packaging-only supervisor. Runtime remains entirely inside Companion. */
export async function runProduct({
  root,
  artifact,
  nodePath,
  port = PRODUCT_PORT,
  stateRoot,
  reuseOnly = false,
  openBrowser = true,
  sessionId = startupSessionId(process.env.MIZAR_STARTUP_SESSION_ID),
  log = createSupervisorLog(stateRoot, sessionId),
}) {
  log('supervisor_start', { gitSha: artifact.gitSha, artifactSha256: artifact.artifactSha256 });
  const url = `http://127.0.0.1:${port}/operator`;
  async function open() {
    if (!openBrowser) return;
    if (process.platform === 'win32') {
      const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => console.error(`浏览器未能打开，请访问 ${url}`));
      child.unref();
    }
  }
  if (reuseOnly) {
    const deadline = performance.now() + 30000;
    while (performance.now() < deadline) {
      const health = await healthAt(port);
      if (sameRuntime(health, artifact)) {
        log('runtime_reused');
        await open();
        return { reused: true };
      }
      if (health !== null) throw new Error(await conflictMessage(health, stateRoot, artifact));
      await delay(200);
    }
    throw new Error('已有制播实例尚未就绪，请检查 state/logs 后重试');
  }
  const existing = await healthAt(port);
  if (sameRuntime(existing, artifact)) {
    log('runtime_reused');
    await open();
    return { reused: true };
  }
  try {
    await portAvailable(port);
  } catch {
    log('port_conflict');
    throw new Error(await conflictMessage(await healthAt(port), stateRoot, artifact));
  }
  for (const dir of ['data', 'logs', 'evidence'])
    await mkdir(join(stateRoot, dir), { recursive: true });
  const tokenPath = join(stateRoot, 'data/gsi-token.txt');
  let gsiToken;
  try {
    gsiToken = (await readFile(tokenPath, 'utf8')).trim();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    gsiToken = randomBytes(32).toString('hex');
    await writeFile(tokenPath, gsiToken, { mode: 0o600, flag: 'wx' });
  }
  if (!/^[a-f0-9]{64}$/.test(gsiToken))
    throw new Error('本地 GSI 令牌文件无效，请检查 state/data/gsi-token.txt');
  // Keep receipts long enough for every concurrent stop waiter, then remove
  // old instances at the next start so normal use does not grow indefinitely.
  const dataDir = join(stateRoot, 'data');
  for (const name of await readdir(dataDir)) {
    if (
      !/^runtime-(?:exit|host-exit|flush)-[a-f0-9-]{36}\.json$/.test(name) &&
      !/^runtime-host-exit-[a-f0-9-]{36}\.\d+-\d+\.tmp$/.test(name)
    )
      continue;
    const path = join(dataDir, name);
    try {
      if (Date.now() - (await stat(path)).mtimeMs > 600000) await rm(path, { force: true });
    } catch (error) {
      if (error.code !== 'ENOENT') log('runtime_receipt_cleanup_failed', { code: error.code });
    }
  }
  const instanceId = randomUUID();
  const controlToken = randomBytes(32).toString('hex');
  const statePath = join(stateRoot, 'data/runtime.json');
  const logOptions = {
    secrets: [gsiToken, controlToken, process.env.MIZAR_OUTPUT_TOKEN],
    onFailure: (failure) => log('output_log_failed', failure),
  };
  const stdout = createCompanionLog(stateRoot, 'companion.log', sessionId, logOptions);
  const stderr = createCompanionLog(stateRoot, 'companion.stderr.log', sessionId, logOptions);
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    LOCAL_WEB_LAN_MODE: '0',
    QUALIFICATION_MODE: '0',
    GSI_TOKEN: gsiToken,
    MIZAR_COMMIT: artifact.gitSha,
    MIZAR_APP_VERSION: typeof artifact.appVersion === 'string' ? artifact.appVersion : '',
    MIZAR_ARTIFACT_SHA256: artifact.artifactSha256,
    MIZAR_PRODUCT_INSTANCE: instanceId,
    MIZAR_STATE_ROOT: stateRoot,
    MIZAR_BUNDLE_ROOT: root,
    MIZAR_DISTRIBUTION: existsSync(join(root, 'installed.flag')) ? 'installed' : 'portable',
    MIZAR_RUNTIME_TOKEN: controlToken,
    MIZAR_STARTUP_SESSION_ID: sessionId,
    WEB_ROOT: join(root, 'resources/web/dist'),
    CAPTURE_DIR: join(stateRoot, 'data/capture'),
    HUD_CONFIG_PATH: join(stateRoot, 'data/hud-config.json'),
    SERIES_PROGRESS_CHECKPOINT_PATH: join(stateRoot, 'data/series-progress.json'),
  };
  // The packaged runtime never consumes injected Node flags or module search paths.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  log('companion_spawn_begin');
  const child = spawn(nodePath, [join(root, 'resources/app/dist/server.js')], {
    cwd: join(root, 'resources/app'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (chunk) => stdout.write(chunk));
  child.stdout.once('end', () => stdout.end());
  child.stderr.on('data', (chunk) => stderr.write(chunk));
  child.stderr.once('end', () => stderr.end());
  let exited = false;
  const completion = new Promise((done) => {
    child.once('error', (error) => {
      exited = true;
      log('companion_spawn_failed', {
        code: error.code,
        error: safeLogText(error.message, logOptions.secrets),
      });
      done({ error });
    });
    child.once('exit', (code, signal) => {
      exited = true;
      log('companion_exit', { code, signal });
    });
    child.once('close', (code, signal) => {
      void (async () => {
        try {
          const receipt = exitReceiptPath(stateRoot, instanceId);
          const temporary = `${receipt}.${process.pid}.tmp`;
          let localComplete = false;
          try {
            const marker = JSON.parse(
              await readFile(join(stateRoot, 'data', `runtime-flush-${instanceId}.json`), 'utf8'),
            );
            localComplete =
              marker.instanceId === instanceId &&
              marker.pid === child.pid &&
              marker.artifactSha256 === artifact.artifactSha256;
          } catch (error) {
            if (error.code !== 'ENOENT') log('runtime_flush_marker_invalid', { code: error.code });
          }
          await writeJson(temporary, {
            instanceId,
            pid: child.pid,
            artifactSha256: artifact.artifactSha256,
            code: code ?? null,
            signal: signal ?? null,
            error: false,
            localComplete,
          });
          await rename(temporary, receipt);
          done({ code, signal, localComplete });
        } catch (error) {
          done({ error });
        }
      })();
    });
  });
  try {
    await writeJson(statePath, {
      repository: PRODUCT_REPOSITORY,
      artifactSha256: artifact.artifactSha256,
      instanceId,
      controlToken,
      pid: child.pid,
      supervisorPid: process.pid,
      startupSessionId: sessionId,
      startedAt: new Date().toISOString(),
    });
    const deadline = performance.now() + 30000;
    let ready = false;
    while (!exited && performance.now() < deadline) {
      if (sameRuntime(await healthAt(port), artifact, instanceId)) {
        ready = true;
        break;
      }
      await delay(200);
    }
    if (!ready) throw new Error('本地制播服务未能启动，请查看 state/logs/companion.stderr.log');
    log('runtime_ready', { instanceId });
    await open();
    const result = await completion;
    if (result.error || result.code !== 0 || !result.localComplete)
      throw new Error('本地制播服务意外退出，请查看 state/logs 后重新启动');
    return { reused: false };
  } catch (error) {
    log('runtime_error', { error: safeLogText(error.message, logOptions.secrets) });
    throw error;
  } finally {
    if (!exited) {
      log('companion_rollback');
      child.kill();
    }
    log('supervisor_complete');
  }
}

async function main() {
  const stateRoot = writableRoot(bundleRoot, process.env.MIZAR_STATE_ROOT);
  const sessionId = startupSessionId(process.env.MIZAR_STARTUP_SESSION_ID);
  const log = createSupervisorLog(stateRoot, sessionId);
  try {
    log('process_start', { platform: process.platform, arch: process.arch });
    if (process.env.MIZAR_DESKTOP_SUPERVISED === '1') {
      await awaitDesktopStart(process.stdin);
      log('desktop_supervision_ready');
    }
    const args = new Set(process.argv.slice(2));
    if ([...args].some((arg) => !['--stop', '--reuse-only', '--no-browser'].includes(arg)))
      throw new Error('启动参数无法识别');
    if (process.platform !== 'win32' || process.arch !== 'x64')
      throw new Error('此产品包需要 64 位 Windows');
    log('artifact_verify_begin');
    const artifact = await verifyPayload(bundleRoot, {
      onProgress: (progress) => log('artifact_verify_progress', progress),
    });
    log('artifact_verified', { gitSha: artifact.gitSha, artifactSha256: artifact.artifactSha256 });
    if (args.has('--stop')) {
      log('product_stop_begin');
      await stopProduct(bundleRoot, {
        stateRoot,
        artifact,
        expectedInstance: process.env.MIZAR_EXPECTED_RUNTIME_INSTANCE,
      });
      log('product_stopped');
      return;
    }
    await runProduct({
      root: bundleRoot,
      artifact,
      stateRoot,
      nodePath: join(bundleRoot, 'resources/runtime/node.exe'),
      reuseOnly: args.has('--reuse-only'),
      openBrowser: !args.has('--no-browser'),
      sessionId,
      log,
    });
  } catch (error) {
    log('supervisor_error', { code: error.code, error: safeLogText(error.message) });
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = error.code === 'RUNTIME_STOP_TIMEOUT' ? 2 : 1;
  });
