const SAMPLE_BYTES = 64 * 1024;
const PROBE_TIMEOUT = 3_000;
const CACHE_MS = 6 * 60 * 60_000;
const cache = new Map<string, { until: number; order: number[] }>();

export function forgetSourceOrder(key: string) {
  cache.delete(key);
}

/** Measure a small prefix of the authenticated asset; this never authenticates its contents. */
export async function sourceOrder(
  key: string,
  expectedBytes: number,
  signal: AbortSignal,
  probes: Array<(signal: AbortSignal, end: number) => Promise<Response>>,
): Promise<number[]> {
  signal.throwIfAborted();
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 1 ||
    probes.length < 1 ||
    probes.length > 3
  )
    throw new Error('source_probe_invalid');
  const cached = cache.get(key);
  if (cached && cached.until > Date.now() && cached.order.length === probes.length)
    return [...cached.order];
  const sample = Math.min(expectedBytes, SAMPLE_BYTES);
  const measured = await Promise.all(
    probes.map(async (probe, index) => {
      const started = performance.now();
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT)]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(attempt.reason);
        if (attempt.aborted) abortListener();
        else attempt.addEventListener('abort', abortListener, { once: true });
      });
      try {
        const pending = probe(attempt, sample - 1);
        void pending.then(
          (response) => {
            if (attempt.aborted) void response.body?.cancel().catch(() => undefined);
          },
          () => undefined,
        );
        const response = await Promise.race([pending, aborted]);
        reader = response.body?.getReader();
        if (!reader || ![200, 206].includes(response.status)) throw new Error('probe_failed');
        const encoding = response.headers.get('content-encoding');
        const type = response.headers.get('content-type') ?? '';
        if ((encoding && encoding !== 'identity') || /text\/html/i.test(type))
          throw new Error('probe_invalid');
        const length = response.headers.get('content-length');
        if (
          response.status === 206 &&
          response.headers.get('content-range') !== `bytes 0-${sample - 1}/${expectedBytes}`
        )
          throw new Error('probe_invalid');
        if (response.status === 200 && length && Number(length) !== expectedBytes)
          throw new Error('probe_invalid');
        let bytes = 0;
        while (bytes < sample) {
          const chunk = await Promise.race([reader.read(), aborted]);
          attempt.throwIfAborted();
          if (chunk.done || !chunk.value.length) throw new Error('probe_incomplete');
          bytes += Math.min(chunk.value.length, sample - bytes);
        }
        return { index, elapsed: performance.now() - started };
      } catch {
        return { index, elapsed: Infinity };
      } finally {
        if (abortListener) attempt.removeEventListener('abort', abortListener);
        void reader?.cancel().catch(() => undefined);
      }
    }),
  );
  signal.throwIfAborted();
  measured.sort((a, b) => a.elapsed - b.elapsed || a.index - b.index);
  const order = measured.map((item) => item.index);
  if (measured.some((item) => Number.isFinite(item.elapsed))) {
    if (cache.size >= 16) cache.delete(cache.keys().next().value!);
    cache.set(key, { until: Date.now() + CACHE_MS, order });
  }
  return order;
}
