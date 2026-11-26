import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadVerifiedAsset, fetchVerifiedMetadata } from './transfer.js';
import { errorEvidence } from '../updates/diagnostics.js';
import {
  MACHINE_METADATA_MAX_BYTES,
  MACHINE_METADATA_NAME,
  readMachineFile,
} from '@mizar/resource-pack-contract/transport';
import {
  RESOURCE_ASSET_NAMES,
  type ResourceCatalogIdentity,
} from '@mizar/resource-pack-contract/runtime';

export function logBootstrapFallback(stage: string, error: unknown) {
  process.stderr.write(`${JSON.stringify({ stage, error: errorEvidence(error) })}\n`);
}

const fixedNames = new Set(Object.values(RESOURCE_ASSET_NAMES));

export function validateResourceAsset(version: string, name: string) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.[1-9]\d*)?$/.test(version) ||
    !(
      fixedNames.has(name) ||
      /^Mizar-official-epl-default-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.zip$/.test(name)
    )
  ) {
    throw new Error('resource_mirror_path_invalid');
  }
}

// Transport only. Original canonical catalog URLs and all publisher claims stay
// unchanged; the existing SDK authenticates the returned original bytes.
/** A transaction-local byte cache, not an authorization or persistent trust cache. */
export function createResourceOriginalDownloader() {
  const carriers = new Map<string, Buffer>();
  return (options: Parameters<typeof downloadResourceOriginal>[0]) =>
    downloadResourceOriginal(options, carriers);
}

async function downloadResourceOriginal(
  {
    version,
    name,
    maximum,
    signal,
    fetcher,
  }: {
    version: string;
    name: string;
    maximum: number;
    signal: AbortSignal;
    fetcher?: typeof fetch;
  },
  carriers: Map<string, Buffer>,
) {
  validateResourceAsset(version, name);
  if (!fixedNames.has(name)) throw new Error('resource_metadata_name_invalid');
  const extract = (bytes: Buffer) => {
    const original = readMachineFile(bytes, name);
    if (original.length > maximum) throw new Error('resource_metadata_size_invalid');
    return original;
  };
  const key = version;
  const cached = carriers.get(key);
  signal.throwIfAborted();
  if (cached) return extract(cached);

  return fetchVerifiedMetadata<Buffer>({
    origin: `https://github.com/Starfie1d1272/Mizar/releases/download/v${version}/${MACHINE_METADATA_NAME}`,
    maxBytes: MACHINE_METADATA_MAX_BYTES,
    signal,
    fetcher,
    verify: (bytes) => {
      const original = extract(bytes);
      carriers.set(key, bytes);
      return original;
    },
    onDiagnostic: (stage, { index, error }) => {
      if (stage === 'metadata_fallback') {
        logBootstrapFallback(
          index === 0 ? 'github_metadata_fallback' : 'proxy_metadata_failed',
          error,
        );
      }
    },
  });
}

/** Only the already authenticated catalog identity can enter this archive transport. */
export async function downloadResourceArchive({
  version,
  archive,
  signal,
  fetcher,
  onProgress,
}: {
  version: string;
  archive: ResourceCatalogIdentity['archive'];
  signal: AbortSignal;
  fetcher?: typeof fetch;
  onProgress?: ((bytes: number) => void) | undefined;
}) {
  validateResourceAsset(version, archive.name);
  const origin = `https://github.com/Starfie1d1272/Mizar/releases/download/v${version}/${archive.name}`;
  const log = (stage: string, fields: Record<string, unknown> = {}) =>
    process.stderr.write(
      `${JSON.stringify({
        stage,
        asset: archive.name,
        ...fields,
      })}\n`,
    );
  const directory = await mkdtemp(join(tmpdir(), 'mizar-resource-download-'));
  const target = join(directory, 'archive.zip');
  let selected: string | undefined;
  try {
    const result = await downloadVerifiedAsset({
      origin,
      target,
      bytes: archive.bytes,
      sha256: archive.sha256,
      integrityError: 'resource_archive_integrity',
      fetcher,
      signal,
      cacheKey: `epl:${origin}:${archive.sha256}:${archive.bytes}`,
      onDiagnostic: (diagnostic) =>
        log('resource_sources', {
          stage: diagnostic.stage,
          candidates: diagnostic.candidates,
          ...(diagnostic.elapsedMs === undefined ? {} : { elapsedMs: diagnostic.elapsedMs }),
          ...(diagnostic.status === undefined ? {} : { status: diagnostic.status }),
          ...(diagnostic.rangeIgnored === undefined
            ? {}
            : { rangeIgnored: diagnostic.rangeIgnored }),
          ...(diagnostic.cacheHit === undefined ? {} : { cacheHit: diagnostic.cacheHit }),
          ...(diagnostic.sourceName === undefined ? {} : { source: diagnostic.sourceName }),
          ...(diagnostic.orderNames === undefined ? {} : { order: diagnostic.orderNames }),
          ...(diagnostic.error === undefined ? {} : { error: errorEvidence(diagnostic.error) }),
        }),
      onProgress: (bytes, source) => {
        onProgress?.(bytes);
        selected = source.name;
        if (bytes === 0) log('resource_downloading', { source: selected });
      },
      onVerifying: (source) => {
        selected = source.name;
        log('resource_verifying', { source: selected });
      },
      onFallback: (error, source) => {
        log('resource_fallback', { source: source.name, error: errorEvidence(error) });
      },
    });
    selected = result.source.name;
    log('resource_verified', { source: selected, bytes: archive.bytes, sha256: archive.sha256 });
    return await readFile(target);
  } catch (error) {
    log('resource_download_failed', { source: selected, error: errorEvidence(error) });
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
