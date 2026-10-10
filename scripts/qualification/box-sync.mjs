import { createHash, randomUUID } from 'node:crypto';
import { readFile, appendFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Buffer, Blob } from 'node:buffer';
import { URL } from 'node:url';
import { releaseAttestationArgs } from './release-identity.mjs';
import { assertPublication } from './update-publication.mjs';
import {
  decodeEvidence,
  evidenceName,
  makeUpdateIndex,
  verifyCoreEvidence,
  verifyEvidencePublication,
  verifyPromotionEvidence,
} from './release-envelope.mjs';

const { fetch, AbortSignal, FormData } = globalThis;

const origin = 'https://box.nju.edu.cn';
const offlinePattern = /^Mizar-v(\d+\.\d+\.\d+)-Windows-x64\.zip$/;
const setupPattern = /^Mizar-v(\d+\.\d+\.\d+)-Windows-x64-Setup\.exe$/;
const shaPattern = /^[a-f0-9]{64}$/;
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
class MirrorError extends Error {}
const requireValue = (ok, message) => {
  if (!ok) throw new MirrorError(message);
};
const older = (a, b) => {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
};

export function promotionTag(run, jobs) {
  const candidates = jobs
    .filter(
      (job) => job.run_id === run.id && job.status === 'completed' && job.conclusion === 'success',
    )
    .map((job) => /^发布 Mizar (v\d+\.\d+\.\d+(?:-rc\.\d+)?)$/.exec(job.name))
    .filter(Boolean);
  requireValue(candidates.length === 1, '无法确定唯一晋级标签；请手动指定标签重试');
  return candidates[0][1];
}

export function validateRelease(release, manifest, distribution, tag, tagSha) {
  requireValue(/^v\d+\.\d+\.\d+$/.test(tag), '仅同步正式版本');
  requireValue(
    release.tag_name === tag && !release.draft && !release.prerelease && release.published_at,
    '版本尚未正式发布',
  );
  const version = tag.slice(1),
    name = `Mizar-v${version}-Windows-x64-Setup.exe`;
  requireValue(
    manifest.schemaVersion === 1 &&
      manifest.developmentOnly === false &&
      manifest.desktopBuildProfile === 'release' &&
      manifest.archive === `Mizar-v${version}-Windows-x64.zip` &&
      shaPattern.test(manifest.archiveSha256),
    '产品清单必须来自正式配置的完整构建',
  );
  requireValue(
    manifest.appVersion === version && distribution.appVersion === version,
    '发布版本与清单不一致',
  );
  requireValue(
    /^[a-f0-9]{40}$/.test(tagSha) && manifest.gitSha === tagSha && distribution.gitSha === tagSha,
    '标签与清单源码不一致',
  );
  requireValue(
    distribution.schemaVersion === 1 &&
      distribution.format === 'nsis-setup' &&
      distribution.archive === name &&
      Number.isSafeInteger(distribution.archiveBytes) &&
      distribution.archiveBytes > 0,
    '安装包格式或名称不一致',
  );
  requireValue(
    shaPattern.test(distribution.archiveSha256) &&
      shaPattern.test(manifest.contentDigest) &&
      distribution.contentDigest === manifest.contentDigest &&
      distribution.originalArchiveSha256 === manifest.archiveSha256,
    '分发内容身份不一致',
  );
  const assets = release.assets.filter((a) => a.name === name);
  requireValue(
    assets.length === 1 &&
      assets[0].size === distribution.archiveBytes &&
      assets[0].digest === `sha256:${distribution.archiveSha256}`,
    'Release 安装包大小或摘要不一致',
  );
  return {
    name,
    version,
    size: distribution.archiveBytes,
    sha256: distribution.archiveSha256,
    asset: assets[0],
    gitSha: manifest.gitSha,
    releaseId: release.id,
  };
}

export function validateOfflineRelease(release, manifest, tag, tagSha) {
  requireValue(
    /^v\d+\.\d+\.\d+$/.test(tag) &&
      release.tag_name === tag &&
      !release.draft &&
      !release.prerelease &&
      release.published_at,
    '离线包不是同版本正式发行',
  );
  requireValue(
    manifest.schemaVersion === 1 &&
      manifest.gitSha === tagSha &&
      /^[a-f0-9]{40}$/.test(tagSha) &&
      manifest.appVersion === tag.slice(1) &&
      manifest.developmentOnly === false &&
      manifest.desktopBuildProfile === 'release' &&
      manifest.archive === `Mizar-${tag}-Windows-x64.zip` &&
      shaPattern.test(manifest.archiveSha256),
    '离线包源码、版本或完整构建身份不一致',
  );
  const found = release.assets.filter((a) => a.name === manifest.archive);
  requireValue(
    found.length === 1 &&
      Number.isSafeInteger(found[0].size) &&
      found[0].size > 0 &&
      found[0].size <= 1073741824 &&
      found[0].digest === `sha256:${manifest.archiveSha256}` &&
      found[0].browser_download_url ===
        `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/${manifest.archive}`,
    'Release 离线包大小、地址或摘要不一致',
  );
  return {
    name: manifest.archive,
    version: manifest.appVersion,
    size: found[0].size,
    sha256: manifest.archiveSha256,
    asset: found[0],
    gitSha: manifest.gitSha,
    releaseId: release.id,
  };
}

async function checkedFetch(url, options = {}, timeout = 120000) {
  // Error text and response bodies may contain temporary upload URLs or credentials.
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new MirrorError('网络请求失败或超时；保留现有文件，可重试同一版本');
  }
  requireValue(response.ok, `远端请求失败（HTTP ${response.status}）；保留现有文件`);
  return response;
}

export class BoxClient {
  constructor(token) {
    requireValue(token, '未配置 MIZAR_BOX_REPO_TOKEN；在 Actions 配置后重试');
    this.token = token;
  }
  async api(endpoint, path, method = 'GET', body) {
    const url = new URL(`/api/v2.1/via-repo-token/${endpoint}/`, origin);
    if (path !== undefined) url.searchParams.set('path', path);
    const headers = { Authorization: `Token ${this.token}`, Accept: 'application/json' };
    if (body) headers['Content-Type'] = 'application/json';
    return (
      await checkedFetch(url, {
        method,
        headers,
        redirect: 'error',
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    ).json();
  }
  async list(path) {
    const result = await this.api('dir', path);
    requireValue(Array.isArray(result.dirent_list), '云盘目录返回格式错误');
    return result.dirent_list;
  }
  async initialize() {
    const info = await this.api('repo-info');
    requireValue(info.repo_name === 'Mizar', '令牌必须指向现有 Mizar 资料库');
    const entries = await this.list('/');
    for (const name of ['Stable', 'Archive'])
      requireValue(
        entries.some((e) => e.name === name && e.type === 'dir'),
        `资料库缺少 ${name} 目录`,
      );
  }
  temporaryUrl(value) {
    const url = new URL(value);
    requireValue(
      url.origin === origin &&
        !url.username &&
        !url.password &&
        url.pathname.startsWith('/seafhttp/'),
      '云盘临时地址超出允许范围',
    );
    return url;
  }
  async hash(path) {
    const url = this.temporaryUrl(await this.api('download-link', path));
    const response = await checkedFetch(url, { redirect: 'error' }, 600000);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      hash.update(chunk);
      size += chunk.length;
    }
    return { sha256: hash.digest('hex'), size };
  }
  async upload(path, name, bytes, replace = false) {
    const url = this.temporaryUrl(await this.api('upload-link', path));
    url.searchParams.set('ret-json', '1');
    const form = new FormData();
    form.set('parent_dir', path);
    form.set('replace', replace ? '1' : '0');
    form.set('file', new Blob([bytes]), name);
    const result = await (
      await checkedFetch(url, { method: 'POST', body: form, redirect: 'error' }, 600000)
    ).json();
    requireValue(
      Array.isArray(result) && result.length === 1 && result[0].name === name,
      '上传回执不一致；检查目录后重试',
    );
  }
  async move(from, to, name) {
    await this.api('sync-batch-move-item', undefined, 'POST', {
      src_parent_dir: from,
      dst_parent_dir: to,
      src_dirents: [name],
    });
  }
  async remove(path) {
    await this.api('file', path, 'DELETE');
  }
}

async function verifyRemote(box, path, identity) {
  const actual = await box.hash(path);
  requireValue(
    actual.sha256 === identity.sha256 && actual.size === identity.size,
    '云盘同名文件内容冲突；停止同步并保留文件',
  );
}

// Upload and verify before removing anything from Stable. Archive is never pruned here.
async function syncPackage({ box, identity, bytes, resolveIdentity }, folder, pattern) {
  requireValue(
    bytes.length === identity.size && digest(bytes) === identity.sha256,
    '本地安装包校验失败',
  );
  requireValue(pattern.exec(identity.name)?.[1] === identity.version, '分发包名称或版本无效');
  await box.initialize();
  if (folder === '/Offline') {
    const matches = (await box.list('/')).filter((entry) => entry.name === 'Offline');
    requireValue(
      matches.length <= 1 && (!matches.length || matches[0].type === 'dir'),
      'Offline 必须是独立目录',
    );
    if (!matches.length) await box.api('dir', '/Offline', 'POST', { operation: 'mkdir' });
  }
  const current = await box.list(folder);
  requireValue(
    current.every((e) => e.type === 'file' && pattern.test(e.name)),
    `${folder.slice(1)} 存在不支持的分发文件；请维护者核对`,
  );
  const old = current.filter((e) => e.name !== identity.name);
  const verified = [];
  // Validate all names and published identities before any mutation, including downgrade retries.
  for (const entry of old) {
    const version = pattern.exec(entry.name)[1];
    requireValue(
      older(version, identity.version),
      `${folder.slice(1)} 已有更新版本；跳过旧版本同步`,
    );
    const previous = await resolveIdentity(`v${version}`);
    requireValue(previous.name === entry.name, '旧安装包名称不一致');
    await verifyRemote(box, `${folder}/${entry.name}`, previous);
    verified.push(previous);
  }
  const archive = await box.list('/Archive');
  for (const previous of verified) {
    if (archive.some((e) => e.name === previous.name))
      await verifyRemote(box, `/Archive/${previous.name}`, previous);
  }
  if (!current.some((e) => e.name === identity.name))
    await box.upload(folder, identity.name, bytes);
  await verifyRemote(box, `${folder}/${identity.name}`, identity);
  for (const previous of verified) {
    // Repeat the new download check before each operation that removes an old public file.
    await verifyRemote(box, `${folder}/${identity.name}`, identity);
    if (archive.some((e) => e.name === previous.name)) {
      await verifyRemote(box, `/Archive/${previous.name}`, previous);
      await box.remove(`${folder}/${previous.name}`);
    } else {
      await box.move(folder, '/Archive', previous.name);
      await verifyRemote(box, `/Archive/${previous.name}`, previous);
    }
  }
  const after = await box.list(folder);
  requireValue(
    after.length === 1 && after[0].name === identity.name,
    `新版已保留；${folder.slice(1)} 尚需整理，可重试同一版本`,
  );
  return `同步成功：${folder.slice(1)} 已保留一个经过校验的正式分发包；Archive 保留回滚版本。`;
}

export async function syncStable(options) {
  return syncPackage(options, '/Stable', setupPattern);
}
export async function syncOffline(options) {
  return syncPackage(options, '/Offline', offlinePattern);
}

export async function syncStableRelease({
  box,
  identity,
  bytes,
  resolveIdentity,
  offline,
  updateIndex,
}) {
  requireValue(
    offline?.identity && offline.bytes && offline.resolveIdentity,
    '缺少同源完整离线 ZIP',
  );
  requireValue(
    offline.identity.version === identity.version &&
      offline.identity.gitSha === identity.gitSha &&
      offline.identity.releaseId === identity.releaseId,
    '安装器与离线 ZIP 必须属于同源同版正式发行',
  );
  await syncOffline({ box, ...offline });
  const result = await syncStable({ box, identity, bytes, resolveIdentity });
  if (!updateIndex) return result; // Historical releases have no update metadata.
  // A pointer is published only after upload/hash verification and complete
  // archival. Failed cleanup never advertises a new update to clients.
  await verifyRemote(box, `/Stable/${identity.name}`, identity);
  await verifyRemote(box, `/Offline/${offline.identity.name}`, offline.identity);
  const root = await box.list('/');
  const updates = root.find((e) => e.name === 'Updates');
  requireValue(!updates || updates.type === 'dir', 'Updates 必须是独立目录');
  if (!updates) await box.api('dir', '/Updates', 'POST', { operation: 'mkdir' });
  const indexIdentity = { size: updateIndex.length, sha256: digest(updateIndex) };
  const entries = await box.list('/Updates');
  if (entries.some((e) => e.name === 'latest.json')) {
    const previous = await box.hash('/Updates/latest.json');
    if (previous.sha256 === indexIdentity.sha256 && previous.size === indexIdentity.size)
      return result;
  }
  // Seafile replace=1 publishes one complete file after its upload completes;
  // the signature and original manifest travel in this one atomic envelope.
  await box.upload('/Updates', 'latest.json', updateIndex, true);
  await verifyRemote(box, '/Updates/latest.json', indexIdentity);
  return `${result} Updates 最新清单已发布并核对。`;
}

export async function probe(box) {
  await box.initialize();
  const name = `mizar-api-probe-${randomUUID()}.txt`;
  const folder = `/Archive/${name.slice(0, -4)}`;
  const bytes = Buffer.from('Mizar Box API probe\n');
  const expected = { size: bytes.length, sha256: digest(bytes) };
  await box.api('dir', folder, 'POST', { operation: 'mkdir' });
  try {
    await box.upload(folder, name, bytes);
    await verifyRemote(box, `${folder}/${name}`, expected);
    const metadata = await box.api('file', `${folder}/${name}`);
    requireValue(metadata, '探测文件元数据读取失败');
    await box.move(folder, '/Archive', name);
    await verifyRemote(box, `/Archive/${name}`, expected);
  } finally {
    // Only this unique probe file and its empty directory can be removed.
    for (const parent of [folder, '/Archive']) {
      if ((await box.list(parent)).some((e) => e.name === name))
        await box.remove(`${parent}/${name}`);
    }
    requireValue((await box.list(folder)).length === 0, '探测目录出现其他文件；保留目录供核对');
    await box.api('dir', folder, 'DELETE');
  }
  return '接口探测通过：列目录、上传、元数据、下载校验、移动与删除；Stable 保持原样。';
}

async function github(path) {
  const repo = process.env.GITHUB_REPOSITORY;
  requireValue(repo === 'Starfie1d1272/Mizar', '仅允许 Mizar 发布仓库');
  return (
    await checkedFetch(`https://api.github.com/repos/${repo}/${path}`, {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    })
  ).json();
}
async function downloadReleaseAsset(release, tag, name, maximum = 65536) {
  const assets = release.assets.filter((asset) => asset.name === name);
  requireValue(
    assets.length === 1 &&
      Number.isSafeInteger(assets[0].size) &&
      assets[0].size > 0 &&
      assets[0].size <= maximum &&
      assets[0].browser_download_url ===
        `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/${name}`,
    'Release 资产名称、大小或地址无效',
  );
  const response = await checkedFetch(assets[0].browser_download_url, {}, 600000);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requireValue(size <= assets[0].size && size <= maximum, 'Release 下载字节超限');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  requireValue(
    bytes.length === assets[0].size && assets[0].digest === `sha256:${digest(bytes)}`,
    'Release 下载身份不一致',
  );
  return bytes;
}
async function releaseIdentity(tag) {
  requireValue(/^v\d+\.\d+\.\d+$/.test(tag), '无效正式版本标签');
  const release = await github(`releases/tags/${tag}`);
  const ref = await github(`git/ref/tags/${tag}`);
  requireValue(ref.object.type === 'commit', '发布标签必须直接指向已验源码');
  const compact = release.assets.some((asset) => asset.name === 'update-index.json');
  let manifestBytes, distributionBytes, entries;
  if (compact) {
    entries = decodeEvidence(
      await downloadReleaseAsset(release, tag, evidenceName(tag.slice(1)), 67108864),
    );
    await verifyCoreEvidence(entries, ref.object.sha);
    await verifyPromotionEvidence(entries);
    await verifyEvidencePublication(entries, release);
    manifestBytes = entries.get('product/release-manifest.json');
    distributionBytes = entries.get('product/distribution-manifest.json');
  } else {
    manifestBytes = await downloadReleaseAsset(release, tag, 'release-manifest.json');
    distributionBytes = await downloadReleaseAsset(release, tag, 'distribution-manifest.json');
    const directory = await mkdtemp(join(tmpdir(), 'mizar-mirror-source-'));
    try {
      for (const [name, bytes] of [
        ['release-manifest.json', manifestBytes],
        ['distribution-manifest.json', distributionBytes],
      ]) {
        await writeFile(join(directory, name), bytes);
        await promisify(execFile)(
          'gh',
          releaseAttestationArgs(join(directory, name), ref.object.sha),
        );
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  const manifest = JSON.parse(manifestBytes),
    distribution = JSON.parse(distributionBytes);
  const identity = validateRelease(release, manifest, distribution, tag, ref.object.sha);
  identity.offline = validateOfflineRelease(release, manifest, tag, ref.object.sha);
  identity.release = release;
  if (compact) {
    const expected = makeUpdateIndex(
      entries.get('product/update-manifest.json'),
      entries.get('product/update-provenance.json'),
      entries.get('update-publication.json'),
      entries.get('update-publication-provenance.json'),
    );
    const update = JSON.parse(entries.get('product/update-manifest.json'));
    requireValue(
      update.version === identity.version &&
        update.gitSha === identity.gitSha &&
        update.installer.name === identity.name &&
        update.installer.sha256 === identity.sha256 &&
        update.installer.bytes === identity.size,
      '更新信封与同版正式安装包不一致',
    );
    identity.updateIndex = await downloadReleaseAsset(release, tag, 'update-index.json', 2097152);
    requireValue(identity.updateIndex.equals(expected), '公开更新信封与已验原证明不一致');
  }
  return identity;
}

async function main() {
  const mode = process.env.BOX_SYNC_MODE || 'sync';
  requireValue(['sync', 'probe'].includes(mode), '未知镜像操作');
  let tag = process.env.RELEASE_TAG;
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run') {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const run = await github(`actions/runs/${event.workflow_run.id}`);
    requireValue(
      run.conclusion === 'success' &&
        run.event === 'workflow_dispatch' &&
        run.path === '.github/workflows/release-promotion.yml' &&
        run.repository.full_name === process.env.GITHUB_REPOSITORY,
      '触发来源不是成功的发布晋级',
    );
    const { jobs } = await github(`actions/runs/${run.id}/jobs?per_page=100`);
    tag = promotionTag(run, jobs);
  }
  if (mode === 'sync' && /^v\d+\.\d+\.\d+-rc\.\d+$/.test(tag ?? ''))
    return '候选版本：Stable 与 Archive 保持原样。';
  const box = new BoxClient(process.env.MIZAR_BOX_REPO_TOKEN);
  if (mode === 'probe') return probe(box);
  const identity = await releaseIdentity(tag);
  requireValue(
    identity.asset.browser_download_url ===
      `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/${identity.name}`,
    '安装包地址不一致',
  );
  const release = identity.release;
  const bytes = await downloadReleaseAsset(release, tag, identity.name, identity.size);
  const offlineBytes = await downloadReleaseAsset(
    release,
    tag,
    identity.offline.name,
    identity.offline.size,
  );
  const metadata = release.assets.filter((a) =>
    [
      'update-manifest.json',
      'update-provenance.json',
      'update-publication.json',
      'update-publication-provenance.json',
    ].includes(a.name),
  );
  let updateIndex = identity.updateIndex;
  if (!updateIndex && metadata.length) {
    requireValue(metadata.length === 4, '正式更新资料缺少清单、来源证明或发布确认');
    const assets = [];
    const directory = await mkdtemp(join(tmpdir(), 'mizar-update-proof-'));
    try {
      for (const kind of ['manifest', 'provenance', 'publication', 'publication-provenance']) {
        const asset = metadata.find((a) => a.name === `update-${kind}.json`);
        requireValue(
          asset &&
            asset.size <= (kind.includes('provenance') ? 2097152 : 65536) &&
            asset.browser_download_url ===
              `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/update-${kind}.json`,
          '更新资料地址或大小无效',
        );
        const data = await downloadReleaseAsset(
          release,
          tag,
          asset.name,
          kind.includes('provenance') ? 2097152 : 65536,
        );
        requireValue(
          data.length === asset.size && asset.digest === `sha256:${digest(data)}`,
          '更新资料下载身份不一致',
        );
        await writeFile(join(directory, asset.name), data);
        assets.push({ kind, bytes: data, size: data.length, sha256: digest(data) });
      }
      const update = JSON.parse(assets.find((a) => a.kind === 'manifest').bytes);
      // The same main signer and exact-source policy owns Promotion and mirrors.
      await promisify(execFile)(
        'gh',
        releaseAttestationArgs(
          join(directory, 'update-manifest.json'),
          update.gitSha,
          join(directory, 'update-provenance.json'),
        ),
      );
      requireValue(
        update.version === identity.version &&
          update.gitSha === identity.gitSha &&
          update.installer.name === identity.name &&
          update.installer.sha256 === identity.sha256 &&
          update.installer.bytes === identity.size,
        '更新清单与正式安装包不一致',
      );
      const publication = JSON.parse(assets.find((a) => a.kind === 'publication').bytes);
      assertPublication(publication, assets.find((a) => a.kind === 'manifest').bytes, update);
      requireValue(
        publication.releaseId === release.id && publication.publishedAt === release.published_at,
        '发布确认与正式 Release 不一致',
      );
      await promisify(execFile)(
        'gh',
        releaseAttestationArgs(
          join(directory, 'update-publication.json'),
          publication.promotionSha,
          join(directory, 'update-publication-provenance.json'),
          'promotion',
        ),
      );
      updateIndex = makeUpdateIndex(
        assets.find((a) => a.kind === 'manifest').bytes,
        assets.find((a) => a.kind === 'provenance').bytes,
        assets.find((a) => a.kind === 'publication').bytes,
        assets.find((a) => a.kind === 'publication-provenance').bytes,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return syncStableRelease({
    box,
    identity,
    bytes,
    resolveIdentity: releaseIdentity,
    offline: {
      identity: identity.offline,
      bytes: offlineBytes,
      resolveIdentity: async (tag) => (await releaseIdentity(tag)).offline,
    },
    updateIndex,
  });
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const result = await main();
    console.log(result);
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `${result}\n`);
  } catch (error) {
    // Never include server response bodies, nested network causes or signed URLs.
    const message =
      error instanceof MirrorError
        ? error.message
        : '返回内容或配置无效；请核对云盘接口与发布资料后重试';
    console.error(message);
    process.exitCode = 1;
    if (process.env.GITHUB_STEP_SUMMARY)
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `镜像未完成：${message}。GitHub Release 保持可用，修正后重试 Box Sync。\n`,
      );
  }
}
