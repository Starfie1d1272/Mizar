import {
  MACHINE_METADATA_NAME,
  MACHINE_METADATA_MAX_BYTES,
  readMachineFile,
} from '../../packages/resource-pack-contract/transport.mjs';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { releaseAttestationArgs } from './release-identity.mjs';
import { publicProductAssets, assetInventory } from './release-assets.mjs';

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

async function expectedAssets(product) {
  return assetInventory(await publicProductAssets(product));
}

async function verifiedPublishedRelease(releasePath, refPath, tag, product) {
  const identity = await json('promotion-identity.json');
  requireValue(identity.tag === tag, '晋级标签不一致');
  const release = await json(releasePath),
    ref = await json(refPath);
  assertPublishedAssets(release, ref, identity, await expectedAssets(product));
  return { identity, release };
}

async function verifyExistingPublication(release, identity, product) {
  if (!/^v\d+\.\d+\.\d+$/.test(identity.tag)) return;
  const directory = await mkdtemp(join(tmpdir(), 'mizar-publication-'));
  try {
    const carriers = release.assets.filter((a) => a.name === MACHINE_METADATA_NAME);
    const indexName = carriers.length ? MACHINE_METADATA_NAME : 'update-index.json';
    const indexAssets = carriers.length
      ? carriers
      : release.assets.filter((a) => a.name === 'update-index.json');
    if (indexAssets.length) {
      requireValue(
        indexAssets.length === 1 &&
          indexAssets[0].size > 0 &&
          indexAssets[0].size <= (carriers.length ? MACHINE_METADATA_MAX_BYTES : 2097152),
        '更新信封不唯一或超限',
      );
      execFileSync(
        'gh',
        [
          'release',
          'download',
          identity.tag,
          '--repo',
          repository,
          '--pattern',
          indexName,
          '--dir',
          directory,
        ],
        { stdio: 'pipe', timeout: 60000 },
      );
      const transport = await readFile(join(directory, indexName));
      const bytes = carriers.length ? readMachineFile(transport, 'update-index.json') : transport;
      assertPublishedAssets(
        release,
        { object: { type: 'commit', sha: identity.gitSha } },
        identity,
        [{ name: indexName, size: transport.length, sha256: sha256(transport) }],
      );
      const index = JSON.parse(bytes);
      requireValue(index.schemaVersion === 'mizar.update-index.v2', '更新信封格式无效');
      const manifestBytes = Buffer.from(index.manifestBase64, 'base64'),
        publicationBytes = Buffer.from(index.publicationBase64, 'base64');
      requireValue(
        manifestBytes.equals(await readFile(join(product, 'update-manifest.json'))),
        '原更新清单字节不一致',
      );
      const { makeUpdateIndex } = await import('./update-index.mjs');
      const provenance = Buffer.from(JSON.stringify(index.provenance)),
        publicationProof = Buffer.from(JSON.stringify(index.publicationProvenance));
      requireValue(
        bytes.equals(
          makeUpdateIndex(manifestBytes, provenance, publicationBytes, publicationProof),
        ),
        '更新信封不是原始规范字节',
      );
      const publication = JSON.parse(publicationBytes);
      requireValue(
        publication.releaseId === release.id && publication.publishedAt === release.published_at,
        '发布确认对应不同 Release',
      );
      for (const [name, data] of [
        ['update-manifest.json', manifestBytes],
        ['update-provenance.json', provenance],
        ['update-publication.json', publicationBytes],
        ['update-publication-provenance.json', publicationProof],
      ])
        await writeFile(join(directory, name), data);
      execFileSync(
        'gh',
        releaseAttestationArgs(
          join(directory, 'update-manifest.json'),
          identity.gitSha,
          join(directory, 'update-provenance.json'),
        ),
        { stdio: 'inherit', timeout: 60000 },
      );
      execFileSync(
        'gh',
        releaseAttestationArgs(
          join(directory, 'update-publication.json'),
          publication.promotionSha,
          join(directory, 'update-publication-provenance.json'),
          'promotion',
        ),
        { stdio: 'inherit', timeout: 60000 },
      );
      return;
    }
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
  const [, , mode, releasePath, refPath, tag, product, output] = process.argv;
  requireValue(['create', 'verify-existing'].includes(mode), '发布确认操作无效');
  const { identity, release } = await verifiedPublishedRelease(releasePath, refPath, tag, product);
  if (mode === 'verify-existing') {
    await verifyExistingPublication(release, identity, product);
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
