import type { VerifiedPackContent } from '../../../packages/resource-pack-contract/content.mjs';
import type {
  ResourceTrustPolicy,
  ResourcePublication,
} from '../../../packages/resource-pack-contract/runtime.mjs';
export type {
  ResourceTrustPolicy,
  ResourcePublication,
} from '../../../packages/resource-pack-contract/runtime.mjs';
/** 实际 gh/Sigstore 验证成功后才返回；entries 即本次被冻结并核验的字节。 */
export function verifyResourcePublication(options: {
  statementPath: string;
  publicationBundlePath: string;
  archivePath: string;
  archiveBundlePath: string;
  policy: ResourceTrustPolicy;
}): Promise<VerifiedPackContent & { statement: ResourcePublication }>;
