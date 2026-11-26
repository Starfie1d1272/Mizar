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
  source?: string;
  order?: string[];
  elapsedMs?: number;
  status?: number | undefined;
  rangeIgnored?: boolean;
  error?: unknown;
};

export interface ProbeResult {
  elapsedMs: number;
  ok: boolean;
  status?: number | undefined;
  rangeIgnored?: boolean | undefined;
  contentType?: string | undefined;
  contentRange?: string | null | undefined;
  bytesReceived?: number | undefined;
  error?: unknown;
}

/** Probe a single candidate source with a bounded Range prefix. */
export async function probeSource(
  expectedBytes: number,
  signal: AbortSignal,
  source: DistributionSource,
  report?: (diagnostic: SourceDiagnostic) => void,
): Promise<ProbeResult> {
  const config = getDistributionConfig();
  const sample = Math.min(expectedBytes, config.probe.sampleBytes);
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
  let contentType: string | undefined;
  let contentRange: string | null | undefined;
  let bytes = 0;

  try {
    const pending = source.request(attempt, sample - 1);
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
    contentType = response.headers.get('content-type') ?? '';
    if (encoding && encoding !== 'identity') throw new Error('probe_encoding_invalid');
    if (/text\/html/i.test(contentType)) throw new Error('probe_html');
    const length = response.headers.get('content-length');
    contentRange = response.headers.get('content-range');
    if (response.status === 206 && contentRange !== `bytes 0-${sample - 1}/${expectedBytes}`) {
      throw new Error('probe_range_invalid');
    }
    if (response.status === 200 && length && Number(length) !== expectedBytes) {
      throw new Error('probe_size_invalid');
    }
    while (bytes < sample) {
      const chunk = await Promise.race([reader.read(), aborted]);
      attempt.throwIfAborted();
      if (chunk.done || !chunk.value.length) throw new Error('probe_incomplete');
      bytes += Math.min(chunk.value.length, sample - bytes);
    }
    const elapsedMs = Math.round(performance.now() - started);
    const rangeIgnored = status === 200;
    report?.({
      stage: 'probe',
      source: source.name,
      elapsedMs,
      status,
      rangeIgnored,
    });
    return {
      elapsedMs,
      ok: true,
      status,
      rangeIgnored,
      contentType,
      contentRange,
      bytesReceived: bytes,
    };
  } catch (error) {
    const elapsedMs = Math.round(performance.now() - started);
    report?.({
      stage: 'probe',
      source: source.name,
      elapsedMs,
      status,
      error,
    });
    return {
      elapsedMs,
      ok: false,
      status,
      contentType,
      contentRange,
      bytesReceived: bytes,
      error,
    };
  } finally {
    if (abortListener) attempt.removeEventListener('abort', abortListener);
    void reader?.cancel().catch(() => undefined);
  }
}

/** Measure a small prefix of each candidate source and return them ranked fastest-first. */
export async function sourceOrder(
  expectedBytes: number,
  signal: AbortSignal,
  sources: readonly DistributionSource[],
  report?: (diagnostic: SourceDiagnostic) => void,
): Promise<DistributionSource[]> {
  signal.throwIfAborted();
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || sources.length < 1) {
    throw new Error('source_probe_invalid');
  }
  const measured = await Promise.all(
    sources.map(async (source, index) => ({
      source,
      index,
      probe: await probeSource(expectedBytes, signal, source, report),
    })),
  );
  signal.throwIfAborted();
  measured.sort((a, b) => {
    if (a.probe.ok !== b.probe.ok) return a.probe.ok ? -1 : 1;
    const byTime = a.probe.elapsedMs - b.probe.elapsedMs;
    return byTime !== 0 ? byTime : a.index - b.index;
  });
  const ordered = measured.map((item) => item.source);
  report?.({ stage: 'selection', order: ordered.map((s) => s.name) });
  return ordered;
}
