import { z } from 'zod';

export const UPDATE_REPOSITORY = 'Starfie1d1272/Mizar';
export const UPDATE_WORKFLOW = `https://github.com/${UPDATE_REPOSITORY}/.github/workflows/release-qualification.yml@refs/heads/main`;
export const PUBLICATION_WORKFLOW = `https://github.com/${UPDATE_REPOSITORY}/.github/workflows/release-promotion.yml@refs/heads/main`;
export const RELEASES_URL = `https://github.com/${UPDATE_REPOSITORY}/releases`;
export const MIRROR_SHARE = '91dec4c27e5d47f38fcf';
// Public distribution credential: the Mizar library contains public releases only,
// and the server grants this dedicated token read permission (r). It is not a signing key.
export const BOX_READ_TOKEN = 'b88f62e59ca365d27ccb48f55dfef3a78965341f';
export const MIRROR_URL = `https://box.nju.edu.cn/d/${MIRROR_SHARE}/?p=/Downloads`;
export const UPDATE_MAX_BYTES = 512 * 1024 * 1024;
const stable = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function versionParts(version: string): number[] {
  if (!stable.test(version)) throw new Error('update_version_invalid');
  const parts = version.split('.').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error('update_version_invalid');
  return parts;
}
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a),
    y = versionParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}
const version = z
  .string()
  .regex(stable)
  .refine((v) => {
    try {
      versionParts(v);
      return true;
    } catch {
      return false;
    }
  });
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const updatePublicationSchema = z.strictObject({
  schemaVersion: z.literal('mizar.update-publication.v1'),
  repository: z.literal(UPDATE_REPOSITORY),
  version,
  gitSha: z.string().regex(/^[a-f0-9]{40}$/),
  manifestSha256: digest,
  releaseId: z.number().int().positive(),
  publishedAt: z.iso.datetime(),
  promotionSha: z.string().regex(/^[a-f0-9]{40}$/),
});
export const updateManifestSchema = z
  .strictObject({
    schemaVersion: z.literal('mizar.update.v1'),
    repository: z.literal(UPDATE_REPOSITORY),
    channel: z.literal('stable'),
    version,
    gitSha: z.string().regex(/^[a-f0-9]{40}$/),
    coreArchiveSha256: digest.optional(),
    notes: z.string().min(1).max(48_000),
    compatibility: z.strictObject({ minimumVersion: version, maximumVersionExclusive: version }),
    installer: z.strictObject({
      platform: z.literal('win32-x64'),
      format: z.literal('nsis-setup'),
      name: z.string().regex(/^Mizar-v\d+\.\d+\.\d+-Windows-x64-(?:Core-)?Setup\.exe$/),
      bytes: z.number().int().positive().max(UPDATE_MAX_BYTES),
      sha256: digest,
      contentDigest: digest,
    }),
  })
  .superRefine((m, context) => {
    if (
      m.installer.name !==
        `Mizar-v${m.version}-Windows-x64-${m.coreArchiveSha256 ? 'Core-' : ''}Setup.exe` ||
      compareVersions(m.compatibility.minimumVersion, m.compatibility.maximumVersionExclusive) >=
        0 ||
      compareVersions(m.version, m.compatibility.minimumVersion) < 0 ||
      compareVersions(m.version, m.compatibility.maximumVersionExclusive) >= 0
    )
      context.addIssue({ code: 'custom', message: 'update_identity_invalid' });
  });
export type UpdateManifest = z.infer<typeof updateManifestSchema>;
export function isCompatible(current: string, manifest: UpdateManifest): boolean {
  // A prerelease can move to its Stable release, but is never an offered target.
  const base = /^(\d+\.\d+\.\d+)(?:-(?:alpha|beta|rc)\.[1-9]\d*)?$/.exec(current)?.[1];
  return Boolean(
    base &&
    compareVersions(base, manifest.compatibility.minimumVersion) >= 0 &&
    compareVersions(base, manifest.compatibility.maximumVersionExclusive) < 0,
  );
}
