import net from 'node:net';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(rootDir, 'apps', 'web', 'dist');
const upgradeTimeoutMs = 5_000;
const appCloseTimeoutMs = 10_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function withTimeout(promise, message, timeoutMs = upgradeTimeoutMs) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = globalThis.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => globalThis.clearTimeout(timer));
}

function parseFrame(buffer) {
  if (buffer.length < 2) return null;
  const firstLength = buffer[1] & 0x7f;
  let payloadLength = firstLength;
  let offset = 2;
  if (firstLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (firstLength === 127) {
    if (buffer.length < 10) return null;
    const length = buffer.readBigUInt64BE(2);
    assert(length <= BigInt(Number.MAX_SAFE_INTEGER), 'WebSocket frame is too large');
    payloadLength = Number(length);
    offset = 10;
  }
  assert((buffer[1] & 0x80) === 0, 'server WebSocket frame must not be masked');
  if (buffer.length < offset + payloadLength) return null;
  return {
    opcode: buffer[0] & 0x0f,
    payload: buffer.subarray(offset, offset + payloadLength),
  };
}

function closeWebSocket(socket) {
  if (!socket.destroyed) socket.destroy();
}

function readUpgradeResponse(socket) {
  return new Promise((resolvePromise, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      cleanup();
      resolvePromise({
        headers: buffer.subarray(0, end).toString('latin1'),
        remaining: buffer.subarray(end + 4),
      });
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket socket closed before upgrade response'));
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

function readFrame(socket, initialBuffer) {
  return new Promise((resolvePromise, reject) => {
    let buffer = initialBuffer;
    const consume = () => {
      const frame = parseFrame(buffer);
      if (frame === null) return;
      cleanup();
      resolvePromise(frame);
    };
    const cleanup = () => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      consume();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error('WebSocket socket closed before baseline'));
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    consume();
  });
}

async function assertProgramBaseline(port, subprotocol, route) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  try {
    await withTimeout(
      new Promise((resolvePromise, reject) => {
        socket.once('connect', resolvePromise);
        socket.once('error', reject);
      }),
      'WebSocket TCP connection timed out',
    );
    socket.write(
      `GET ${route} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        'Connection: Upgrade\r\n' +
        'Upgrade: websocket\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        'Sec-WebSocket-Key: cHJvZHVjdGlvbi1zbW9rZQ==\r\n' +
        'Origin: http://127.0.0.1:4173\r\n' +
        `Sec-WebSocket-Protocol: ${subprotocol}\r\n` +
        '\r\n',
    );
    const response = await withTimeout(
      readUpgradeResponse(socket),
      'WebSocket upgrade response timed out',
    );
    assert(/^HTTP\/1\.1 101\b/m.test(response.headers), 'Program WebSocket did not upgrade');
    assert(
      new RegExp(`^Sec-WebSocket-Protocol: ${subprotocol}$`, 'im').test(response.headers),
      'Program WebSocket did not negotiate the Local Protocol V1 subprotocol',
    );
    const frame = await withTimeout(
      readFrame(socket, response.remaining),
      'Program WebSocket baseline timed out',
    );
    assert(frame.opcode === 1, 'Program WebSocket baseline must be a text frame');
    const snapshot = JSON.parse(frame.payload.toString('utf8'));
    assert(snapshot.type === 'snapshot', 'Program WebSocket did not send a snapshot baseline');
    assert(snapshot.channel === 'program', 'Program WebSocket baseline has the wrong channel');
  } finally {
    console.log('[production-smoke] WS cleanup');
    closeWebSocket(socket);
  }
}

async function assertCs2Assets(baseUrl, requestOptions) {
  const manifestResponse = await globalThis.fetch(
    `${baseUrl}/assets/cs2/manifest.json`,
    requestOptions,
  );
  assert(manifestResponse.status === 200, 'CS2 asset manifest 未返回 HTTP 200');
  assert(
    manifestResponse.headers.get('content-type')?.includes('application/json') === true,
    'CS2 asset manifest MIME 不正确',
  );
  const manifest = JSON.parse(await manifestResponse.text());
  assert(manifest.schemaVersion === 1, 'CS2 asset manifest schemaVersion 不正确');
  for (const [assetId, asset] of Object.entries(manifest.assets ?? {})) {
    const assetResponse = await globalThis.fetch(`${baseUrl}${asset.outputPath}`, requestOptions);
    const body = Buffer.from(await assetResponse.arrayBuffer());
    assert(assetResponse.status === 200, `${assetId} 未返回 HTTP 200`);
    assert(
      assetResponse.headers.get('content-type')?.includes('image/svg+xml') === true,
      `${assetId} SVG MIME 不正确`,
    );
    const digest = createHash('sha256').update(body).digest('hex');
    assert(digest === asset.outputSha256, `${assetId} SVG hash 不一致`);
  }
}

async function closeApp(app) {
  const closePromise = app.close();
  try {
    await withTimeout(closePromise, 'Fastify app.close timed out', appCloseTimeoutMs);
  } catch (error) {
    app.server.closeAllConnections?.();
    app.server.closeIdleConnections?.();
    throw error;
  }
}

async function runPhase(name, operation) {
  console.log(`[production-smoke] ${name}`);
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${name}: ${message}`, { cause: error });
  }
}

async function main() {
  const builtHtml = await readFile(join(webRoot, 'index.html'), 'utf8');
  const assetPath = /(?:src|href)="(\/assets\/[^"\s]+)"/.exec(builtHtml)?.[1];
  assert(assetPath !== undefined, 'Vite build HTML has no hashed /assets reference');

  const { buildApp } = await import('../apps/companion/dist/app.js');
  const { LOCAL_WEB_ROUTES, LOCAL_WEB_SUBPROTOCOL } =
    await import('../apps/companion/dist/local-web/transport-constants.js');
  const app = buildApp({ webRoot });
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert(address !== null && typeof address !== 'string', 'production smoke has no server port');
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const requestOptions = { headers: { connection: 'close' } };
    await runPhase('static html', async () => {
      const pageResponse = await globalThis.fetch(`${baseUrl}/program`, requestOptions);
      const pageBody = await pageResponse.text();
      assert(pageResponse.status === 200, `/program returned HTTP ${pageResponse.status}`);
      assert(
        pageResponse.headers.get('content-type')?.includes('text/html') === true,
        '/program did not return HTML',
      );
      assert(pageBody === builtHtml, '/program did not return the built Vite HTML');
    });
    await runPhase('hashed asset drained', async () => {
      const assetResponse = await globalThis.fetch(`${baseUrl}${assetPath}`, requestOptions);
      await assetResponse.arrayBuffer();
      assert(assetResponse.status === 200, `${assetPath} returned HTTP ${assetResponse.status}`);
    });
    await runPhase('shared product shell stylesheet', async () => {
      const response = await globalThis.fetch(`${baseUrl}/product-shell.css`, requestOptions);
      const body = await response.text();
      assert(response.status === 200, `/product-shell.css returned HTTP ${response.status}`);
      assert(
        response.headers.get('content-type')?.includes('text/css') === true,
        '/product-shell.css did not return CSS',
      );
      const builtStyles = await readFile(join(webRoot, 'product-shell.css'), 'utf8');
      assert(builtStyles.trim().length > 0, 'built product shell stylesheet is empty');
      assert(body === builtStyles, '/product-shell.css did not return the built stylesheet');
    });
    await runPhase('CS2 assets', () => assertCs2Assets(baseUrl, requestOptions));
    await runPhase('WS baseline', () =>
      assertProgramBaseline(address.port, LOCAL_WEB_SUBPROTOCOL, LOCAL_WEB_ROUTES.program),
    );
  } finally {
    console.log('[production-smoke] app.close');
    await closeApp(app);
  }
}

main()
  .then(() => console.log('LOCAL_WEB_PRODUCTION_SMOKE_PASS'))
  .catch((error) => {
    console.error(
      `LOCAL_WEB_PRODUCTION_SMOKE_FAIL: ${error instanceof Error ? error.message : error}`,
    );
    process.exitCode = 1;
  });
