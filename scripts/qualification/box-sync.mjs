import {
  MACHINE_METADATA_NAME,
  MACHINE_METADATA_MAX_BYTES,
  readMachineMetadata,
} from '../../packages/resource-pack-contract/transport.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, appendFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Buffer, Blob } from 'node:buffer';
import { URL } from 'node:url';
import { releaseAttestationArgs } from './release-identity.mjs';
import { assertPublication } from './update-publication.mjs';
import { makeUpdateIndex } from './update-index.mjs';
import { RESOURCE_ASSET_NAMES as resourceNames } from '../../packages/resource-pack-contract/catalog.mjs';
import { LIMITS } from '../../packages/resource-pack-contract/index.mjs';
import { resourceAssetInventory } from '../ci/resource-release.mjs';
import { apiRequest, multipartUpload } from './box-upload.mjs';
import { curlMultipartUpload } from './box-curl-upload.mjs';

const { fetch, AbortSignal, FormData } = globalThis;

const origin = 'https://box.nju.edu.cn';
const offlinePattern = /^Mizar-v(\d+\.\d+\.\d+)-Windows-x64\.zip$/;
const downloadsFolder = '/Stable/Downloads';
const publicShare = 'https://box.nju.edu.cn/d/91dec4c27e5d47f38fcf/';
const bootstrapPattern = /^Mizar-v(\d+\.\d+\.\d+)-Windows-x64-WebInstaller\.exe$/;
const setupPattern = /^Mizar-v(\d+\.\d+\.\d+)-Windows-x64-Setup\.exe$/;
const shaPattern = /^[a-f0-9]{64}$/;
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
class MirrorError extends Error {
  constructor(message, httpStatus) {
    super(message);
    this.httpStatus = httpStatus;
  }
}
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
    .map((job) => /^发布 Mizar (v\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.[1-9]\d*)?)$/.exec(job.name))
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

const networkCodes = new Set([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);
function safeNetworkCode(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  const code = error?.cause?.code || error?.code;
  if (code === 'BOX_RESPONSE_LIMIT') return 'response_limit';
  if (code === 'BOX_CURL_FAILED') return code;
  return networkCodes.has(code) ? code : 'network';
}
function directoryCategory(path) {
  const category = path?.split('/')[1];
  return ['Stable', 'Offline', 'Runtime', 'Resources', 'Updates', 'Archive'].includes(category)
    ? category
    : 'root';
}
async function boxStage(stage, action) {
  const started = globalThis.performance.now();
  console.log(`Box ${stage} 开始`);
  try {
    const result = await action();
    console.log(`Box ${stage} 完成（${Math.round(globalThis.performance.now() - started)}ms）`);
    return result;
  } catch (error) {
    const elapsed = Math.round(globalThis.performance.now() - started);
    console.log(`Box ${stage} 失败（${elapsed}ms）`);
    if (error instanceof MirrorError)
      throw Object.assign(
        new MirrorError(`Box ${stage}（${elapsed}ms）：${error.message}`, error.httpStatus),
        {
          uploadOutcomeUnknown: error.uploadOutcomeUnknown,
          retrySafeUpload: error.retrySafeUpload,
          retryableRead: error.retryableRead,
        },
      );
    const code = safeNetworkCode(error);
    if (code !== 'network')
      throw new MirrorError(`Box ${stage}（${elapsed}ms）：网络请求失败（${code}）；保留现有文件`);
    throw error;
  }
}
function retryAfterMs(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}
async function retryWait(attempt, reason, deadline, retryAfter, signal) {
  const delay = Math.max(Math.ceil(Math.random() * 1000 * 2 ** attempt), retryAfterMs(retryAfter));
  requireValue(delay < deadline - Date.now(), '重试等待超出本次恢复预算；保留现有文件');
  console.log(`Box 暂态失败（${reason}），${delay}ms 后重试 ${attempt + 1}/2`);
  await sleep(delay, undefined, { signal });
}
async function checkedFetch(url, options = {}, timeout = 120000, transport = fetch, consume) {
  // Error text and response bodies may contain temporary upload URLs or credentials.
  const readOnlyBox =
    ['GET', 'HEAD'].includes((options.method ?? 'GET').toUpperCase()) &&
    new URL(url).origin === origin;
  const temporaryStatuses = new Set([408, 429, 500, 502, 503, 504]);
  const deadline = Date.now() + timeout * (readOnlyBox ? 3 : 1) + 30000;
  for (let attempt = 0; ; attempt++) {
    options.signal?.throwIfAborted();
    requireValue(Date.now() < deadline, '请求恢复预算已用完；保留现有文件');
    const signal = AbortSignal.any([
      AbortSignal.timeout(Math.min(timeout, Math.max(1, deadline - Date.now()))),
      ...(options.signal ? [options.signal] : []),
    ]);
    let response;
    try {
      response = await transport(url, { ...options, signal });
      if (response.ok && consume) return await consume(response);
    } catch (error) {
      const code = safeNetworkCode(error);
      if (
        readOnlyBox &&
        (networkCodes.has(code) || (code === 'timeout' && signal.aborted)) &&
        attempt < 2 &&
        !options.signal?.aborted
      ) {
        await retryWait(attempt, code, deadline, undefined, options.signal);
        continue;
      }
      throw Object.assign(
        new MirrorError(
          `网络请求失败或超时（${code}，每次请求上限${timeout}ms，已尝试${attempt + 1}次）；保留现有文件`,
          error?.httpStatus,
        ),
        {
          retrySafeUpload: error?.retrySafeUpload === true,
          uploadOutcomeUnknown:
            code === 'BOX_CURL_FAILED' || networkCodes.has(code) || code === 'timeout',
          retryableRead: readOnlyBox && (networkCodes.has(code) || code === 'timeout'),
        },
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (readOnlyBox && temporaryStatuses.has(response.status) && attempt < 2) {
        await retryWait(
          attempt,
          `HTTP ${response.status}`,
          deadline,
          response.headers.get('retry-after'),
          options.signal,
        );
        continue;
      }
      throw Object.assign(
        new MirrorError(
          `远端请求失败（HTTP ${response.status}，已尝试${attempt + 1}次）；保留现有文件`,
          response.status,
        ),
        { retryableRead: readOnlyBox && temporaryStatuses.has(response.status) },
      );
    }
    return response;
  }
}

export class BoxClient {
  constructor(
    token,
    uploadTransport = curlMultipartUpload,
    apiTransport = apiRequest,
    downloadTransport = fetch,
  ) {
    requireValue(token, '未配置 MIZAR_BOX_REPO_TOKEN；在 Actions 配置后重试');
    this.token = token;
    this.uploadTransport = uploadTransport;
    this.apiTransport = apiTransport;
    this.downloadTransport = downloadTransport;
  }
  async api(endpoint, path, method = 'GET', body, signal) {
    const safeEndpoint = [
      'repo-info',
      'dir',
      'download-link',
      'upload-link',
      'sync-batch-move-item',
      'sync-batch-copy-item',
      'file',
    ].includes(endpoint)
      ? endpoint
      : 'other';
    return boxStage(`接口/${safeEndpoint}/${directoryCategory(path)}`, async () => {
      const url = new URL(`/api/v2.1/via-repo-token/${endpoint}/`, origin);
      if (path !== undefined) url.searchParams.set('path', path);
      const headers = { Authorization: `Token ${this.token}`, Accept: 'application/json' };
      if (body) headers['Content-Type'] = 'application/json';
      const response = await checkedFetch(
        url,
        {
          method,
          headers,
          redirect: 'error',
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal,
        },
        20000,
        this.apiTransport,
      );
      try {
        return await response.json();
      } catch (error) {
        // JSON parse messages can quote credentials or temporary URLs from the response.
        const kind = error instanceof SyntaxError ? 'SyntaxError' : 'unknown';
        throw new MirrorError(`云盘接口返回无效 JSON（解析阶段，${kind}）；保留现有文件`);
      }
    });
  }
  async list(path, signal) {
    // This directory is the verified public share; do not send a repository token.
    if (path === downloadsFolder) return readPublicDownloadDirectory(signal);
    const result = await this.api('dir', path, 'GET', undefined, signal);
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
  async hash(path, signal) {
    return boxStage(`回读/${directoryCategory(path)}`, async () => {
      const url = this.temporaryUrl(
        await this.api('download-link', path, 'GET', undefined, signal),
      );
      return checkedFetch(
        url,
        { redirect: 'error', signal },
        600000,
        this.downloadTransport,
        async (response) => {
          const hash = createHash('sha256');
          let size = 0;
          for await (const chunk of response.body) {
            hash.update(chunk);
            size += chunk.length;
          }
          return { sha256: hash.digest('hex'), size };
        },
      );
    });
  }
  async upload(path, name, bytes, replace = false) {
    return boxStage(`上传/${directoryCategory(path)}`, async () => {
      const deadline = Date.now() + 900000;
      const signal = AbortSignal.timeout(900000);
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const url = this.temporaryUrl(
          await this.api('upload-link', path, 'GET', undefined, signal),
        );
        url.searchParams.set('ret-json', '1');
        const form = new FormData();
        form.set('parent_dir', path);
        form.set('replace', replace ? '1' : '0');
        form.set('file', new Blob([bytes]), name);
        try {
          const result = await (
            await checkedFetch(
              url,
              { method: 'POST', body: form, redirect: 'error', signal },
              Math.min(600000, Math.max(1, deadline - Date.now())),
              this.uploadTransport,
            )
          ).json();
          requireValue(
            Array.isArray(result) && result.length === 1 && result[0].name === name,
            '上传回执不一致；检查目录后重试',
          );
          return;
        } catch (error) {
          if (!error.uploadOutcomeUnknown || error.httpStatus === 401 || error.httpStatus === 403)
            throw error;
          // Reconciliation is read-only and shares this upload's total budget.
          // A completed body might still commit later: absence alone never authorizes replay.
          let existing;
          try {
            existing = (await this.list(path, signal)).filter((entry) => entry.name === name);
          } catch (readError) {
            // A failed reconciliation cannot make an uncertain write safe to replay.
            if (!error.retrySafeUpload || replace) readError.retryableRead = false;
            throw readError;
          }
          requireValue(existing.length <= 1, '上传恢复发现重名文件；保留远端内容');
          if (existing.length) {
            requireValue(existing[0].type === 'file', '上传恢复目标不是文件');
            let actual;
            try {
              actual = await this.hash(path + '/' + name, signal);
            } catch (readError) {
              if (!error.retrySafeUpload || replace) readError.retryableRead = false;
              throw readError;
            }
            requireValue(
              actual.size === bytes.length && actual.sha256 === digest(bytes),
              '上传恢复发现不同内容；保留远端文件',
            );
            console.log('Box 上传回执丢失，远端原字节已核验，跳过重传');
            return;
          }
          if (!error.retrySafeUpload || replace || attempt === 2) throw error;
          await retryWait(attempt, '上传未发送且目标缺失', deadline, undefined, signal);
        }
      }
    });
  }
  async move(from, to, name) {
    await this.api('sync-batch-move-item', undefined, 'POST', {
      src_parent_dir: from,
      dst_parent_dir: to,
      src_dirents: [name],
    });
  }
  async copy(from, to, name) {
    await this.api('sync-batch-copy-item', undefined, 'POST', {
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
async function ensureDownloads(box) {
  const directories = (await box.list('/Stable')).filter((e) => e.name === 'Downloads');
  requireValue(
    directories.length <= 1 && (!directories.length || directories[0].type === 'dir'),
    'Downloads 必须是独立目录',
  );
  if (!directories.length) await box.api('dir', downloadsFolder, 'POST', { operation: 'mkdir' });
}
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
  if (folder === downloadsFolder) await ensureDownloads(box);
  const current = await box.list(folder);
  requireValue(
    new Set(current.map((e) => e.name)).size === current.length &&
      current.every(
        (e) =>
          (folder === '/Stable' && e.type === 'dir' && e.name === 'Downloads') ||
          (e.type === 'file' &&
            (pattern.test(e.name) ||
              (folder === '/Stable' &&
                (setupPattern.test(e.name) || bootstrapPattern.test(e.name))) ||
              (folder === downloadsFolder &&
                (offlinePattern.test(e.name) || bootstrapPattern.test(e.name))))),
      ),
    `${folder.slice(1)} 存在不支持的分发文件；请维护者核对`,
  );
  for (const entry of current.filter((e) => e.type === 'file')) {
    const version = (offlinePattern.exec(entry.name) ||
      setupPattern.exec(entry.name) ||
      bootstrapPattern.exec(entry.name))?.[1];
    requireValue(
      version === identity.version || older(version, identity.version),
      '已有更新版本，拒绝降级同步',
    );
  }
  const old = current.filter((e) => pattern.test(e.name) && e.name !== identity.name);
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
    // The new bytes were verified above. Old bytes remain verified in Archive;
    // the new public bytes are read back again before publishing the update pointer.
    if (archive.some((e) => e.name === previous.name)) {
      await verifyRemote(box, `/Archive/${previous.name}`, previous);
      await box.remove(`${folder}/${previous.name}`);
    } else {
      await box.move(folder, '/Archive', previous.name);
      await verifyRemote(box, `/Archive/${previous.name}`, previous);
    }
  }
  const after = (await box.list(folder)).filter((e) => pattern.test(e.name));
  requireValue(
    after.length === 1 && after[0].name === identity.name,
    `新版已保留；${folder.slice(1)} 尚需整理，可重试同一版本`,
  );
  return `同步成功：${folder.slice(1)} 已保留一个经过校验的正式分发包；Archive 保留回滚版本。`;
}

export async function syncBootstrap(options) {
  return syncPackage(options, downloadsFolder, bootstrapPattern);
}

// Retire redundant distributions without deleting the only copy or trusting filenames.
// Resolve and verify every source/destination before changing the public directory.
async function planFullDownloadRetirement(box, version, resolveIdentity) {
  const plans = [];
  const archive = await box.list('/Archive');
  for (const folder of ['/Stable', downloadsFolder]) {
    const entries = await box.list(folder);
    requireValue(
      new Set(entries.map((entry) => entry.name)).size === entries.length,
      '分发目录存在重复文件',
    );
    for (const entry of entries) {
      // Music is independent user content, never an application distribution source.
      if (
        folder === '/Stable' &&
        entry.type === 'dir' &&
        (entry.name === 'Downloads' || entry.name === 'Music')
      )
        continue;
      const match =
        setupPattern.exec(entry.name) ||
        offlinePattern.exec(entry.name) ||
        bootstrapPattern.exec(entry.name);
      requireValue(entry.type === 'file' && match, '分发目录存在未知内容，保留原文件');
      const previousVersion = match[1];
      requireValue(
        previousVersion === version || older(previousVersion, version),
        '已有更新版本，拒绝降级同步',
      );
      if (folder === downloadsFolder && bootstrapPattern.test(entry.name)) continue;
      const release = await resolveIdentity('v' + previousVersion);
      const identity = offlinePattern.test(entry.name)
        ? release.offline
        : bootstrapPattern.test(entry.name)
          ? release.bootstrap
          : release;
      requireValue(identity?.name === entry.name, '待归档文件缺少原发行身份');
      await verifyRemote(box, folder + '/' + entry.name, identity);
      const existing = archive.find((row) => row.name === entry.name);
      if (existing) {
        requireValue(existing.type === 'file', '归档目标不是文件');
        await verifyRemote(box, '/Archive/' + entry.name, identity);
      }
      plans.push({ folder, identity, existing: Boolean(existing) });
    }
  }
  return async () => {
    for (const { folder, identity, existing } of plans) {
      if (existing) {
        await verifyRemote(box, '/Archive/' + identity.name, identity);
        await box.remove(folder + '/' + identity.name);
      } else await box.move(folder, '/Archive', identity.name);
      await verifyRemote(box, '/Archive/' + identity.name, identity);
    }
  };
}

export async function syncUserDownloads({
  box,
  bootstrap,
  resolveIdentity,
  accept = verifyPublicDownloads,
}) {
  requireValue(bootstrap?.identity && bootstrap.bytes, '用户下载缺少轻量安装器');
  await ensureDownloads(box);
  const retire = await planFullDownloadRetirement(box, bootstrap.identity.version, resolveIdentity);
  await syncBootstrap({ box, ...bootstrap });
  await retire();
  await accept({ bootstrap });
}

// One public directory reader serves migration inventory and anonymous acceptance.
// It cannot list private folders or authorize a write; every retired file still
// requires its original signed release identity and authenticated full-byte readback.
export async function readPublicDownloadDirectory(signal) {
  const listing = await (
    await checkedFetch(
      'https://box.nju.edu.cn/api/v2.1/share-links/91dec4c27e5d47f38fcf/dirents/?path=%2FDownloads%2F',
      { redirect: 'error', cache: 'no-store', signal },
      20000,
    )
  ).json();
  requireValue(
    listing.dir_path === downloadsFolder + '/' &&
      Array.isArray(listing.dirent_list) &&
      listing.dirent_list.length <= 100,
    '公开下载目录身份不一致',
  );
  const names = new Set();
  return listing.dirent_list.map((entry) => {
    requireValue(
      typeof entry.file_name === 'string' &&
        entry.file_name.length > 0 &&
        !/[\\/]/.test(entry.file_name) &&
        !names.has(entry.file_name) &&
        entry.is_dir === false &&
        entry.file_path === '/Downloads/' + entry.file_name &&
        Number.isSafeInteger(entry.size) &&
        entry.size >= 0,
      '公开下载目录存在无效或重复文件',
    );
    names.add(entry.file_name);
    return { name: entry.file_name, size: entry.size, type: 'file' };
  });
}

// Anonymous access is a separate acceptance boundary, never inferred from the upload token.
export async function verifyPublicDownloads({ bootstrap }) {
  requireValue(bootstrap?.identity, '匿名验收缺少原文件身份');
  const listing = await readPublicDownloadDirectory();
  const files = [bootstrap.identity];
  requireValue(
    listing.length === 1 &&
      listing[0].name === bootstrap.identity.name &&
      listing[0].size === bootstrap.identity.size,
    '匿名用户入口未就绪或文件不一致',
  );
  for (const identity of files) {
    let url = new URL('files/', publicShare);
    url.searchParams.set('p', '/Downloads/' + identity.name);
    url.searchParams.set('dl', '1');
    let response;
    for (let redirects = 0; redirects < 5; redirects++) {
      requireValue(
        url.origin === origin &&
          !url.username &&
          !url.password &&
          (url.pathname.startsWith('/d/91dec4c27e5d47f38fcf/files/') ||
            url.pathname.startsWith('/seafhttp/files/')),
        '匿名下载地址超出允许范围',
      );
      // A redirect is expected from the shared file page; do not forward credentials.
      response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(600000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        requireValue(location, '匿名下载重定向无效');
        url = new URL(location, url);
        continue;
      }
      break;
    }
    requireValue(response?.ok && response.body, '匿名下载未完成');
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      requireValue(size <= identity.size, '匿名文件大小不一致');
      hash.update(chunk);
    }
    requireValue(
      size === identity.size && hash.digest('hex') === identity.sha256,
      '匿名下载原字节不一致',
    );
  }
  return '匿名验收成功：用户入口仅提供轻量 EXE，下载原字节一致；完整离线 ZIP 由 GitHub 提供。';
}

export async function syncResourceFiles({
  box,
  version,
  files,
  metadataInRuntime = false,
  reuseVersion,
}) {
  requireValue(/^\d+\.\d+\.\d+$/.test(version), '资源镜像版本无效');
  requireValue(
    !reuseVersion || (/^\d+\.\d+\.\d+$/.test(reuseVersion) && older(reuseVersion, version)),
    '原资源镜像版本无效',
  );
  const zip = files.filter((f) => /^Mizar-official-epl-default-\d+\.\d+\.\d+\.zip$/.test(f.name));
  const expected = [...(metadataInRuntime ? [] : Object.values(resourceNames)), zip[0]?.name];
  requireValue(
    zip.length === 1 &&
      files.length === expected.length &&
      new Set(files.map((f) => f.name)).size === expected.length &&
      files.every(
        (f) =>
          expected.includes(f.name) && f.bytes.length === f.size && digest(f.bytes) === f.sha256,
      ),
    '资源镜像缺少唯一原文件或摘要不一致',
  );
  const root = await box.list('/');
  const resources = root.filter((e) => e.name === 'Resources');
  requireValue(
    resources.length <= 1 && (!resources.length || resources[0].type === 'dir'),
    'Resources 必须是独立目录',
  );
  if (!resources.length) await box.api('dir', '/Resources', 'POST', { operation: 'mkdir' });
  const folders = (await box.list('/Resources')).filter((e) => e.name === `v${version}`);
  requireValue(
    folders.length <= 1 && (!folders.length || folders[0].type === 'dir'),
    '资源版本目录无效',
  );
  const folder = `/Resources/v${version}`;
  if (!folders.length) await box.api('dir', folder, 'POST', { operation: 'mkdir' });
  const existing = await box.list(folder);
  requireValue(
    existing.every((e) => e.type === 'file' && expected.includes(e.name)) &&
      new Set(existing.map((e) => e.name)).size === existing.length,
    '已有资源目录含未知或重复文件',
  );
  for (const file of files.filter((f) => existing.some((e) => e.name === f.name)))
    await verifyRemote(box, `${folder}/${file.name}`, file);
  for (const file of files.filter((f) => !existing.some((e) => e.name === f.name))) {
    let copied = false;
    if (file.name.endsWith('.zip') && reuseVersion) {
      const source = `/Resources/v${reuseVersion}`;
      if (
        (await box.list('/Resources')).some(
          (e) => e.name === `v${reuseVersion}` && e.type === 'dir',
        ) &&
        (await box.list(source)).some((e) => e.name === file.name && e.type === 'file')
      ) {
        // A directory hint is not provenance: both sides must match the currently verified original ZIP.
        await verifyRemote(box, `${source}/${file.name}`, file);
        try {
          await box.copy(source, folder, file.name);
          copied = true;
        } catch (error) {
          // 404 may mean the verified source disappeared, not an unsupported endpoint.
          if (![405, 501].includes(error.httpStatus) && !error.uploadOutcomeUnknown) throw error;
          let destinations;
          try {
            destinations = (await box.list(folder)).filter((e) => e.name === file.name);
          } catch (readError) {
            if (error.uploadOutcomeUnknown) readError.retryableRead = false;
            throw readError;
          }
          requireValue(
            destinations.length <= 1 && destinations.every((e) => e.type === 'file'),
            '资源复制目标无效；保留现场',
          );
          if (destinations.length) {
            try {
              await verifyRemote(box, `${folder}/${file.name}`, file);
            } catch (readError) {
              if (error.uploadOutcomeUnknown) readError.retryableRead = false;
              throw readError;
            }
            copied = true;
          }
          // A timed-out copy may still complete later. Only a verified existing
          // destination proves success; absence does not authorize another write.
          if (!copied && error.uploadOutcomeUnknown) throw error;
          if (!copied) console.log('Box 服务端复制未提供；使用已验证原资源上传，保留原目录');
        }
      }
    }
    if (!copied) await box.upload(folder, file.name, file.bytes);
    await verifyRemote(box, `${folder}/${file.name}`, file);
  }
}
export async function syncRuntimeFiles({ box, version, files }) {
  requireValue(
    /^\d+\.\d+\.\d+$/.test(version) &&
      files.length === 2 &&
      new Set(files.map((f) => f.name)).size === 2 &&
      files.some((f) => f.name === MACHINE_METADATA_NAME) &&
      files.some((f) => f.name === `Mizar-v${version}-Windows-x64-Core-Setup.exe`) &&
      files.every((f) => f.bytes.length === f.size && digest(f.bytes) === f.sha256),
    'Invalid immutable Runtime files',
  );
  readMachineMetadata(files.find((f) => f.name === MACHINE_METADATA_NAME).bytes);
  const root = await box.list('/');
  const runtime = root.filter((e) => e.name === 'Runtime');
  requireValue(
    runtime.length <= 1 && (!runtime.length || runtime[0].type === 'dir'),
    'Invalid Runtime directory',
  );
  if (!runtime.length) await box.api('dir', '/Runtime', 'POST', { operation: 'mkdir' });
  const versionName = 'v' + version;
  const versions = (await box.list('/Runtime')).filter((e) => e.name === versionName);
  requireValue(
    versions.length <= 1 && (!versions.length || versions[0].type === 'dir'),
    'Invalid Runtime version',
  );
  const folder = '/Runtime/' + versionName;
  if (!versions.length) await box.api('dir', folder, 'POST', { operation: 'mkdir' });
  const existing = await box.list(folder);
  requireValue(
    new Set(existing.map((e) => e.name)).size === existing.length &&
      existing.every((e) => e.type === 'file' && files.some((f) => f.name === e.name)),
    'Unexpected Runtime content',
  );
  for (const file of files.filter((f) => existing.some((e) => e.name === f.name)))
    await verifyRemote(box, folder + '/' + file.name, file);
  for (const file of files.filter((f) => !existing.some((e) => e.name === f.name))) {
    await box.upload(folder, file.name, file.bytes);
    await verifyRemote(box, folder + '/' + file.name, file);
  }
}
async function syncStableReleaseOnce({
  box,
  identity,
  resolveIdentity,
  bootstrap,
  resources,
  updateIndex,
  runtime,
  resourceReuseVersion,
  accept,
}) {
  requireValue(
    bootstrap?.identity && runtime?.length && resources?.length && updateIndex,
    '拆分分发必须提供轻量安装器、Core 与已签更新清单；旧版本请从 GitHub 获取',
  );
  requireValue(
    !older(identity.version, '1.6.0') &&
      bootstrap.identity.version === identity.version &&
      bootstrap.identity.gitSha === identity.gitSha &&
      bootstrap.identity.releaseId === identity.releaseId,
    '仅同步同源同版的 1.6.0 及以后拆分发行',
  );
  await box.initialize();
  // Wait for every writer before reporting failure. No failed sibling may publish the pointer.
  const settle = async (tasks) => {
    const results = await Promise.allSettled(tasks);
    // Never restart after a sibling's uncertain write merely because a read
    // happened to fail first. Every in-flight operation has settled here.
    const failed =
      results.find((result) => result.status === 'rejected' && !result.reason?.retryableRead) ??
      results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    return results.map((result) => result.value);
  };
  await settle([
    runtime ? syncRuntimeFiles({ box, version: identity.version, files: runtime }) : undefined,
    resources
      ? syncResourceFiles({
          box,
          version: identity.version,
          files: resources,
          metadataInRuntime: Boolean(runtime),
          reuseVersion: resourceReuseVersion,
        })
      : undefined,
    syncUserDownloads({ box, bootstrap, resolveIdentity, accept }),
  ]);
  // A pointer is published only after upload/hash verification and complete
  // archival. Failed cleanup never advertises a new update to clients.
  const readbacks = [
    [`${downloadsFolder}/${bootstrap.identity.name}`, bootstrap.identity],
    ...(resources ?? []).map((file) => [`/Resources/v${identity.version}/${file.name}`, file]),
    ...(runtime ?? []).map((file) => [`/Runtime/v${identity.version}/${file.name}`, file]),
  ];
  // Complete every post-write full hash before publishing. Bound only independent
  // reads; a failed batch joins its active siblings and starts no further batch.
  await boxStage('发布前完整回读', async () => {
    for (let offset = 0; offset < readbacks.length; offset += 3)
      await settle(
        readbacks.slice(offset, offset + 3).map(([path, file]) => verifyRemote(box, path, file)),
      );
  });
  const root = await box.list('/');
  const updates = root.find((e) => e.name === 'Updates');
  requireValue(!updates || updates.type === 'dir', 'Updates 必须是独立目录');
  if (!updates) await box.api('dir', '/Updates', 'POST', { operation: 'mkdir' });
  const indexIdentity = { size: updateIndex.length, sha256: digest(updateIndex) };
  const entries = await box.list('/Updates');
  if (entries.some((e) => e.name === 'latest.json')) {
    const previous = await box.hash('/Updates/latest.json');
    if (previous.sha256 === indexIdentity.sha256 && previous.size === indexIdentity.size)
      return '拆分分发已核验，更新清单保持一致。';
  }
  // Seafile replace=1 publishes one complete file after its upload completes;
  // the signature and original manifest travel in this one atomic envelope.
  await box.upload('/Updates', 'latest.json', updateIndex, true);
  await verifyRemote(box, '/Updates/latest.json', indexIdentity);
  return '同步成功：拆分分发与历史归档已核验，Updates 最新清单已发布并核对。';
}

export async function syncStableRelease(options) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await syncStableReleaseOnce(options);
    } catch (error) {
      if (!error.retryableRead || attempt >= 2) throw error;
      console.log(`Box 读取暂态失败，核对已有文件后重新同步（${attempt + 1}/2）`);
      await sleep(1000 * 2 ** attempt);
    }
  }
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
  const carrier = release.assets.some((a) => a.name === MACHINE_METADATA_NAME)
    ? await downloadReleaseAsset(release, tag, MACHINE_METADATA_NAME, MACHINE_METADATA_MAX_BYTES)
    : undefined;
  const originals = carrier ? readMachineMetadata(carrier) : undefined;
  requireValue(
    !originals ||
      [
        'release-manifest.json',
        'distribution-manifest.json',
        'core-release-manifest.json',
        'core-distribution-manifest.json',
        'update-index.json',
        ...Object.values(resourceNames),
      ].every((name) => originals.has(name)),
    'Carrier is missing required original machine bytes',
  );
  const manifestBytes =
    originals?.get('release-manifest.json') ??
    (await downloadReleaseAsset(release, tag, 'release-manifest.json'));
  const distributionBytes =
    originals?.get('distribution-manifest.json') ??
    (await downloadReleaseAsset(release, tag, 'distribution-manifest.json'));
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
  const manifest = JSON.parse(manifestBytes),
    distribution = JSON.parse(distributionBytes);
  const identity = validateRelease(release, manifest, distribution, tag, ref.object.sha);
  identity.offline = validateOfflineRelease(release, manifest, tag, ref.object.sha);
  identity.release = release;
  identity.manifest = manifest;
  if (originals) {
    const coreBytes = originals.get('core-release-manifest.json'),
      coreDistributionBytes = originals.get('core-distribution-manifest.json');
    requireValue(coreBytes && coreDistributionBytes, 'Missing Core machine metadata');
    const core = JSON.parse(coreBytes),
      distribution = JSON.parse(coreDistributionBytes);
    requireValue(
      core.resourceMode === 'core' &&
        !core.developmentOnly &&
        core.desktopBuildProfile === 'release' &&
        core.gitSha === manifest.gitSha &&
        core.appVersion === manifest.appVersion &&
        core.derivedFrom?.archiveSha256 === manifest.archiveSha256 &&
        core.archive === `Mizar-v${identity.version}-Windows-x64-Core.zip` &&
        distribution.archive === `Mizar-v${identity.version}-Windows-x64-Core-Setup.exe` &&
        distribution.originalArchiveSha256 === core.archiveSha256 &&
        distribution.contentDigest === core.contentDigest &&
        distribution.gitSha === core.gitSha &&
        distribution.appVersion === core.appVersion,
      'Core and Full identities differ',
    );
    const temp = await mkdtemp(join(tmpdir(), 'mizar-core-publication-proof-'));
    try {
      for (const [name, data] of [
        ['core-release-manifest.json', coreBytes],
        ['core-distribution-manifest.json', coreDistributionBytes],
      ]) {
        await writeFile(join(temp, name), data);
        await promisify(execFile)('gh', releaseAttestationArgs(join(temp, name), core.gitSha));
      }
      const backend = await downloadReleaseAsset(
        release,
        tag,
        distribution.archive,
        distribution.archiveBytes,
      );
      requireValue(
        digest(backend) === distribution.archiveSha256 &&
          backend.length === distribution.archiveBytes,
        'Core backend original bytes differ',
      );
      await writeFile(join(temp, distribution.archive), backend);
      await promisify(execFile)(
        'gh',
        releaseAttestationArgs(join(temp, distribution.archive), core.gitSha),
      );
      identity.runtime = [
        {
          name: MACHINE_METADATA_NAME,
          size: carrier.length,
          sha256: digest(carrier),
          bytes: carrier,
        },
        {
          name: distribution.archive,
          size: backend.length,
          sha256: digest(backend),
          bytes: backend,
        },
      ];
      identity.core = core;
      identity.originals = originals;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  const bootstrapName = `Mizar-v${identity.version}-Windows-x64-WebInstaller.exe`;
  if (release.assets.some((a) => a.name === bootstrapName)) {
    const data = await downloadReleaseAsset(release, tag, bootstrapName, 16777216);
    const proof = await mkdtemp(join(tmpdir(), 'mizar-bootstrap-proof-'));
    try {
      await writeFile(join(proof, bootstrapName), data);
      await promisify(execFile)(
        'gh',
        releaseAttestationArgs(join(proof, bootstrapName), manifest.gitSha),
      );
    } finally {
      await rm(proof, { recursive: true, force: true });
    }
    identity.bootstrap = {
      name: bootstrapName,
      version: identity.version,
      gitSha: identity.gitSha,
      releaseId: release.id,
      size: data.length,
      sha256: digest(data),
      data,
    };
  }
  return identity;
}

export function cacheReleaseIdentities(resolveIdentity) {
  const identities = new Map();
  return (tag) => {
    if (!identities.has(tag))
      identities.set(
        tag,
        Promise.resolve().then(() => resolveIdentity(tag)),
      );
    return identities.get(tag);
  };
}

async function main() {
  const mode = process.env.BOX_SYNC_MODE || 'sync';
  requireValue(['sync', 'probe', 'verify-downloads'].includes(mode), '未知镜像操作');
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
  const prerelease = /^v\d+\.\d+\.\d+-(?:alpha|beta|rc)\.[1-9]\d*$/.test(tag ?? '');
  if (process.env.GITHUB_OUTPUT)
    await appendFile(process.env.GITHUB_OUTPUT, `prerelease=${prerelease}\n`);
  if (prerelease) return '预发布版本：Box Stable、Downloads、Updates 与 Archive 保持原样。';
  const box =
    mode === 'verify-downloads'
      ? undefined
      : new BoxClient(
          process.env.MIZAR_BOX_REPO_TOKEN,
          process.env.BOX_UPLOAD_TRANSPORT === 'native' ? multipartUpload : curlMultipartUpload,
        );
  if (mode === 'probe') return probe(box);
  const resolveIdentity = cacheReleaseIdentities(releaseIdentity);
  const identity = await resolveIdentity(tag);
  const downloads = {
    box,
    identity,
    bootstrap: identity.bootstrap
      ? { identity: identity.bootstrap, bytes: identity.bootstrap.data }
      : undefined,
  };
  if (mode === 'verify-downloads') return verifyPublicDownloads(downloads);
  requireValue(mode === 'sync', '不支持该同步模式');

  requireValue(
    identity.asset.browser_download_url ===
      `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/${identity.name}`,
    '安装包地址不一致',
  );
  const release = identity.release;
  requireValue(
    identity.runtime && identity.bootstrap && !older(identity.version, '1.6.0'),
    '仅同步 1.6.0 及以后的拆分发行',
  );
  const metadata = release.assets.filter((a) =>
    [
      'update-manifest.json',
      'update-provenance.json',
      'update-publication.json',
      'update-publication-provenance.json',
    ].includes(a.name),
  );
  let updateIndex;
  const indexAsset = release.assets.filter((a) => a.name === 'update-index.json');
  if (identity.originals) updateIndex = identity.originals.get('update-index.json');
  if (indexAsset.length || updateIndex) {
    requireValue(updateIndex || indexAsset.length === 1, '更新信封不唯一');
    updateIndex ??= await downloadReleaseAsset(release, tag, 'update-index.json', 2097152);
    const index = JSON.parse(updateIndex);
    requireValue(index.schemaVersion === 'mizar.update-index.v2', '更新信封格式无效');
    const extracted = [
      ['manifest', Buffer.from(index.manifestBase64, 'base64')],
      ['provenance', Buffer.from(JSON.stringify(index.provenance))],
      ['publication', Buffer.from(index.publicationBase64, 'base64')],
      ['publication-provenance', Buffer.from(JSON.stringify(index.publicationProvenance))],
    ];
    metadata.splice(
      0,
      metadata.length,
      ...extracted.map(([kind, data]) => ({
        name: `update-${kind}.json`,
        size: data.length,
        digest: `sha256:${digest(data)}`,
        data,
      })),
    );
  }
  if (metadata.length) {
    requireValue(metadata.length === 4, '正式更新资料缺少清单、来源证明或发布确认');
    const assets = [];
    const directory = await mkdtemp(join(tmpdir(), 'mizar-update-proof-'));
    try {
      for (const kind of ['manifest', 'provenance', 'publication', 'publication-provenance']) {
        const asset = metadata.find((a) => a.name === `update-${kind}.json`);
        requireValue(
          asset &&
            asset.size <= (kind.includes('provenance') ? 2097152 : 65536) &&
            (asset.data ||
              asset.browser_download_url ===
                `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/update-${kind}.json`),
          '更新资料地址或大小无效',
        );
        const data =
          asset.data ||
          (await downloadReleaseAsset(
            release,
            tag,
            asset.name,
            kind.includes('provenance') ? 2097152 : 65536,
          ));
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
  let resources, resourceReuseVersion;
  if (identity.originals || release.assets.some((a) => a.name === resourceNames.descriptor)) {
    const directory = await mkdtemp(join(tmpdir(), 'mizar-mirror-resources-'));
    try {
      for (const name of Object.values(resourceNames))
        await writeFile(
          join(directory, name),
          identity.originals?.get(name) ??
            (await downloadReleaseAsset(
              release,
              tag,
              name,
              name.includes('provenance') ? 2097152 : 65536,
            )),
        );
      const descriptor = JSON.parse(await readFile(join(directory, resourceNames.descriptor)));
      const name = descriptor.resources?.[0]?.archive?.name;
      requireValue(
        /^Mizar-official-epl-default-\d+\.\d+\.\d+\.zip$/.test(name),
        '资源归档名称无效',
      );
      await writeFile(
        join(directory, name),
        await downloadReleaseAsset(release, tag, name, LIMITS.archiveBytes),
      );
      resources = await Promise.all(
        (await resourceAssetInventory(directory, identity.core ?? identity.manifest, true)).map(
          async (file) => ({
            ...file,
            bytes: await readFile(join(directory, file.name)),
          }),
        ),
      );
      // This is only a storage hint after original publication verification above.
      const originalVersion = JSON.parse(await readFile(join(directory, resourceNames.catalog)))
        .origin?.publication?.releaseVersion;
      resourceReuseVersion =
        originalVersion && older(originalVersion, identity.version) ? originalVersion : undefined;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  return syncStableRelease({
    box,
    identity,
    runtime: identity.runtime,
    resolveIdentity,
    bootstrap: identity.bootstrap
      ? {
          identity: identity.bootstrap,
          bytes: identity.bootstrap.data,
          resolveIdentity: async (tag) => (await resolveIdentity(tag)).bootstrap,
        }
      : undefined,
    resources: identity.runtime ? resources.filter((f) => f.name.endsWith('.zip')) : resources,
    resourceReuseVersion,
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
