import { Buffer } from 'node:buffer';
import { LIMITS, requireValue, parsePackManifest } from './index.mjs';
import { verifyPackBytes, sha256, jsonBytes } from './content.mjs';
import { getResourceAuthorization, verifyResourceCatalogReceipt } from './catalog-runtime.mjs';
export { RESOURCE_ASSET_NAMES } from './catalog.mjs';
export {
  getResourceAuthorization,
  verifyResourceCatalogBytes,
  verifyResourceCatalogReceipt,
  verifyCatalogResourcePublicationBytes,
} from './catalog-runtime.mjs';
import { parsePublication, assertPublicationContent } from './publication.mjs';
import {
  createMizarVerifier,
  verifyMizarAttestation,
  verifyMizarAttestationDigest,
} from './attestation.mjs';
import {
  captureTrustSnapshot,
  createOfflineMizarVerifier,
  RECEIPT_MAX_BYTES,
} from './trust-snapshot.mjs';
function snapshot(value, maximum) {
  requireValue(
    Buffer.isBuffer(value) && value.length > 0 && value.length <= maximum,
    '资源授权输入大小或类型无效',
  );
  return Buffer.from(value);
}
/** Store/Installer 的真实进程内入口。无 gh、无替换信任根/假 verifier 注入。 */
export async function verifyResourcePublicationBytes({
  statementBytes,
  publicationBundleBytes,
  archiveBytes,
  archiveBundleBytes,
  policy,
  tufCachePath,
  signal,
}) {
  const declaration = snapshot(statementBytes, 64 * 1024),
    archive = snapshot(archiveBytes, LIMITS.archiveBytes);
  const publicationProof = snapshot(publicationBundleBytes, 2 * 1024 * 1024),
    archiveProof = snapshot(archiveBundleBytes, 2 * 1024 * 1024);
  const publicationBundle = JSON.parse(publicationProof.toString('utf8'));
  const archiveBundle = JSON.parse(archiveProof.toString('utf8'));
  const statement = parsePublication(JSON.parse(declaration.toString('utf8')), policy);
  const pack = verifyPackBytes(archive, {
    coreVersion: policy.coreVersion,
    expectedArchive: statement.archive,
  });
  assertPublicationContent(statement, pack);
  signal?.throwIfAborted();
  const publicationVerifier = await createMizarVerifier(
    'promotion',
    statement.promotionSha,
    tufCachePath,
  );
  signal?.throwIfAborted();
  requireValue(
    verifyMizarAttestation(
      declaration,
      'resource-publication.json',
      publicationBundle,
      publicationVerifier,
      'promotion',
    ) === statement.promotionSha,
    '资源发行授权签名源码不符',
  );
  const archiveVerifier = await createMizarVerifier(
    'qualification',
    statement.sourceSha,
    tufCachePath,
  );
  signal?.throwIfAborted();
  requireValue(
    verifyMizarAttestation(archive, statement.archive.name, archiveBundle, archiveVerifier) ===
      statement.sourceSha,
    '资源归档签名源码不符',
  );
  const trust = await captureTrustSnapshot(tufCachePath, signal);
  const receipt = {
    schemaVersion: 'mizar.resource-receipt.v1',
    manifestBase64: pack.entries.get('pack-manifest.json').toString('base64'),
    publicationBase64: declaration.toString('base64'),
    publicationBundleBase64: publicationProof.toString('base64'),
    archiveBundleBase64: archiveProof.toString('base64'),
    trust,
  };
  requireValue(
    Buffer.byteLength(JSON.stringify(receipt)) <= RECEIPT_MAX_BYTES,
    '资源缓存 receipt 超限',
  );
  // 在激活前真正验证离线证据可用，而非认为保存一个对象就足够。
  await verifyResourceReceipt({ receipt, policy, purpose: 'cache', signal });
  return { statement, ...pack, receipt };
}

function receiptBytes(value, maximum) {
  requireValue(
    typeof value === 'string' && value.length <= Math.ceil(maximum / 3) * 4,
    '缓存授权字段超限',
  );
  const bytes = Buffer.from(value, 'base64');
  requireValue(
    bytes.length > 0 && bytes.length <= maximum && bytes.toString('base64') === value,
    '缓存授权字段编码无效',
  );
  return bytes;
}
/** 无 ZIP 的授权 receipt 复验；文件实际 bytes/sha256 仍必须由 Store 在返回之后逐文件核对。 */
export async function verifyResourceReceipt({
  receipt,
  manifestBytes: localManifestBytes,
  policy,
  purpose,
  expectedCore,
  tufCachePath,
  signal,
}) {
  requireValue(
    ['install', 'legacy', 'cache', 'rollback'].includes(purpose),
    '必须由 Store 明确指定资源验证用途',
  );
  const serialized = JSON.stringify(receipt);
  requireValue(
    typeof serialized === 'string' && Buffer.byteLength(serialized) <= RECEIPT_MAX_BYTES,
    '缓存 receipt 大小无效',
  );
  receipt = JSON.parse(serialized);
  requireValue(receipt?.schemaVersion === 'mizar.resource-receipt.v1', '缓存 receipt 版本无效');
  policy = policy && { ...policy };
  let catalogIdentity;
  if (receipt.catalog !== undefined) {
    const authorization = await verifyResourceCatalogReceipt({
      receipt: receipt.catalog,
      expectedCore:
        expectedCore ?? (policy && { appVersion: policy.coreVersion, gitSha: policy.sourceSha }),
      purpose,
      tufCachePath,
      signal,
    });
    const pinned = getResourceAuthorization(authorization);
    catalogIdentity = pinned;
    if (policy)
      requireValue(
        Number.isSafeInteger(policy.minimumSequence) &&
          policy.minimumSequence >= 0 &&
          ['packVersion', 'sourceSha', 'promotionSha', 'coreVersion'].every(
            (key) => policy[key] === pinned.policy[key],
          ),
        '资源缓存目录不等于当前受信任策略',
      );
    policy = {
      ...pinned.policy,
      minimumSequence: Math.max(pinned.policy.minimumSequence, policy?.minimumSequence ?? 0),
      now: Date.now(),
    };
    requireValue(
      sha256(receiptBytes(receipt.publicationBase64, 64 * 1024)) === pinned.publication.sha256 &&
        sha256(receiptBytes(receipt.manifestBase64, LIMITS.manifestBytes)) ===
          pinned.manifestSha256,
      '资源缓存字节不等于签名目录',
    );
  }
  const declaration = receiptBytes(receipt.publicationBase64, 64 * 1024),
    manifestBytes =
      localManifestBytes === undefined
        ? receiptBytes(receipt.manifestBase64, LIMITS.manifestBytes)
        : snapshot(localManifestBytes, LIMITS.manifestBytes);
  const statement = parsePublication(JSON.parse(declaration.toString('utf8')), policy, { purpose });
  if (catalogIdentity)
    requireValue(
      declaration.equals(jsonBytes(statement)) &&
        ['name', 'bytes', 'sha256', 'format'].every(
          (key) => statement.archive[key] === catalogIdentity.archive[key],
        ) &&
        ['sequence', 'issuedAt', 'expiresAt'].every(
          (key) => statement[key] === catalogIdentity.publication[key],
        ),
      '资源缓存归档、序号或时间不等于签名目录',
    );
  const publicationBundle = JSON.parse(
    receiptBytes(receipt.publicationBundleBase64, RECEIPT_MAX_BYTES).toString('utf8'),
  );
  const archiveBundle = JSON.parse(
    receiptBytes(receipt.archiveBundleBase64, RECEIPT_MAX_BYTES).toString('utf8'),
  );
  const cached = purpose === 'cache' || purpose === 'rollback';
  signal?.throwIfAborted();
  // 任何 receipt 都先证明其根材料来自固定 SDK seed，防止普通缓存路径被当成可替换根。
  const offlinePublication = createOfflineMizarVerifier(
    receipt.trust,
    'promotion',
    statement.promotionSha,
  );
  const offlineArchive = createOfflineMizarVerifier(
    receipt.trust,
    'qualification',
    statement.sourceSha,
  );
  function authorize(publicationVerifier, archiveVerifier) {
    requireValue(
      verifyMizarAttestation(
        declaration,
        'resource-publication.json',
        publicationBundle,
        publicationVerifier,
        'promotion',
      ) === statement.promotionSha,
      '缓存发行授权源码不符',
    );
    requireValue(
      verifyMizarAttestationDigest(
        statement.archive.sha256,
        statement.archive.name,
        archiveBundle,
        archiveVerifier,
      ) === statement.sourceSha,
      '缓存归档资格源码不符',
    );
  }
  authorize(offlinePublication, offlineArchive);
  if (!cached) {
    const publicationVerifier = await createMizarVerifier(
      'promotion',
      statement.promotionSha,
      tufCachePath,
    );
    signal?.throwIfAborted();
    const archiveVerifier = await createMizarVerifier(
      'qualification',
      statement.sourceSha,
      tufCachePath,
    );
    signal?.throwIfAborted();
    authorize(publicationVerifier, archiveVerifier);
  }
  const manifest = parsePackManifest(JSON.parse(manifestBytes.toString('utf8')), {
    coreVersion: policy.coreVersion,
  });
  assertPublicationContent(statement, { manifest, manifestSha256: sha256(manifestBytes) });
  return manifest;
}
