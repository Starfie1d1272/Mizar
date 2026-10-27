import { EventSubscription, OBSWebSocket } from 'obs-websocket-js';
import type { ObsConfigStore } from './config.js';
import { observeAudioMigration, type MigrationEventSource } from './audio-migration-observer.js';
import type { MigrationObserver } from './audio-migration.js';
import type { ObsRpc } from './reconcile.js';

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('audio_configuration_timeout')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
/** One connection remains alive through a configuration operation and pending RPC settlement. */
export class AudioConfigurationConnection {
  private busy = false;
  constructor(
    private readonly config: ObsConfigStore,
    private readonly create: () => Client = () => new OBSWebSocket() as unknown as Client,
    private readonly requestMs = 4000,
    private readonly budgetMs = 45000,
  ) {}
  async run<T>(
    operation: (obs: ObsRpc, endpoint: string, observer: MigrationObserver) => Promise<T>,
  ): Promise<T> {
    if (this.busy) throw new Error('audio_configuration_busy');
    this.busy = true;
    const client = this.create();
    const pending = new Set<Promise<unknown>>();
    const deadline = Date.now() + this.budgetMs;
    let closed = false;
    const remaining = () => Math.max(1, Math.min(this.requestMs, deadline - Date.now()));
    const lost = () => {
      closed = true;
    };
    client.on('ConnectionClosed', lost);
    try {
      const config = await this.config.read();
      const endpoint = `ws://${config.host}:${config.port}`;
      const connecting = client.connect(endpoint, config.password, {
        eventSubscriptions:
          EventSubscription.General |
          EventSubscription.Config |
          EventSubscription.Inputs |
          EventSubscription.Scenes |
          EventSubscription.SceneItems |
          EventSubscription.Filters |
          EventSubscription.Outputs,
      });
      pending.add(connecting);
      void connecting.then(
        () => pending.delete(connecting),
        () => pending.delete(connecting),
      );
      await bounded(connecting, remaining());
      const rpc: ObsRpc = {
        call: async (type, data) => {
          if (closed || Date.now() >= deadline) throw new Error('audio_configuration_disconnected');
          const task = client.call(type, data);
          pending.add(task);
          void task.then(
            () => pending.delete(task),
            () => pending.delete(task),
          );
          try {
            return await bounded(task, remaining());
          } catch (error) {
            // A scene-item write may have reached OBS even when its short RPC
            // deadline expires. Keep the transaction and its observer alive
            // until the original receipt settles or the operation budget ends.
            if (
              !['SetSceneItemEnabled', 'SetInputSettings'].includes(type) ||
              closed ||
              Date.now() >= deadline
            )
              throw error;
            return bounded(task, Math.max(1, deadline - Date.now()));
          }
        },
      };
      return await bounded(
        operation(rpc, endpoint, observeAudioMigration(client as MigrationEventSource)),
        Math.max(1, deadline - Date.now()),
      );
    } finally {
      // A timed-out write can still complete. Keep observation alive until settlement or the total budget expires.
      if (pending.size && !closed)
        await bounded(Promise.allSettled([...pending]), Math.max(1, deadline - Date.now())).catch(
          () => undefined,
        );
      closed = true;
      client.off('ConnectionClosed', lost);
      await bounded(client.disconnect(), this.requestMs).catch(() => undefined);
      this.busy = false;
    }
  }
}
