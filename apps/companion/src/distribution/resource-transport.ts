import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sourceOrder, forgetSourceOrder } from './sources.js';
import { transfer } from './transfer.js';
import { errorEvidence } from '../updates/diagnostics.js';
import {
  MACHINE_METADATA_NAME,
  MACHINE_METADATA_MAX_BYTES,
  readMachineFile,
} from '@mizar/resource-pack-contract/transport';
import {
  RESOURCE_ASSET_NAMES,
  type ResourceCatalogIdentity,
} from '@mizar/resource-pack-contract/runtime';
import { updateJson, updateRequest, boundedBytes } from '../updates/network.js';

export function logBootstrapFallback(stage: string, error: unknown) {
  process.stderr.write(`${JSON.stringify({ stage, error: errorEvidence(error) })}\n`);
}
export type ResourceSourceMode = 'auto' | 'github';
const fixedNames = new Set(Object.values(RESOURCE_ASSET_NAMES));
export function mirrorResourcePath(version: string, name: string) {
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
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
export async function downloadResourceOriginal({
  version,
  name,
  maximum,
  signal,
  fetcher,
  sourceMode = 'auto',
}: {
  version: string;
  name: string;
  maximum: number;
  signal: AbortSignal;
  fetcher?: typeof fetch;
  sourceMode?: ResourceSourceMode;
}) {
  mirrorResourcePath(version, name);
  if (!fixedNames.has(name)) throw new Error('resource_metadata_name_invalid');
  const transportName = MACHINE_METADATA_NAME;
  const path = `/Runtime/v${version}/${transportName}`;
  const bound = MACHINE_METADATA_MAX_BYTES;
  const extract = (bytes: Buffer) => {
    const original = readMachineFile(bytes, name);
    if (original.length > maximum) throw new Error('resource_metadata_size_invalid');
    return original;
  };
  const deadline = globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(60000)]);
  try {
    if (sourceMode === 'github') throw new Error('resource_github_transport');
    const attempt = globalThis.AbortSignal.any([deadline, globalThis.AbortSignal.timeout(15000)]);
    const url = await resourceMirrorUrl(path, attempt, fetcher);
    // Never fall back after bytes have arrived and failed publisher verification.
    return extract(await boundedBytes(await updateRequest(url.href, deadline, fetcher), bound));
  } catch (mirrorError) {
    if (sourceMode !== 'github')
      logBootstrapFallback('resource mirror fallback ' + name, mirrorError);
    deadline.throwIfAborted();
    // All fallback bytes undergo the same sole SDK verification. No metadata,
    // pin or authority is taken from the failed mirror response.
    try {
      return extract(
        await boundedBytes(
          await updateRequest(
            `https://github.com/Starfie1d1272/Mizar/releases/download/v${version}/${transportName}`,
            deadline,
            fetcher,
          ),
          bound,
        ),
      );
    } catch (githubError) {
      if (sourceMode === 'github') throw githubError;
      throw new AggregateError(
        [mirrorError, githubError],
        'Resource mirror and canonical download both failed',
        { cause: githubError },
      );
    }
  }
}

async function resourceMirrorUrl(path: string, attempt: AbortSignal, fetcher?: typeof fetch) {
  const directory = await updateJson(
    `https://box.nju.edu.cn/api/v2.1/via-repo-token/dir/?path=${encodeURIComponent(path.slice(0, path.lastIndexOf('/')))}`,
    attempt,
    fetcher,
  );
  if (
    !directory ||
    typeof directory !== 'object' ||
    !('repo_name' in directory) ||
    directory.repo_name !== 'Mizar' ||
    !('user_perm' in directory) ||
    directory.user_perm !== 'r'
  )
    throw new Error('resource_mirror_permission_invalid');
  const link = await updateJson(
    `https://box.nju.edu.cn/api/v2.1/via-repo-token/download-link/?path=${encodeURIComponent(path)}`,
    attempt,
    fetcher,
    16384,
  );
  if (typeof link !== 'string' || link.length > 8192)
    throw new Error('resource_mirror_link_invalid');
  const url = new globalThis.URL(link);
  if (
    url.origin !== 'https://box.nju.edu.cn' ||
    url.username ||
    url.password ||
    url.hash ||
    !url.pathname.startsWith('/seafhttp/files/')
  )
    throw new Error('resource_mirror_link_invalid');
  return url;
}

/** Only the already authenticated catalog identity can enter this archive transport. */
export async function downloadResourceArchive({
  version,
  archive,
  signal,
  fetcher,
  sourceMode = 'auto',
  onProgress,
}: {
  version: string;
  archive: ResourceCatalogIdentity['archive'];
  signal: AbortSignal;
  fetcher?: typeof fetch;
  sourceMode?: ResourceSourceMode;
  onProgress?: ((bytes: number) => void) | undefined;
}) {
  const path = mirrorResourcePath(version, archive.name);
  const origin = `https://github.com/Starfie1d1272/Mizar/releases/download/v${version}/${archive.name}`;
  const deadline = globalThis.AbortSignal.any([signal, globalThis.AbortSignal.timeout(300000)]);
  const sources = [
    {
      name: 'GitHub',
      request: (attempt: AbortSignal, end?: number) =>
        updateRequest(origin, attempt, fetcher, end === undefined ? undefined : { rangeEnd: end }),
    },
    ...(sourceMode === 'github'
      ? []
      : [
          {
            name: 'GitHub 加速',
            request: (attempt: AbortSignal, end?: number) =>
              updateRequest(`https://gh-proxy.com/${origin}`, attempt, fetcher, {
                proxyAsset: origin,
                ...(end === undefined ? {} : { rangeEnd: end }),
              }),
          },
          {
            name: '南大云盘',
            request: async (attempt: AbortSignal, end?: number) =>
              updateRequest(
                (await resourceMirrorUrl(path, attempt, fetcher)).href,
                attempt,
                fetcher,
                end === undefined ? undefined : { rangeEnd: end },
              ),
          },
        ]),
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
