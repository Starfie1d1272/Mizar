import {
  PACK_ID,
  LIMITS,
  isVersion,
  isSha256,
  isSourceSha,
  assertCompatibility,
  requireValue,
} from '../../../packages/resource-pack-contract/index.mjs';
export const REPOSITORY = 'Starfie1d1272/Mizar';
export const STATEMENT_SCHEMA = 'mizar.resource-publication.v1';
const instant = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
  new Date(value).toISOString() === value.replace('Z', '.000Z');

/** policy 来自安装器/本地受信任控制面，绝不能从待验证镜像反推。 */
export function parsePublication(value, policy) {
  requireValue(
    policy &&
      isVersion(policy.packVersion) &&
      isSourceSha(policy.sourceSha) &&
      isSourceSha(policy.promotionSha) &&
      isVersion(policy.coreVersion) &&
      Number.isFinite(policy.now),
    '缺少固定资源版本、源码、签发源码、Core 与时间策略',
  );
  requireValue(
    value &&
      value.schemaVersion === STATEMENT_SCHEMA &&
      value.repository === REPOSITORY &&
      value.packId === PACK_ID &&
      value.packVersion === policy.packVersion &&
      value.sourceSha === policy.sourceSha &&
      value.promotionSha === policy.promotionSha &&
      value.sourceRef === 'refs/heads/main' &&
      value.contentKind === 'recorded-replay',
    '发行声明身份不等于受信任策略',
  );
  assertCompatibility(value.compatibility, policy.coreVersion);
  requireValue(
    isSha256(value.manifestSha256) &&
      value.archive &&
      value.archive.name === `Mizar-official-epl-default-${value.packVersion}.zip` &&
      value.archive.format === 'zip' &&
      isSha256(value.archive.sha256) &&
      Number.isSafeInteger(value.archive.bytes) &&
      value.archive.bytes > 0 &&
      value.archive.bytes <= LIMITS.archiveBytes,
    '发行声明归档身份无效',
  );
  requireValue(
    Number.isSafeInteger(value.sequence) &&
      value.sequence > 0 &&
      Number.isSafeInteger(policy.minimumSequence) &&
      policy.minimumSequence >= 0 &&
      value.sequence >= policy.minimumSequence,
    '发行声明重放或序号无效',
  );
  requireValue(
    instant(value.issuedAt) &&
      instant(value.expiresAt) &&
      Date.parse(value.issuedAt) <= policy.now &&
      policy.now < Date.parse(value.expiresAt) &&
      Date.parse(value.expiresAt) > Date.parse(value.issuedAt) &&
      Date.parse(value.expiresAt) - Date.parse(value.issuedAt) <= 366 * 86400000,
    '发行声明过期、时间或有效期无效',
  );
  return value;
}
export function assertPublicationContent(statement, pack) {
  requireValue(
    statement.packId === pack.manifest.packId &&
      statement.packVersion === pack.manifest.packVersion &&
      statement.sourceSha === pack.manifest.source.gitSha &&
      statement.manifestSha256 === pack.manifestSha256 &&
      ['resourceSchemaVersion', 'minimumCoreVersion', 'maximumCoreVersionExclusive'].every(
        (key) => statement.compatibility[key] === pack.manifest.compatibility[key],
      ),
    '发行声明与资源清单身份不符',
  );
}
