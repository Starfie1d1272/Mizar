import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
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
  resourceAssetReleaseTag,
} from '../../packages/resource-pack-contract/catalog.mjs';

const equal = (a, b, message) => requireValue(JSON.stringify(a) === JSON.stringify(b), message);
const coreIdentity = (manifest) => {
  requireValue(
    /^[a-f0-9]{40}$/.test(manifest.gitSha) &&
      /^[a-f0-9]{64}$/.test(manifest.archiveSha256) &&
      manifest.desktopBuildProfile === 'release' &&
      manifest.developmentOnly === false,
    '资源目录必须绑定正式资格候选；不能将 Core-only 开发产物升级为正式候选',
  );
  validateReleaseTag(`v${manifest.appVersion}`, manifest.appVersion);
  requireValue(
    manifest.archive === `Mizar-v${manifest.appVersion}-Windows-x64.zip`,
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
    assetReleaseTag: parameters.assetReleaseTag,
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
  const catalog = makeResourceDescriptor(pack, manifest, {
    sequence,
    issuedAt,
    expiresAt,
    assetReleaseTag: `data-v${core.appVersion}`,
  });
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
  const expected = makeResourceDescriptor(pack, manifest, {
    ...entry.publication,
    assetReleaseTag: resourceAssetReleaseTag(catalog),
  });
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
export function publishedResourceMetadata(
  release,
  catalog,
  expected,
  allowMissing = false,
  allowDraft = false,
) {
  const tag = resourceAssetReleaseTag(catalog);
  requireValue(
    release.tag_name === tag &&
      (allowDraft || (!release.draft && release.published_at)) &&
      (!tag.startsWith('data-v') || release.prerelease === true),
    '资源必须来自已公开的同版本发行，拒绝覆盖未完成草稿',
  );
  for (const asset of expected) {
    const found = release.assets.filter((item) => item.name === asset.name);
    if (allowMissing && found.length === 0) continue;
    requireValue(
      found.length === 1 &&
        found[0].size === asset.size &&
        found[0].digest === `sha256:${asset.sha256}` &&
        found[0].browser_download_url === catalog.resources[0].assets[asset.name],
      `公开资源资产缺失、重复、地址或摘要不符：${asset.name}`,
    );
  }
}
export async function verifyPublishedResourceMetadata(folder, manifest, release) {
  const { catalog } = await verifyPublishedResources(folder, manifest);
  const expected = await resourceAssetInventory(folder, manifest, true);
  publishedResourceMetadata(release, catalog, expected);
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
export function restorePublishedResourceBindings(candidate, files) {
  const shas = [];
  for (const name of [names.catalog, names.publication])
    if (files.has(name)) shas.push(JSON.parse(files.get(name).toString('utf8')).promotionSha);
  for (const name of [names.catalogPromotion, names.publicationPromotion]) {
    if (!files.has(name)) continue;
    const bundle = JSON.parse(files.get(name).toString('utf8'));
    const statement = JSON.parse(Buffer.from(bundle.dsseEnvelope?.payload ?? '', 'base64'));
    const dependencies = statement.predicate?.buildDefinition?.resolvedDependencies;
    const commits = dependencies?.filter(
      (dependency) => dependency.uri === `git+https://github.com/${repository}@refs/heads/main`,
    );
    requireValue(commits?.length === 1, '已有晋级证明必须绑定唯一原晋级源码');
    shas.push(commits[0].digest?.gitCommit);
  }
  if (shas.length === 0) return null;
  const promotionSha = shas[0];
  requireValue(
    isSourceSha(promotionSha) && shas.every((sha) => sha === promotionSha),
    '已有目录、声明及证明的晋级身份不一致',
  );
  const catalog = makePublishedCatalog(candidate, promotionSha);
  const publication = makePublication(candidate.pack, {
    ...candidate.entry.publication,
    promotionSha,
  });
  for (const [name, bytes] of [
    [names.catalog, jsonBytes(catalog)],
    [names.publication, jsonBytes(publication)],
  ]) {
    requireValue(
      !files.has(name) || files.get(name).equals(bytes),
      '已有目录或声明与原资格身份、规范字节不一致',
    );
    files.set(name, bytes);
  }
  return promotionSha;
}
async function recoverPromotionProof(folder, subject, proof, promotionSha) {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-resource-proof-'));
  try {
    const subjectPath = resolve(folder, subject);
    const bytes = await boundedRead(subjectPath, 65536);
    execFileSync('gh', ['attestation', 'download', subjectPath, '--repo', repository], {
      cwd: directory,
      stdio: 'pipe',
      timeout: 60000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const candidates = (
      await boundedRead(join(directory, `sha256:${sha256(bytes)}.jsonl`), 2 * 1024 * 1024)
    )
      .toString('utf8')
      .trim()
      .split('\n');
    for (const candidate of candidates) {
      const path = join(directory, proof);
      const bundle = jsonBytes(JSON.parse(candidate));
      await writeFile(path, bundle);
      try {
        verifyProof(subjectPath, promotionSha, path, 'promotion');
      } catch {
        continue;
      }
      await writeFile(join(folder, proof), bundle, { flag: 'wx' });
      return;
    }
    throw new Error(`不能恢复原晋级证明，拒绝重新签发：${proof}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
export async function resolvePublishedResourceFiles(folder, manifest) {
  const candidate = await verifyQualifiedResources(folder, manifest);
  const tag = resourceAssetReleaseTag(candidate.descriptor);
  const dataRelease = tag.startsWith('data-v');
  const release = lookupGithubObject(`releases/tags/${tag}`);
  const expectedNames = expectedResourceNames(candidate, true);
  if (dataRelease) {
    const ref = lookupGithubObject(`git/ref/tags/${tag}`);
    requireValue(
      (ref === null && release === null) ||
        (ref?.object?.type === 'commit' && ref.object.sha === manifest.gitSha),
      '技术发行标签必须绑定原 Core 资格源码',
    );
  }
  if (release === null)
    return { found: false, complete: false, reusePromotion: false, missing: expectedNames };
  // Existing qualified bytes must match; absent assets remain eligible for safe upload.
  const qualified = await resourceAssetInventory(folder, manifest);
  publishedResourceMetadata(release, candidate.descriptor, qualified, dataRelease, dataRelease);
  const downloaded = new Map();
  for (const name of [
    names.catalog,
    names.publication,
    names.publicationPromotion,
    names.catalogPromotion,
  ]) {
    const matches = release.assets.filter((asset) => asset.name === name);
    if (matches.length === 0) {
      requireValue(dataRelease, `已有发行缺少唯一资源授权：${name}`);
      continue;
    }
    const limit = [names.publication, names.catalog].includes(name) ? 65536 : 2097152;
    requireValue(
      matches.length === 1 &&
        matches[0].size > 0 &&
        matches[0].size <= limit &&
        /^sha256:[a-f0-9]{64}$/.test(matches[0].digest) &&
        matches[0].browser_download_url === candidate.entry.assets[name],
      `已有发行资源授权重复、地址、大小或摘要无效：${name}`,
    );
    execFileSync(
      'gh',
      ['release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', folder],
      { stdio: 'pipe', timeout: 60000 },
    );
    const bytes = await boundedRead(join(folder, name), limit);
    requireValue(
      bytes.length === matches[0].size && `sha256:${sha256(bytes)}` === matches[0].digest,
      `已有发行资源授权下载字节不符：${name}`,
    );
    downloaded.set(name, bytes);
  }
  // Derivation never authorizes: recover both original subjects, then verify every
  // proof against its original main Promotion identity before reusing the snapshot.
  const promotionSha = restorePublishedResourceBindings(candidate, downloaded);
  if (promotionSha) {
    for (const name of [names.catalog, names.publication])
      if (!release.assets.some((asset) => asset.name === name))
        await writeFile(join(folder, name), downloaded.get(name), { flag: 'wx' });
    for (const [subject, proof] of [
      [names.catalog, names.catalogPromotion],
      [names.publication, names.publicationPromotion],
    ]) {
      if (!downloaded.has(proof)) await recoverPromotionProof(folder, subject, proof, promotionSha);
      else verifyProof(join(folder, subject), promotionSha, join(folder, proof), 'promotion');
    }
    await verifyPublishedResources(folder, manifest);
    const inventory = await resourceAssetInventory(folder, manifest, true);
    publishedResourceMetadata(release, candidate.descriptor, inventory, dataRelease, dataRelease);
  }

  const missing = expectedNames.filter(
    (name) => !release.assets.some((asset) => asset.name === name),
  );
  if (missing.length === 0 && !release.draft)
    await verifyPublishedResourceMetadata(folder, manifest, release);
  return {
    found: true,
    complete: missing.length === 0 && !release.draft,
    reusePromotion: Boolean(promotionSha),
    promotionSha,
    missing,
  };
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
    const result = await resolvePublishedResourceFiles(folder, manifest);
    requireValue(process.env.GITHUB_ENV, '发行工作流环境缺失');
    await appendFile(
      process.env.GITHUB_ENV,
      `RESOURCE_RELEASE_EXISTS=${result.complete}\nRESOURCE_RELEASE_FOUND=${result.found}\nRESOURCE_REUSE_PROMOTION=${result.reusePromotion}\nRESOURCE_PROMOTION_SHA=${result.promotionSha ?? ''}\nRESOURCE_RELEASE_MISSING=${JSON.stringify(result.missing)}\n`,
    );
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
