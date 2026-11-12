import { StableSource } from '../updates/source.js';
import { authenticatePublishedResource } from '../distribution/resources.js';
import { createActivePolicyVerifier } from '../resource-store/runtime-adapter.js';
import { PACK_ID } from '@mizar/resource-pack-contract';
import {
  getResourceAuthorization,
  verifyResourceCatalogReceipt,
} from '@mizar/resource-pack-contract/runtime';

/** Authenticate the existing Core update chain, then both original resource directory proofs. */
export async function authenticatePublishedBootstrap({
  version,
  expectedCore,
  tufCachePath,
  signal,
}) {
  const manifest = await new StableSource(tufCachePath).authenticateVersion(version, signal);
  if (
    manifest.version !== expectedCore.version ||
    manifest.gitSha !== expectedCore.gitSha ||
    manifest.installer.contentDigest !== expectedCore.contentDigest ||
    manifest.installer.sha256 !== expectedCore.sha256 ||
    manifest.installer.bytes !== expectedCore.bytes
  )
    throw new Error('Published NSIS differs from the fixed native qualification identity');
  const result = await authenticatePublishedResource({
    core: { appVersion: manifest.version, gitSha: manifest.gitSha },
    tufCachePath,
    signal,
  });
  if (getResourceAuthorization(result.authorization).core.archiveSha256 !== expectedCore.coreSha256)
    throw new Error('Published Core archive differs from the fixed native qualification identity');
  return result;
}

/** Read dual-proof policy from the unique Store's receipt without any network or extra cache. */
export async function restoreResourceAuthorization({ store, expectedCore, signal }) {
  let authorization;
  const active = await store.reuseActive(
    PACK_ID,
    async ({ receipt, signal: storeSignal }) => {
      authorization = await verifyResourceCatalogReceipt({
        receipt: receipt.catalog,
        expectedCore,
        purpose: 'cache',
        signal: storeSignal,
      });
      return createActivePolicyVerifier(
        getResourceAuthorization(authorization).policy,
        authorization,
      )({
        receipt,
        signal: storeSignal,
      });
    },
    { signal },
  );
  if (!active) throw new Error('Authenticated official resource cache is unavailable');
  return authorization;
}
