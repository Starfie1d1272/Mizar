import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsBundleName } from './app-version.mjs';

async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

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
  const archive = join(product, manifest.archive);
  if ((await fileHash(archive)) !== archiveSha256) throw new Error('候选 ZIP 传输摘要不一致');
  if (evidenceRoot) {
    if (
      (await readFile(`${archive}.sha256`, 'utf8')).trim() !==
      `${archiveSha256}  ${manifest.archive}`
    )
      throw new Error('候选 ZIP 校验文件不一致');
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
        if (
          distribution.archive !== manifest.archive.replace(/\.zip$/, '-Setup.exe') ||
          distribution.installerLicense !== 'NSIS-LICENSE.txt'
        )
          throw new Error('Setup 或许可文件名不一致');
        const setup = join(product, distribution.archive);
        if (
          identity.tag !== `v${manifest.appVersion}` ||
          (await fileHash(setup)) !== distribution.archiveSha256 ||
          (await stat(setup)).size !== distribution.archiveBytes ||
          (await readFile(`${setup}.sha256`, 'utf8')).trim() !==
            `${distribution.archiveSha256}  ${distribution.archive}` ||
          (await fileHash(join(product, distribution.installerLicense))) !==
            distribution.installerLicenseSha256
        )
          throw new Error('Setup 传输摘要或验收版本不一致');
      }
    }
    const core = JSON.parse(await readFile(join(product, 'core-release-manifest.json'), 'utf8'));
    const identity = JSON.parse(
      await readFile(join(evidenceRoot, 'core-setup', 'core-setup-identity.json'), 'utf8'),
    );
    if (
      core.gitSha !== sourceSha ||
      core.appVersion !== manifest.appVersion ||
      core.resourceMode !== 'core' ||
      core.derivedFrom?.archiveSha256 !== archiveSha256 ||
      core.derivedFrom?.contentDigest !== manifest.contentDigest
    )
      throw new Error('Core 验收来源与 Full 不一致');
    for (const field of [
      'gitSha',
      'archive',
      'archiveSha256',
      'contentDigest',
      'appVersion',
      'derivedFrom',
    ])
      if (JSON.stringify(identity[field]) !== JSON.stringify(core[field]))
        throw new Error(`core-setup 验收身份不一致：${field}`);
    const distribution = JSON.parse(
      await readFile(join(product, 'core-distribution-manifest.json'), 'utf8'),
    );
    if (JSON.stringify(identity.distribution) !== JSON.stringify(distribution))
      throw new Error('Core Setup 验收身份与分发清单不一致');
  }
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyCandidate(...process.argv.slice(2));
}
