import type { VerifiedPackContent } from '../../packages/resource-pack-contract/content.mjs';
export {
  sha256,
  jsonBytes,
  verifyPackBytes,
  type VerifiedPackContent,
} from '../../packages/resource-pack-contract/content.mjs';
export function buildOfficialPack(
  root: string,
  options: {
    packVersion: string;
    sourceSha: string;
    minimumCoreVersion?: string;
    maximumCoreVersionExclusive?: string;
  },
): Promise<VerifiedPackContent & { archiveBytes: Buffer }>;
