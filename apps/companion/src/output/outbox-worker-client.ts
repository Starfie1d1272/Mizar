import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { OutboxOperations, OutboxReply, OutboxRequest } from './outbox-worker.js';

const LOAD_DEADLINE_MS = 30_000;
const REPLY_DEADLINE_MS = 12_000;

export class OutboxWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      startedAt: number;
    }
  >();
  private nextId = 0;
  private failure: Error | undefined;
  private termination: Promise<number> | undefined;
  private closed = false;
  private timing = { count: 0, totalMs: 0, maxMs: 0 };
  private roundTrip = { count: 0, totalMs: 0, maxMs: 0 };

  constructor(
    filePath: string,
    private readonly onFailure?: (error: Error) => void,
  ) {
    const entry = import.meta.url.endsWith('.ts')
      ? new URL(
          'data:text/javascript,' +
            encodeURIComponent(
              `import { tsImport } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)}; await tsImport(${JSON.stringify(new URL('./outbox-worker.ts', import.meta.url).href)}, ${JSON.stringify(import.meta.url)});`,
            ),
        )
      : new URL('./outbox-worker.js', import.meta.url);
    this.worker = new Worker(entry, { execArgv: [], workerData: filePath });
    this.worker.on('message', (reply: OutboxReply) => {
      const request = this.pending.get(reply.id);
      if (!request) return;
      this.pending.delete(reply.id);
      clearTimeout(request.timer);
      const elapsed = performance.now() - request.startedAt;
      this.roundTrip.count++;
      this.roundTrip.totalMs += elapsed;
      this.roundTrip.maxMs = Math.max(this.roundTrip.maxMs, elapsed);
      this.timing.count += reply.timing.count;
      this.timing.totalMs += reply.timing.totalMs;
      this.timing.maxMs = Math.max(this.timing.maxMs, reply.timing.maxMs);
      if (this.pending.size === 0) this.worker.unref();
      if (reply.ok) request.resolve(reply.value);
      else request.reject(reply.error);
    });
    this.worker.on('error', (error: unknown) =>
      this.fail(
        error instanceof Error ? error : new Error('outbox_worker_failed', { cause: error }),
      ),
    );
    this.worker.on('messageerror', (error: unknown) =>
      this.fail(new Error('outbox_worker_reply_invalid', { cause: error })),
    );
    this.worker.on('exit', (code) => this.fail(new Error(`outbox_worker_exited:${code}`)));
    this.worker.unref();
  }

  get failed(): boolean {
    return this.failure !== undefined;
  }

  get failureReason(): string | undefined {
    if (!this.failure) return undefined;
    return /^outbox_worker_(?:reply_timeout:[A-Za-z]+|reply_invalid|exited:[0-9]+)$/.test(
      this.failure.message,
    )
      ? this.failure.message
      : 'outbox_worker_failed';
  }

  takeTiming() {
    const sqlite = this.timing;
    const roundTrip = this.roundTrip;
    this.timing = { count: 0, totalMs: 0, maxMs: 0 };
    this.roundTrip = { count: 0, totalMs: 0, maxMs: 0 };
    return { sqlite, roundTrip };
  }

  request<K extends keyof OutboxOperations>(
    operation: K,
    ...args: Parameters<OutboxOperations[K]>
  ): Promise<ReturnType<OutboxOperations[K]>> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(new Error('outbox_worker_closed'));
    const id = ++this.nextId;
    this.worker.ref();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error(`outbox_worker_reply_timeout:${operation}`)),
        operation === 'load' ? LOAD_DEADLINE_MS : REPLY_DEADLINE_MS,
      );
      this.pending.set(id, { resolve, reject, timer, startedAt: performance.now() });
      try {
        this.worker.postMessage({ id, operation, args } as OutboxRequest);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        if (this.pending.size === 0) this.worker.unref();
        reject(error);
      }
    }) as Promise<ReturnType<OutboxOperations[K]>>;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    try {
      await this.request('close');
      this.closed = true;
    } finally {
      const stopped = this.stopWorker();
      if (!this.failed) await stopped;
    }
  }

  private stopWorker(): Promise<number> {
    this.termination ??= this.worker.terminate();
    // The caller records a failed or timed-out write even when termination also fails.
    void this.termination.catch(() => undefined);
    return this.termination;
  }

  private fail(error: Error): void {
    if (this.failure || this.closed) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.worker.unref();
    void this.stopWorker();
    this.onFailure?.(error);
  }
}
