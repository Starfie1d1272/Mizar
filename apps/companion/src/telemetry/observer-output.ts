import type { Readable } from 'node:stream';
import type { ObserverSourceManager } from './cstv-source-manager.js';
import type { GameEventSourceRole } from '@mizar/core/game-events';

const MAX_LINE_BYTES = 64 * 1024;

/** Consume only an already-owned observer stdout pipe; never opens paths or launches a process. */
export async function consumeObserverOutput<R extends GameEventSourceRole>(
  stream: Readable,
  manager: ObserverSourceManager<R>,
  signal?: AbortSignal,
): Promise<{ status: 'ended' | 'cancelled' | 'failed'; parsedRecords: number }> {
  let pending = Buffer.alloc(0);
  let parsedRecords = 0;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const abort = (): void => {
    stream.destroy();
  };
  const consume = (line: Uint8Array): void => {
    if (line.byteLength === 0) return;
    if (line.byteLength > MAX_LINE_BYTES) throw new Error('Observer record budget');
    const record: unknown = JSON.parse(decoder.decode(line));
    manager.consumeObserverRecord(record);
    parsedRecords += 1;
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) {
      abort();
      return { status: 'cancelled', parsedRecords };
    }
    for await (const value of stream) {
      const chunk: unknown = value;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength > MAX_LINE_BYTES) {
        throw new Error('Observer input budget');
      }
      pending = Buffer.concat([pending, chunk]);
      let end: number;
      while ((end = pending.indexOf(10)) !== -1) {
        consume(pending.subarray(0, end));
        pending = pending.subarray(end + 1);
      }
      if (pending.byteLength > MAX_LINE_BYTES) throw new Error('Observer record budget');
    }
    if (signal?.aborted) return { status: 'cancelled', parsedRecords };
    consume(pending);
    return { status: 'ended', parsedRecords };
  } catch {
    stream.destroy();
    return { status: signal?.aborted ? 'cancelled' : 'failed', parsedRecords };
  } finally {
    signal?.removeEventListener('abort', abort);
    manager.disconnectObserver();
  }
}
