import type { Buffer } from 'node:buffer';
import type {
  ArchiveIdentity,
  ResourcePackManifest,
} from '../../packages/resource-pack-contract/index.mjs';
export interface VerifiedPackContent {
  manifest: ResourcePackManifest;
  manifestSha256: string;
  archive: ArchiveIdentity;
  entries: Map<string, Buffer>;
}
export function sha256(bytes: Uint8Array): string;
export function jsonBytes(value: unknown): Buffer;
/** 只证明完整性，不代表来源授权。 */
export function verifyPackBytes(
  archive: Buffer,
  options?: { coreVersion?: string; expectedArchive?: ArchiveIdentity },
): VerifiedPackContent;
export function buildOfficialPack(
  root: string,
  options: {
    packVersion: string;
    sourceSha: string;
    minimumCoreVersion?: string;
    maximumCoreVersionExclusive?: string;
  },
): Promise<VerifiedPackContent & { archiveBytes: Buffer }>;
