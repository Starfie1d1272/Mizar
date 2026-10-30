import { expect, it, vi } from 'vitest';
vi.mock('obs-websocket-js', async () => await import('obs-websocket-js/json'));
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObsAdapter } from '../src/obs/adapter.js';
import { ObsConfigStore } from '../src/obs/config.js';

it('invalidates the capture lease on OBS output, takeover, input, disconnect and exit events', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-warmup-generation-'));
  const server = Fastify();
  await server.register(websocket);
  let sendEvent: (
    eventType: string,
    eventIntent: number,
    eventData?: Record<string, unknown>,
  ) => void = () => {
    throw new Error('OBS connection missing');
  };
  let closeConnection: () => void = () => undefined;
  server.get('/', { websocket: true }, (socket) => {
    sendEvent = (eventType, eventIntent, eventData = {}) =>
      socket.send(JSON.stringify({ op: 5, d: { eventType, eventIntent, eventData } }));
    closeConnection = () => socket.close();
    socket.send(JSON.stringify({ op: 0, d: { obsWebSocketVersion: '5.6.3', rpcVersion: 1 } }));
    socket.on('message', (raw) => {
      const request = JSON.parse(raw.toString()) as {
        op: number;
        d: { requestType: string; requestId: string };
      };
      if (request.op === 1) socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      if (request.op !== 6) return;
      const responseData =
        request.d.requestType === 'GetStreamStatus' || request.d.requestType === 'GetRecordStatus'
          ? { outputActive: false, outputReconnecting: false, outputPaused: false }
          : request.d.requestType === 'GetSceneCollectionList'
            ? { currentSceneCollectionName: 'Mizar' }
            : request.d.requestType === 'GetCurrentProgramScene'
              ? { currentProgramSceneName: '等待画面' }
              : {};
      socket.send(
        JSON.stringify({
          op: 7,
          d: { ...request.d, requestStatus: { result: true, code: 100 }, responseData },
        }),
      );
    });
  });
  await server.listen({ host: '127.0.0.1', port: 0 });
  const address = server.server.address();
  if (!address || typeof address === 'string') throw new Error('address unavailable');
  const config = new ObsConfigStore(join(directory, 'obs.json'));
  await config.save({ host: '127.0.0.1', port: address.port, password: '', executablePath: null });
  const adapter = new ObsAdapter(config, 'http://127.0.0.1:3000');
  const invalidate = async (
    eventType: string,
    eventIntent: number,
    eventData: Record<string, unknown> = {},
  ) => {
    const valid = await adapter.captureWarmupGuard();
    expect(valid()).toBe(true);
    sendEvent(eventType, eventIntent, eventData);
    await vi.waitFor(() => expect(valid()).toBe(false));
  };
  try {
    const starting = await adapter.captureWarmupGuard();
    sendEvent('StreamStateChanged', 64, {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING',
    });
    await vi.waitFor(() => expect(starting()).toBe(false));
    await expect(adapter.captureWarmupGuard()).rejects.toThrow('直播正在开始');
    sendEvent('StreamStateChanged', 64, {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
    });
    await vi.waitFor(async () => {
      expect((await adapter.outputStatus()).stream.phase).toBe('idle');
    });
    await invalidate('RecordStateChanged', 64, {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING',
    });
    sendEvent('RecordStateChanged', 64, {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
    });
    await vi.waitFor(async () => {
      expect((await adapter.outputStatus()).record.phase).toBe('idle');
    });
    await invalidate('ReplayBufferStateChanged', 64, {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING',
    });
    await expect(adapter.captureWarmupGuard()).rejects.toThrow('回放缓冲正在开始');
    sendEvent('ReplayBufferStateChanged', 64, {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
    });
    await vi.waitFor(async () => expect((await adapter.captureWarmupGuard())()).toBe(true));
    await invalidate('VirtualcamStateChanged', 64, {
      outputActive: true,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED',
    });
    await expect(adapter.captureWarmupGuard()).rejects.toThrow('虚拟摄像头正在运行');
    sendEvent('VirtualcamStateChanged', 64, {
      outputActive: false,
      outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED',
    });
    await vi.waitFor(async () => expect((await adapter.captureWarmupGuard())()).toBe(true));
    await invalidate('CurrentProgramSceneChanged', 4, { sceneName: '外部场景' });
    await invalidate('CurrentSceneCollectionChanging', 2, { sceneCollectionName: '外部集合' });
    await expect(adapter.captureWarmupGuard()).rejects.toThrow('场景集合正在切换');
    sendEvent('CurrentSceneCollectionChanged', 2, { sceneCollectionName: '外部集合' });
    await vi.waitFor(async () => expect((await adapter.captureWarmupGuard())()).toBe(true));
    await invalidate('InputSettingsChanged', 8, {
      inputName: '游戏画面',
      inputSettings: { capture_audio: true },
    });
    await invalidate('InputRemoved', 8, { inputName: '游戏画面' });
    await invalidate('InputNameChanged', 8, { inputName: '游戏画面', oldInputName: '其他' });
    const exiting = await adapter.captureWarmupGuard();
    adapter.pauseAutomatic();
    expect(exiting()).toBe(false);
    await invalidate('ExitStarted', 1);
    await expect(adapter.captureWarmupGuard()).rejects.toThrow('OBS 正在退出');
    const secondAdapter = new ObsAdapter(config, 'http://127.0.0.1:3000');
    try {
      const disconnected = await secondAdapter.captureWarmupGuard();
      closeConnection();
      await vi.waitFor(() => expect(disconnected()).toBe(false));
    } finally {
      await secondAdapter.close();
    }
  } finally {
    await adapter.close();
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
