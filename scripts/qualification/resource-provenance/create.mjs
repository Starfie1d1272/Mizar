import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIMITS, requireValue } from '../../../packages/resource-pack-contract/index.mjs';
import { verifyPackBytes, jsonBytes } from '../../asset-packs/pack.mjs';
import { releaseAttestationArgs } from '../release-identity.mjs';
import { verifySourceCi } from '../verify-source-ci.mjs';
import { boundedRead } from './io.mjs';
import { REPOSITORY, STATEMENT_SCHEMA, parsePublication } from './statement.mjs';

/** 只构造未签声明；签发仍归既有 main 晋级工作流。 */
export function makePublication(pack, { promotionSha, sequence, issuedAt, expiresAt }) {
  const value = {
    schemaVersion: STATEMENT_SCHEMA,
    repository: REPOSITORY,
    packId: pack.manifest.packId,
    packVersion: pack.manifest.packVersion,
    sourceRef: 'refs/heads/main',
    sourceSha: pack.manifest.source.gitSha,
    promotionSha,
    contentKind: pack.manifest.contentKind,
    compatibility: pack.manifest.compatibility,
    manifestSha256: pack.manifestSha256,
    archive: {
      name: `Mizar-official-epl-default-${pack.manifest.packVersion}.zip`,
      ...pack.archive,
    },
    sequence,
    issuedAt,
    expiresAt,
  };
  return parsePublication(value, {
    packVersion: value.packVersion,
    sourceSha: value.sourceSha,
    promotionSha,
    coreVersion: value.compatibility.minimumCoreVersion,
    minimumSequence: sequence,
    now: Date.parse(issuedAt),
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [archivePath, archiveBundle, metadataPath, output] = process.argv.slice(2);
  requireValue(output, '用法：create.mjs 归档 资格证明 签发参数JSON 输出声明');
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  requireValue(
    process.env.GITHUB_REPOSITORY === REPOSITORY &&
      process.env.GITHUB_REF === 'refs/heads/main' &&
      process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
      process.env.GITHUB_WORKFLOW_REF ===
        `${REPOSITORY}/.github/workflows/release-promotion.yml@refs/heads/main` &&
      process.env.GITHUB_SHA === sha,
    '资源发行声明只能在既有 main 晋级工作流构造',
  );
  const archiveBytes = await boundedRead(archivePath, LIMITS.archiveBytes);
  const bundleBytes = await boundedRead(archiveBundle, 2 * 1024 * 1024);
  const pack = verifyPackBytes(archiveBytes);
  const directory = await mkdtemp(join(tmpdir(), 'mizar-resource-create-'));
  try {
    const archive = join(directory, 'pack.zip'),
      bundle = join(directory, 'pack-provenance.json');
    await writeFile(archive, archiveBytes);
    await writeFile(bundle, bundleBytes);
    execFileSync('gh', releaseAttestationArgs(archive, pack.manifest.source.gitSha, bundle), {
      stdio: 'inherit',
      timeout: 60_000,
    });
    verifySourceCi(REPOSITORY, pack.manifest.source.gitSha);
    const metadata = JSON.parse((await boundedRead(metadataPath, 64 * 1024)).toString('utf8'));
    const statement = makePublication(pack, { ...metadata, promotionSha: sha });
    await writeFile(output, jsonBytes(statement));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
