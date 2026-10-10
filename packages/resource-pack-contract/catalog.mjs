import { Buffer } from 'node:buffer';
import { LIMITS, PACK_ID, requireValue, isSourceSha, isSha256, isVersion } from './index.mjs';
import { jsonBytes, sha256 } from './content.mjs';
import { REPOSITORY } from './publication.mjs';

export const RESOURCE_ASSET_NAMES = Object.freeze({
  descriptor: 'resource-descriptor.json',
  descriptorQualification: 'resource-descriptor-qualification-provenance.json',
  catalog: 'resource-catalog.json',
  catalogPromotion: 'resource-catalog-promotion-provenance.json',
  archiveQualification: 'resource-pack-provenance.json',
  publication: 'resource-publication.json',
  publicationPromotion: 'resource-publication-provenance.json',
});
const instant = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
  new Date(value).toISOString() === value.replace('Z', '.000Z');
export function createResourceDescriptor({
  core,
  packVersion,
  archive,
  manifestSha256,
  sequence,
  issuedAt,
  expiresAt,
  assetReleaseTag = `v${core?.appVersion}`,
}) {
  const coreVersion = core?.appVersion?.replace(/-rc\.\d+$/, '');
  requireValue(
    isVersion(coreVersion) &&
      /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(core.appVersion) &&
      isSourceSha(core.gitSha) &&
      isSha256(core.archiveSha256) &&
      core.archive === `Mizar-v${core.appVersion}-Windows-x64.zip`,
    '资源目录 Core 身份无效',
  );
  requireValue(
    isVersion(packVersion) &&
      isSha256(manifestSha256) &&
      archive &&
      archive.name === `Mizar-official-epl-default-${packVersion}.zip` &&
      archive.format === 'zip' &&
      Number.isSafeInteger(archive.bytes) &&
      archive.bytes > 0 &&
      archive.bytes <= LIMITS.archiveBytes &&
      isSha256(archive.sha256),
    '资源目录归档身份无效',
  );
  requireValue(
    Number.isSafeInteger(sequence) &&
      sequence > 0 &&
      instant(issuedAt) &&
      instant(expiresAt) &&
      Date.parse(expiresAt) > Date.parse(issuedAt) &&
      Date.parse(expiresAt) - Date.parse(issuedAt) <= 366 * 86400000,
    '资源目录序号或有效期无效',
  );
  requireValue(
    [`v${core.appVersion}`, `data-v${core.appVersion}`].includes(assetReleaseTag),
    '资源资产发行标签无效',
  );
  const names = [archive.name, ...Object.values(RESOURCE_ASSET_NAMES)];
  const prefix = `https://github.com/${REPOSITORY}/releases/download/${assetReleaseTag}/`;
  return {
    schemaVersion: 'mizar.resource-descriptor.v1',
    repository: REPOSITORY,
    core: {
      appVersion: core.appVersion,
      gitSha: core.gitSha,
      archive: core.archive,
      archiveSha256: core.archiveSha256,
    },
    resources: [
      {
        packId: PACK_ID,
        policy: { packVersion, sourceSha: core.gitSha, coreVersion, minimumSequence: sequence },
        archive: {
          name: archive.name,
          bytes: archive.bytes,
          sha256: archive.sha256,
          format: 'zip',
        },
        manifestSha256,
        publication: { name: RESOURCE_ASSET_NAMES.publication, sequence, issuedAt, expiresAt },
        assets: Object.fromEntries(names.map((name) => [name, prefix + name])),
      },
    ],
  };
}
// Transport is restricted to the two exact release locations for this Core.
// Canonical reconstruction below also rejects missing/extra asset fields.
export function resourceAssetReleaseTag(descriptor) {
  const entry = descriptor?.resources?.[0];
  const version = descriptor?.core?.appVersion;
  requireValue(
    typeof version === 'string' &&
      /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/.test(version) &&
      isVersion(entry?.policy?.packVersion) &&
      entry?.archive?.name === `Mizar-official-epl-default-${entry.policy.packVersion}.zip`,
    '资源资产发行身份无效',
  );
  const assetNames = [entry.archive.name, ...Object.values(RESOURCE_ASSET_NAMES)];
  const tag = [`v${version}`, `data-v${version}`].find((candidate) =>
    assetNames.every(
      (name) =>
        entry?.assets?.[name] ===
        `https://github.com/${REPOSITORY}/releases/download/${candidate}/${name}`,
    ),
  );
  requireValue(tag, '资源资产地址必须绑定唯一受控发行标签');
  return tag;
}
export function createResourceCatalog(
  descriptor,
  descriptorBytes,
  promotionSha,
  publicationSha256,
) {
  requireValue(isSourceSha(promotionSha) && isSha256(publicationSha256), '资源晋级目录身份无效');
  const entry = descriptor.resources[0];
  return {
    ...descriptor,
    schemaVersion: 'mizar.resource-catalog.v1',
    descriptorSha256: sha256(descriptorBytes),
    promotionSha,
    resources: [
      {
        ...entry,
        policy: { ...entry.policy, promotionSha },
        publication: { ...entry.publication, sha256: publicationSha256 },
      },
    ],
  };
}
export function parseResourceCatalogBytes(descriptorBytes, catalogBytes, expectedCore) {
  for (const bytes of [descriptorBytes, catalogBytes])
    requireValue(
      Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 64 * 1024,
      '资源目录大小无效',
    );
  const raw = JSON.parse(descriptorBytes.toString('utf8'));
  requireValue(raw?.resources?.length === 1, '资源目录必须含唯一默认资源');
  const item = raw.resources[0];
  const descriptor = createResourceDescriptor({
    core: raw.core,
    assetReleaseTag: resourceAssetReleaseTag(raw),
    packVersion: item.policy?.packVersion,
    archive: item.archive,
    manifestSha256: item.manifestSha256,
    sequence: item.publication?.sequence,
    issuedAt: item.publication?.issuedAt,
    expiresAt: item.publication?.expiresAt,
  });
  requireValue(descriptorBytes.equals(jsonBytes(descriptor)), '资源资格目录不是固定规范字节');
  requireValue(
    expectedCore &&
      descriptor.core.appVersion === expectedCore.appVersion &&
      descriptor.core.gitSha === expectedCore.gitSha &&
      (expectedCore.archiveSha256 === undefined ||
        descriptor.core.archiveSha256 === expectedCore.archiveSha256),
    '资源目录不属于已认证 Core',
  );
  const rawCatalog = JSON.parse(catalogBytes.toString('utf8'));
  const catalog = createResourceCatalog(
    descriptor,
    descriptorBytes,
    rawCatalog.promotionSha,
    rawCatalog.resources?.[0]?.publication?.sha256,
  );
  requireValue(
    catalogBytes.equals(jsonBytes(catalog)),
    '资源晋级目录、原描述符或地址绑定不是固定规范字节',
  );
  return { descriptor, catalog, entry: catalog.resources[0] };
}
