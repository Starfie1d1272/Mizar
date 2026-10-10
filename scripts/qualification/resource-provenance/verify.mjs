import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { releaseAttestationArgs } from '../release-identity.mjs';
import { LIMITS, requireValue } from '../../../packages/resource-pack-contract/index.mjs';
import { verifyPackBytes } from '../../asset-packs/pack.mjs';
import { boundedRead } from './io.mjs';
import { parsePublication, assertPublicationContent } from './statement.mjs';

/** 始终调用现有 gh/Sigstore 根；不接受镜像自报可信或注入的假可信对象。 */
export async function verifyResourcePublication({
  statementPath,
  publicationBundlePath,
  archivePath,
  archiveBundlePath,
  policy,
  purpose = 'install',
}) {
  const declarationBytes = await boundedRead(statementPath, 64 * 1024);
  const statement = parsePublication(JSON.parse(declarationBytes.toString('utf8')), policy, {
    purpose,
  });
  const archiveBytes = await boundedRead(archivePath, LIMITS.archiveBytes);
  const publicationBundle = await boundedRead(publicationBundlePath, 2 * 1024 * 1024);
  const archiveBundle = await boundedRead(archiveBundlePath, 2 * 1024 * 1024);
  const pack = verifyPackBytes(archiveBytes, {
    coreVersion: policy.coreVersion,
    expectedArchive: statement.archive,
  });
  assertPublicationContent(statement, pack);
  const directory = await mkdtemp(join(tmpdir(), 'mizar-resource-trust-'));
  try {
    // 先冻结所有输入，防止文件在内容校验与来源校验之间被替换。
    const publication = join(directory, 'resource-publication.json'),
      archive = join(directory, statement.archive.name),
      publicationProof = join(directory, 'publication-provenance.json'),
      archiveProof = join(directory, 'pack-provenance.json');
    await writeFile(publication, declarationBytes);
    await writeFile(archive, archiveBytes);
    await writeFile(publicationProof, publicationBundle);
    await writeFile(archiveProof, archiveBundle);
    execFileSync(
      'gh',
      releaseAttestationArgs(publication, statement.promotionSha, publicationProof, 'promotion'),
      { stdio: 'pipe', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 },
    );
    execFileSync('gh', releaseAttestationArgs(archive, statement.sourceSha, archiveProof), {
      stdio: 'pipe',
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { statement, ...pack };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [statementPath, publicationBundlePath, archivePath, archiveBundlePath, policyPath] =
    process.argv.slice(2);
  requireValue(policyPath, '用法：verify.mjs 声明 晋级证明 归档 资格证明 受信任策略JSON');
  const policy = JSON.parse((await boundedRead(policyPath, 64 * 1024)).toString('utf8'));
  policy.now = Date.now();
  const result = await verifyResourcePublication({
    statementPath,
    publicationBundlePath,
    archivePath,
    archiveBundlePath,
    policy,
  });
  console.log(
    JSON.stringify({
      packId: result.manifest.packId,
      packVersion: result.manifest.packVersion,
      archive: result.archive,
      sourceSha: result.statement.sourceSha,
      sequence: result.statement.sequence,
    }),
  );
}
