import { Buffer } from 'node:buffer';
import { LIMITS, requireValue } from './index.mjs';
import { verifyPackBytes } from './content.mjs';
import { parsePublication, assertPublicationContent } from './publication.mjs';
import { createMizarVerifier, verifyMizarAttestation } from './attestation.mjs';
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
  const publicationBundle = JSON.parse(
    snapshot(publicationBundleBytes, 2 * 1024 * 1024).toString('utf8'),
  );
  const archiveBundle = JSON.parse(snapshot(archiveBundleBytes, 2 * 1024 * 1024).toString('utf8'));
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
  return { statement, ...pack };
}
