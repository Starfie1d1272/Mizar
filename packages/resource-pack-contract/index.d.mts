export interface ResourceCompatibility {
  resourceSchemaVersion: 1;
  minimumCoreVersion: string;
  maximumCoreVersionExclusive: string;
}
export interface ResourcePackFile {
  path: string;
  bytes: number;
  sha256: string;
}
export interface ResourcePackManifest {
  schemaVersion: 1;
  packId: 'official:epl-default';
  packVersion: string;
  compatibility: ResourceCompatibility;
  contentKind: 'recorded-replay';
  source: { repository: 'Starfie1d1272/Mizar'; gitSha: string };
  totalBytes: number;
  files: ResourcePackFile[];
}
export interface ArchiveIdentity {
  format: 'zip';
  bytes: number;
  sha256: string;
}
export const PACK_ID: 'official:epl-default';
export const LIMITS: Readonly<{
  files: number;
  fileBytes: number;
  totalBytes: number;
  archiveBytes: number;
  manifestBytes: number;
}>;
export const REPLAY_IDS: readonly string[];
export function requireValue(ok: unknown, message: string): asserts ok;
export function isSha256(value: unknown): boolean;
export function isSourceSha(value: unknown): boolean;
export function isVersion(value: unknown): boolean;
export function compareVersions(a: string, b: string): number;
export function assertResourcePath(path: unknown): string;
export function assertCompatibility(compatibility: unknown, coreVersion?: string): void;
export function parsePackManifest(
  value: unknown,
  options?: { coreVersion?: string },
): ResourcePackManifest;
