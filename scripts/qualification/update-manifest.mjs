import { readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stableVersion = (value) =>
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
  value.split('.').every((part) => Number.isSafeInteger(Number(part)));
const compare = (a, b) => {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};
export function makeUpdateManifest(release, distribution, policy, notes) {
  if (!stableVersion(release.appVersion)) return null;
  if (
    policy.version !== release.appVersion ||
    !stableVersion(policy.minimumVersion) ||
    !stableVersion(policy.maximumVersionExclusive) ||
    compare(policy.minimumVersion, release.appVersion) > 0 ||
    compare(release.appVersion, policy.maximumVersionExclusive) >= 0 ||
    !/^[a-f0-9]{40}$/.test(release.gitSha) ||
    !/^[a-f0-9]{64}$/.test(distribution.contentDigest) ||
    release.developmentOnly !== false ||
    release.desktopBuildProfile !== 'release' ||
    distribution.appVersion !== release.appVersion ||
    distribution.gitSha !== release.gitSha ||
    distribution.originalArchiveSha256 !== release.archiveSha256 ||
    distribution.contentDigest !== release.contentDigest ||
    distribution.format !== 'nsis-setup' ||
    distribution.archive !== `Mizar-v${release.appVersion}-Windows-x64-Setup.exe` ||
    !/^[a-f0-9]{64}$/.test(distribution.archiveSha256) ||
    !Number.isSafeInteger(distribution.archiveBytes) ||
    distribution.archiveBytes <= 0 ||
    distribution.archiveBytes > 512 * 1024 * 1024 ||
    !notes.trim() ||
    notes.length > 48_000
  )
    throw new Error('更新发布配置与资格构建身份不一致');
  return {
    schemaVersion: 'mizar.update.v1',
    repository: 'Starfie1d1272/Mizar',
    channel: 'stable',
    version: release.appVersion,
    gitSha: release.gitSha,
    notes: notes.trim(),
    compatibility: {
      minimumVersion: policy.minimumVersion,
      maximumVersionExclusive: policy.maximumVersionExclusive,
    },
    installer: {
      platform: 'win32-x64',
      format: 'nsis-setup',
      name: distribution.archive,
      bytes: distribution.archiveBytes,
      sha256: distribution.archiveSha256,
      contentDigest: distribution.contentDigest,
    },
  };
}
export async function qualifiedUpdateManifest(product) {
  const release = JSON.parse(await readFile(join(product, 'release-manifest.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(release.appVersion)) return null;
  const policy = JSON.parse(
    await readFile(join(root, 'scripts/qualification/update-release.json'), 'utf8'),
  );
  if (!/^docs\/releases\/[A-Za-z0-9.-]+\.md$/.test(policy.notesFile))
    throw new Error('更新说明必须来自随源码维护的版本文档');
  const distribution = JSON.parse(
    await readFile(join(product, 'distribution-manifest.json'), 'utf8'),
  );
  return makeUpdateManifest(
    release,
    distribution,
    policy,
    await readFile(join(root, policy.notesFile), 'utf8'),
  );
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const product = process.argv[2];
  const manifest = await qualifiedUpdateManifest(product);
  if (manifest) {
    const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
    if (Buffer.byteLength(bytes, 'utf8') > 64 * 1024) throw new Error('更新清单超出客户端字节上限');
    if (process.argv[3] === '--check') {
      if ((await readFile(join(product, 'update-manifest.json'), 'utf8')) !== bytes)
        throw new Error('更新清单不等于已核验源码与原分发身份');
    } else await writeFile(join(product, 'update-manifest.json'), bytes);
  }
}
