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
      if (!(chunk instanceof Uint8Array)) throw new Error('Observer input type');
      let start = 0;
      let end: number;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        const part = chunk.subarray(start, end);
        if (pending.byteLength + part.byteLength + 1 > MAX_LINE_BYTES)
          throw new Error('Observer record budget');
        consume(pending.length ? Buffer.concat([pending, part]) : part);
        pending = Buffer.alloc(0);
        start = end + 1;
      }
      const tail = chunk.subarray(start);
      if (pending.byteLength + tail.byteLength >= MAX_LINE_BYTES)
        throw new Error('Observer record budget');
      pending = Buffer.concat([pending, tail]);
    }
    if (signal?.aborted) return { status: 'cancelled', parsedRecords };
    if (pending.length) throw new Error('Observer truncated record');
    return { status: 'ended', parsedRecords };
  } catch {
    stream.destroy();
    return { status: signal?.aborted ? 'cancelled' : 'failed', parsedRecords };
  } finally {
    signal?.removeEventListener('abort', abort);
    manager.disconnectObserver();
  }
}
