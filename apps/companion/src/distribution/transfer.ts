import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { boundedBytes, type FetchLike } from './http.js';
import {
  buildGitHubReleaseSources,
  forgetSourceOrder,
  getDistributionConfig,
  sourceOrder,
  type DistributionSource,
  type SourceDiagnostic,
} from './sources.js';

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
}): Promise<{ sourceIndex: number; bytes: number }> {
  const { firstByteMs, stallMs } = getDistributionConfig().timeouts;
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
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      arm(firstByteMs);
      response = await source(signal);
      if (!response.ok || !response.body) throw new Error(`transfer_http_${response.status}`);
      const length = response.headers.get('content-length');
      if (
        (length && options.bytes !== undefined && Number(length) !== options.bytes) ||
        response.headers.get('content-type')?.toLowerCase().includes('text/html')
      ) {
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
        arm(stallMs);
        bytes += chunk.value.length;
        if (bytes > (options.bytes ?? options.maxBytes ?? 0)) {
          throw new Error(options.integrityError ?? 'transfer_integrity');
        }
        hash.update(chunk.value);
        clearTimeout(timer);
        try {
          await file.writeFile(chunk.value);
        } catch (error) {
          localError = true;
          throw error;
        }
        options.progress?.(bytes, index);
        arm(stallMs);
      }
      options.verifying?.();
      if (
        (options.bytes !== undefined && bytes !== options.bytes) ||
        hash.digest('hex') !== options.sha256
      ) {
        throw new Error(options.integrityError ?? 'transfer_integrity');
      }
      try {
        await file.sync();
        signal.throwIfAborted();
        await file.close();
        file = undefined;
      } catch (error) {
        localError = true;
        throw error;
      }
      return { sourceIndex: index, bytes };
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
      } catch (cleanupError) {
        throw new AggregateError([lastError, cleanupError], 'transfer_cleanup_failed', {
          cause: cleanupError,
        });
      }
      options.signal.throwIfAborted();
      if (localError || index === options.sources.length - 1) throw lastError;
      options.fallback?.(lastError, index);
    } finally {
      clearTimeout(timer);
      if (reader) await reader.cancel().catch(() => undefined);
      else await response?.body?.cancel().catch(() => undefined);
    }
  }
  throw lastError;
}

export interface DownloadVerifiedAssetOptions {
  origin: string;
  target: string;
  bytes?: number;
  maxBytes?: number;
  sha256: string;
  integrityError?: string;
  extraSources?: readonly DistributionSource[];
  fetcher?: FetchLike | undefined;
  signal: AbortSignal;
  cacheKey?: string;
  onProgress?: (bytes: number, source: DistributionSource, sourceIndex: number) => void;
  onVerifying?: (source: DistributionSource) => void;
  onFallback?: (error: unknown, source: DistributionSource, sourceIndex: number) => void;
  onDiagnostic?: (
    diagnostic: SourceDiagnostic & {
      candidates: string[];
      sourceName?: string | undefined;
      orderNames?: string[] | undefined;
    },
  ) => void;
}

export async function downloadVerifiedAsset(
  options: DownloadVerifiedAssetOptions,
): Promise<{ source: DistributionSource; bytes: number }> {
  const sources = buildGitHubReleaseSources(
    options.origin,
    options.extraSources ?? [],
    options.fetcher,
  );
  const key =
    options.cacheKey ??
    `asset:${options.origin}:${options.sha256}:${options.bytes ?? 0}:${sources.map((s) => s.name).join(',')}`;

  const shouldProbe = options.bytes !== undefined && sources.length > 1;
  const order = shouldProbe
    ? await sourceOrder(
        key,
        options.bytes!,
        options.signal,
        sources.map((s) => s.request),
        (diagnostic) =>
          options.onDiagnostic?.({
            ...diagnostic,
            candidates: sources.map((entry) => entry.name),
            sourceName:
              diagnostic.source === undefined ? undefined : sources[diagnostic.source]?.name,
            orderNames: diagnostic.order?.map((idx) => sources[idx]!.name),
          }),
      )
    : sources.map((_, idx) => idx);

  let currentSource = sources[order[0]!]!;
  try {
    const result = await transfer({
      target: options.target,
      ...(options.bytes === undefined ? {} : { bytes: options.bytes }),
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      sha256: options.sha256,
      ...(options.integrityError === undefined ? {} : { integrityError: options.integrityError }),
      signal: options.signal,
      sources: order.map((idx) => (attempt) => sources[idx]!.request(attempt)),
      progress: (bytes, orderedIndex) => {
        currentSource = sources[order[orderedIndex]!]!;
        options.onProgress?.(bytes, currentSource, orderedIndex);
      },
      verifying: () => {
        options.onVerifying?.(currentSource);
      },
      fallback: (error, orderedIndex) => {
        const failed = sources[order[orderedIndex]!]!;
        if (shouldProbe) forgetSourceOrder(key);
        options.onFallback?.(error, failed, orderedIndex);
      },
    });
    return { source: sources[order[result.sourceIndex]!]!, bytes: result.bytes };
  } catch (error) {
    if (!options.signal.aborted && shouldProbe) forgetSourceOrder(key);
    throw error;
  }
}

export interface FetchVerifiedMetadataOptions<T> {
  origin: string;
  maxBytes: number;
  signal: AbortSignal;
  verify: (bytes: Buffer, attemptSignal: AbortSignal) => Promise<T> | T;
  extraSources?: readonly DistributionSource[];
  fetcher?: FetchLike | undefined;
  onDiagnostic?: (
    stage: 'metadata_attempt' | 'metadata_fallback' | 'metadata_verified',
    detail: { source: DistributionSource; index: number; error?: unknown },
  ) => void;
}

export async function fetchVerifiedMetadata<T>(
  options: FetchVerifiedMetadataOptions<T>,
): Promise<T> {
  const sources = buildGitHubReleaseSources(
    options.origin,
    options.extraSources ?? [],
    options.fetcher,
  );
  const { metadataMs } = getDistributionConfig().timeouts;
  const failures: unknown[] = [];

  for (const [index, source] of sources.entries()) {
    options.signal.throwIfAborted();
    const attemptSignal = AbortSignal.any([options.signal, AbortSignal.timeout(metadataMs)]);
    try {
      options.onDiagnostic?.('metadata_attempt', { source, index });
      const response = await source.request(attemptSignal);
      const bytes = await boundedBytes(response, options.maxBytes);
      const verified = await options.verify(bytes, options.signal);
      options.onDiagnostic?.('metadata_verified', { source, index });
      return verified;
    } catch (error) {
      options.signal.throwIfAborted();
      failures.push(error);
      options.onDiagnostic?.('metadata_fallback', { source, index, error });
    }
  }

  throw new AggregateError(failures, 'distribution_metadata_failed', {
    cause: failures.at(-1),
  });
}
