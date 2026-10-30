import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyGroupedReleaseAttestations } from './release-identity.mjs';

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));
const safeName = (name) =>
  typeof name === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/.test(name) &&
  basename(name) === name;
export async function freezePromotionProduct(
  source,
  destination,
  sourceSha,
  tag,
  verify = verifyGroupedReleaseAttestations,
) {
  if (
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    !/^v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.[1-9]\d*)?$/.test(tag)
  )
    throw new Error('非法晋级身份');
  const started = globalThis.performance.now();
  const entries = await readdir(source, { withFileTypes: true });
  if (
    !entries.length ||
    entries.length > 80 ||
    entries.some((entry) => !entry.isFile() || !safeName(entry.name))
  )
    throw new Error('候选目录包含非普通文件或非法名称');
  await mkdir(destination, { recursive: false });
  try {
    for (const entry of entries) {
      const sourcePath = join(source, entry.name);
      const info = await stat(sourcePath);
      if (info.size > 2 * 1024 * 1024 * 1024) throw new Error('候选资产超出大小上限');
      await copyFile(sourcePath, join(destination, entry.name), constants.COPYFILE_EXCL);
    }
    const manifest = await json(join(destination, 'release-manifest.json'));
    const core = await json(join(destination, 'core-release-manifest.json'));
    if (
      manifest.gitSha !== sourceSha ||
      core.gitSha !== sourceSha ||
      tag !== `v${manifest.appVersion}` ||
      core.appVersion !== manifest.appVersion
    )
      throw new Error('冻结候选版本或源码不一致');
    const qualification = [
      'release-manifest.json',
      manifest.archive,
      core.archive,
      'core-release-manifest.json',
      'core-distribution-manifest.json',
      core.archive.replace(/\.zip$/, '-Setup.exe'),
    ];
    const distributionPath = join(destination, 'distribution-manifest.json');
    let distribution;
    try {
      distribution = await json(distributionPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (distribution) qualification.push('distribution-manifest.json', distribution.archive);
    const stable = /^v\d+\.\d+\.\d+$/.test(tag);
    if (stable) {
      if (!distribution) throw new Error('正式版缺少分发清单');
      qualification.push(`Mizar-${tag}-Windows-x64-WebInstaller.exe`, 'web-installer-build.json');
    }
    if (
      qualification.some((name) => !safeName(name)) ||
      new Set(qualification).size !== qualification.length
    )
      throw new Error('候选资产名称无效或重复');
    const bundle = join(destination, 'qualification-provenance.json');
    const subjects = qualification.map((name) => ({
      file: join(destination, name),
      sourceSha,
      bundle,
    }));
    if (stable)
      subjects.push({
        file: join(destination, 'update-manifest.json'),
        sourceSha,
        bundle: join(destination, 'update-provenance.json'),
      });
    await verify(subjects);
    console.log(
      `PROVENANCE_SNAPSHOT subjects=${subjects.length} elapsed_ms=${Math.round(globalThis.performance.now() - started)}`,
    );
    return { subjectCount: subjects.length };
  } catch (error) {
    console.log(
      `PROVENANCE_SNAPSHOT status=failure elapsed_ms=${Math.round(globalThis.performance.now() - started)}`,
    );
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , source, destination, sha, tag] = process.argv;
  if (!tag) throw new Error('用法：promotion-snapshot.mjs 源目录 冻结目录 精确源码SHA 标签');
  await freezePromotionProduct(source, destination, sha, tag);
}
