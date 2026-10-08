import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsBundleName } from './app-version.mjs';

export async function verifyCandidate(product, sourceSha, archiveSha256, evidenceRoot) {
  const manifest = JSON.parse(await readFile(join(product, 'release-manifest.json'), 'utf8'));
  if (
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    !/^[a-f0-9]{64}$/.test(archiveSha256) ||
    manifest.gitSha !== sourceSha ||
    manifest.archiveSha256 !== archiveSha256 ||
    manifest.desktopBuildProfile !== 'release' ||
    manifest.developmentOnly !== false ||
    manifest.archive !== `${windowsBundleName(manifest.appVersion)}.zip`
  ) {
    throw new Error('候选包身份与构建任务不一致');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(join(product, manifest.archive))) hash.update(chunk);
  if (hash.digest('hex') !== archiveSha256) throw new Error('候选 ZIP 传输摘要不一致');
  if (evidenceRoot) {
    for (const lane of ['portable', 'setup']) {
      const identity = JSON.parse(
        await readFile(join(evidenceRoot, lane, `${lane}-identity.json`), 'utf8'),
      );
      for (const field of ['gitSha', 'archive', 'archiveSha256', 'contentDigest', 'appVersion']) {
        if (identity[field] !== manifest[field])
          throw new Error(`${lane} 验收身份不一致：${field}`);
      }
      if (lane === 'setup') {
        const distribution = JSON.parse(
          await readFile(join(product, 'distribution-manifest.json'), 'utf8'),
        );
        if (JSON.stringify(identity.distribution) !== JSON.stringify(distribution)) {
          throw new Error('Setup 验收身份与分发清单不一致');
        }
      }
    }
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyCandidate(...process.argv.slice(2));
}
