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

it.each([
  [207, 'obs_output_busy', '忙碌'],
  [500, 'obs_output_busy', '正在使用'],
  [504, 'obs_output_disabled', '完成相应直播或录像配置'],
  [501, 'obs_output_stale', '状态已变化'],
  [502, 'obs_output_stale', '状态已变化'],
  [503, 'obs_output_stale', '状态已变化'],
  [204, 'obs_output_failed', '版本'],
  [702, 'obs_output_failed', '诊断'],
])(
  'gives safe output guidance for OBS rejection %s and retains its cause',
  async (code, expected, message) => {
    const { controller } = setup();
    const status = await controller.read();
    const client = wire.clients[0]!;
    const original = client.call.getMockImplementation()!;
    const cause = Object.assign(new Error('private server comment'), { code });
    client.call.mockImplementation((type) =>
      type === 'StartStream' ? Promise.reject(cause) : original(type),
    );
    const failure: unknown = await controller
      .command({ output: 'stream', action: 'start', expectedRevision: status.stream.revision })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: expected, cause });
    expect((failure as Error).message).toContain(message);
  },
);

it('logs the OBS rejection code and original reason through the existing redaction boundary', async () => {
  const { store } = setup();
  vi.spyOn(store, 'read').mockResolvedValue({
    host: '127.0.0.1',
    port: 4455,
    password: 'private-obs-value',
    executablePath: null,
  });
  const diagnostic = vi.fn<(stage: string, error: unknown) => void>();
  const adapter = new ObsAdapter(store, 'http://127.0.0.1:3000', diagnostic);
  try {
    const status = await adapter.outputStatus();
    const client = wire.clients[0]!;
    const original = client.call.getMockImplementation()!;
    client.call.mockImplementation((type) =>
      type === 'StartStream'
        ? Promise.reject(
            Object.assign(new Error('encoder initialization failed\npassword=private-obs-value'), {
              code: 702,
            }),
          )
        : original(type),
    );
    await expect(
      adapter.outputCommand({
        output: 'stream',
        action: 'start',
        expectedRevision: status.stream.revision,
      }),
    ).rejects.toMatchObject({
      code: 'obs_output_failed',
      message: 'OBS 拒绝了此操作，请查看诊断中的 OBS 原因。',
    });
    const evidence: unknown = diagnostic.mock.calls.find(
      ([stage]) => stage === 'obs_output_command',
    )?.[1];
    expect(evidence).toMatchObject({ cause: { code: 702 } });
    expect(JSON.stringify(evidence)).toContain('encoder initialization failed');
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('private-obs-value');
  } finally {
    await adapter.close();
  }
});

it('recovers external transitions with a bounded snapshot check when the final event is lost', async () => {
  vi.useFakeTimers();
  const { controller } = setup();
  await controller.read();
  event('stream', 'STARTING', false);
  expect((await controller.read()).stream.phase).toBe('starting');
  await vi.advanceTimersByTimeAsync(8000);
  expect((await controller.read()).stream).toMatchObject({ phase: 'idle', active: false });
});

it('does not mistake a numeric transport error for a definite OBS rejection', async () => {
  vi.useFakeTimers();
  const { controller } = setup();
  const status = await controller.read();
  const client = wire.clients[0]!;
  const original = client.call.getMockImplementation()!;
  client.call.mockImplementation((type) =>
    type === 'StartStream'
      ? Promise.reject(Object.assign(new Error('transport timeout'), { code: -1 }))
      : original(type),
  );
  const result = controller
    .command({ output: 'stream', action: 'start', expectedRevision: status.stream.revision })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(8500);
  expect(await result).toMatchObject({ code: 'obs_output_unconfirmed' });
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

it('subscribes to outputs, observes external changes, and replaces disconnected state with a new snapshot', async () => {
  const { controller } = setup();
  await controller.read();
  expect(wire.clients[0]!.connect).toHaveBeenCalledWith('ws://127.0.0.1:4455', '', {
    eventSubscriptions: 64,
  });
  event('stream', 'RECONNECTING', true);
  event('record', 'PAUSED', true);
  expect(controller.snapshot()).toMatchObject({
    stream: { phase: 'reconnecting' },
    record: { phase: 'paused' },
  });
  const oldRevision = controller.snapshot().stream.revision;
  wire.clients[0]!.emit('ConnectionClosed');
  expect(controller.snapshot()).toMatchObject({
    stream: { active: null, phase: 'unknown' },
    record: { active: null },
  });
  wire.active.record = false;
  await controller.read();
  expect(controller.snapshot()).toMatchObject({
    stream: { active: true },
    record: { active: false },
  });
  event('stream', 'STOPPED', false, 0);
  expect(controller.snapshot().stream.active).toBe(true);
  expect(controller.snapshot().stream.revision).not.toBe(oldRevision);
});

it('does not overwrite a newer event with a delayed snapshot', async () => {
  const { controller } = setup();
  await controller.read();
  let resolve!: (value: { outputActive: boolean }) => void;
  wire.clients[0]!.call.mockImplementation((type: string) =>
    type === 'GetStreamStatus'
      ? new Promise((done) => {
          resolve = done;
        })
      : Promise.resolve({ outputActive: false }),
  );
  const reading = controller.read();
  await vi.waitFor(() => expect(resolve).toBeTypeOf('function'));
  event('stream', 'STARTED', true);
  resolve({ outputActive: false });
  expect((await reading).stream).toMatchObject({ active: true, phase: 'active' });
});

it.each([
  ['stream', 'start', 'StartStream', 'STARTED'],
  ['stream', 'stop', 'StopStream', 'STOPPED'],
  ['record', 'start', 'StartRecord', 'STARTED'],
  ['record', 'stop', 'StopRecord', 'STOPPED'],
] as const)(
  'executes explicit %s %s once across concurrent operator windows',
  async (output, action, request, finalState) => {
    const { controller } = setup();
    wire.active[output] = action === 'stop';
    const status = await controller.read();
    const client = wire.clients[0]!;
    const original = client.call.getMockImplementation()!;
    client.call.mockImplementation(async (type: string) => {
      await Promise.resolve();
      if (type === request) {
        event(output, finalState, action === 'start');
        return {};
      }
      return original(type);
    });
    const command = { output, action, expectedRevision: status[output].revision };
    const first = controller.command(command);
    await expect(controller.command(command)).rejects.toMatchObject({ code: 'obs_output_busy' });
    await first;
    expect(controller.snapshot()[output]).toMatchObject({
      active: action === 'start',
      pending: null,
    });
    expect(client.call.mock.calls.filter(([type]) => type === request)).toHaveLength(1);
    expect(client.call.mock.calls.some(([type]) => String(type).startsWith('Toggle'))).toBe(false);
  },
);

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

it('reports an unconfirmed result when acknowledgement never becomes actual output', async () => {
  vi.useFakeTimers();
  const { controller } = setup();
  const status = await controller.read();
  const result = controller
    .command({ output: 'record', action: 'start', expectedRevision: status.record.revision })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(8500);
  expect(await result).toMatchObject({ code: 'obs_output_unconfirmed' });
  expect(controller.snapshot().record).toMatchObject({
    phase: 'unknown',
    active: null,
    pending: null,
  });
});

it('reconciles server errors against observed state and rejects stale confirmations', async () => {
  const { controller } = setup();
  const status = await controller.read();
  const client = wire.clients[0]!;
  const original = client.call.getMockImplementation()!;
  client.call.mockImplementation(async (type: string) => {
    await Promise.resolve();
    if (type === 'StartStream') throw Object.assign(new Error('output disabled'), { code: 504 });
    return original(type);
  });
  await expect(
    controller.command({
      output: 'stream',
      action: 'start',
      expectedRevision: status.stream.revision,
    }),
  ).rejects.toMatchObject({ code: 'obs_output_disabled' });
  event('stream', 'STARTED', true);
  await expect(
    controller.command({
      output: 'stream',
      action: 'start',
      expectedRevision: status.stream.revision,
    }),
  ).rejects.toMatchObject({ code: 'obs_output_stale' });
  const active = controller.snapshot().stream;
  client.call.mockImplementation(async (type: string) => {
    await Promise.resolve();
    if (type === 'StopStream') {
      event('stream', 'STOPPED', false);
      throw Object.assign(new Error('already stopped'), { code: 501 });
    }
    return original(type);
  });
  await controller.command({ output: 'stream', action: 'stop', expectedRevision: active.revision });
  expect(controller.snapshot().stream.active).toBe(false);
});

it('invalidates an in-flight command on disconnect and never replays it after reconnect', async () => {
  vi.useFakeTimers();
  const { controller } = setup();
  const status = await controller.read();
  const command = controller
    .command({ output: 'stream', action: 'start', expectedRevision: status.stream.revision })
    .catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  wire.clients[0]!.emit('ConnectionClosed');
  await vi.advanceTimersByTimeAsync(2000);
  expect(await command).toMatchObject({ code: 'obs_output_unconfirmed' });
  expect(wire.clients).toHaveLength(2);
  expect(wire.clients[1]!.call.mock.calls.every(([type]) => String(type).startsWith('Get'))).toBe(
    true,
  );
});

it('keeps output mutations mutually exclusive with configuration and repair across windows', async () => {
  vi.useFakeTimers();
  const { store } = setup();
  const adapter = new ObsAdapter(store, 'http://127.0.0.1:3000');
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
    await expect(adapter.outputCommand(command)).rejects.toMatchObject({ code: 'obs_output_busy' });
    await vi.advanceTimersByTimeAsync(0);
    saved();
    await saving;
  } finally {
    await adapter.close();
  }
});
