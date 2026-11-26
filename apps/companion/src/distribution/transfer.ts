import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { boundedBytes, type FetchLike } from './http.js';
import {
  buildGitHubReleaseSources,
  getDistributionConfig,
  sourceOrder,
  type DistributionSource,
  type SourceDiagnostic,
} from './sources.js';

const OFFICIAL_METADATA_TIMEOUT_MS = 8_000;

export type FormattedSourceDiagnostic = SourceDiagnostic & {
  candidates: string[];
};

/** Download each authenticated source to a fresh file and verify every byte before returning. */
export async function transfer(options: {
  target: string;
  bytes?: number;
  maxBytes?: number;
  sha256: string;
  integrityError?: string;
  signal: AbortSignal;
  sources: readonly DistributionSource[];
  progress?: (bytes: number, source: DistributionSource, index: number) => void;
  verifying?: (source: DistributionSource) => void;
  fallback?: (error: unknown, source: DistributionSource, index: number) => void;
}): Promise<{ source: DistributionSource; bytes: number }> {
  const { firstByteMs, stallMs } = getDistributionConfig().timeouts;
  let lastError: unknown;
  for (const [index, source] of options.sources.entries()) {
    options.signal.throwIfAborted();
    options.progress?.(0, source, index);
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
      response = await source.request(signal);
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
        options.progress?.(bytes, source, index);
        arm(stallMs);
      }
      options.verifying?.(source);
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
      return { source, bytes };
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
      options.fallback?.(lastError, source, index);
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
  onProgress?: (bytes: number, source: DistributionSource, sourceIndex: number) => void;
  onVerifying?: (source: DistributionSource) => void;
  onFallback?: (error: unknown, source: DistributionSource, sourceIndex: number) => void;
  onDiagnostic?: (diagnostic: FormattedSourceDiagnostic) => void;
}

export async function downloadVerifiedAsset(
  options: DownloadVerifiedAssetOptions,
): Promise<{ source: DistributionSource; bytes: number }> {
  const sources = buildGitHubReleaseSources(
    options.origin,
    options.extraSources ?? [],
    options.fetcher,
  );
  const candidates = sources.map((entry) => entry.name);
  const orderedSources =
    options.bytes !== undefined && sources.length > 1
      ? await sourceOrder(options.bytes, options.signal, sources, (diagnostic) =>
          options.onDiagnostic?.({ ...diagnostic, candidates }),
        )
      : sources;

  return transfer({
    target: options.target,
    ...(options.bytes === undefined ? {} : { bytes: options.bytes }),
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
    sha256: options.sha256,
    ...(options.integrityError === undefined ? {} : { integrityError: options.integrityError }),
    signal: options.signal,
    sources: orderedSources,
    ...(options.onProgress === undefined ? {} : { progress: options.onProgress }),
    ...(options.onVerifying === undefined ? {} : { verifying: options.onVerifying }),
    ...(options.onFallback === undefined ? {} : { fallback: options.onFallback }),
  });
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

/**
 * Official-first (8s transport budget), then parallel proxy byte-fetch + serial verify:
 * transport timeouts apply only to HTTP + body read, never to verify(bytes, options.signal).
 */
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

  const official = sources[0]!;
  const officialTransportSignal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(Math.min(OFFICIAL_METADATA_TIMEOUT_MS, metadataMs)),
  ]);
  try {
    options.onDiagnostic?.('metadata_attempt', { source: official, index: 0 });
    const bytes = await boundedBytes(
      await official.request(officialTransportSignal),
      options.maxBytes,
    );
    const verified = await options.verify(bytes, options.signal);
    options.onDiagnostic?.('metadata_verified', { source: official, index: 0 });
    return verified;
  } catch (error) {
    options.signal.throwIfAborted();
    failures.push(error);
    options.onDiagnostic?.('metadata_fallback', { source: official, index: 0, error });
  }

  const proxies = sources.slice(1);
  if (proxies.length > 0) {
    const raceAbort = new AbortController();
    const proxyTransportSignal = AbortSignal.any([
      options.signal,
      raceAbort.signal,
      AbortSignal.timeout(metadataMs),
    ]);
    type FetchOutcome =
      | { slot: number; index: number; source: DistributionSource; ok: true; bytes: Buffer }
      | { slot: number; index: number; source: DistributionSource; ok: false; error: unknown };

    const pending = new Map<number, Promise<FetchOutcome>>();
    proxies.forEach((source, offset) => {
      const index = offset + 1;
      options.onDiagnostic?.('metadata_attempt', { source, index });
      const task = (async (): Promise<FetchOutcome> => {
        try {
          const bytes = await boundedBytes(
            await source.request(proxyTransportSignal),
            options.maxBytes,
          );
          return { slot: offset, index, source, ok: true, bytes };
        } catch (error) {
          return { slot: offset, index, source, ok: false, error };
        }
      })();
      pending.set(offset, task);
    });

    try {
      while (pending.size > 0) {
        const outcome = await Promise.race(pending.values());
        pending.delete(outcome.slot);
        options.signal.throwIfAborted();

        if (!outcome.ok) {
          failures.push(outcome.error);
          if (!raceAbort.signal.aborted) {
            options.onDiagnostic?.('metadata_fallback', {
              source: outcome.source,
              index: outcome.index,
              error: outcome.error,
            });
          }
          continue;
        }

        try {
          const verified = await options.verify(outcome.bytes, options.signal);
          raceAbort.abort();
          options.onDiagnostic?.('metadata_verified', {
            source: outcome.source,
            index: outcome.index,
          });
          return verified;
        } catch (error) {
          options.signal.throwIfAborted();
          failures.push(error);
          options.onDiagnostic?.('metadata_fallback', {
            source: outcome.source,
            index: outcome.index,
            error,
          });
        }
      }
    } finally {
      raceAbort.abort();
    }
  }

  throw new AggregateError(failures, 'distribution_metadata_failed', {
    cause: failures.at(-1),
  });
}
