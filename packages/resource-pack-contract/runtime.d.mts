import type { Buffer } from 'node:buffer';
import type { ResourceCompatibility } from './index.mjs';
import type { VerifiedPackContent } from './content.mjs';
export interface ResourceTrustPolicy {
  packVersion: string;
  sourceSha: string;
  promotionSha: string;
  coreVersion: string;
  minimumSequence: number;
  now: number;
}
export interface ResourcePublication {
  schemaVersion: 'mizar.resource-publication.v1';
  repository: 'Starfie1d1272/Mizar';
  packId: 'official:epl-default';
  packVersion: string;
  sourceRef: 'refs/heads/main';
  sourceSha: string;
  promotionSha: string;
  contentKind: 'recorded-replay';
  compatibility: ResourceCompatibility;
  manifestSha256: string;
  archive: VerifiedPackContent['archive'] & { name: string };
  sequence: number;
  issuedAt: string;
  expiresAt: string;
}
export function verifyResourcePublicationBytes(options: {
  statementBytes: Buffer;
  publicationBundleBytes: Buffer;
  archiveBytes: Buffer;
  archiveBundleBytes: Buffer;
  policy: ResourceTrustPolicy;
  tufCachePath: string;
  signal?: AbortSignal;
}): Promise<VerifiedPackContent & { statement: ResourcePublication; receipt: ResourceReceipt }>;

export interface ResourceReceipt {
  schemaVersion: 'mizar.resource-receipt.v1';
  manifestBase64: string;
  publicationBase64: string;
  publicationBundleBase64: string;
  archiveBundleBase64: string;
  trust: {
    schemaVersion: 'mizar.sigstore-cache.v1';
    rootChain: string[];
    targetsBase64: string;
    trustedRootBase64: string;
  };
}
export function verifyResourceReceipt(options: {
  receipt: unknown;
  manifestBytes?: Buffer;
  policy: ResourceTrustPolicy;
  purpose: 'install' | 'cache' | 'legacy' | 'rollback';
  tufCachePath?: string;
  signal?: AbortSignal;
}): Promise<import('./index.mjs').ResourcePackManifest>;
