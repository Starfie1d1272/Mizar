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
  authorization?: ResourceCatalogAuthorization;
  tufCachePath: string;
  signal?: AbortSignal;
}): Promise<VerifiedPackContent & { statement: ResourcePublication; receipt: ResourceReceipt }>;

export interface ResourceReceipt {
  schemaVersion: 'mizar.resource-receipt.v1';
  manifestBase64: string;
  publicationBase64: string;
  publicationBundleBase64: string;
  archiveBundleBase64: string;
  catalog?: ResourceCatalogReceipt;
  catalogHistory?: ResourceCatalogReceipt[];
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
  policy?: ResourceTrustPolicy;
  expectedCore?: ResourceCatalogCorePin;
  purpose: 'install' | 'cache' | 'legacy' | 'rollback';
  tufCachePath?: string;
  signal?: AbortSignal;
}): Promise<import('./index.mjs').ResourcePackManifest>;

export interface ResourceCatalogCorePin {
  appVersion: string;
  gitSha: string;
  archiveSha256?: string;
}
export interface ResourceCatalogReceipt {
  schemaVersion: 'mizar.resource-catalog-receipt.v1';
  descriptorBase64: string;
  descriptorBundleBase64: string;
  catalogBase64: string;
  catalogBundleBase64: string;
  trust: ResourceReceipt['trust'];
}
/** Opaque process-local handle, issued only after real fixed-root dual-proof authentication. */
export interface ResourceCatalogAuthorization {
  readonly schemaVersion: 'mizar.authenticated-resource-catalog.v1';
}
export interface ResourceCatalogIdentity {
  core: ResourceCatalogCorePin & { archive: string; archiveSha256: string };
  policy: ResourceTrustPolicy;
  manifestSha256: string;
  archive: ResourcePublication['archive'];
  publication: {
    name: string;
    sequence: number;
    issuedAt: string;
    expiresAt: string;
    sha256: string;
  };
  assets: Readonly<Record<string, string>>;
  descriptorSha256: string;
  origin?: {
    sourceSha: string;
    publication?: {
      promotionSha: string;
      sha256: string;
      sequence: number;
      issuedAt: string;
      expiresAt: string;
    };
  };
  authorization?: { sequence: number; issuedAt: string; expiresAt: string };
}
export function getResourceAuthorization(
  authorization: ResourceCatalogAuthorization,
): Readonly<ResourceCatalogIdentity>;
export function verifyResourceCatalogBytes(options: {
  descriptorBytes: Buffer;
  descriptorBundleBytes: Buffer;
  catalogBytes: Buffer;
  catalogBundleBytes: Buffer;
  expectedCore: ResourceCatalogCorePin;
  tufCachePath: string;
  signal?: AbortSignal;
}): Promise<ResourceCatalogAuthorization>;
export function verifyResourceCatalogReceipt(options: {
  receipt: unknown;
  expectedCore: ResourceCatalogCorePin;
  purpose?: 'install' | 'legacy' | 'cache' | 'rollback';
  tufCachePath?: string;
  signal?: AbortSignal;
}): Promise<ResourceCatalogAuthorization>;
export function verifyCatalogResourcePublicationBytes(options: {
  authorization: ResourceCatalogAuthorization;
  statementBytes: Buffer;
  publicationBundleBytes: Buffer;
  archiveBytes: Buffer;
  archiveBundleBytes: Buffer;
  tufCachePath: string;
  signal?: AbortSignal;
}): Promise<VerifiedPackContent & { statement: ResourcePublication; receipt: ResourceReceipt }>;

export const RESOURCE_ASSET_NAMES: Readonly<{
  descriptor: string;
  descriptorQualification: string;
  catalog: string;
  catalogPromotion: string;
  archiveQualification: string;
  publication: string;
  publicationPromotion: string;
}>;

export function authorizeCachedResource(options: {
  authorization: ResourceCatalogAuthorization;
  receipt: unknown;
  signal?: AbortSignal;
}): Promise<{ manifest: import('./index.mjs').ResourcePackManifest; receipt: ResourceReceipt }>;

export function verifyCatalogResourceMetadata(options: {
  authorization: ResourceCatalogAuthorization;
  statementBytes: Buffer;
  publicationBundleBytes: Buffer;
  archiveBundleBytes: Buffer;
  tufCachePath: string;
  signal?: AbortSignal;
}): Promise<ResourcePublication>;
