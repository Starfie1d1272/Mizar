import { Worker } from 'node:worker_threads';
import type { PreparedBombDamage } from '@mizar/core/projection';
import type { StandingC4Input, StandingC4Outcome } from 'cs2-c4-damage';

/** One worker; at most one map load (owner) and ten predictions in flight. */
export class BombDamageWorkerClient {
  private worker: Worker | undefined;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly tasks = new Set<Promise<unknown>>();
  private closed = false;
  private context = '';
  private notification: ReturnType<typeof setImmediate> | undefined;
  constructor(private readonly changed: () => void) {}

  setContext(context: string): void {
    this.context = context;
  }

  private request(mapName: string, input?: StandingC4Input): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('worker-closed'));
    if (!this.worker) {
      const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
      this.worker = new Worker(new URL(`./bomb-damage-worker.${extension}`, import.meta.url), {
        // Do not inherit a test runner's loader or CLI arguments.
        execArgv: [],
      });
      this.worker.on('message', (message: { id: number; result?: unknown; error?: string }) => {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (this.pending.size === 0) this.worker?.unref();
        clearTimeout(request.timer);
        if (message.error) request.reject(new Error(message.error));
        else request.resolve(message.result);
      });
      this.worker.on('error', () => this.fail());
      this.worker.on('exit', () => this.fail());
      this.worker.unref();
    }
    this.worker.ref();
    const id = ++this.nextId;
    const task = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), 15_000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.postMessage({ id, mapName, ...(input ? { input } : {}) });
    });
    this.tasks.add(task);
    void task.then(
      () => this.tasks.delete(task),
      () => this.tasks.delete(task),
    );
    return task;
  }

  async load(mapName: string): Promise<PreparedBombDamage> {
    const metadata = (await this.request(mapName)) as Omit<PreparedBombDamage, 'predict'>;
    const cache = new Map<string, StandingC4Outcome>();
    const loading = new Set<string>();
    return {
      ...metadata,
      predict: (input) => {
        if (this.closed) return { status: 'unavailable', reason: 'worker-unavailable' };
        const context = this.context;
        const key = JSON.stringify([context, input]);
        const result = cache.get(key);
        if (result) return result;
        if (!this.closed && !loading.has(key) && this.pending.size < 10) {
          loading.add(key);
          void this.request(mapName, input)
            .then((value) => {
              loading.delete(key);
              // Completion reprojects current state; never publishes a saved frame.
              if (this.closed || this.context !== context) return;
              cache.set(key, value as StandingC4Outcome);
              while (cache.size > 32) cache.delete(cache.keys().next().value!);
              if (this.pending.size === 0 && !this.notification)
                this.notification = setImmediate(() => {
                  this.notification = undefined;
                  if (!this.closed) this.changed();
                });
            })
            .catch(() => {
              loading.delete(key);
              if (!this.closed && this.context === context) {
                cache.set(key, { status: 'unavailable', reason: 'model-unavailable' });
                while (cache.size > 32) cache.delete(cache.keys().next().value!);
              }
            });
        }
        return { status: 'unavailable', reason: 'prediction-loading' };
      },
    };
  }

  evict(mapName: string): void {
    if (!this.closed) this.worker?.postMessage({ evict: mapName });
  }

  async settle(): Promise<boolean> {
    const hadTasks = this.tasks.size > 0;
    await Promise.allSettled([...this.tasks]);
    if (this.notification) clearImmediate(this.notification);
    this.notification = undefined;
    return hadTasks;
  }

  private fail(): void {
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error('worker-unavailable'));
    }
    this.pending.clear();
    if (this.worker) void this.worker.terminate();
  }
  close(): void {
    if (this.notification) clearImmediate(this.notification);
    this.fail();
  }
}
