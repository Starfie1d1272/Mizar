import {
  assertCompatibility,
  assertResourcePath,
  parsePackManifest,
  PACK_ID,
  REPLAY_IDS,
} from '@mizar/resource-pack-contract';
import {
  verifyResourceReceipt,
  type ResourceTrustPolicy,
} from '@mizar/resource-pack-contract/runtime';
import { createHash } from 'node:crypto';
import { ResourceStoreError, type StoreOptions, type ActivePackVerification } from './contract.js';
import { createManifestVerifier } from './manifest-adapter.js';

/** Policy pins come from authenticated Core/bootstrap inputs, never from the receipt or a mirror. */
export function createRuntimeVerifier(
  policy: ResourceTrustPolicy | undefined,
  history: readonly ResourceTrustPolicy[] = [],
  expectedCore?: { appVersion: string; gitSha: string },
): StoreOptions['verifyTrustedPack'] {
  const pinned = policy ? { ...policy } : undefined;
  const approved = [pinned, ...history.map((item) => ({ ...item }))].filter(
    (item): item is ResourceTrustPolicy => item !== undefined,
  );
  return createManifestVerifier(
    {
      parsePackManifest,
      assertResourcePath,
      assertCompatibility,
      verifyReceipt: ({ receipt, purpose, signal }) => {
        if (!pinned) {
          if (!expectedCore || !(receipt as { catalog?: unknown } | null)?.catalog)
            throw new ResourceStoreError('resource_policy_unavailable');
          return verifyResourceReceipt({ receipt, purpose, signal, expectedCore });
        }
        let selected = pinned;
        if (purpose === 'cache' || purpose === 'rollback') {
          const encoded = (receipt as { publicationBase64?: unknown } | null)?.publicationBase64;
          if (typeof encoded !== 'string' || encoded.length > 88 * 1024)
            throw new ResourceStoreError('resource_receipt_invalid');
          const version = (
            JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as { packVersion?: unknown }
          ).packVersion;
          // An untrusted field only selects an already approved pin; the SDK authenticates it.
          const match = approved.find((item) => item.packVersion === version);
          if (!match) throw new ResourceStoreError('resource_policy_unavailable');
          selected = match;
        }
        return verifyResourceReceipt({
          receipt,
          purpose,
          signal,
          policy: { ...selected, coreVersion: pinned.coreVersion, now: Date.now() },
          ...(expectedCore ? { expectedCore } : {}),
        });
      },
    },
    pinned?.coreVersion ?? expectedCore?.appVersion.replace(/-rc\.\d+$/, '') ?? '1.1.0',
  );
}

export { PACK_ID };

export interface ResourceIdentity {
  packId: string;
  packVersion: string;
  sourceSha: string;
  promotionSha: string;
  manifestSha256: string;
}

/** Verify current pins offline; historical cache pins cannot authorize an installer shortcut. */
export function createActivePolicyVerifier(
  policy: ResourceTrustPolicy,
): ActivePackVerification<ResourceIdentity> {
  const pinned = { ...policy };
  const verify = createRuntimeVerifier(pinned);
  return async ({ receipt, signal }) => {
    const descriptor = await verify({
      packId: PACK_ID,
      directory: '',
      receipt,
      signal,
      purpose: 'cache',
    });
    // The SDK has authenticated these exact manifest bytes and fixed policy pins above.
    const manifest = (receipt as { manifestBase64: string }).manifestBase64;
    return {
      descriptor,
      identity: {
        packId: descriptor.packId,
        packVersion: descriptor.packVersion,
        sourceSha: pinned.sourceSha,
        promotionSha: pinned.promotionSha,
        manifestSha256: createHash('sha256').update(Buffer.from(manifest, 'base64')).digest('hex'),
      },
    };
  };
}
export function isOfficialWebResource(path: string): boolean {
  return (
    REPLAY_IDS.some((id) => path.startsWith(`fixtures/${id}/`)) ||
    path.startsWith('fixture-media/epl-s24/')
  );
}
