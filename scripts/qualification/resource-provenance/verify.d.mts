import type { ResourceCompatibility } from '../../../packages/resource-pack-contract/index.mjs';
import type { VerifiedPackContent } from '../../asset-packs/pack.mjs';
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
/** 实际 gh/Sigstore 验证成功后才返回；entries 即本次被冻结并核验的字节。 */
export function verifyResourcePublication(options: {
  statementPath: string;
  publicationBundlePath: string;
  archivePath: string;
  archiveBundlePath: string;
  policy: ResourceTrustPolicy;
}): Promise<VerifiedPackContent & { statement: ResourcePublication }>;
