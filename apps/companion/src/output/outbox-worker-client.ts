import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { OutboxOperations, OutboxReply, OutboxRequest } from './outbox-worker.js';

export class OutboxWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private nextId = 0;
  private failure: Error | undefined;
  private timing = { count: 0, totalMs: 0, maxMs: 0 };

  constructor(filePath: string) {
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

  takeTransactionTiming() {
    const timing = this.timing;
    this.timing = { count: 0, totalMs: 0, maxMs: 0 };
    return timing;
  }

  request<K extends keyof OutboxOperations>(
    operation: K,
    ...args: Parameters<OutboxOperations[K]>
  ): Promise<ReturnType<OutboxOperations[K]>> {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.nextId;
    this.worker.ref();
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, operation, args } as OutboxRequest);
      } catch (error) {
        this.pending.delete(id);
        if (this.pending.size === 0) this.worker.unref();
        reject(error);
      }
    }) as Promise<ReturnType<OutboxOperations[K]>>;
  }

  async close(): Promise<void> {
    try {
      if (!this.failed) await this.request('close');
    } finally {
      await this.worker.terminate();
    }
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const request of this.pending.values()) request.reject(this.failure);
    this.pending.clear();
    this.worker.unref();
  }
}
