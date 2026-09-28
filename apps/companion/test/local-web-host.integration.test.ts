import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { checkLocalWebOrigin, createLocalWebOriginPolicy } from '../src/local-web/origin-policy.js';
import { LOCAL_WEB_ROUTES, LOCAL_WEB_SUBPROTOCOL } from '../src/local-web/transport-constants.js';

const LOOPBACK_HEADERS = {
  origin: 'http://localhost:4173',
  'sec-websocket-protocol': LOCAL_WEB_SUBPROTOCOL,
};

const apps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function receiveClose(socket: {
  once(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
}) {
  return new Promise<{ readonly code: number; readonly reason: string }>((resolve) =>
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() })),
  );
}

interface WebSocketFrame {
  readonly opcode: number;
  readonly payload: Buffer;
}

function parseFrame(
  buffer: Buffer,
): { readonly frame: WebSocketFrame; readonly rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const firstLength = buffer[1]! & 0x7f;
  let offset = 2;
  let payloadLength = firstLength;
  if (firstLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (firstLength === 127) {
    if (buffer.length < 10) return null;
    const length = buffer.readBigUInt64BE(2);
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('test frame is too large');
    payloadLength = Number(length);
    offset = 10;
  }
  if (buffer.length < offset + payloadLength) return null;
  return {
    frame: {
      opcode: buffer[0]! & 0x0f,
      payload: buffer.subarray(offset, offset + payloadLength),
    },
    rest: buffer.subarray(offset + payloadLength),
  };
}

async function readUpgradeResponse(
  socket: net.Socket,
): Promise<{ readonly statusCode: number; readonly remaining: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      cleanup();
      const headers = buffer.subarray(0, end).toString();
      const statusCode = Number(/^HTTP\/1\.1 (\d+)/.exec(headers)?.[1]);
      resolve({ statusCode, remaining: buffer.subarray(end + 4) });
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
  });
}

async function receiveFrame(socket: net.Socket, initialBuffer: Buffer): Promise<WebSocketFrame> {
  return new Promise((resolve, reject) => {
    let buffer = initialBuffer;
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseFrame(buffer);
      if (parsed === null) return;
      cleanup();
      resolve(parsed.frame);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off('data', onData);
      socket.off('error', onError);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    onData(Buffer.alloc(0));
  });
}

async function connectRawWebSocket(
  app: { listen(options: { host: string; port: number }): Promise<string>; server: net.Server },
  route: string,
  userAgent?: string,
): Promise<{ readonly socket: net.Socket; readonly firstFrame: Promise<WebSocketFrame> }> {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('test server has no port');
  const socket = net.connect({ host: '127.0.0.1', port: address.port });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const key = randomBytes(16).toString('base64');
  socket.write(
    `GET ${route} HTTP/1.1\r\n` +
      `Host: 127.0.0.1:${address.port}\r\n` +
      'Connection: Upgrade\r\n' +
      'Upgrade: websocket\r\n' +
      'Sec-WebSocket-Version: 13\r\n' +
      `Sec-WebSocket-Key: ${key}\r\n` +
      `Origin: ${LOOPBACK_HEADERS.origin}\r\n` +
      (userAgent === undefined ? '' : `User-Agent: ${userAgent}\r\n`) +
      `Sec-WebSocket-Protocol: ${LOCAL_WEB_SUBPROTOCOL}\r\n` +
      '\r\n',
  );
  const response = await readUpgradeResponse(socket);
  expect(response.statusCode).toBe(101);
  return { socket, firstFrame: receiveFrame(socket, response.remaining) };
}

describe('production local web host', () => {
  it('serves only the explicit SPA surfaces and applies cache policy', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rivalhub-local-web-'));
    try {
      await mkdir(join(root, 'assets'));
      await writeFile(join(root, 'index.html'), '<!doctype html><div id="root">built</div>');
      await writeFile(
        join(root, 'product-shell.css'),
        ':root { --broadcast-shell-topbar-height: 60px; }',
      );
      await writeFile(join(root, 'assets', 'main-123.js'), 'console.log("built");');
      await writeFile(join(root, 'robots.txt'), 'User-agent: *');

      const app = buildApp({ webRoot: root });
      apps.push(app);
      await app.ready();

      const hostDiagnostics = await app.inject({ method: 'GET', url: '/debug/hosts' });
      expect(hostDiagnostics.statusCode).toBe(200);
      expect(hostDiagnostics.json()).toMatchObject({
        active: {
          obs: 0,
          browser: 0,
          unknown: 0,
          byChannel: { program: 0, radar: 0, operator: 0, assist: 0, 'program-cue': 0 },
          obsVersions: [],
        },
        totals: {
          connected: 0,
          disconnected: 0,
          connectionLimitRejected: 0,
          slowConsumerTerminated: 0,
        },
        recentEvents: [],
      });

      for (const route of [
        '/program',
        '/program/waiting',
        '/program/matchup',
        '/program/bp',
        '/program/halftime',
        '/program/map-result',
        '/program/intermap',
        '/program/match-result',
        '/workspace',
        '/workspace/left',
        '/workspace/dock',
        '/',
        '/matches',
        '/picture',
        '/settings',
        '/operator',
        '/operator/hud',
        '/debug',
        '/qualification',
      ]) {
        const response = await app.inject({ method: 'GET', url: route });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).toContain('built');
      }

      const entry = await app.inject({ method: 'GET', url: '/' });
      expect(entry.statusCode).toBe(200);
      expect(entry.headers['cache-control']).toBe('no-store');
      const missing = await app.inject({
        method: 'GET',
        url: '/missing-page',
        headers: { accept: 'text/html' },
      });
      expect(missing.statusCode).toBe(404);
      expect(missing.body).toContain('built');
      const missingApi = await app.inject({
        method: 'GET',
        url: '/operator/series/missing',
        headers: { accept: 'text/html' },
      });
      expect(missingApi.statusCode).toBe(404);
      expect(missingApi.body).not.toContain('built');

      const asset = await app.inject({ method: 'GET', url: '/assets/main-123.js' });
      expect(asset.statusCode).toBe(200);
      expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');

      const shellStyles = await app.inject({ method: 'GET', url: '/product-shell.css' });
      expect(shellStyles.statusCode).toBe(200);
      expect(shellStyles.body).toContain('--broadcast-shell-topbar-height: 60px');

      const other = await app.inject({ method: 'GET', url: '/robots.txt' });
      expect(other.statusCode).toBe(200);
      expect(other.headers['cache-control']).toBe('no-cache');

      const websocketPath = await app.inject({ method: 'GET', url: LOCAL_WEB_ROUTES.program });
      expect(websocketPath.statusCode).toBe(404);
      expect(websocketPath.body).not.toContain('built');
      const apiPath = await app.inject({ method: 'GET', url: '/debug/runtime/typo' });
      expect(apiPath.statusCode).toBe(404);
      expect(apiPath.body).not.toContain('built');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects an explicit invalid WEB_ROOT instead of silently serving API-only mode', () => {
    expect(() => buildApp({ webRoot: join(tmpdir(), 'rivalhub-web-does-not-exist') })).toThrow(
      'WEB_ROOT',
    );
  });

  it.each(Object.entries(LOCAL_WEB_ROUTES))(
    'upgrades %s and sends the current baseline first',
    async (_channel, route) => {
      const app = buildApp();
      apps.push(app);
      await app.ready();

      const connection = await connectRawWebSocket(app, route);
      const snapshot = JSON.parse((await connection.firstFrame).payload.toString()) as {
        readonly type: string;
        readonly channel: string;
        readonly channelSeq: number;
      };
      expect(snapshot).toMatchObject({
        type: _channel === 'program-cue' ? 'cue-baseline' : 'snapshot',
        channelSeq: 1,
      });
      expect(snapshot.channel).toBe(_channel);
      connection.socket.destroy();
    },
  );

  it('reports OBS host connections from the handshake without retaining the user-agent', async () => {
    const app = buildApp();
    apps.push(app);
    await app.ready();
    const userAgent = 'Mozilla/5.0 Chrome/120.0.0.0 OBS/32.0.2 private-agent-marker';
    const connection = await connectRawWebSocket(app, LOCAL_WEB_ROUTES.program, userAgent);
    await connection.firstFrame;

    const response = await app.inject({ method: 'GET', url: '/debug/hosts' });
    expect(response.json()).toMatchObject({
      active: {
        obs: 1,
        browser: 0,
        byChannel: { program: 1 },
        byHostChannel: {
          obs: { program: 1 },
          browser: { program: 0 },
          unknown: { program: 0 },
        },
        obsVersions: ['32.0.2'],
      },
      totals: { connected: 1 },
      recentEvents: [{ action: 'connected', host: 'obs', channel: 'program' }],
    });
    expect(response.body).not.toContain('private-agent-marker');

    connection.socket.destroy();
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      const current = await app.inject({ method: 'GET', url: '/debug/hosts' });
      const diagnostics = current.json<{ active: { obs: number } }>();
      if (diagnostics.active.obs === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect((await app.inject({ method: 'GET', url: '/debug/hosts' })).json()).toMatchObject({
      active: { obs: 0 },
      totals: { disconnected: 1 },
    });
  });

  it('rejects missing/unsupported subprotocol and non-loopback origin before upgrade', async () => {
    const app = buildApp();
    apps.push(app);
    await app.ready();

    await expect(
      app.injectWS(LOCAL_WEB_ROUTES.program, { headers: { origin: LOOPBACK_HEADERS.origin } }),
    ).rejects.toThrow('Unexpected server response: 426');
    await expect(
      app.injectWS(LOCAL_WEB_ROUTES.program, {
        headers: { ...LOOPBACK_HEADERS, 'sec-websocket-protocol': 'unsupported.v1' },
      }),
    ).rejects.toThrow('Unexpected server response: 426');
    await expect(
      app.injectWS(LOCAL_WEB_ROUTES.program, {
        headers: { ...LOOPBACK_HEADERS, origin: 'http://192.168.1.10:4173' },
      }),
    ).rejects.toThrow('Unexpected server response: 403');
    await expect(
      app.injectWS(LOCAL_WEB_ROUTES.program, {
        headers: { 'sec-websocket-protocol': LOCAL_WEB_SUBPROTOCOL },
      }),
    ).rejects.toThrow('Unexpected server response: 403');
  });

  it('accepts only an exact explicit LAN origin allowlist', () => {
    const policy = createLocalWebOriginPolicy({
      host: '192.168.1.20',
      lanMode: true,
      allowedOrigins: ['http://caster-pc:4173'],
    });
    expect(checkLocalWebOrigin(policy, 'http://caster-pc:4173')).toMatchObject({ allowed: true });
    expect(checkLocalWebOrigin(policy, 'http://caster-pc:4173/')).toMatchObject({ allowed: true });
    expect(checkLocalWebOrigin(policy, 'http://caster-pc:4173/program')).toMatchObject({
      allowed: false,
    });
    expect(checkLocalWebOrigin(policy, 'http://other-pc:4173')).toMatchObject({
      allowed: false,
      reason: 'not-allowed',
    });
    expect(() => createLocalWebOriginPolicy({ host: '0.0.0.0' })).toThrow('LOCAL_WEB_LAN_MODE');
    expect(() => createLocalWebOriginPolicy({ host: '0.0.0.0', lanMode: true })).toThrow(
      'LOCAL_WEB_ALLOWED_ORIGINS',
    );
  });

  it('closes a read-only channel when the browser sends an application message', async () => {
    const app = buildApp();
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS(LOCAL_WEB_ROUTES.program, { headers: LOOPBACK_HEADERS });

    const closed = receiveClose(socket);
    socket.send('not allowed');
    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: 'read-only local snapshot channel',
    });
  });
});
