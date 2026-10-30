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

it.each(['idle', 'streaming', 'late'])('video guard %s', async (scenario) => {
  const streaming = scenario === 'streaming';
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
  let settings =
    scenario !== 'idle'
      ? {
          baseWidth: 1920,
          baseHeight: 1080,
          outputWidth: 1920,
          outputHeight: 1080,
          fpsNumerator: 60,
          fpsDenominator: 1,
        }
      : { ...original };
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
  let preflightDone = false;
  let emitStarting: () => Promise<void> = async () => {};
  const sockets = new Set<{ send: (data: string) => void }>();
  server.get('/', { websocket: true }, (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
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
        else if (requestType === 'GetStreamStatus' || requestType === 'GetRecordStatus')
          responseData = {
            outputActive: streaming && requestType === 'GetStreamStatus',
            outputPaused: false,
            outputReconnecting: false,
          };
        else if (requestType === 'GetVideoSettings') {
          responseData = { ...settings };
          if (scenario === 'late' && preflightDone) {
            preflightDone = false;
            await emitStarting();
          }
        } else if (requestType === 'GetOutputList') responseData = { outputs: [] };
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
            d: {
              requestType,
              requestId,
              requestStatus: { result: true, code: 100 },
              responseData,
            },
          }),
        );
      })().catch(() => socket.close());
    });
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('address unavailable');
  const config = new ObsConfigStore(join(directory, 'obs.json'));
  await config.save({
    host: '127.0.0.1',
    port: address.port,
    password: '',
    executablePath: null,
  });
  const journal = new ObsVideoTransaction(join(directory, 'video.json'));
  const adapter = new ObsAdapter(
    config,
    'http://127.0.0.1:3000',
    undefined,
    undefined,
    undefined,
    journal,
  );
  emitStarting = async () => {
    const lease = await adapter.captureWarmupGuard();
    for (const socket of sockets)
      socket.send(
        JSON.stringify({
          op: 5,
          d: {
            eventType: 'StreamStateChanged',
            eventIntent: 64,
            eventData: { outputActive: false, outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' },
          },
        }),
      );
    await vi.waitFor(() => expect(lease()).toBe(false));
  };
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
    if (streaming) {
      expect(preflight.statusCode).toBe(409);
      expect(preflight.json().message).toContain('直播');
      expect(calls.some((value) => /^(Set|Create|Remove|Stop)/.test(value))).toBe(false);
      expect(await journal.pending()).toBe(false);
      return;
    }
    expect(preflight.statusCode).toBe(200);
    preflightDone = true;
    const request = app.inject({
      method: 'POST',
      url: '/operator/obs/video-prepare',
      headers,
      payload: { expectedRevision: 'revision' },
    });
    if (scenario === 'late') {
      const response = await request;
      expect(response.statusCode).toBe(409);
      expect(await journal.pending()).toBe(false);
      expect(calls.some((value) => /^(Set|Create|Remove|Stop)/.test(value))).toBe(false);
      return;
    }
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
