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
  downloadResourceArchive,
  extractMachineFile,
  fetchVerifiedResourceCarrier,
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
export async function authenticatePublishedResource(options: PublishedResourceOptions) {
  const signal = options.signal;
  const fetcher = options.fetcher ?? globalThis.fetch;
  const version = options.core.appVersion;
  const prefix = `https://github.com/Starfie1d1272/Mizar/releases/download/v${version}/`;

  const verified = await fetchVerifiedResourceCarrier({
    version,
    signal,
    fetcher,
    verify: async (carrier, verifySignal) => {
      const authorization = await verifyResourceCatalogBytes({
        descriptorBytes: extractMachineFile(carrier, names.descriptor, 65536),
        descriptorBundleBytes: extractMachineFile(carrier, names.descriptorQualification, 2097152),
        catalogBytes: extractMachineFile(carrier, names.catalog, 65536),
        catalogBundleBytes: extractMachineFile(carrier, names.catalogPromotion, 2097152),
        expectedCore: options.core,
        tufCachePath: options.tufCachePath,
        signal: verifySignal,
      });
      const identity = getResourceAuthorization(authorization);
      const metadata = (name: string, maximum: number) => {
        if (identity.assets[name] !== prefix + name) {
          throw new Error('Canonical resource origin changed');
        }
        return extractMachineFile(carrier, name, maximum);
      };
      const archiveBundleBytes = metadata(names.archiveQualification, 2097152);
      const statementBytes = metadata(names.publication, 65536);
      if (
        createHash('sha256').update(statementBytes).digest('hex') !== identity.publication.sha256
      ) {
        throw new Error('Authenticated resource asset bytes changed');
      }
      const publicationBundleBytes = metadata(names.publicationPromotion, 2097152);
      const inputs = {
        authorization,
        archiveBundleBytes,
        statementBytes,
        publicationBundleBytes,
        tufCachePath: options.tufCachePath,
        signal: verifySignal,
      };
      await verifyCatalogResourceMetadata(inputs);
      return { authorization, identity, inputs };
    },
  });

  const loadVerified = async (downloadSignal: AbortSignal = signal) => {
    const attempt = AbortSignal.any([signal, downloadSignal]);
    const archiveBytes = await downloadResourceArchive({
      version,
      archive: verified.identity.archive,
      signal: attempt,
      fetcher,
      onProgress: options.onProgress,
    });
    return verifyCatalogResourcePublicationBytes({
      ...verified.inputs,
      signal: attempt,
      archiveBytes,
    });
  };
  return { authorization: verified.authorization, loadVerified };
}
