import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';

const FIRST_BYTE_TIMEOUT = 15_000;
const STALL_TIMEOUT = 30_000;

/** Download each authenticated source to a fresh file and verify every byte before returning. */
export async function transfer(options: {
  target: string;
  bytes?: number;
  maxBytes?: number;
  sha256: string;
  integrityError?: string;
  signal: AbortSignal;
  sources: Array<(signal: AbortSignal) => Promise<Response>>;
  progress?: (bytes: number, source: number) => void;
  verifying?: () => void;
  fallback?: (error: unknown, source: number) => void;
}) {
  let lastError: unknown;
  for (const [index, source] of options.sources.entries()) {
    options.signal.throwIfAborted();
    options.progress?.(0, index);
    const timeout = new AbortController();
    const signal = AbortSignal.any([options.signal, timeout.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => timeout.abort(new Error('transfer_stalled')), ms);
    };
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let localError = false;
    let created = false;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      arm(FIRST_BYTE_TIMEOUT);
      const response = await source(signal);
      if (!response.ok || !response.body) throw new Error(`transfer_http_${response.status}`);
      const length = response.headers.get('content-length');
      if (
        (length && options.bytes !== undefined && Number(length) !== options.bytes) ||
        response.headers.get('content-type')?.includes('text/html')
      ) {
        await response.body.cancel();
        throw new Error(options.integrityError ?? 'transfer_integrity');
      }
      try {
        file = await open(options.target, 'wx', 0o600);
        created = true;
      } catch (error) {
        localError = true;
        throw error;
      }
      reader = response.body.getReader();
      const hash = createHash('sha256');
      let bytes = 0;
      for (;;) {
        const chunk = await reader.read();
        signal.throwIfAborted();
        if (chunk.done) break;
        if (!chunk.value.length) continue;
        arm(STALL_TIMEOUT);
        bytes += chunk.value.length;
        if (bytes > (options.bytes ?? options.maxBytes ?? 0))
          throw new Error(options.integrityError ?? 'transfer_integrity');
        hash.update(chunk.value);
        clearTimeout(timer);
        try {
          await file.writeFile(chunk.value);
        } catch (error) {
          localError = true;
          throw error;
        }
        options.progress?.(bytes, index);
        arm(STALL_TIMEOUT);
      }
      options.verifying?.();
      if (
        (options.bytes !== undefined && bytes !== options.bytes) ||
        hash.digest('hex') !== options.sha256
      )
        throw new Error(options.integrityError ?? 'transfer_integrity');
      try {
        await file.sync();
        signal.throwIfAborted();
        await file.close();
        file = undefined;
      } catch (error) {
        localError = true;
        throw error;
      }
      return;
    } catch (error) {
      lastError = error;
      if (file) {
        try {
          await file.close();
        } catch (closeError) {
          localError = true;
          lastError = new AggregateError([error, closeError], 'transfer_close_failed');
        }
      }
      try {
        if (created) await rm(options.target, { force: true });
      } catch (cleanup) {
        throw new AggregateError([lastError, cleanup], 'transfer_cleanup_failed', {
          cause: cleanup,
        });
      }
      options.signal.throwIfAborted();
      if (localError || index === options.sources.length - 1) throw lastError;
      options.fallback?.(lastError, index);
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => undefined);
    }
  }
  throw lastError;
}
