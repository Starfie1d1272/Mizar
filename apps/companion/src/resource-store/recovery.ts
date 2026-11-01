import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { LIMITS } from '@mizar/resource-pack-contract';
import {
  RESOURCE_ASSET_NAMES as names,
  getResourceAuthorization,
  verifyResourceCatalogBytes,
  verifyCatalogResourceMetadata,
  verifyCatalogResourcePublicationBytes,
  type ResourceCatalogCorePin,
} from '@mizar/resource-pack-contract/runtime';
import { boundedBytes, updateRequest } from '../updates/network.js';
import { ResourceStoreError, type PreparePack } from './contract.js';

/** Current Core identity comes from the authenticated product runtime, never the browser. */
export function prepareCurrentResource(core: ResourceCatalogCorePin, root: string): PreparePack {
  return async ({ directory, signal: operationSignal, onProgress }) => {
    const signal = AbortSignal.any([operationSignal, AbortSignal.timeout(600000)]);
    const prefix = `https://github.com/Starfie1d1272/Mizar/releases/download/v${core.appVersion}/`;
    const tufCachePath = join(root, 'tuf');
    let downloaded = 0;
    const download = async (name: string, maximum: number) => {
      try {
        const bytes = await boundedBytes(await updateRequest(prefix + name, signal), maximum);
        downloaded += bytes.length;
        onProgress(downloaded);
        return bytes;
      } catch (error) {
        signal.throwIfAborted();
        throw new ResourceStoreError('resource_download_failed', undefined, { cause: error });
      }
    };
    const descriptorBytes = await download(names.descriptor, 65536);
    const descriptorBundleBytes = await download(names.descriptorQualification, 2 * 1024 * 1024);
    const catalogBytes = await download(names.catalog, 65536);
    const catalogBundleBytes = await download(names.catalogPromotion, 2 * 1024 * 1024);
    let verified;
    try {
      const authorization = await verifyResourceCatalogBytes({
        descriptorBytes,
        descriptorBundleBytes,
        catalogBytes,
        catalogBundleBytes,
        expectedCore: core,
        tufCachePath,
        signal,
      });
      const identity = getResourceAuthorization(authorization);
      const statementBytes = await download(names.publication, 65536);
      const publicationBundleBytes = await download(names.publicationPromotion, 2 * 1024 * 1024);
      const archiveBundleBytes = await download(names.archiveQualification, 2 * 1024 * 1024);
      const inputs = {
        authorization,
        statementBytes,
        publicationBundleBytes,
        archiveBundleBytes,
        tufCachePath,
        signal,
      };
      await verifyCatalogResourceMetadata(inputs);
      const archiveBytes = await download(identity.archive.name, LIMITS.archiveBytes);
      verified = await verifyCatalogResourcePublicationBytes({ ...inputs, archiveBytes });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof ResourceStoreError) throw error;
      throw new ResourceStoreError('resource_trust_failed', undefined, { cause: error });
    }
    for (const file of verified.manifest.files) {
      signal.throwIfAborted();
      const path = join(directory, file.path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, verified.entries.get(file.path)!, { flag: 'wx', mode: 0o600 });
    }
    return verified.receipt;
  };
}
