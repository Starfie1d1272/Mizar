import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { fetchHttps, validateHttpsUrl, type FetchLike } from './http.js';

const distributionConfigSchema = z.strictObject({
  githubReleaseProxies: z.array(z.string().url()).min(0),
  probe: z.strictObject({
    sampleBytes: z.number().int().positive(),
    timeoutMs: z.number().int().positive(),
  }),
  timeouts: z.strictObject({
    firstByteMs: z.number().int().positive(),
    stallMs: z.number().int().positive(),
    metadataMs: z.number().int().positive(),
  }),
});

export type DistributionConfig = z.infer<typeof distributionConfigSchema>;

let cachedConfig: DistributionConfig | undefined;

export function getDistributionConfig(): DistributionConfig {
  if (cachedConfig) return cachedConfig;
  const candidates = [
    new URL('./distribution.json', import.meta.url),
    new URL('../../../../config/distribution.json', import.meta.url),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const raw = readFileSync(candidate, 'utf8');
      cachedConfig = distributionConfigSchema.parse(JSON.parse(raw));
      return cachedConfig;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error('distribution_config_missing', { cause: lastError });
}

export interface DistributionSource {
  name: string;
  stage?: string;
  request: (signal: AbortSignal, rangeEnd?: number) => Promise<Response>;
}

export function buildGitHubReleaseSources(
  origin: string,
  extraSources: readonly DistributionSource[] = [],
  fetcher?: FetchLike | undefined,
): DistributionSource[] {
  const canonical = validateHttpsUrl(origin).href;
  const config = getDistributionConfig();
  const sources: DistributionSource[] = [
    {
      name: 'GitHub',
      stage: 'github_download',
      request: (signal, rangeEnd) =>
        fetchHttps(canonical, {
          signal,
          fetcher,
          ...(rangeEnd === undefined ? {} : { range: { end: rangeEnd } }),
        }),
    },
  ];
  for (const proxy of config.githubReleaseProxies) {
    const proxyUrl = validateHttpsUrl(proxy);
    const prefix = proxyUrl.href.replace(/\/+$/, '');
    sources.push({
      name: `GitHub 加速 (${proxyUrl.hostname})`,
      stage: 'proxy_download',
      request: (signal, rangeEnd) =>
        fetchHttps(`${prefix}/${canonical}`, {
          signal,
          fetcher,
          ...(rangeEnd === undefined ? {} : { range: { end: rangeEnd } }),
        }),
    });
  }
  sources.push(...extraSources);
  return sources;
}

export type SourceDiagnostic = {
  stage: 'probe' | 'selection';
  sourceIndex?: number;
  elapsedMs?: number;
  status?: number | undefined;
  rangeIgnored?: boolean;
  error?: unknown;
  orderIndices?: number[];
};

/** Measure a small prefix of the authenticated asset; this never authenticates its contents. */
export async function sourceOrder(
  expectedBytes: number,
  signal: AbortSignal,
  probes: Array<(signal: AbortSignal, end: number) => Promise<Response>>,
  report?: (diagnostic: SourceDiagnostic) => void,
): Promise<number[]> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || probes.length < 1) {
    throw new Error('source_probe_invalid');
  }
  const config = getDistributionConfig();
  const sample = Math.min(expectedBytes, config.probe.sampleBytes);
  const measured = await Promise.all(
    probes.map(async (probe, index) => {
      const started = performance.now();
      const attempt = AbortSignal.any([signal, AbortSignal.timeout(config.probe.timeoutMs)]);
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        abortListener = () => reject(attempt.reason);
        if (attempt.aborted) abortListener();
        else attempt.addEventListener('abort', abortListener, { once: true });
      });
      let status: number | undefined;
      try {
        const pending = probe(attempt, sample - 1);
        void pending.then(
          (response) => {
            if (attempt.aborted) void response.body?.cancel().catch(() => undefined);
          },
          () => undefined,
        );
        const response = await Promise.race([pending, aborted]);
        status = response.status;
        reader = response.body?.getReader();
        if (!reader || ![200, 206].includes(response.status)) {
          throw new Error(`probe_http_${response.status}`);
        }
        const encoding = response.headers.get('content-encoding');
        const type = response.headers.get('content-type') ?? '';
        if (encoding && encoding !== 'identity') throw new Error('probe_encoding_invalid');
        if (/text\/html/i.test(type)) throw new Error('probe_html');
        const length = response.headers.get('content-length');
        if (
          response.status === 206 &&
          response.headers.get('content-range') !== `bytes 0-${sample - 1}/${expectedBytes}`
        ) {
          throw new Error('probe_range_invalid');
        }
        if (response.status === 200 && length && Number(length) !== expectedBytes) {
          throw new Error('probe_size_invalid');
        }
        let bytes = 0;
        while (bytes < sample) {
          const chunk = await Promise.race([reader.read(), aborted]);
          attempt.throwIfAborted();
          if (chunk.done || !chunk.value.length) throw new Error('probe_incomplete');
          bytes += Math.min(chunk.value.length, sample - bytes);
        }
        const elapsed = performance.now() - started;
        report?.({
          stage: 'probe',
          sourceIndex: index,
          elapsedMs: elapsed,
          status,
          rangeIgnored: status === 200,
        });
        return { index, elapsed };
      } catch (error) {
        report?.({
          stage: 'probe',
          sourceIndex: index,
          elapsedMs: performance.now() - started,
          status,
          error,
        });
        return { index, elapsed: Infinity };
      } finally {
        if (abortListener) attempt.removeEventListener('abort', abortListener);
        void reader?.cancel().catch(() => undefined);
      }
    }),
  );
  signal.throwIfAborted();
  measured.sort((a, b) => a.elapsed - b.elapsed || a.index - b.index);
  const orderIndices = measured.map((item) => item.index);
  report?.({ stage: 'selection', orderIndices: [...orderIndices] });
  return orderIndices;
}
