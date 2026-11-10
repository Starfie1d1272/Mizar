import { EventSubscription, OBSWebSocket } from 'obs-websocket-js';
import type { ObsConfigStore } from './config.js';
import type { ObsRpc } from './reconcile.js';

const roles = ['桌面声音', '游戏声音', '其他解说', '麦克风', '音乐', '音效'] as const;
interface Client {
  connect(
    endpoint: string,
    password: string,
    options: { eventSubscriptions: number },
  ): Promise<unknown>;
  disconnect(): Promise<unknown>;
  call(type: string, data?: Record<string, unknown>): Promise<Record<string, unknown>>;
  on(event: string, listener: (value: unknown) => void): void;
  off(event: string, listener: (value: unknown) => void): void;
}
async function bounded<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('audio_meter_timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Explicit, short read-only connection: never changes another owner's subscriptions. */
export class AudioMeter {
  private busy = false;
  constructor(
    private readonly config: ObsConfigStore,
    private readonly create: () => Client = () => new OBSWebSocket() as unknown as Client,
    private readonly durationMs = 2000,
    private readonly failed: (error: unknown, password?: string) => void = () => undefined,
  ) {}
  async sample(valid: () => boolean = () => true) {
    if (this.busy) throw new Error('audio_meter_busy');
    const client = this.create();
    this.busy = true;
    const deadline = Date.now() + 10000;
    let stopped = false;
    let changed = false;
    let collecting = false;
    const peaks = new Map<string, { peak: number; samples: number }>();
    const invalidate = () => {
      changed = true;
    };
    let unsubscribe = () => {};
    let password: string | undefined;
    const onMeters = (value: unknown) => {
      if (!collecting || changed || !valid()) return;
      const inputs = (value as { inputs?: unknown })?.inputs;
      if (!Array.isArray(inputs)) return;
      for (const input of inputs) {
        if (!input || typeof input.inputUuid !== 'string') continue;
        const sample = peaks.get(input.inputUuid);
        if (!sample || !Array.isArray(input.inputLevelsMul)) continue;
        const values = input.inputLevelsMul.map((channel: unknown) =>
          Array.isArray(channel) ? channel[2] : undefined,
        );
        if (
          !values.length ||
          values.some((n: unknown) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)
        )
          continue;
        sample.peak = Math.max(sample.peak, ...values);
        sample.samples++;
      }
    };
    const changes = [
      'ConnectionClosed',
      'CurrentSceneCollectionChanging',
      'CurrentSceneCollectionChanged',
      'InputRemoved',
      'InputNameChanged',
      'InputSettingsChanged',
    ];
    for (const event of changes) client.on(event, invalidate);
    client.on('InputVolumeMeters', onMeters);
    const check = () => {
      if (changed || !valid() || Date.now() >= deadline)
        throw new Error('audio_meter_context_changed');
    };
    try {
      unsubscribe = this.config.onChanged(invalidate);
      const config = await this.config.read();
      password = config.password;
      const endpoint = `ws://${config.host}:${config.port}`;
      const connecting = client.connect(endpoint, config.password, {
        eventSubscriptions:
          EventSubscription.General |
          EventSubscription.Config |
          EventSubscription.Inputs |
          EventSubscription.InputVolumeMeters,
      });
      void connecting.then(
        () => {
          if (stopped) void client.disconnect().catch(() => undefined);
        },
        () => undefined,
      );
      await bounded(connecting, 4000);
      check();
      const rpc: ObsRpc = {
        call: (type, data) => {
          check();
          return bounded(client.call(type, data), 2000);
        },
      };
      const obs = await this.config.managedResources.bind(rpc, endpoint, 'http://127.0.0.1:3000');
      const scope = await obs.ownershipScope!();
      const identities = await Promise.all(
        roles.map(async (name) => ({ name, identity: await obs.managedInputIdentity!(name) })),
      );
      for (const { identity } of identities)
        if (identity) peaks.set(identity.uuid, { peak: 0, samples: 0 });
      collecting = true;
      const start = Date.now();
      while (Date.now() - start < this.durationMs) {
        check();
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      collecting = false;
      const durationMs = Date.now() - start;
      check();
      if ((await obs.ownershipScope!()) !== scope) throw new Error('audio_meter_context_changed');
      for (const { name, identity } of identities) {
        const current = await obs.managedInputIdentity!(name);
        if (current?.uuid !== identity?.uuid || current?.kind !== identity?.kind)
          throw new Error('audio_meter_context_changed');
      }
      check();
      return {
        durationMs,
        channels: identities.map(({ name, identity }) => {
          const sample = identity ? peaks.get(identity.uuid) : undefined;
          return {
            name,
            samples: sample?.samples ?? 0,
            peakDb: sample?.samples && sample.peak > 0 ? 20 * Math.log10(sample.peak) : null,
            status: !sample?.samples
              ? ('unavailable' as const)
              : sample.peak === 0
                ? ('silent' as const)
                : ('signal' as const),
          };
        }),
      };
    } catch (error) {
      this.failed(error, password);
      throw error;
    } finally {
      stopped = true;
      collecting = false;
      unsubscribe();
      for (const event of changes) client.off(event, invalidate);
      client.off('InputVolumeMeters', onMeters);
      await bounded(client.disconnect(), 1000).catch(() => undefined);
      this.busy = false;
    }
  }
}
