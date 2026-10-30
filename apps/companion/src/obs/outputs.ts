import { randomUUID } from 'node:crypto';
import { EventSubscription, OBSWebSocket } from 'obs-websocket-js';
import type {
  ObsOutputCommand,
  ObsOutputKind,
  ObsOutputPhase,
  ObsOutputsStatus,
  ObsOutputStatus,
} from '@mizar/protocol/obs';
import type { ObsConfigStore } from './config.js';

const REQUEST_MS = 4000;
const CONFIRM_MS = 8000;
const RETRY_MS = 1500;
const kinds = ['stream', 'record'] as const;
const requests = {
  stream: { start: 'StartStream', stop: 'StopStream' },
  record: { start: 'StartRecord', stop: 'StopRecord' },
} as const;

export class ObsOutputError extends Error {
  constructor(
    readonly code:
      | 'obs_output_busy'
      | 'obs_output_stale'
      | 'obs_output_unavailable'
      | 'obs_output_disabled'
      | 'obs_output_failed'
      | 'obs_output_unconfirmed',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** OBS request-status codes, not arbitrary server comments, choose operator guidance. */
function rejectedOutput(failure: unknown): ObsOutputError {
  const code = (failure as { code: number }).code;
  if (code === 207 || code === 500)
    return new ObsOutputError(
      'obs_output_busy',
      'OBS 输出正在使用或暂时忙碌，请等待状态稳定后重试。',
      { cause: failure },
    );
  if (code === 504)
    return new ObsOutputError(
      'obs_output_disabled',
      'OBS 输出未启用，请先在 OBS 完成相应直播或录像配置。',
      { cause: failure },
    );
  if (code === 501 || code === 502 || code === 503)
    return new ObsOutputError(
      'obs_output_stale',
      'OBS 输出已停止或暂停状态已变化，请核对当前状态后操作。',
      { cause: failure },
    );
  if (code === 204)
    return new ObsOutputError(
      'obs_output_failed',
      '当前 OBS 不支持此操作，请检查 OBS 与 WebSocket 版本。',
      { cause: failure },
    );
  return new ObsOutputError('obs_output_failed', 'OBS 拒绝了此操作，请查看诊断中的 OBS 原因。', {
    cause: failure,
  });
}

function unknown(): ObsOutputStatus {
  return { phase: 'unknown', active: null, pending: null, revision: randomUUID() };
}

async function bounded<T>(task: Promise<T>, ms = REQUEST_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('OBS output timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One observed output state for all operator windows. Never retries a mutation. */
export class ObsOutputController {
  private values: Record<ObsOutputKind, ObsOutputStatus> = { stream: unknown(), record: unknown() };
  private client: OBSWebSocket | undefined;
  private generation = 0;
  private events = { stream: 0, record: 0 };
  private transitionAt = { stream: 0, record: 0 };
  private connecting: Promise<void> | undefined;
  private reading: Promise<void> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private ready = false;
  private hasConnected = false;
  // Broader than the UI output revision: every observed takeover invalidates a
  // capture warmup, even when its final output state matches the prior snapshot.
  private warmupGeneration = 0;
  // Unlike warmupGeneration, owned scene and input writes do not invalidate this
  // lease. Every observed output transition does, even if it returns to idle.
  private preparationOutputGeneration = 0;
  private readonly warmupExtraOutputs: Record<
    'replay' | 'virtual',
    'idle' | 'starting' | 'active' | 'stopping' | 'unknown'
  > = { replay: 'idle', virtual: 'idle' };
  private warmupCollectionChanging = false;
  private warmupExitStarted = false;

  constructor(
    private readonly config: ObsConfigStore,
    private readonly diagnostic: (error: unknown, password: string) => void,
    private readonly observeProgram: (
      kind: 'scene' | 'collection' | 'collection-changing' | 'disconnected',
      name?: string,
    ) => void = () => undefined,
  ) {}

  get busy(): boolean {
    return kinds.some((kind) => {
      const state = this.values[kind];
      return state.pending !== null || state.phase === 'starting' || state.phase === 'stopping';
    });
  }

  captureWarmupGeneration(): number | null {
    return this.captureWarmupBlockReason() === null ? this.warmupGeneration : null;
  }

  preparationOutputEpoch(): number {
    return this.preparationOutputGeneration;
  }

  captureWarmupBlockReason(): string | null {
    if (!this.ready || this.closed) return 'OBS 连接状态未确认，请检查连接后重试。';
    if (this.warmupExitStarted) return 'OBS 正在退出，请等待结束后重试。';
    if (this.warmupCollectionChanging) return 'OBS 场景集合正在切换，请等待切换完成后重试。';
    const message = (
      name: string,
      phase: string,
      active: boolean | null,
      pending?: string | null,
    ) => {
      if (phase === 'starting' || pending === 'start')
        return `OBS ${name}正在开始，请等待状态稳定后重试。`;
      if (phase === 'stopping' || pending === 'stop')
        return `OBS ${name}正在停止，请等待状态稳定后重试。`;
      if (active === true || phase === 'active' || phase === 'paused' || phase === 'reconnecting')
        return `OBS ${name}正在运行，请停止${name}后重试。`;
      if (active !== false || phase !== 'idle') return `OBS ${name}状态未确认，请检查 OBS 后重试。`;
      return null;
    };
    for (const [kind, name] of [
      ['stream', '直播'],
      ['record', '录制'],
    ] as const) {
      const state = this.values[kind];
      const reason = message(name, state.phase, state.active, state.pending);
      if (reason) return reason;
    }
    for (const [kind, name] of [
      ['replay', '回放缓冲'],
      ['virtual', '虚拟摄像头'],
    ] as const) {
      const phase = this.warmupExtraOutputs[kind];
      const reason = message(
        name,
        phase,
        phase === 'active' ? true : phase === 'unknown' ? null : false,
      );
      if (reason) return reason;
    }
    return null;
  }

  snapshot(): ObsOutputsStatus {
    return { stream: { ...this.values.stream }, record: { ...this.values.record } };
  }

  private update(kind: ObsOutputKind, phase: ObsOutputPhase, active: boolean | null): void {
    const previous = this.values[kind];
    if (previous.phase === phase && previous.active === active) return;
    this.preparationOutputGeneration++;
    this.warmupGeneration++;
    this.values[kind] = { ...previous, phase, active, revision: randomUUID() };
  }

  private invalidate(client?: OBSWebSocket): void {
    if (client && this.client !== client) return;
    this.preparationOutputGeneration++;
    this.warmupGeneration++;
    this.warmupExtraOutputs.replay = 'idle';
    this.warmupExtraOutputs.virtual = 'idle';
    this.warmupCollectionChanging = false;
    this.warmupExitStarted = false;
    const old = this.client;
    this.client = undefined;
    if (this.ready) this.observeProgram('disconnected');
    this.ready = false;
    this.generation++;
    this.connecting = undefined;
    this.reading = undefined;
    for (const kind of kinds) this.update(kind, 'unknown', null);
    if (old) void old.disconnect().catch(() => undefined);
    if (!this.closed && !this.retry) {
      this.retry = setTimeout(() => {
        this.retry = undefined;
        void this.read().catch(() => undefined);
      }, RETRY_MS);
      this.retry.unref();
    }
  }

  reset(): void {
    this.invalidate();
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    const client = this.client;
    this.invalidate();
    await client?.disconnect().catch(() => undefined);
  }

  private event(kind: ObsOutputKind, event: { outputState: string; outputActive: boolean }): void {
    this.preparationOutputGeneration++;
    this.warmupGeneration++;
    this.events[kind]++;
    const phases: Record<string, ObsOutputPhase> = {
      OBS_WEBSOCKET_OUTPUT_STARTING: 'starting',
      OBS_WEBSOCKET_OUTPUT_STARTED: 'active',
      OBS_WEBSOCKET_OUTPUT_STOPPING: 'stopping',
      OBS_WEBSOCKET_OUTPUT_STOPPED: 'idle',
      OBS_WEBSOCKET_OUTPUT_RECONNECTING: 'reconnecting',
      OBS_WEBSOCKET_OUTPUT_RECONNECTED: 'active',
      OBS_WEBSOCKET_OUTPUT_PAUSED: 'paused',
      OBS_WEBSOCKET_OUTPUT_RESUMED: 'active',
    };
    const phase = phases[event.outputState] ?? 'unknown';
    if (phase === 'starting' || phase === 'stopping') this.transitionAt[kind] = Date.now();
    this.update(kind, phase, phase === 'unknown' ? null : event.outputActive);
  }

  private async connect(): Promise<void> {
    if (this.closed) throw new Error('OBS outputs closed');
    if (this.ready) return;
    if (this.connecting) return this.connecting;
    clearTimeout(this.retry);
    this.retry = undefined;
    const generation = this.generation;
    const client = new OBSWebSocket();
    this.client = client;
    const current = () => this.client === client && this.generation === generation && !this.closed;
    client.on('StreamStateChanged', (event) => {
      if (current()) this.event('stream', event);
    });
    client.on('RecordStateChanged', (event) => {
      if (current()) this.event('record', event);
    });
    client.on('CurrentProgramSceneChanged', (event) => {
      if (current()) {
        this.warmupGeneration++;
        this.observeProgram('scene', event.sceneName);
      }
    });
    client.on('CurrentSceneCollectionChanged', (event) => {
      if (current()) {
        this.warmupGeneration++;
        this.warmupCollectionChanging = false;
        this.observeProgram('collection', event.sceneCollectionName);
      }
    });
    client.on('CurrentSceneCollectionChanging', (event) => {
      if (current()) {
        this.warmupGeneration++;
        this.warmupCollectionChanging = true;
        this.observeProgram('collection-changing', event.sceneCollectionName);
      }
    });
    const invalidateWarmup = () => {
      if (current()) this.warmupGeneration++;
    };
    const extraOutput = (
      kind: 'replay' | 'virtual',
      event: { outputActive: boolean; outputState: string },
    ) => {
      if (!current()) return;
      this.preparationOutputGeneration++;
      this.warmupGeneration++;
      const phases: Record<string, typeof this.warmupExtraOutputs.replay> = {
        OBS_WEBSOCKET_OUTPUT_STARTING: 'starting',
        OBS_WEBSOCKET_OUTPUT_STARTED: 'active',
        OBS_WEBSOCKET_OUTPUT_STOPPING: 'stopping',
        OBS_WEBSOCKET_OUTPUT_STOPPED: 'idle',
        OBS_WEBSOCKET_OUTPUT_RECONNECTING: 'active',
        OBS_WEBSOCKET_OUTPUT_RECONNECTED: 'active',
      };
      const phase = phases[event.outputState] ?? 'unknown';
      this.warmupExtraOutputs[kind] =
        phase === 'idle' && event.outputActive !== false ? 'unknown' : phase;
    };
    client.on('ReplayBufferStateChanged', (event) => extraOutput('replay', event));
    client.on('VirtualcamStateChanged', (event) => extraOutput('virtual', event));
    client.on('InputSettingsChanged', invalidateWarmup);
    client.on('InputRemoved', invalidateWarmup);
    client.on('InputNameChanged', invalidateWarmup);
    client.on('ExitStarted', () => {
      if (current()) {
        this.preparationOutputGeneration++;
        this.warmupGeneration++;
        this.warmupExitStarted = true;
      }
    });
    client.on('ConnectionClosed', () => {
      if (current()) this.invalidate(client);
    });
    // ConnectionClosed owns invalidation; an error alone need not mean the socket is closed.
    client.on('ConnectionError', () => undefined);
    const task = (async () => {
      const config = await this.config.read();
      try {
        if (!current()) throw new Error('OBS connection superseded');
        await bounded(
          client
            .connect(`ws://${config.host}:${config.port}`, config.password, {
              eventSubscriptions:
                EventSubscription.Outputs |
                EventSubscription.Scenes |
                EventSubscription.Config |
                EventSubscription.Inputs |
                EventSubscription.General,
            })
            .then(async (result) => {
              if (!current()) await client.disconnect();
              return result;
            }),
        );
        if (!current()) {
          await client.disconnect();
          throw new Error('OBS connection superseded');
        }
        await this.refresh(client, generation);
        if (generation > 0) {
          await bounded(
            Promise.all([
              client.call('GetSceneCollectionList'),
              client.call('GetCurrentProgramScene'),
            ]),
          );
          if (this.hasConnected) this.observeProgram('disconnected');
        }
        if (!current()) throw new Error('OBS connection superseded');
        this.ready = true;
        this.hasConnected = true;
      } catch (error) {
        this.diagnostic(error, config.password);
        if (current()) this.invalidate(client);
        throw error;
      }
    })();
    this.connecting = task;
    try {
      await task;
    } finally {
      if (this.connecting === task) this.connecting = undefined;
    }
  }

  private async refresh(client: OBSWebSocket, generation: number): Promise<void> {
    const versions = { ...this.events };
    const [stream, record] = await bounded(
      Promise.all([client.call('GetStreamStatus'), client.call('GetRecordStatus')]),
    );
    if (this.client !== client || this.generation !== generation || this.closed)
      throw new Error('OBS connection superseded');
    for (const kind of kinds) {
      // Events received while reading are newer than this snapshot.
      if (this.events[kind] !== versions[kind]) continue;
      const value = kind === 'stream' ? stream : record;
      if (typeof value.outputActive !== 'boolean') {
        this.update(kind, 'unknown', null);
        continue;
      }
      const phase = !value.outputActive
        ? 'idle'
        : kind === 'stream' && stream.outputReconnecting
          ? 'reconnecting'
          : kind === 'record' && record.outputPaused
            ? 'paused'
            : 'active';
      // A transitional event is stronger evidence than a snapshot of the old active bit.
      const previous = this.values[kind].phase;
      if (
        Date.now() - this.transitionAt[kind] < CONFIRM_MS &&
        ((previous === 'starting' && !value.outputActive) ||
          (previous === 'stopping' && value.outputActive))
      )
        continue;
      this.update(kind, phase, value.outputActive);
    }
  }

  async read(): Promise<ObsOutputsStatus> {
    await this.connect();
    const client = this.client;
    if (!client || !this.ready) throw new Error('OBS unavailable');
    if (!this.reading) {
      const task = this.refresh(client, this.generation).catch((error: unknown) => {
        if (this.client === client) this.invalidate(client);
        throw error;
      });
      this.reading = task;
      void task
        .finally(() => {
          if (this.reading === task) this.reading = undefined;
        })
        .catch(() => undefined);
    }
    await this.reading;
    return this.snapshot();
  }

  async command(command: ObsOutputCommand): Promise<ObsOutputsStatus> {
    const { output, action, expectedRevision } = command;
    const state = this.values[output];
    if (state.pending || state.phase === 'starting' || state.phase === 'stopping')
      throw new ObsOutputError('obs_output_busy', 'OBS 正在处理此输出，请等待状态确认。');
    if (state.revision !== expectedRevision)
      throw new ObsOutputError('obs_output_stale', 'OBS 状态已变化，请核对后重新操作。');
    if (!this.ready || state.active === null)
      throw new ObsOutputError('obs_output_unavailable', 'OBS 输出状态无法确认，请等待重新连接。');
    const generation = this.generation;
    const client = this.client!;
    this.values[output] = { ...state, pending: action };
    this.preparationOutputGeneration++;
    this.warmupGeneration++;
    const reached = () => {
      const current = this.values[output];
      return action === 'start'
        ? current.active === true && (current.phase === 'active' || current.phase === 'paused')
        : current.active === false && current.phase === 'idle';
    };
    try {
      await this.read();
      if (generation !== this.generation || this.values[output].revision !== expectedRevision)
        throw new ObsOutputError('obs_output_stale', 'OBS 状态已变化，请核对后重新操作。');
      if (reached()) return this.snapshot();
      let failure: unknown;
      try {
        await bounded(client.call(requests[output][action]));
      } catch (error) {
        failure = error;
        const config = await this.config.read();
        this.diagnostic(error, config.password);
      }
      // A successful RPC only acknowledges the request. Confirm the actual output.
      const deadline = Date.now() + CONFIRM_MS;
      while (this.generation === generation && Date.now() < deadline) {
        if (reached()) return this.snapshot();
        await this.read().catch(() => undefined);
        if (this.generation !== generation) break;
        if (reached()) return this.snapshot();
        // A server rejection is definite; timeout/network failure may have executed.
        const failureCode = (failure as { code?: unknown } | undefined)?.code;
        if (typeof failureCode === 'number' && failureCode >= 200 && failureCode < 800)
          throw rejectedOutput(failure);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (this.generation === generation) this.update(output, 'unknown', null);
      throw new ObsOutputError(
        'obs_output_unconfirmed',
        '操作结果尚未确认，正在核实 OBS 状态。请勿重复操作。',
        { cause: failure },
      );
    } catch (error) {
      if (error instanceof ObsOutputError) throw error;
      throw new ObsOutputError(
        'obs_output_unconfirmed',
        '操作结果尚未确认，请等待 OBS 重新连接后核对。',
        { cause: error },
      );
    } finally {
      this.values[output] = { ...this.values[output], pending: null };
    }
  }
}
