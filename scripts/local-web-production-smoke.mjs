import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(join(tmpdir(), 'mizar-startup-'));
const port = await new Promise((resolvePort, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port: selected } = server.address();
    server.close(() => resolvePort(selected));
  });
});
const url = `http://127.0.0.1:${port}`;
function bounded(promise, label, ms = 5000) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => globalThis.clearTimeout(timer));
}

const service = spawn(process.execPath, [join(root, 'apps/companion/dist/server.js')], {
  cwd: root,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    GSI_TOKEN: 'mizar-startup-smoke',
    WEB_ROOT: join(root, 'apps/web/dist'),
    MIZAR_STATE_ROOT: temporary,
    CAPTURE_DIR: join(temporary, 'recordings'),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
service.stdout.on('data', (data) => (logs += data));
service.stderr.on('data', (data) => (logs += data));
const serviceExit = new Promise((resolveExit) =>
  service.once('exit', (code, signal) => resolveExit({ code, signal })),
);
let browser;
let socket;
let failure;
try {
  const deadline = Date.now() + 30000;
  while (true) {
    if (service.exitCode !== null) throw new Error(`Companion exited before readiness: ${logs}`);
    const health = await globalThis
      .fetch(`${url}/health`, { signal: globalThis.AbortSignal.timeout(2000) })
      .catch(() => null);
    if (health?.ok) break;
    if (Date.now() >= deadline) throw new Error(`Companion readiness timed out: ${logs}`);
    await delay(100);
  }
  browser = spawn(
    process.env.CHROME_BIN || 'chromium',
    [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--remote-debugging-port=0',
      `--user-data-dir=${join(temporary, 'browser')}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  let browserError;
  browser.once('error', (error) => {
    browserError = error;
  });
  let debuggerPort;
  while (!debuggerPort) {
    if (browserError) throw browserError;
    if (browser.exitCode !== null) throw new Error('Chromium exited before startup');
    debuggerPort = await readFile(join(temporary, 'browser', 'DevToolsActivePort'), 'utf8')
      .then((content) => Number(content.split('\n')[0]))
      .catch(() => null);
    if (Date.now() >= deadline) throw new Error('Chromium startup timed out');
    if (!debuggerPort) await delay(100);
  }
  const info = await globalThis
    .fetch(`http://127.0.0.1:${debuggerPort}/json/version`, {
      signal: globalThis.AbortSignal.timeout(2000),
    })
    .then((response) => response.json());
  socket = new globalThis.WebSocket(info.webSocketDebuggerUrl);
  await bounded(
    new Promise((resolveOpen, reject) => {
      socket.addEventListener('open', resolveOpen, { once: true });
      socket.addEventListener('error', reject, { once: true });
    }),
    'Chrome connection',
  );
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown')
      errors.push(message.params.exceptionDetails.text);
    if (!message.id || !pending.has(message.id)) return;
    const { resolveCall, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolveCall(message.result);
  });
  const call = (method, params = {}, sessionId) =>
    bounded(
      new Promise((resolveCall, reject) => {
        const id = ++nextId;
        pending.set(id, { resolveCall, reject });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
      method,
    );
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Runtime.enable', {}, sessionId);
  await call('Page.enable', {}, sessionId);
  await call('Page.navigate', { url }, sessionId);
  while (true) {
    const result = await call(
      'Runtime.evaluate',
      {
        expression:
          "document.readyState === 'complete' && document.querySelector('#root main') !== null",
        returnByValue: true,
      },
      sessionId,
    );
    if (errors.length) throw new Error(`Main page error: ${errors.join('; ')}`);
    if (result.result.value === true) break;
    if (Date.now() >= deadline) throw new Error('Main page did not render');
    await delay(100);
  }
  await delay(500);
  if (errors.length) throw new Error(`Main page error: ${errors.join('; ')}`);
  console.log('Production Companion ready; main page rendered without uncaught errors.');
} catch (error) {
  failure = error;
} finally {
  socket?.close();
  if (browser && browser.exitCode === null) browser.kill('SIGKILL');
  if (service.exitCode === null) service.kill('SIGTERM');
  const exit = await Promise.race([
    serviceExit,
    delay(10000, null, { ref: false }).then(() => null),
  ]);
  if (!exit) {
    service.kill('SIGKILL');
    failure ??= new Error('Companion did not exit');
  }
  await rm(temporary, { recursive: true, force: true });
  if (exit && exit.code !== 0)
    failure ??= new Error(`Companion exit failed: ${JSON.stringify(exit)} ${logs}`);
  if (
    await globalThis.fetch(`${url}/health`, { signal: globalThis.AbortSignal.timeout(2000) }).then(
      () => true,
      () => false,
    )
  )
    failure ??= new Error('Companion port remained active');
}

if (failure) throw failure;
