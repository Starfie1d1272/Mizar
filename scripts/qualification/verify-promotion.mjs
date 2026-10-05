import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyPayload } from './product-runtime.mjs';
import { validateReleaseTag } from './app-version.mjs';

export async function verifyPromotion({ product, extracted, tag, sourceSha, binaryVersion }) {
  const manifest = JSON.parse(await readFile(join(product, 'release-manifest.json'), 'utf8'));
  validateReleaseTag(tag, manifest.appVersion);
  if (
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    manifest.gitSha !== sourceSha ||
    manifest.developmentOnly ||
    manifest.desktopBuildProfile !== 'release'
  )
    throw new Error('晋级来源必须是指定源码的 release 产品');
  if (!/^Mizar-[A-Za-z0-9.-]+\.zip$/.test(manifest.archive)) throw new Error('非法产品文件名');
  const archive = join(product, manifest.archive);
  const digest = createHash('sha256')
    .update(await readFile(archive))
    .digest('hex');
  if (digest !== manifest.archiveSha256) throw new Error('产品 ZIP 摘要不一致');
  const checksum = (await readFile(`${archive}.sha256`, 'utf8')).trim();
  if (checksum !== `${digest}  ${manifest.archive}`) throw new Error('产品 checksum 不一致');
  const dirs = (await readdir(extracted, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory(),
  );
  if (dirs.length !== 1) throw new Error('解压目录必须包含唯一产品');
  const root = join(extracted, dirs[0].name);
  const artifact = await verifyPayload(root);
  if (
    artifact.gitSha !== sourceSha ||
    artifact.artifactSha256 !== manifest.contentDigest ||
    artifact.appVersion !== manifest.appVersion ||
    artifact.desktopBuildProfile !== 'release'
  )
    throw new Error('包内身份与 manifest 不一致');
  const version =
    binaryVersion ??
    execFileSync(join(root, 'Mizar.exe'), ['--app-version'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
  if (version !== manifest.appVersion) throw new Error('EXE 编译版本与 manifest 不一致');
  return {
    tag,
    appVersion: version,
    gitSha: sourceSha,
    archive: manifest.archive,
    archiveSha256: digest,
    contentDigest: manifest.contentDigest,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , product, extracted, tag, sourceSha, output] = process.argv;
  const identity = await verifyPromotion({ product, extracted, tag, sourceSha });
  await writeFile(output, `${JSON.stringify(identity, null, 2)}\n`);
  console.log(JSON.stringify(identity));
}
