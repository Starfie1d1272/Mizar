import { createHash } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join, basename, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const repo = 'Starfie1d1272/Mizar';
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export async function publicProductAssets(product) {
  const manifest = JSON.parse(await readFile(join(product, 'release-manifest.json')));
  const paths = [
    manifest.archive,
    'release-manifest.json',
    'distribution-manifest.json',
    'NSIS-LICENSE.txt',
  ];
  const distribution = JSON.parse(await readFile(join(product, 'distribution-manifest.json')));
  if (distribution.gitSha !== manifest.gitSha || distribution.appVersion !== manifest.appVersion)
    throw new Error('发行身份不一致');
  paths.push(distribution.archive);
  if (/^\d+\.\d+\.\d+$/.test(manifest.appVersion)) {
    paths.push('update-manifest.json');
    const build = JSON.parse(await readFile(join(product, 'web-installer-build.json')));
    const name = `Mizar-v${manifest.appVersion}-Windows-x64-WebInstaller.exe`;
    const bytes = await readFile(join(product, name));
    if (
      build.artifact !== name ||
      build.gitSha !== manifest.gitSha ||
      build.version !== manifest.appVersion ||
      build.sha256 !== hash(bytes) ||
      build.bytes !== bytes.length ||
      build.installer !== distribution.archive ||
      build.core !== manifest.archive
    )
      throw new Error('轻量安装器不是同一资格候选的原字节');
    paths.push(name);
  }
  if (
    paths.some((name) => typeof name !== 'string' || name !== basename(name) || name.includes('..'))
  )
    throw new Error('发行路径无效');
  return paths.map((name) => join(product, name));
}
export async function assetInventory(paths) {
  return Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(path);
      return { path, name: basename(path), size: bytes.length, sha256: hash(bytes) };
    }),
  );
}
export function missingAssets(release, ref, identity, expected) {
  const stable = /^v\d+\.\d+\.\d+$/.test(identity.tag);
  if (
    release.tag_name !== identity.tag ||
    release.prerelease !== !stable ||
    typeof release.draft !== 'boolean' ||
    ref.object?.type !== 'commit' ||
    ref.object.sha !== identity.gitSha ||
    (!release.draft && !release.published_at)
  )
    throw new Error('发行或标签身份不一致');
  if (!expected.length || new Set(expected.map((a) => a.name)).size !== expected.length)
    throw new Error('发行资产清单重复或为空');
  return expected.filter((asset) => {
    const found = release.assets.filter((a) => a.name === asset.name);
    if (!found.length) return true;
    if (
      found.length !== 1 ||
      found[0].size !== asset.size ||
      found[0].digest !== `sha256:${asset.sha256}` ||
      found[0].browser_download_url !==
        `https://github.com/${repo}/releases/download/${identity.tag}/${asset.name}`
    )
      throw new Error(`已有同名资产不同，拒绝覆盖：${asset.name}`);
    return false;
  });
}
// Verify every existing original before adding anything; uploads never use --clobber.
export async function reconcileAssets(release, ref, identity, expected, readExisting, upload) {
  const missing = missingAssets(release, ref, identity, expected);
  for (const asset of expected.filter((a) => !missing.includes(a))) {
    const bytes = await readExisting(asset.name);
    if (bytes.length !== asset.size || hash(bytes) !== asset.sha256)
      throw new Error(`已有资产实际字节不同：${asset.name}`);
  }
  for (const asset of missing) await upload(asset.path);
  return missing;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, product, ...args] = process.argv.slice(2);
  const paths = await publicProductAssets(product);
  if (mode === 'assets') console.log(JSON.stringify(paths));
  else if (mode === 'reconcile') {
    const [releasePath, refPath, identityPath, resources] = args;
    if (resources && resources !== '-') {
      const { readdir } = await import('node:fs/promises');
      for (const name of await readdir(resources)) paths.push(join(resources, name));
    }
    const release = JSON.parse(await readFile(releasePath)),
      ref = JSON.parse(await readFile(refPath)),
      identity = JSON.parse(await readFile(identityPath));
    const temp = await mkdtemp(join(tmpdir(), 'mizar-published-bytes-'));
    try {
      await reconcileAssets(
        release,
        ref,
        identity,
        await assetInventory(paths),
        async (name) => {
          execFileSync(
            'gh',
            ['release', 'download', identity.tag, '--repo', repo, '--pattern', name, '--dir', temp],
            { stdio: 'pipe', timeout: 600000 },
          );
          return readFile(join(temp, name));
        },
        async (path) => {
          execFileSync('gh', ['release', 'upload', identity.tag, path, '--repo', repo], {
            stdio: 'inherit',
            timeout: 600000,
          });
        },
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } else
    throw new Error(
      'release-assets assets PRODUCT | reconcile PRODUCT RELEASE REF IDENTITY RESOURCES-or-dash',
    );
}
