import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
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

describe('production local web host', () => {
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
