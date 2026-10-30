import { expect, it, vi } from 'vitest';
vi.mock('obs-websocket-js', async () => await import('obs-websocket-js/json'));
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsAdapter } from '../src/obs/adapter.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { ObsVideoTransaction } from '../src/obs/video-transaction.js';
import { registerObsRoutes } from '../src/obs/routes.js';
import { createLocalWebOriginPolicy } from '../src/local-web/origin-policy.js';

it('routes use the real OBS client and roll back when preparation is invalidated in flight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-video-routes-'));
  const server = Fastify();
  const app = Fastify();
  await server.register(websocket);
  const original = {
    baseWidth: 2560,
    baseHeight: 1440,
    outputWidth: 1280,
    outputHeight: 720,
    fpsNumerator: 30,
    fpsDenominator: 1,
  };
  let settings = { ...original };
  let valid = true;
  let release!: () => void;
  let reached!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const calls: string[] = [];
  server.get('/', { websocket: true }, (socket) => {
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.6.3', rpcVersion: 1 } }));
    socket.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as {
        op: number;
        d: { requestId: string; requestType: string; requestData?: Record<string, unknown> };
      };
      if (message.op === 1) {
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        return;
      }
      if (message.op !== 6) return;
      void (async () => {
        const { requestType, requestId, requestData } = message.d;
        calls.push(requestType);
        let responseData: Record<string, unknown> = {};
        if (requestType === 'GetProfileList') responseData = { currentProfileName: 'Personal' };
        else if (requestType === 'GetVideoSettings') responseData = { ...settings };
        else if (requestType === 'GetOutputList') responseData = { outputs: [] };
        else if (requestType === 'SetVideoSettings') {
          settings = { ...settings, ...requestData };
          if (settings.baseWidth === 1920) {
            reached();
            await wait;
          }
        } else throw new Error(`Unexpected OBS request ${requestType}`);
        socket.send(
          JSON.stringify({
            op: 7,
            d: { requestType, requestId, requestStatus: { result: true, code: 100 }, responseData },
          }),
        );
      })().catch(() => socket.close());
    });
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('address unavailable');
  const config = new ObsConfigStore(join(directory, 'obs.json'));
  await config.save({ host: '127.0.0.1', port: address.port, password: '', executablePath: null });
  const journal = new ObsVideoTransaction(join(directory, 'video.json'));
  const adapter = new ObsAdapter(
    config,
    'http://127.0.0.1:3000',
    undefined,
    undefined,
    undefined,
    journal,
  );
  registerObsRoutes(app, {
    adapter,
    configStore: config,
    originPolicy: createLocalWebOriginPolicy(),
    activeScene: () => 'waiting',
    preparationValid: (revision) => () => valid && revision === 'revision',
  });
  try {
    const headers = { origin: 'http://127.0.0.1:3000' };
    const preflight = await app.inject({
      method: 'POST',
      url: '/operator/obs/video-preflight',
      headers,
      payload: { expectedRevision: 'revision' },
    });
    expect(preflight.statusCode).toBe(200);
    const request = app.inject({
      method: 'POST',
      url: '/operator/obs/video-prepare',
      headers,
      payload: { expectedRevision: 'revision' },
    });
    await entered;
    valid = false;
    release();
    const response = await request;
    expect(response.statusCode).toBe(409);
    expect(settings).toEqual(original);
    expect(await journal.pending()).toBe(false);
    expect(calls.filter((value) => value === 'SetVideoSettings')).toHaveLength(2);
    expect(calls.some((value) => value.startsWith('Stop'))).toBe(false);
  } finally {
    release();
    await adapter.close();
    await app.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
