import { createHash } from 'node:crypto';
import {
  RESOURCE_ASSET_NAMES as names,
  getResourceAuthorization,
  verifyResourceCatalogBytes,
  verifyCatalogResourceMetadata,
  verifyCatalogResourcePublicationBytes,
  type ResourceCatalogCorePin,
} from '@mizar/resource-pack-contract/runtime';
import { createResourceOriginalDownloader, downloadResourceArchive } from './resource-transport.js';

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
export async function authenticatePublishedResource(options: PublishedResourceOptions) {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(600_000)]);
  const fetcher = options.fetcher ?? globalThis.fetch;
  const version = options.core.appVersion;
  const downloadResourceOriginal = createResourceOriginalDownloader();
  const download = (name: string, maximum: number, attempt: AbortSignal) =>
    downloadResourceOriginal({
      version,
      name,
      maximum,
      signal: attempt,
      fetcher,
    });
  const authenticate = async () => {
    const descriptorBytes = await download(names.descriptor, 65536, signal);
    const descriptorBundleBytes = await download(names.descriptorQualification, 2097152, signal);
    const catalogBytes = await download(names.catalog, 65536, signal);
    const catalogBundleBytes = await download(names.catalogPromotion, 2097152, signal);
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
  const authorization = await authenticate();
  const identity = getResourceAuthorization(authorization);
  const loadVerified = async (downloadSignal: AbortSignal = signal) => {
    const attempt = AbortSignal.any([signal, downloadSignal]);
    const prefix = `https://github.com/Starfie1d1272/Mizar/releases/download/v${version}/`;
    const metadata = async (name: string, maximum: number) => {
      if (identity.assets[name] !== prefix + name)
        throw new Error('Canonical resource origin changed');
      return download(name, maximum, attempt);
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
      onProgress: options.onProgress,
    });
    return verifyCatalogResourcePublicationBytes({ ...inputs, archiveBytes });
  };
  return { authorization, loadVerified };
}
