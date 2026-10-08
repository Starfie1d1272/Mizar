import { readFile, writeFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyPayload } from './product-runtime.mjs';
import { validateReleaseTag, windowsBundleName } from './app-version.mjs';

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
  const currentArchive = `${windowsBundleName(manifest.appVersion)}.zip`;
  const legacyArchive = /^Mizar-[A-Za-z0-9.-]+-win-x64-portable-[a-f0-9]{7}\.zip$/.test(
    manifest.archive,
  );
  if (manifest.archive !== currentArchive && !legacyArchive) throw new Error('非法产品文件名');
  const setupName = manifest.archive.replace(/\.zip$/, '-Setup.exe');
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
  let distribution;
  const productFiles = await readdir(product);
  if (productFiles.includes('distribution-manifest.json')) {
    distribution = JSON.parse(await readFile(join(product, 'distribution-manifest.json'), 'utf8'));
    if (
      distribution.schemaVersion !== 1 ||
      distribution.gitSha !== manifest.gitSha ||
      distribution.appVersion !== manifest.appVersion ||
      distribution.contentDigest !== manifest.contentDigest ||
      distribution.originalArchiveSha256 !== digest ||
      distribution.format !== 'nsis-setup' ||
      distribution.archive !== setupName
    )
      throw new Error('安装包身份与已验 ZIP 不一致');
    if (
      distribution.installerLicense !== 'NSIS-LICENSE.txt' ||
      distribution.installerVersion !== 'v3.11' ||
      !/^[a-f0-9]{64}$/.test(distribution.installerCompilerSha256) ||
      !/^[a-f0-9]{64}$/.test(distribution.installerScriptSha256)
    )
      throw new Error('安装工具身份无效');
    const licenseDigest = createHash('sha256')
      .update(await readFile(join(product, distribution.installerLicense)))
      .digest('hex');
    if (licenseDigest !== distribution.installerLicenseSha256)
      throw new Error('安装工具许可摘要不一致');
    const setup = join(product, distribution.archive);
    const bytes = await readFile(setup);
    const setupDigest = createHash('sha256').update(bytes).digest('hex');
    if (
      setupDigest !== distribution.archiveSha256 ||
      bytes.length !== distribution.archiveBytes ||
      (await readFile(`${setup}.sha256`, 'utf8')).trim() !==
        `${setupDigest}  ${distribution.archive}`
    )
      throw new Error('安装包摘要不一致');
  } else if (productFiles.some((name) => /^Mizar-.*\.exe$/.test(name))) {
    throw new Error('安装包缺少已验分发清单');
  }
  return {
    ...(distribution ? { distribution } : {}),
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
