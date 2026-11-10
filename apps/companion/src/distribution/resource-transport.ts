import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceOrder, forgetSourceOrder } from './sources.js';
import { transfer } from './transfer.js';
import { errorEvidence } from '../updates/diagnostics.js';
import { MACHINE_METADATA_NAME, readMachineFile } from '@mizar/resource-pack-contract/transport';
import {
  RESOURCE_ASSET_NAMES,
  type ResourceCatalogIdentity,
} from '@mizar/resource-pack-contract/runtime';
import { updateRequest, githubMetadata } from '../updates/network.js';

export function logBootstrapFallback(stage: string, error: unknown) {
  process.stderr.write(`${JSON.stringify({ stage, error: errorEvidence(error) })}\n`);
}
const fixedNames = new Set(Object.values(RESOURCE_ASSET_NAMES));
export function mirrorResourcePath(version: string, name: string) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.[1-9]\d*)?$/.test(version) ||
    !(
      fixedNames.has(name) ||
      /^Mizar-official-epl-default-(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.zip$/.test(name)
    )
  )
    throw new Error('resource_mirror_path_invalid');
  return `/Resources/v${version}/${name}`;
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
  mirrorResourcePath(version, name);
  if (!fixedNames.has(name)) throw new Error('resource_metadata_name_invalid');
  const transportName = MACHINE_METADATA_NAME;
  const extract = (bytes: Buffer) => {
    const original = readMachineFile(bytes, name);
    if (original.length > maximum) throw new Error('resource_metadata_size_invalid');
    return original;
  };
  const key = version;
  const cached = carriers.get(key);
  signal.throwIfAborted();
  if (cached) return extract(cached);
  const remember = (bytes: Buffer) => {
    const original = extract(bytes);
    carriers.set(key, bytes);
    return original;
  };
  const deadline = globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(30000)]);
  return remember(
    await githubMetadata(
      `https://github.com/Starfie1d1272/Mizar/releases/download/v${version}/${transportName}`,
      deadline,
      fetcher,
      logBootstrapFallback,
    ),
  );
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
  mirrorResourcePath(version, archive.name);
  const origin = `https://github.com/Starfie1d1272/Mizar/releases/download/v${version}/${archive.name}`;
  const deadline = globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(300000)]);
  const sources = [
    {
      name: 'GitHub',
      request: (attempt: AbortSignal, end?: number) =>
        updateRequest(origin, attempt, fetcher, end === undefined ? undefined : { rangeEnd: end }),
    },
    {
      name: 'GitHub 加速',
      request: (attempt: AbortSignal, end?: number) =>
        updateRequest(`https://gh-proxy.com/${origin}`, attempt, fetcher, {
          proxyAsset: origin,
          ...(end === undefined ? {} : { rangeEnd: end }),
        }),
    },
  ];
  const key = `epl:${origin}:${archive.sha256}:${archive.bytes}:${sources.map((source) => source.name).join(',')}`;
  const log = (stage: string, fields: Record<string, unknown> = {}) =>
    process.stderr.write(
      `${JSON.stringify({
        stage,
        asset: archive.name,
        ...fields,
      })}\n`,
    );
  const order = await sourceOrder(
    key,
    archive.bytes,
    deadline,
    sources.map((source) => source.request),
    ({ error, source, order, ...diagnostic }) =>
      log('resource_sources', {
        ...diagnostic,
        candidates: sources.map((entry) => entry.name),
        source: source === undefined ? undefined : sources[source]!.name,
        order: order?.map((index) => sources[index]!.name),
        ...(error === undefined ? {} : { error: errorEvidence(error) }),
      }),
  );
  const directory = await mkdtemp(join(tmpdir(), 'mizar-resource-download-'));
  const target = join(directory, 'archive.zip');
  let selected: string | undefined;
  try {
    await transfer({
      target,
      bytes: archive.bytes,
      sha256: archive.sha256,
      signal: deadline,
      integrityError: 'resource_archive_integrity',
      sources: order.map((index) => (attempt) => sources[index]!.request(attempt)),
      progress: (bytes, index) => {
        onProgress?.(bytes);
        selected = sources[order[index]!]!.name;
        if (bytes === 0) log('resource_downloading', { source: selected });
      },
      verifying: () => log('resource_verifying', { source: selected }),
      fallback: (error) => {
        forgetSourceOrder(key);
        log('resource_fallback', { source: selected, error: errorEvidence(error) });
      },
    });
    log('resource_verified', { source: selected, bytes: archive.bytes, sha256: archive.sha256 });
    return await readFile(target);
  } catch (error) {
    if (!signal.aborted) forgetSourceOrder(key);
    log('resource_download_failed', { source: selected, error: errorEvidence(error) });
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
