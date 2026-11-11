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
let browserExit;
let browserLogs = '';
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
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
  );
  browserExit = new Promise((resolveExit) =>
    browser.once('exit', (code, signal) => resolveExit({ code, signal })),
  );
  browser.stderr.on('data', (data) => {
    browserLogs = (browserLogs + data).slice(-16_384);
  });
  let browserError;
  browser.once('error', (error) => {
    browserError = error;
  });
  let debuggerAddress;
  while (!debuggerAddress) {
    if (browserError) throw browserError;
    if (browser.exitCode !== null || browser.signalCode !== null)
      throw new Error(
        `Chromium exited before startup (code=${browser.exitCode}, signal=${browser.signalCode}): ${browserLogs}`,
      );
    debuggerAddress = await readFile(join(temporary, 'browser', 'DevToolsActivePort'), 'utf8')
      .then((content) => {
        const [port, path] = content.trim().split('\n');
        return /^\d+$/.test(port) && path?.startsWith('/devtools/browser/')
          ? `ws://127.0.0.1:${port}${path}`
          : null;
      })
      .catch(() => null);
    if (Date.now() >= deadline) throw new Error(`Chromium startup timed out: ${browserLogs}`);
    if (!debuggerAddress) await delay(100);
  }
  const resources = await globalThis.fetch(`${url}/resources`, {
    method: 'HEAD',
    headers: { accept: 'text/html' },
    signal: globalThis.AbortSignal.timeout(2000),
  });
  if (!resources.ok)
    throw new Error(`The production resource library returned HTTP ${resources.status}`);
  for (let attempt = 1; attempt <= 2; attempt++) {
    socket = new globalThis.WebSocket(debuggerAddress);
    try {
      await bounded(
        Promise.race([
          browserExit.then((exit) => {
            throw new Error(`Chromium exited during CDP startup: ${JSON.stringify(exit)}`);
          }),
          new Promise((resolveOpen, reject) => {
            socket.addEventListener('open', resolveOpen, { once: true });
            socket.addEventListener('error', reject, { once: true });
          }),
        ]),
        'Chrome connection',
        Math.max(1, Math.min(5000, deadline - Date.now())),
      );
      break;
    } catch (error) {
      socket.close();
      if (
        attempt === 2 ||
        Date.now() >= deadline ||
        browser.exitCode !== null ||
        browser.signalCode !== null
      )
        throw new Error(`Chrome connection failed after ${attempt} attempt(s): ${browserLogs}`, {
          cause: error,
        });
      await delay(100);
    }
  }
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
  if (browser.exitCode !== null || browser.signalCode !== null)
    throw new Error(`Chromium exited before controlled shutdown: ${browserLogs}`);
} catch (error) {
  failure = error;
} finally {
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    if (socket?.readyState === globalThis.WebSocket.OPEN) {
      socket.send(JSON.stringify({ id: 2147483647, method: 'Browser.close' }));
    } else browser.kill('SIGTERM');
    try {
      const exit = await bounded(browserExit, 'Chromium exit');
      if (exit.code !== 0 || exit.signal)
        failure ??= new Error(`Chromium exit failed: ${JSON.stringify(exit)} ${browserLogs}`);
    } catch (error) {
      failure ??= error;
      try {
        process.kill(-browser.pid, 'SIGKILL');
      } catch (killError) {
        if (killError.code !== 'ESRCH') failure ??= killError;
      }
      await bounded(browserExit, 'Chromium forced exit').catch((exitError) => {
        failure ??= exitError;
      });
    }
  } else if (browser) {
    failure ??= new Error(`Chromium exited before controlled shutdown: ${browserLogs}`);
  }
  socket?.close();
  if (service.exitCode === null) service.kill('SIGTERM');
  const exit = await Promise.race([
    serviceExit,
    delay(10000, null, { ref: false }).then(() => null),
  ]);
  if (!exit) {
    service.kill('SIGKILL');
    failure ??= new Error('Companion did not exit');
    await bounded(serviceExit, 'Companion forced exit').catch((error) => {
      failure ??= error;
    });
  }
  await rm(temporary, { recursive: true, force: true }).catch((error) => {
    console.warn(`Temporary smoke directory retained for runner cleanup: ${error.message}`);
  });
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
console.log(
  'Production Companion ready; main page and resource entry verified, Chromium and Companion exited cleanly.',
);
