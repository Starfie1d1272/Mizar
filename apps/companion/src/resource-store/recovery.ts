import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ResourceCatalogCorePin } from '@mizar/resource-pack-contract/runtime';
import { fetchPublishedResource } from '../distribution/resources.js';
import { ResourceStoreError, type PreparePack } from './contract.js';

/** Current Core identity comes from the authenticated product runtime, never the browser. */
export function prepareCurrentResource(core: ResourceCatalogCorePin, root: string): PreparePack {
  return async ({ directory, signal: operationSignal, onProgress }) => {
    const signal = AbortSignal.any([operationSignal, AbortSignal.timeout(600000)]);
    let verified;
    try {
      verified = await fetchPublishedResource({
        core,
        tufCachePath: join(root, 'tuf'),
        signal,
        onProgress,
      });
    } catch (error) {
      signal.throwIfAborted();
      throw new ResourceStoreError('resource_preparation_failed', undefined, { cause: error });
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
