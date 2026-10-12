import { afterEach, expect, it, vi, type Mock } from 'vitest';
import type { EventEmitter } from 'node:events';
import { ObsOutputController } from '../src/obs/outputs.js';
import { ObsAdapter } from '../src/obs/adapter.js';
import { ObsConfigStore } from '../src/obs/config.js';

const wire = vi.hoisted(() => ({
  clients: [] as Array<
    EventEmitter & {
      call: Mock<(type: string) => Promise<Record<string, unknown>>>;
      connect: ReturnType<typeof vi.fn>;
    }
  >,
  active: { stream: false, record: false },
}));
vi.mock('obs-websocket-js', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    EventSubscription: { Outputs: 64 },
    OBSWebSocket: class extends EventEmitter {
      connect = vi.fn().mockResolvedValue({});
      disconnect = vi.fn().mockResolvedValue(undefined);
      call = vi.fn<(type: string) => Promise<Record<string, unknown>>>(async (type: string) => {
        await Promise.resolve();
        if (type === 'GetStreamStatus') return { outputActive: wire.active.stream };
        if (type === 'GetRecordStatus') return { outputActive: wire.active.record };
        return {};
      });
      constructor() {
        super();
        wire.clients.push(this);
      }
    },
  };
});

const controllers: ObsOutputController[] = [];
function setup() {
  const store = new ObsConfigStore('/unused-output-test');
  vi.spyOn(store, 'read').mockResolvedValue({
    host: '127.0.0.1',
    port: 4455,
    password: '',
    executablePath: null,
  });
  const controller = new ObsOutputController(store, vi.fn());
  controllers.push(controller);
  return { controller, store };
}
function event(
  kind: 'stream' | 'record',
  state: string,
  active: boolean,
  index = wire.clients.length - 1,
) {
  wire.active[kind] = active;
  wire.clients[index]!.emit(kind === 'stream' ? 'StreamStateChanged' : 'RecordStateChanged', {
    outputState: `OBS_WEBSOCKET_OUTPUT_${state}`,
    outputActive: active,
  });
}
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  wire.clients.length = 0;
  wire.active = { stream: false, record: false };
});

it('does not send an old intent when OBS changes during command preflight', async () => {
  const { controller } = setup();
  const status = await controller.read();
  const client = wire.clients[0]!;
  client.call.mockImplementation(async (type: string) => {
    await Promise.resolve();
    if (type === 'GetStreamStatus') event('stream', 'STARTED', true);
    return { outputActive: type === 'GetStreamStatus' };
  });
  await expect(
    controller.command({
      output: 'stream',
      action: 'start',
      expectedRevision: status.stream.revision,
    }),
  ).rejects.toMatchObject({ code: 'obs_output_stale' });
  expect(client.call.mock.calls.every(([type]) => type.startsWith('Get'))).toBe(true);
});

it('confirms a timed out request from the actual output without replaying the mutation', async () => {
  vi.useFakeTimers();
  const { controller } = setup();
  const status = await controller.read();
  const client = wire.clients[0]!;
  const original = client.call.getMockImplementation()!;
  client.call.mockImplementation((type: string) =>
    type === 'StartStream' ? new Promise(() => {}) : original(type),
  );
  const running = controller.command({
    output: 'stream',
    action: 'start',
    expectedRevision: status.stream.revision,
  });
  await vi.advanceTimersByTimeAsync(0);
  wire.active.stream = true; // OBS executed it, but both the response and event were lost.
  await vi.advanceTimersByTimeAsync(4000);
  await running;
  expect(controller.snapshot().stream).toMatchObject({ active: true, pending: null });
  expect(client.call.mock.calls.filter(([type]) => type === 'StartStream')).toHaveLength(1);
});

it('keeps output mutations mutually exclusive with configuration and repair across windows', async () => {
  vi.useFakeTimers();
  const { store } = setup();
  const diagnostic = vi.fn();
  const adapter = new ObsAdapter(store, 'http://127.0.0.1:3000', diagnostic);
  try {
    const status = await adapter.outputStatus();
    const command = {
      output: 'stream',
      action: 'start',
      expectedRevision: status.stream.revision,
    } as const;
    const running = adapter.outputCommand(command).catch(() => undefined);
    await expect(adapter.repair(() => 'waiting')).rejects.toMatchObject({
      code: 'obs_output_busy',
    });
    await expect(adapter.setupAudio()).rejects.toMatchObject({ code: 'obs_output_busy' });
    await expect(adapter.ensure()).rejects.toMatchObject({ code: 'obs_output_busy' });
    await vi.advanceTimersByTimeAsync(8500);
    await running;
    let saved!: () => void;
    vi.spyOn(store, 'save').mockImplementation(
      () =>
        new Promise((resolve) => {
          saved = resolve;
        }),
    );
    const saving = adapter.configure(await store.read());
    diagnostic.mockClear();
    await expect(adapter.outputCommand(command)).rejects.toMatchObject({ code: 'obs_output_busy' });
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      'obs_output_command',
      expect.objectContaining({
        code: 'obs_output_busy',
        message: 'OBS 配置正在处理，请稍后操作。',
      }),
    );
    expect(
      wire.clients
        .flatMap((client) => client.call.mock.calls)
        .filter(([type]) => type === 'StartStream'),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    saved();
    await saving;
  } finally {
    await adapter.close();
  }
});
