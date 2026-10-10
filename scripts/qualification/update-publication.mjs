import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { releaseAttestationArgs } from './release-identity.mjs';

const repository = 'Starfie1d1272/Mizar';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};

export function assertPublishedAssets(release, ref, identity, expected) {
  const stable = /^v\d+\.\d+\.\d+$/.test(identity.tag);
  requireValue(
    release.tag_name === identity.tag &&
      !release.draft &&
      release.prerelease === !stable &&
      release.published_at &&
      ref.object?.type === 'commit' &&
      ref.object.sha === identity.gitSha,
    '已发布版本的标签、源码或发布状态不一致',
  );
  requireValue(
    expected.length > 0 && new Set(expected.map((a) => a.name)).size === expected.length,
    '必需资产清单为空或重复',
  );
  for (const asset of expected) {
    const found = release.assets.filter((a) => a.name === asset.name);
    requireValue(
      found.length === 1 &&
        found[0].size === asset.size &&
        found[0].digest === `sha256:${asset.sha256}` &&
        found[0].browser_download_url ===
          `https://github.com/${repository}/releases/download/${identity.tag}/${asset.name}`,
      `已发布资产缺失或身份不一致：${asset.name}`,
    );
  }
}

export function assertPublication(publication, manifestBytes, manifest) {
  requireValue(
    publication.schemaVersion === 'mizar.update-publication.v1' &&
      publication.repository === repository &&
      publication.version === manifest.version &&
      publication.gitSha === manifest.gitSha &&
      publication.manifestSha256 === sha256(manifestBytes) &&
      /^[a-f0-9]{40}$/.test(publication.promotionSha) &&
      Number.isSafeInteger(publication.releaseId) &&
      publication.releaseId > 0 &&
      typeof publication.publishedAt === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(publication.publishedAt) &&
      Number.isFinite(Date.parse(publication.publishedAt)),
    '正式发布确认与更新清单不一致',
  );
}

async function compactLayout(product) {
  try {
    await readFile(join(product, 'qualification-provenance.json'));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function expectedAssets(product, evidence) {
  if (await compactLayout(product)) {
    const { productAssets } = await import('./release-envelope.mjs');
    return Promise.all(
      (await productAssets(product)).map(async (path) => {
        const bytes = await readFile(path);
        return { name: basename(path), size: bytes.length, sha256: sha256(bytes) };
      }),
    );
  }
  const paths = [];
  for (const folder of [product, evidence])
    for (const entry of await readdir(folder, { withFileTypes: true }))
      if (entry.isFile()) paths.push(join(folder, entry.name));
  paths.push('promotion-identity.json', 'promotion-ci.json');
  return Promise.all(
    paths.map(async (path) => {
      const bytes = await readFile(path);
      return { name: basename(path), size: bytes.length, sha256: sha256(bytes) };
    }),
  );
}

async function verifiedPublishedRelease(releasePath, refPath, tag, product, evidence) {
  const identity = await json('promotion-identity.json');
  requireValue(identity.tag === tag, '晋级标签不一致');
  const release = await json(releasePath),
    ref = await json(refPath);
  assertPublishedAssets(release, ref, identity, await expectedAssets(product, evidence));
  return { identity, release };
}

async function verifyExistingPublication(release, identity, product, evidence) {
  if (await compactLayout(product)) {
    const { verifyCompactExisting } = await import('./release-envelope.mjs');
    await verifyCompactExisting(
      release,
      { object: { type: 'commit', sha: identity.gitSha } },
      identity,
      product,
      evidence,
    );
    return;
  }
  if (!/^v\d+\.\d+\.\d+$/.test(identity.tag)) return;
  const directory = await mkdtemp(join(tmpdir(), 'mizar-publication-'));
  try {
    for (const name of ['update-publication.json', 'update-publication-provenance.json']) {
      const assets = release.assets.filter((a) => a.name === name);
      requireValue(
        assets.length === 1 && assets[0].size <= (name.includes('provenance') ? 2097152 : 65536),
        `已发布版本缺少唯一发布确认：${name}`,
      );
      execFileSync('gh', [
        'release',
        'download',
        identity.tag,
        '--repo',
        repository,
        '--pattern',
        name,
        '--dir',
        directory,
      ]);
      const bytes = await readFile(join(directory, name));
      assertPublishedAssets(
        release,
        { object: { type: 'commit', sha: identity.gitSha } },
        identity,
        [{ name, size: bytes.length, sha256: sha256(bytes) }],
      );
    }
    const manifestBytes = await readFile(join(product, 'update-manifest.json'));
    const publication = await json(join(directory, 'update-publication.json'));
    assertPublication(publication, manifestBytes, JSON.parse(manifestBytes));
    requireValue(
      publication.releaseId === release.id && publication.publishedAt === release.published_at,
      '正式发布确认对应不同 Release',
    );
    execFileSync(
      'gh',
      releaseAttestationArgs(
        join(directory, 'update-publication.json'),
        publication.promotionSha,
        join(directory, 'update-publication-provenance.json'),
        'promotion',
      ),
      { stdio: 'inherit' },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , mode, releasePath, refPath, tag, product, evidence, output] = process.argv;
  requireValue(['create', 'verify-existing'].includes(mode), '发布确认操作无效');
  const { identity, release } = await verifiedPublishedRelease(
    releasePath,
    refPath,
    tag,
    product,
    evidence,
  );
  if (mode === 'verify-existing') {
    await verifyExistingPublication(release, identity, product, evidence);
    console.log('已发布版本的完整必需资产与正式发布确认一致；不修改公开文件。');
  } else {
    requireValue(
      /^v\d+\.\d+\.\d+$/.test(tag) &&
        process.env.GITHUB_REPOSITORY === repository &&
        process.env.GITHUB_REF === 'refs/heads/main' &&
        process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' &&
        process.env.GITHUB_WORKFLOW_REF ===
          `${repository}/.github/workflows/release-promotion.yml@refs/heads/main` &&
        /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA),
      '发布确认必须由 main 正式晋级签发',
    );
    const bytes = await readFile(join(product, 'update-manifest.json'));
    const manifest = JSON.parse(bytes);
    requireValue(
      `v${manifest.version}` === tag && manifest.gitSha === identity.gitSha,
      '发布确认源码或版本不一致',
    );
    const publication = {
      schemaVersion: 'mizar.update-publication.v1',
      repository,
      version: manifest.version,
      gitSha: identity.gitSha,
      manifestSha256: sha256(bytes),
      releaseId: release.id,
      publishedAt: release.published_at,
      promotionSha: process.env.GITHUB_SHA,
    };
    assertPublication(publication, bytes, manifest);
    await writeFile(output, `${JSON.stringify(publication, null, 2)}\n`);
  }
}
