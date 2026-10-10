import { createHash } from 'node:crypto';

// Shared validation only; importing the contract never runs a release CLI.
export function assertPublication(publication, manifestBytes, manifest) {
  if (!(
    publication.schemaVersion === 'mizar.update-publication.v1' &&
    publication.repository === 'Starfie1d1272/Mizar' &&
    publication.version === manifest.version &&
    publication.gitSha === manifest.gitSha &&
    publication.manifestSha256 === createHash('sha256').update(manifestBytes).digest('hex') &&
    /^[a-f0-9]{40}$/.test(publication.promotionSha) &&
    Number.isSafeInteger(publication.releaseId) &&
    publication.releaseId > 0 &&
    typeof publication.publishedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(publication.publishedAt) &&
    Number.isFinite(Date.parse(publication.publishedAt))
  ))
    throw new Error('正式发布确认与更新清单不一致');
}
