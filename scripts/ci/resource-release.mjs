import {
  MACHINE_METADATA_NAME,
  MACHINE_METADATA_MAX_BYTES,
  readMachineMetadata,
} from '../../packages/resource-pack-contract/transport.mjs';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { buildOfficialPack, verifyPackBytes, jsonBytes, sha256 } from '../asset-packs/pack.mjs';
import { makePublication } from '../qualification/resource-provenance/create.mjs';
import { verifyResourcePublication } from '../qualification/resource-provenance/verify.mjs';
import { boundedRead } from '../qualification/resource-provenance/io.mjs';
import { releaseAttestationArgs } from '../qualification/release-identity.mjs';
import { validateReleaseTag } from '../qualification/app-version.mjs';
import {
  LIMITS,
  requireValue,
  assertCompatibility,
  isSourceSha,
} from '../../packages/resource-pack-contract/index.mjs';

const repository = 'Starfie1d1272/Mizar';
import {
  RESOURCE_ASSET_NAMES as names,
  createResourceDescriptor,
  createResourceCatalog,
} from '../../packages/resource-pack-contract/catalog.mjs';

const equal = (a, b, message) => requireValue(JSON.stringify(a) === JSON.stringify(b), message);
const coreIdentity = (manifest) => {
  requireValue(
    /^[a-f0-9]{40}$/.test(manifest.gitSha) &&
      /^[a-f0-9]{64}$/.test(manifest.archiveSha256) &&
      manifest.desktopBuildProfile === 'release' &&
      manifest.developmentOnly === false &&
      manifest.resourceMode !== 'core-only',
    '资源目录必须绑定正式资格候选；不能将 Core-only 开发产物升级为正式候选',
  );
  validateReleaseTag(`v${manifest.appVersion}`, manifest.appVersion);
  requireValue(
    [
      `Mizar-v${manifest.appVersion}-Windows-x64.zip`,
      `Mizar-v${manifest.appVersion}-Windows-x64-Core.zip`,
    ].includes(manifest.archive),
    'Core 归档身份无效',
  );
  return {
    appVersion: manifest.appVersion,
    gitSha: manifest.gitSha,
    archive: manifest.archive,
    archiveSha256: manifest.archiveSha256,
  };
};

// This is a candidate descriptor, not an authorization result. Installation
// requires the original Qualification descriptor AND Promotion catalog proofs,
// then the existing shared verifier's archive/publication proofs.
export function makeResourceDescriptor(pack, manifest, parameters) {
  const core = coreIdentity(manifest);
  requireValue(pack.manifest.source.gitSha === core.gitSha, 'Pack 与 Core 必须来自同一资格源码');
  const publication = makePublication(pack, { ...parameters, promotionSha: core.gitSha });
  const policy = {
    packVersion: pack.manifest.packVersion,
    sourceSha: pack.manifest.source.gitSha,
    coreVersion: core.appVersion.replace(/-rc\.\d+$/, ''),
    minimumSequence: publication.sequence,
  };
  // Also check actual Core compatibility; makePublication checks only the lower bound.
  assertCompatibility(pack.manifest.compatibility, policy.coreVersion);
  return createResourceDescriptor({
    core,
    packVersion: policy.packVersion,
    archive: publication.archive,
    manifestSha256: pack.manifestSha256,
    sequence: publication.sequence,
    issuedAt: publication.issuedAt,
    expiresAt: publication.expiresAt,
  });
}

export function makePublishedCatalog(candidate, promotionSha) {
  requireValue(isSourceSha(promotionSha), '晋级目录必须绑定精确晋级源码');
  const publication = makePublication(candidate.pack, {
    ...candidate.entry.publication,
    promotionSha,
  });
  return createResourceCatalog(
    candidate.descriptor,
    candidate.bytes,
    promotionSha,
    sha256(jsonBytes(publication)),
  );
}

export async function prepareResourceCandidate(
  root,
  output,
  manifest,
  packVersion,
  sequence,
  now = Date.now(),
) {
  const core = coreIdentity(manifest);
  requireValue(Number.isSafeInteger(sequence) && sequence > 0, '资源序号必须是正整数');
  const pack = await buildOfficialPack(root, { packVersion, sourceSha: core.gitSha });
  const issuedAt = new Date(Math.floor(now / 1000) * 1000).toISOString().replace('.000Z', 'Z');
  const expiresAt = new Date(Math.floor(now / 1000) * 1000 + 90 * 86400000)
    .toISOString()
    .replace('.000Z', 'Z');
  const catalog = makeResourceDescriptor(pack, manifest, { sequence, issuedAt, expiresAt });
  await mkdir(output, { recursive: false });
  await writeFile(join(output, catalog.resources[0].archive.name), pack.archiveBytes, {
    flag: 'wx',
  });
  await writeFile(join(output, names.descriptor), jsonBytes(catalog), { flag: 'wx' });
  return { catalog, archive: pack.archive, trusted: false };
}

export async function readResourceCandidate(folder, manifest) {
  const bytes = await boundedRead(join(folder, names.descriptor), 64 * 1024);
  const catalog = JSON.parse(bytes.toString('utf8'));
  coreIdentity(manifest);
  equal(catalog.core, coreIdentity(manifest), '目录与 Core 资格身份不一致');
  requireValue(catalog.resources?.length === 1, '目录必须有唯一官方默认资源');
  const entry = catalog.resources[0];
  // Never open a mirror-supplied path. Derive the sole filename from a bounded version.
  requireValue(/^\d+\.\d+\.\d+$/.test(entry.policy?.packVersion), '资源版本无效');
  const archiveName = `Mizar-official-epl-default-${entry.policy.packVersion}.zip`;
  const archiveBytes = await boundedRead(join(folder, archiveName), LIMITS.archiveBytes);
  const pack = verifyPackBytes(archiveBytes, {
    coreVersion: manifest.appVersion.replace(/-rc\.\d+$/, ''),
  });
  const expected = makeResourceDescriptor(pack, manifest, entry.publication);
  equal(catalog, expected, '目录字段、策略、摘要或下载地址与真实候选不一致');
  requireValue(bytes.equals(jsonBytes(expected)), '目录必须保持原始规范字节，拒绝额外或重复字段');
  return { descriptor: catalog, bytes, archiveBytes, pack, entry: expected.resources[0] };
}

function verifyProof(path, sourceSha, bundle, role = 'qualification') {
  execFileSync('gh', releaseAttestationArgs(path, sourceSha, bundle, role), {
    stdio: 'pipe',
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
  });
}
async function withVerifiedSnapshot(folder, manifest, published, operation) {
  const candidate = await readResourceCandidate(folder, manifest);
  const frozen = new Map([
    [names.descriptor, candidate.bytes],
    [candidate.entry.archive.name, candidate.archiveBytes],
  ]);
  const proofNames = [
    names.descriptorQualification,
    names.archiveQualification,
    ...(published
      ? [names.catalog, names.catalogPromotion, names.publication, names.publicationPromotion]
      : []),
  ];
  for (const name of proofNames)
    frozen.set(
      name,
      await boundedRead(
        join(folder, name),
        [names.publication, names.catalog].includes(name) ? 64 * 1024 : 2 * 1024 * 1024,
      ),
    );
  const directory = await mkdtemp(join(tmpdir(), 'mizar-resource-release-'));
  try {
    for (const [name, bytes] of frozen)
      await writeFile(join(directory, name), bytes, { flag: 'wx' });
    verifyProof(
      join(directory, names.descriptor),
      manifest.gitSha,
      join(directory, names.descriptorQualification),
    );
    verifyProof(
      join(directory, candidate.entry.archive.name),
      candidate.entry.policy.sourceSha,
      join(directory, names.archiveQualification),
    );
    if (published) {
      const catalogBytes = frozen.get(names.catalog);
      const catalog = JSON.parse(catalogBytes.toString('utf8'));
      const expectedCatalog = makePublishedCatalog(candidate, catalog.promotionSha);
      equal(catalog, expectedCatalog, '晋级目录与原资格描述符、声明或受控下载地址不一致');
      requireValue(catalogBytes.equals(jsonBytes(expectedCatalog)), '晋级目录必须保留原始规范字节');
      // promotionSha is only a verification constraint until this fixed-main
      // signature succeeds; no mirror field becomes an authorization policy.
      verifyProof(
        join(directory, names.catalog),
        catalog.promotionSha,
        join(directory, names.catalogPromotion),
        'promotion',
      );
      candidate.catalog = expectedCatalog;
      candidate.entry = expectedCatalog.resources[0];
      requireValue(
        sha256(frozen.get(names.publication)) === candidate.entry.publication.sha256,
        '声明不是已签目录绑定的原始声明',
      );
      await verifyResourcePublication({
        statementPath: join(directory, names.publication),
        publicationBundlePath: join(directory, names.publicationPromotion),
        archivePath: join(directory, candidate.entry.archive.name),
        archiveBundlePath: join(directory, names.archiveQualification),
        policy: { ...candidate.entry.policy, now: Date.now() },
      });
    }
    return await operation(candidate, frozen);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function verifyQualifiedResources(folder, manifest) {
  return withVerifiedSnapshot(folder, manifest, false, (candidate) => candidate);
}
export async function verifyPublishedResources(folder, manifest) {
  return withVerifiedSnapshot(folder, manifest, true, (candidate) => candidate);
}
function expectedResourceNames(candidate, published) {
  return [
    candidate.entry.archive.name,
    names.descriptor,
    names.descriptorQualification,
    names.archiveQualification,
    ...(published
      ? [names.catalog, names.catalogPromotion, names.publication, names.publicationPromotion]
      : []),
  ];
}
async function assertFileSet(folder, expected) {
  const files = await readdir(folder, { withFileTypes: true });
  requireValue(
    files.length === expected.length &&
      files.every((file) => file.isFile() && expected.includes(file.name)),
    '资源目录包含未声明文件、目录或重复资产',
  );
}
export async function resourceAssetInventory(folder, manifest, published = false) {
  return withVerifiedSnapshot(folder, manifest, published, async (candidate, frozen) => {
    await assertFileSet(folder, expectedResourceNames(candidate, published));
    return [...frozen].map(([name, bytes]) => ({
      name,
      size: bytes.length,
      sha256: sha256(bytes),
    }));
  });
}
export async function freezePublishedResources(folder, manifest, destination) {
  return withVerifiedSnapshot(folder, manifest, true, async (candidate, frozen) => {
    await assertFileSet(folder, expectedResourceNames(candidate, true));
    await mkdir(destination, { recursive: false });
    try {
      for (const [name, bytes] of frozen)
        await writeFile(join(destination, name), bytes, { flag: 'wx' });
    } catch (error) {
      await rm(destination, { recursive: true, force: true });
      throw error;
    }
    return candidate;
  });
}
function publishedResourceMetadata(release, catalog, expected, partial = false) {
  requireValue(
    release.tag_name === `v${catalog.core.appVersion}` &&
      (partial ? typeof release.draft === 'boolean' : !release.draft && release.published_at),
    '资源必须来自已公开的同版本发行，拒绝覆盖未完成草稿',
  );
  for (const asset of expected) {
    const found = release.assets.filter((item) => item.name === asset.name);
    if (partial && !found.length) continue;
    requireValue(
      found.length === 1 &&
        found[0].size === asset.size &&
        found[0].digest === `sha256:${asset.sha256}` &&
        found[0].browser_download_url === catalog.resources[0].assets[asset.name],
      `公开资源资产缺失、重复、地址或摘要不符：${asset.name}`,
    );
  }
}
async function publishedCarrier(release) {
  const assets = release.assets.filter((a) => a.name === MACHINE_METADATA_NAME);
  requireValue(
    assets.length === 1 &&
      assets[0].size > 0 &&
      assets[0].size <= MACHINE_METADATA_MAX_BYTES &&
      assets[0].browser_download_url ===
        `https://github.com/${repository}/releases/download/${release.tag_name}/${MACHINE_METADATA_NAME}`,
    'Invalid published machine carrier',
  );
  const directory = await mkdtemp(join(tmpdir(), 'mizar-machine-readback-'));
  try {
    execFileSync(
      'gh',
      [
        'release',
        'download',
        release.tag_name,
        '--repo',
        repository,
        '--pattern',
        MACHINE_METADATA_NAME,
        '--dir',
        directory,
      ],
      { stdio: 'pipe', timeout: 60000 },
    );
    const bytes = await boundedRead(
      join(directory, MACHINE_METADATA_NAME),
      MACHINE_METADATA_MAX_BYTES,
    );
    requireValue(
      bytes.length === assets[0].size && assets[0].digest === `sha256:${sha256(bytes)}`,
      'Machine carrier readback differs',
    );
    return readMachineMetadata(bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function verifyPublishedResourceMetadata(folder, manifest, release) {
  const { catalog } = await verifyPublishedResources(folder, manifest);
  const expected = await resourceAssetInventory(folder, manifest, true);
  if (manifest.resourceMode === 'core') {
    publishedResourceMetadata(
      release,
      catalog,
      expected.filter((a) => a.name.endsWith('.zip')),
    );
    if (release.assets.some((a) => a.name === MACHINE_METADATA_NAME)) {
      const originals = await publishedCarrier(release);
      for (const asset of expected.filter((a) => !a.name.endsWith('.zip'))) {
        const bytes = originals.get(asset.name);
        requireValue(
          bytes && bytes.length === asset.size && sha256(bytes) === asset.sha256,
          'Published carrier differs from original resource proof bytes',
        );
      }
    }
  } else publishedResourceMetadata(release, catalog, expected);
}

function lookupGithubObject(path) {
  try {
    return JSON.parse(
      execFileSync('gh', ['api', `repos/${repository}/${path}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
        maxBuffer: 4 * 1024 * 1024,
      }),
    );
  } catch (error) {
    if (error.stderr?.toString().includes('(HTTP 404)')) return null;
    throw new Error('发行或标签查询失败；未知状态不能触发签发或发布', { cause: error });
  }
}
async function resolvePublishedResourceFiles(folder, manifest) {
  const candidate = await verifyQualifiedResources(folder, manifest);
  const tag = `v${manifest.appVersion}`;
  const release = lookupGithubObject(`releases/tags/${tag}`);
  if (release === null) return false;
  if (release.assets.some((a) => a.name === MACHINE_METADATA_NAME)) {
    const originals = await publishedCarrier(release);
    for (const name of Object.values(names)) {
      const bytes = originals.get(name);
      requireValue(bytes, 'Carrier is missing original resource metadata');
      if (
        [names.descriptor, names.descriptorQualification, names.archiveQualification].includes(name)
      )
        requireValue(
          bytes.equals(await readFile(join(folder, name))),
          'Published carrier differs from original qualification bytes',
        );
      else await writeFile(join(folder, name), bytes, { flag: 'wx' });
    }
    await verifyPublishedResourceMetadata(folder, manifest, release);
    return true;
  }
  const qualified = await resourceAssetInventory(folder, manifest);
  publishedResourceMetadata(
    release,
    candidate.descriptor,
    manifest.resourceMode === 'core' ? qualified.filter((a) => a.name.endsWith('.zip')) : qualified,
    true,
  );
  const authorizationNames = [
    names.catalog,
    names.publication,
    names.publicationPromotion,
    names.catalogPromotion,
  ];
  const present = authorizationNames.filter((name) =>
    release.assets.some((asset) => asset.name === name),
  );
  if (!present.length) return false;
  if (present.length === authorizationNames.length) {
    for (const name of authorizationNames) {
      const found = release.assets.filter((asset) => asset.name === name);
      requireValue(
        found.length === 1 &&
          found[0].size > 0 &&
          found[0].size <= ([names.catalog, names.publication].includes(name) ? 65536 : 2097152),
        '已有资源授权不唯一或超限',
      );
      execFileSync(
        'gh',
        ['release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', folder],
        { stdio: 'pipe', timeout: 60000 },
      );
    }
  } else {
    requireValue(/^\d+$/.test(process.env.RUN_ID ?? ''), '恢复必须绑定原资格任务');
    const prefix = `promotion-resources-${tag}-${process.env.RUN_ID}-`;
    let artifacts = [];
    for (let page = 1; page <= 5; page++) {
      const response = lookupGithubObject(`actions/artifacts?per_page=100&page=${page}`);
      requireValue(response?.artifacts, '无法查询原签名 CI 快照');
      artifacts.push(
        ...response.artifacts.filter(
          (item) =>
            !item.expired &&
            item.name.startsWith(prefix) &&
            /^\d+$/.test(item.name.slice(prefix.length)),
        ),
      );
      if (response.artifacts.length < 100) break;
    }
    artifacts.sort((x, y) => y.id - x.id);
    const original = artifacts[0];
    requireValue(original?.workflow_run?.id, '部分公开资源缺少原签名 CI 快照；拒绝覆盖或重新签发');
    const recovery = await mkdtemp(join(tmpdir(), 'mizar-original-publication-'));
    try {
      execFileSync(
        'gh',
        [
          'run',
          'download',
          String(original.workflow_run.id),
          '--repo',
          repository,
          '--name',
          original.name,
          '--dir',
          recovery,
        ],
        { stdio: 'pipe', timeout: 600000 },
      );
      await resourceAssetInventory(recovery, manifest, true);
      for (const name of authorizationNames)
        await writeFile(join(folder, name), await readFile(join(recovery, name)), { flag: 'wx' });
    } finally {
      await rm(recovery, { recursive: true, force: true });
    }
  }
  const { catalog } = await verifyPublishedResources(folder, manifest);
  publishedResourceMetadata(
    release,
    catalog,
    await resourceAssetInventory(folder, manifest, true),
    true,
  );

  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, folder, manifestPath, argument, sequence] = process.argv.slice(2);
  const manifest = JSON.parse(await boundedRead(manifestPath, 64 * 1024));
  if (mode === 'lookup-release') {
    coreIdentity(manifest);
    requireValue(process.env.RELEASE_TAG === `v${manifest.appVersion}`, '查询标签与候选版本不一致');
    requireValue(process.env.GITHUB_ENV, '发行工作流环境缺失');
    const release = lookupGithubObject(`releases/tags/${process.env.RELEASE_TAG}`);
    if (release !== null) await writeFile(argument, jsonBytes(release), { flag: 'wx' });
    else
      requireValue(
        lookupGithubObject(`git/ref/tags/${process.env.RELEASE_TAG}`) === null,
        '已有标签但无已验证发行；拒绝变更',
      );
    await appendFile(process.env.GITHUB_ENV, `RELEASE_FOUND=${release !== null}\n`);
  } else if (mode === 'prepare') {
    const root = resolve(import.meta.dirname, '../..');
    const result = await prepareResourceCandidate(
      root,
      folder,
      manifest,
      argument,
      Number(sequence),
    );
    console.log(JSON.stringify({ archive: result.archive, trusted: false }));
  } else if (mode === 'check') {
    const candidate = await readResourceCandidate(folder, manifest);
    await assertFileSet(folder, [candidate.entry.archive.name, names.descriptor]);
    console.log('Resource candidate integrity matches Core; this does not authorize installation');
  } else if (mode === 'qualified') {
    await resourceAssetInventory(folder, manifest);
    console.log('Original resource Qualification proofs and exact Core/source identity verified');
  } else if (mode === 'parameters') {
    const candidate = await verifyQualifiedResources(folder, manifest);
    requireValue(
      isSourceSha(process.env.GITHUB_SHA) &&
        execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() ===
          process.env.GITHUB_SHA,
      '资源签发工具必须使用本次晋级工作流精确源码',
    );
    const catalog = makePublishedCatalog(candidate, process.env.GITHUB_SHA);
    await writeFile(join(folder, names.catalog), jsonBytes(catalog), { flag: 'wx' });
    const { publication } = candidate.entry;
    await writeFile(
      argument,
      jsonBytes({
        sequence: publication.sequence,
        issuedAt: publication.issuedAt,
        expiresAt: publication.expiresAt,
      }),
      { flag: 'wx' },
    );
  } else if (mode === 'published') {
    await resourceAssetInventory(folder, manifest, true);
    console.log(
      'Original catalog, archive and publication Qualification/Promotion proofs verified',
    );
  } else if (mode === 'freeze') {
    await freezePublishedResources(folder, manifest, argument);
  } else if (mode === 'resolve') {
    const exists = await resolvePublishedResourceFiles(folder, manifest);
    requireValue(process.env.GITHUB_ENV, '发行工作流环境缺失');
    await appendFile(process.env.GITHUB_ENV, `RESOURCE_RELEASE_EXISTS=${exists}\n`);
  } else if (mode === 'published-release') {
    await verifyPublishedResourceMetadata(
      folder,
      manifest,
      JSON.parse(await boundedRead(argument, 4 * 1024 * 1024)),
    );
  } else if (mode === 'inventory') {
    await writeFile(argument, jsonBytes(await resourceAssetInventory(folder, manifest, true)), {
      flag: 'wx',
    });
  } else
    throw new Error(
      'resource-release: prepare|check|qualified|parameters|published|freeze|resolve|published-release|inventory folder Core-manifest [output/version] [sequence]',
    );
}
