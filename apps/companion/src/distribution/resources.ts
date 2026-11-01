import { createHash } from 'node:crypto';
import {
  RESOURCE_ASSET_NAMES as names,
  getResourceAuthorization,
  verifyResourceCatalogBytes,
  verifyCatalogResourceMetadata,
  verifyCatalogResourcePublicationBytes,
  type ResourceCatalogCorePin,
} from '@mizar/resource-pack-contract/runtime';
import {
  downloadResourceOriginal,
  downloadResourceArchive,
  logBootstrapFallback,
  type ResourceSourceMode,
} from './resource-transport.js';

export interface PublishedResourceOptions {
  /** Authenticated current Core, never a renderer-supplied identity. */
  core: ResourceCatalogCorePin;
  tufCachePath: string;
  signal: AbortSignal;
  fetcher?: typeof fetch;
  onProgress?: (bytes: number) => void;
}

/** Acquire and verify the current Core's resource publication; never opens or activates a Store. */
export async function fetchPublishedResource(options: PublishedResourceOptions) {
  const publication = await authenticatePublishedResource(options);
  return publication.loadVerified(options.signal);
}

/** Installer may verify/reuse its active cache before invoking the same publication loader. */
export async function authenticatePublishedResource(
  options: PublishedResourceOptions,
  sourceMode: ResourceSourceMode = 'auto',
) {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(600_000)]);
  const fetcher = options.fetcher ?? globalThis.fetch;
  const version = options.core.appVersion;
  const download = (
    name: string,
    maximum: number,
    attempt: AbortSignal,
    mode: ResourceSourceMode,
  ) =>
    downloadResourceOriginal({
      version,
      name,
      maximum,
      signal: attempt,
      fetcher,
      sourceMode: mode,
    });
  const authenticate = async (mode: ResourceSourceMode) => {
    const descriptorBytes = await download(names.descriptor, 65536, signal, mode);
    const descriptorBundleBytes = await download(
      names.descriptorQualification,
      2097152,
      signal,
      mode,
    );
    const catalogBytes = await download(names.catalog, 65536, signal, mode);
    const catalogBundleBytes = await download(names.catalogPromotion, 2097152, signal, mode);
    return verifyResourceCatalogBytes({
      descriptorBytes,
      descriptorBundleBytes,
      catalogBytes,
      catalogBundleBytes,
      expectedCore: options.core,
      tufCachePath: options.tufCachePath,
      signal,
    });
  };
  let authorization;
  try {
    authorization = await authenticate(sourceMode);
  } catch (error) {
    signal.throwIfAborted();
    if (sourceMode === 'github') throw error;
    logBootstrapFallback('resource catalog authentication fallback', error);
    sourceMode = 'github';
    try {
      authorization = await authenticate(sourceMode);
    } catch (canonicalError) {
      throw new AggregateError([error, canonicalError], 'Resource catalog authentication failed', {
        cause: canonicalError,
      });
    }
  }
  const identity = getResourceAuthorization(authorization);
  const loadVerified = async (downloadSignal: AbortSignal = signal) => {
    const attempt = AbortSignal.any([signal, downloadSignal]);
    const mode = sourceMode;
    const prefix = `https://github.com/Starfie1d1272/Mizar/releases/download/v${version}/`;
    const metadata = async (name: string, maximum: number) => {
      if (identity.assets[name] !== prefix + name)
        throw new Error('Canonical resource origin changed');
      return download(name, maximum, attempt, mode);
    };
    const archiveBundleBytes = await metadata(names.archiveQualification, 2097152);
    const statementBytes = await metadata(names.publication, 65536);
    if (createHash('sha256').update(statementBytes).digest('hex') !== identity.publication.sha256)
      throw new Error('Authenticated resource asset bytes changed');
    const publicationBundleBytes = await metadata(names.publicationPromotion, 2097152);
    const inputs = {
      authorization,
      archiveBundleBytes,
      statementBytes,
      publicationBundleBytes,
      tufCachePath: options.tufCachePath,
      signal: attempt,
    };
    await verifyCatalogResourceMetadata(inputs);
    const archiveBytes = await downloadResourceArchive({
      version,
      archive: identity.archive,
      signal: attempt,
      fetcher,
      sourceMode: mode,
      onProgress: options.onProgress,
    });
    return verifyCatalogResourcePublicationBytes({ ...inputs, archiveBytes });
  };
  return { authorization, loadVerified };
}
