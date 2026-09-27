import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream, openSync, closeSync } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

export const PRODUCT_REPOSITORY = 'Starfie1d1272/RivalHub-Broadcast';
export const PRODUCT_PORT = 3000;
const bundleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export function writableRoot(root, override) {
  if (override !== undefined && !isAbsolute(override))
    throw new Error('运行数据目录必须是绝对路径');
  const state = resolve(override ?? join(root, 'state'));
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

export async function verifyPayload(root) {
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
    if ((await sha256(join(root, name))) !== match[1])
      throw new Error(`程序文件校验失败：${name}。请重新解压产品包。`);
    if (name !== 'resources/metadata/artifact.json') digest.update(`${name}\0${match[1]}\n`);
  }
  for (const name of [
    'Mizar.exe',
    'resources/runtime/node.exe',
    'resources/app/dist/server.js',
    'resources/web/dist/index.html',
    'resources/scripts/product-runtime.mjs',
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

async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

export async function stopProduct(
  root,
  { port = PRODUCT_PORT, stateRoot = writableRoot(root, process.env.MIZAR_STATE_ROOT) } = {},
) {
  const state = JSON.parse(await readFile(join(stateRoot, 'data/runtime.json'), 'utf8'));
  const health = await healthAt(port);
  if (!sameRuntime(health, state, state.instanceId))
    throw new Error('当前端口不是此目录启动的制播服务，未停止任何进程');
  const response = await globalThis.fetch(`http://127.0.0.1:${port}/operator/runtime/stop`, {
    method: 'POST',
    headers: { 'x-runtime-token': state.controlToken },
    signal: globalThis.AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('停止请求未被接受，请检查运行日志');
  const deadline = performance.now() + 35000;
  while (performance.now() < deadline) {
    if (!sameRuntime(await healthAt(port), state, state.instanceId)) return;
    await delay(200);
  }
  throw new Error('服务未能在 35 秒内停止，请检查运行日志');
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
}) {
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
        await open();
        return { reused: true };
      }
      if (health !== null) throw new Error('已有其他版本或其他程序占用 3000 端口，请先停止该程序');
      await delay(200);
    }
    throw new Error('已有制播实例尚未就绪，请检查 state/logs 后重试');
  }
  const existing = await healthAt(port);
  if (sameRuntime(existing, artifact)) {
    await open();
    return { reused: true };
  }
  try {
    await portAvailable(port);
  } catch {
    throw new Error('3000 端口已被其他程序占用，请先停止该程序；制播服务不会切换端口');
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
  const instanceId = randomUUID();
  const controlToken = randomBytes(32).toString('hex');
  const statePath = join(stateRoot, 'data/runtime.json');
  const stdout = openSync(join(stateRoot, 'logs/companion.log'), 'w', 0o600);
  const stderr = openSync(join(stateRoot, 'logs/companion.stderr.log'), 'w', 0o600);
  const env = {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    LOCAL_WEB_LAN_MODE: '0',
    QUALIFICATION_MODE: '0',
    GSI_TOKEN: gsiToken,
    MIZAR_COMMIT: artifact.gitSha,
    MIZAR_ARTIFACT_SHA256: artifact.artifactSha256,
    MIZAR_PRODUCT_INSTANCE: instanceId,
    MIZAR_RUNTIME_TOKEN: controlToken,
    WEB_ROOT: join(root, 'resources/web/dist'),
    CAPTURE_DIR: join(stateRoot, 'data/capture'),
    HUD_CONFIG_PATH: join(stateRoot, 'data/hud-config.json'),
    SERIES_PROGRESS_CHECKPOINT_PATH: join(stateRoot, 'data/series-progress.json'),
  };
  // The packaged runtime never consumes injected Node flags or module search paths.
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  const child = spawn(nodePath, [join(root, 'resources/app/dist/server.js')], {
    cwd: join(root, 'resources/app'),
    env,
    stdio: ['ignore', stdout, stderr],
    windowsHide: true,
  });
  closeSync(stdout);
  closeSync(stderr);
  let exited = false;
  const completion = new Promise((done) => {
    child.once('error', (error) => {
      exited = true;
      done({ error });
    });
    child.once('exit', (code, signal) => {
      exited = true;
      done({ code, signal });
    });
  });
  try {
    await writeJson(statePath, {
      repository: PRODUCT_REPOSITORY,
      artifactSha256: artifact.artifactSha256,
      instanceId,
      controlToken,
      pid: child.pid,
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
    await open();
    const result = await completion;
    if (result.error || result.code !== 0)
      throw new Error('本地制播服务意外退出，请查看 state/logs 后重新启动');
    return { reused: false };
  } finally {
    if (!exited) child.kill();
    await rm(statePath, { force: true });
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if ([...args].some((arg) => !['--stop', '--reuse-only', '--no-browser'].includes(arg)))
    throw new Error('启动参数无法识别');
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error('此产品包需要 64 位 Windows');
  const artifact = await verifyPayload(bundleRoot);
  const stateRoot = writableRoot(bundleRoot, process.env.MIZAR_STATE_ROOT);
  if (args.has('--stop')) return stopProduct(bundleRoot, { stateRoot });
  await runProduct({
    root: bundleRoot,
    artifact,
    stateRoot,
    nodePath: join(bundleRoot, 'resources/runtime/node.exe'),
    reuseOnly: args.has('--reuse-only'),
    openBrowser: !args.has('--no-browser'),
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
