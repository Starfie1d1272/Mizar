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
import timers from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Buffer, Blob } from 'node:buffer';
import { URL } from 'node:url';
import { releaseAttestationArgs } from './release-identity.mjs';
import { assertPublication } from './update-publication.mjs';
import { makeUpdateIndex } from './update-index.mjs';
import { RESOURCE_ASSET_NAMES as resourceNames } from '../../packages/resource-pack-contract/catalog.mjs';
import { apiRequest, multipartUpload } from './box-upload.mjs';
import { curlMultipartUpload } from './box-curl-upload.mjs';

const { fetch, AbortSignal, FormData } = globalThis;

const origin = 'https://box.nju.edu.cn';
const downloadsFolder = '/Stable/Downloads';
const publicShare = 'https://box.nju.edu.cn/d/91dec4c27e5d47f38fcf/';
const shaPattern = /^[a-f0-9]{64}$/;
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export class MirrorError extends Error {
  constructor(message, httpStatus) {
    super(message);
    this.httpStatus = httpStatus;
  }
}
const requireValue = (ok, message) => {
  if (!ok) throw new MirrorError(message);
};
export const older = (a, b) => {
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
export async function boxStage(stage, action, deadlineMs) {
  const started = globalThis.performance.now();
  const deadline = deadlineMs === undefined ? 'unknown' : `${deadlineMs}ms`;
  const heartbeat = globalThis.setInterval(() => {
    const elapsed = Math.round(globalThis.performance.now() - started);
    const remaining =
      deadlineMs === undefined ? 'unknown' : `${Math.max(0, deadlineMs - elapsed)}ms`;
    console.log(
      `Box ${stage} 运行中 elapsed=${elapsed}ms deadline=${deadline} remaining=${remaining} bytes=unknown`,
    );
  }, 30000);
  heartbeat.unref();
  console.log(`Box ${stage} 开始 ${new Date().toISOString()} deadline=${deadline}`);
  try {
    const result = await action();
    console.log(
      `Box ${stage} 完成 ${new Date().toISOString()}（${Math.round(globalThis.performance.now() - started)}ms）`,
    );
    return result;
  } catch (error) {
    const elapsed = Math.round(globalThis.performance.now() - started);
    console.log(`Box ${stage} 失败 ${new Date().toISOString()}（${elapsed}ms）`);
    if (error instanceof MirrorError)
      throw Object.assign(
        new MirrorError(`Box ${stage}（${elapsed}ms）：${error.message}`, error.httpStatus),
        {
          uploadOutcomeUnknown: error.uploadOutcomeUnknown,
          retrySafeUpload: error.retrySafeUpload,
          uploadTimedOut: error.uploadTimedOut,
          retryableRead: error.retryableRead,
          retryAfter: error.retryAfter,
        },
      );
    const code = safeNetworkCode(error);
    if (code !== 'network')
      throw new MirrorError(`Box ${stage}（${elapsed}ms）：网络请求失败（${code}）；保留现有文件`);
    throw error;
  } finally {
    globalThis.clearInterval(heartbeat);
  }
}
function retryAfterMs(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}
let recoveryStartedAt;
export const getBoxRecoveryStartedAt = () => recoveryStartedAt;

function recordRecovery() {
  recoveryStartedAt ??= new Date().toISOString();
}

async function retryWait(attempt, reason, deadline, retryAfter, signal) {
  recordRecovery();
  const delay = Math.max(Math.ceil(Math.random() * 1000 * 2 ** attempt), retryAfterMs(retryAfter));
  requireValue(delay < deadline - Date.now(), '重试等待超出本次恢复预算；保留现有文件');
  console.log(`Box 暂态失败（${reason}），${delay}ms 后重试 ${attempt + 1}/2`);
  await timers.setTimeout(delay, undefined, { signal });
}

// An accepted write can become visible after the connection has failed. Observe
// the exact destination without issuing another mutation while the outcome is unknown.
const reconciliationDelays = [0, 1000, 2000, 4000, 8000, 15000, 15000, 15000];
async function waitForWrittenFile(
  box,
  folder,
  name,
  identity,
  signal,
  allowPrevious = false,
  delayed = true,
) {
  recordRecovery();
  const delays = delayed ? reconciliationDelays : [0];
  const recoverySignal = AbortSignal.any([AbortSignal.timeout(90000), ...(signal ? [signal] : [])]);
  for (const delay of delays) {
    if (delay) await timers.setTimeout(delay, undefined, { signal: recoverySignal });
    recoverySignal.throwIfAborted();
    const matches = (await box.list(folder, recoverySignal)).filter((entry) => entry.name === name);
    requireValue(
      matches.length <= 1 && matches.every((entry) => entry.type === 'file'),
      '写入恢复目标无效；保留现场',
    );
    if (!matches.length) continue;
    const actual = await box.hash(`${folder}/${name}`, recoverySignal);
    if (actual.size === identity.size && actual.sha256 === identity.sha256) return true;
    if (!allowPrevious) throw new MirrorError('写入恢复发现不同内容；保留远端文件');
  }
  return false;
}
async function checkedFetch(
  url,
  options = {},
  timeout = 120000,
  transport = fetch,
  consume,
  maxAttempts = 3,
) {
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
        (readOnlyBox || (new URL(url).origin === origin && error?.retrySafeMutation === true)) &&
        (networkCodes.has(code) || (code === 'timeout' && signal.aborted)) &&
        attempt + 1 < maxAttempts &&
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
          uploadTimedOut:
            error?.uploadTimedOut === true ||
            code === 'ETIMEDOUT' ||
            (code === 'timeout' && signal.aborted),
          uploadOutcomeUnknown:
            code === 'BOX_CURL_FAILED' || networkCodes.has(code) || code === 'timeout',
          retryableRead: readOnlyBox && (networkCodes.has(code) || code === 'timeout'),
        },
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (readOnlyBox && temporaryStatuses.has(response.status) && attempt + 1 < maxAttempts) {
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
        {
          retryableRead: readOnlyBox && temporaryStatuses.has(response.status),
          retryAfter: response.headers.get('retry-after'),
        },
      );
    }
    return response;
  }
}

async function boundedJson(response, maximum) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    requireValue(size <= maximum, 'JSON 响应字节超限');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
  async api(endpoint, path, method = 'GET', body, signal, maxAttempts = 3) {
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
        undefined,
        maxAttempts,
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
  async readIndex() {
    const signal = AbortSignal.timeout(180000);
    const url = this.temporaryUrl(
      await this.api('download-link', '/Updates/latest.json', 'GET', undefined, signal),
    );
    return checkedFetch(
      url,
      { redirect: 'error', signal },
      180000,
      this.downloadTransport,
      async (response) => {
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          requireValue(size <= 2097152, '更新信封超限');
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      },
    );
  }
  async hash(path, signal) {
    const deadline = Date.now() + 570000;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const requestSignal = AbortSignal.any([
        AbortSignal.timeout(180000),
        ...(signal ? [signal] : []),
      ]);
      try {
        return await boxStage(
          `回读/${directoryCategory(path)}/${path.split('/').at(-1)}/尝试${attempt + 1}`,
          async () => {
            const url = this.temporaryUrl(
              await this.api('download-link', path, 'GET', undefined, requestSignal, 1),
            );
            let idleController, idleTimer;
            const resetIdle = () => {
              globalThis.clearTimeout(idleTimer);
              idleTimer = globalThis.setTimeout(() => idleController.abort(), 60000);
            };
            const stopIdle = () => globalThis.clearTimeout(idleTimer);
            return checkedFetch(
              url,
              { redirect: 'error', signal: requestSignal },
              180000,
              async (address, options) => {
                idleController = new globalThis.AbortController();
                resetIdle();
                try {
                  const response = await this.downloadTransport(address, {
                    ...options,
                    signal: AbortSignal.any([options.signal, idleController.signal]),
                  });
                  if (!response.ok) stopIdle();
                  return response;
                } catch (error) {
                  stopIdle();
                  if (idleController.signal.aborted && !options.signal.aborted)
                    throw Object.assign(new Error('Box download stalled'), {
                      code: 'UND_ERR_BODY_TIMEOUT',
                    });
                  throw error;
                }
              },
              async (response) => {
                try {
                  const hash = createHash('sha256');
                  let size = 0;
                  for await (const chunk of response.body) {
                    resetIdle();
                    hash.update(chunk);
                    size += chunk.length;
                  }
                  return { sha256: hash.digest('hex'), size };
                } catch (error) {
                  if (idleController.signal.aborted && !requestSignal.aborted)
                    throw Object.assign(new Error('Box download stalled'), {
                      code: 'UND_ERR_BODY_TIMEOUT',
                    });
                  throw error;
                } finally {
                  stopIdle();
                }
              },
              1,
            );
          },
          180000,
        );
      } catch (error) {
        if ((!error.retryableRead && !requestSignal.aborted) || attempt === 2 || signal?.aborted)
          throw error;
        await retryWait(attempt, '完整回读失败', deadline, error.retryAfter, signal);
      }
    }
  }

  async upload(path, name, bytes, replace = false) {
    return boxStage(`上传/${directoryCategory(path)}/${name}`, async () => {
      const deadline = Date.now() + 900000;
      const signal = AbortSignal.timeout(900000);
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted();
        const attemptDeadline = Date.now() + Math.min(180000, Math.max(1, deadline - Date.now()));
        const attemptSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, attemptDeadline - Date.now())),
        ]);
        let startedUpload = false;
        try {
          const url = this.temporaryUrl(
            await this.api('upload-link', path, 'GET', undefined, attemptSignal, 1),
          );
          url.searchParams.set('ret-json', '1');
          const form = new FormData();
          form.set('parent_dir', path);
          form.set('replace', replace ? '1' : '0');
          form.set('file', new Blob([bytes]), name);
          startedUpload = true;
          const result = await boxStage(
            `上传尝试/${name}/${attempt + 1}`,
            async () =>
              await checkedFetch(
                url,
                { method: 'POST', body: form, redirect: 'error', signal: attemptSignal },
                Math.max(1, attemptDeadline - Date.now()),
                this.uploadTransport,
                (response) => response.json(),
                1,
              ),
            Math.max(1, attemptDeadline - Date.now()),
          );
          requireValue(
            Array.isArray(result) && result.length === 1 && result[0].name === name,
            '上传回执不一致；检查目录后重试',
          );
          return;
        } catch (error) {
          if (
            !startedUpload &&
            (error.retryableRead || attemptSignal.aborted) &&
            !signal.aborted &&
            attempt < 2
          ) {
            await retryWait(attempt, '上传链接读取失败', deadline, error.retryAfter, signal);
            continue;
          }
          if (!error.uploadOutcomeUnknown || error.httpStatus === 401 || error.httpStatus === 403)
            throw error;
          recordRecovery();
          // Reconcile before replay. replace=0 prevents overwriting a late commit;
          // a conflicting file is never replaced.
          let confirmed;
          try {
            confirmed = await waitForWrittenFile(
              this,
              path,
              name,
              {
                size: bytes.length,
                sha256: digest(bytes),
              },
              signal,
              replace,
              !error.retrySafeUpload || replace,
            );
          } catch (readError) {
            // A failed reconciliation cannot make an uncertain write safe to replay.
            if (!error.retrySafeUpload || replace) readError.retryableRead = false;
            throw readError;
          }
          if (confirmed) {
            console.log('Box 上传回执丢失，远端原字节已核验，跳过重传');
            return;
          }
          // Absence after a timeout does not prove that a late server-side write
          // cannot still appear. Only explicit zero-byte evidence permits replay.
          if (!error.retrySafeUpload || replace || attempt === 2) throw error;
          recordRecovery();
          await retryWait(attempt, '上传后目标缺失', deadline, undefined, signal);
        }
      }
    });
  }
  // A fresh temporary directory isolates each attempt. Never replay an uncertain chunk.
  async uploadChunks(path, name, bytes, chunkSize = 4 * 1024 * 1024) {
    const deadline = Date.now() + 900000;
    const signal = AbortSignal.timeout(900000);
    const url = this.temporaryUrl(await this.api('upload-link', path, 'GET', undefined, signal));
    url.searchParams.set('ret-json', '1');
    for (let start = 0; start < bytes.length; start += chunkSize) {
      requireValue(Date.now() < deadline, '分块上传预算已用完；保留暂存目录');
      const end = Math.min(start + chunkSize, bytes.length);
      console.log(`Box 分块 ${start}-${end - 1}/${bytes.length}`);
      const form = new FormData();
      form.set('parent_dir', path);
      form.set('replace', '0');
      form.set('file', new Blob([bytes.subarray(start, end)]), name);
      let result;
      for (let attempt = 0; ; attempt++) {
        requireValue(Date.now() < deadline, '分块上传预算已用完；保留暂存目录');
        signal.throwIfAborted();
        const started = Date.now();
        const attemptTimeout = Math.min(180000, Math.max(1, deadline - started));
        const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(attemptTimeout)]);
        if (process.env.GITHUB_ACTIONS)
          console.log(`::group::Box ${name} chunk ${start}-${end - 1} attempt ${attempt + 1}`);
        try {
          result = await boxStage(
            `分块/${name}/${start}-${end - 1}/尝试${attempt + 1}`,
            () =>
              checkedFetch(
                url,
                {
                  method: 'POST',
                  body: form,
                  redirect: 'error',
                  signal: attemptSignal,
                  headers: {
                    'Content-Range': `bytes ${start}-${end - 1}/${bytes.length}`,
                    'Content-Disposition': `attachment; filename="${name}"`,
                  },
                },
                attemptTimeout,
                this.uploadTransport,
                (response) => response.json(),
              ),
            attemptTimeout,
          );
          break;
        } catch (error) {
          console.log(
            `Box 分块 ${name} ${start}-${end - 1} 尝试 ${attempt + 1} 失败（${Date.now() - started}ms）`,
          );
          if (!error.retrySafeUpload || attempt === 2 || signal.aborted) throw error;
          recordRecovery();
          await retryWait(attempt, '分块发送 0 字节', deadline, undefined, signal);
        } finally {
          if (process.env.GITHUB_ACTIONS) console.log('::endgroup::');
        }
      }
      requireValue(
        end === bytes.length
          ? Array.isArray(result) && result.length === 1 && result[0].name === name
          : result?.success === true,
        '分块上传回执不一致；保留现场',
      );
    }
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

export async function verifyRemote(box, path, identity, signal) {
  const actual = await (signal ? box.hash(path, signal) : box.hash(path));
  requireValue(
    actual.sha256 === identity.sha256 && actual.size === identity.size,
    '云盘同名文件内容冲突；停止同步并保留文件',
  );
}

// Public listing is read-only; publication uses the authenticated phased workflow.
export async function readPublicDownloadDirectory(signal) {
  const listing = await checkedFetch(
    'https://box.nju.edu.cn/api/v2.1/share-links/91dec4c27e5d47f38fcf/dirents/?path=%2FDownloads%2F',
    { redirect: 'error', cache: 'no-store', signal },
    20000,
    fetch,
    (response) => boundedJson(response, 2 * 1024 * 1024),
  );
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
export async function verifyPublicDownloads(
  { bootstrap },
  { readDirectory = readPublicDownloadDirectory, transport = fetch } = {},
) {
  requireValue(bootstrap?.identity, '匿名验收缺少原文件身份');
  const listing = await readDirectory();
  const files = [bootstrap.identity];
  requireValue(
    listing.length === 1 &&
      listing[0].name === bootstrap.identity.name &&
      listing[0].size === bootstrap.identity.size,
    '匿名用户入口未就绪或文件不一致',
  );
  for (const identity of files)
    await boxStage(
      `匿名下载/${identity.name}`,
      async () => {
        let url = new URL('files/', publicShare);
        url.searchParams.set('p', '/Downloads/' + identity.name);
        url.searchParams.set('dl', '1');
        let response;
        const downloadSignal = AbortSignal.timeout(180000);
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
          response = await transport(url, {
            redirect: 'manual',
            signal: downloadSignal,
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
      },
      180000,
    );
  return '匿名验收成功：用户入口仅提供轻量 EXE，下载原字节一致；完整离线 ZIP 由 GitHub 提供。';
}

export async function syncCompatibilityMetadata({ box, version, bytes }) {
  requireValue(/^\d+\.\d+\.\d+$/.test(version), 'Invalid Runtime version');
  readMachineMetadata(bytes);
  for (const [parent, name] of [
    ['/', 'Runtime'],
    ['/Runtime', `v${version}`],
  ]) {
    const entries = (await box.list(parent)).filter((entry) => entry.name === name);
    requireValue(
      entries.length <= 1 && (!entries.length || entries[0].type === 'dir'),
      'Invalid Runtime directory',
    );
    if (!entries.length)
      await box.api('dir', `${parent === '/' ? '' : parent}/${name}`, 'POST', {
        operation: 'mkdir',
      });
  }
  const folder = `/Runtime/v${version}`;
  const existing = (await box.list(folder)).filter((entry) => entry.name === MACHINE_METADATA_NAME);
  requireValue(
    existing.length <= 1 && (!existing.length || existing[0].type === 'file'),
    'Invalid Runtime metadata',
  );
  // Historical backends and other files are deliberately neither inspected nor changed.
  if (!existing.length) await box.upload(folder, MACHINE_METADATA_NAME, bytes);
  await verifyRemote(box, `${folder}/${MACHINE_METADATA_NAME}`, {
    size: bytes.length,
    sha256: digest(bytes),
  });
}
export async function publishStablePointer({ box, updateIndex, version }) {
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
  if (version && entries.some((entry) => entry.name === 'latest.json')) {
    const previous = JSON.parse(await box.readIndex());
    requireValue(previous.schemaVersion === 'mizar.update-index.v2', '现有更新信封格式无效');
    const previousVersion = JSON.parse(Buffer.from(previous.manifestBase64, 'base64')).version;
    // Existing metadata is only a conservative overwrite guard, never authorization.
    requireValue(
      /^\d+\.\d+\.\d+$/.test(previousVersion) && older(previousVersion, version),
      '拒绝回退或替换同版本不同内容的更新清单',
    );
  }
  // Seafile replace=1 publishes one complete file after its upload completes;
  // the signature and original manifest travel in this one atomic envelope.
  await box.upload('/Updates', 'latest.json', updateIndex, true);
  return '更新清单已提交；等待完整回读核验。';
}
export async function verifyStablePointer({ box, updateIndex }) {
  await verifyRemote(box, '/Updates/latest.json', {
    size: updateIndex.length,
    sha256: digest(updateIndex),
  });
}
export async function probe(box) {
  await box.initialize();
  const name = `mizar-api-probe-${randomUUID()}.txt`;
  const folder = `/Archive/${name.slice(0, -4)}`;
  const bytes = Buffer.from('Mizar Box API probe\n');
  const expected = { size: bytes.length, sha256: digest(bytes) };
  await box.api('dir', folder, 'POST', { operation: 'mkdir' });
  try {
    await box.uploadChunks(folder, name, bytes, Math.ceil(bytes.length / 2));
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
  return '接口探测通过：列目录、分块上传、元数据、下载校验、移动与删除；Stable 保持原样。';
}

export async function github(path) {
  const repo = process.env.GITHUB_REPOSITORY;
  requireValue(repo === 'Starfie1d1272/Mizar', '仅允许 Mizar 发布仓库');
  return checkedFetch(
    `https://api.github.com/repos/${repo}/${path}`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    },
    120000,
    fetch,
    (response) => boundedJson(response, 4 * 1024 * 1024),
  );
}
export async function downloadReleaseAsset(release, tag, name, maximum = 65536, transport = fetch) {
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
  const bytes = await boxStage(
    `Release 下载/${name}`,
    () =>
      checkedFetch(assets[0].browser_download_url, {}, 180000, transport, async (response) => {
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          requireValue(size <= assets[0].size && size <= maximum, 'Release 下载字节超限');
          chunks.push(chunk);
        }
        return Buffer.concat(chunks);
      }),
    180000,
  );
  requireValue(
    bytes.length === assets[0].size && assets[0].digest === `sha256:${digest(bytes)}`,
    'Release 下载身份不一致',
  );
  return bytes;
}
export async function readReleaseInfo(tag) {
  requireValue(/^v\d+\.\d+\.\d+$/.test(tag), '无效正式版本标签');
  const release = await github(`releases/tags/${tag}`);
  const ref = await github(`git/ref/tags/${tag}`);
  requireValue(ref.object.type === 'commit', '发布标签必须直接指向已验源码');
  return { tag, release, ref };
}
export async function releaseIdentity(tag, { runtime = true, bootstrap = true, releaseInfo } = {}) {
  const { release, ref, tag: infoTag } = releaseInfo ?? (await readReleaseInfo(tag));
  requireValue(
    infoTag === tag && /^v\d+\.\d+\.\d+$/.test(tag) && ref.object.type === 'commit',
    '发布标签身份无效',
  );
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
    const backendAssets = release.assets.filter((asset) => asset.name === distribution.archive);
    requireValue(
      backendAssets.length === 1 &&
        Number.isSafeInteger(distribution.archiveBytes) &&
        distribution.archiveBytes > 0 &&
        backendAssets[0].size === distribution.archiveBytes &&
        shaPattern.test(distribution.archiveSha256) &&
        backendAssets[0].digest === `sha256:${distribution.archiveSha256}` &&
        backendAssets[0].browser_download_url ===
          `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/${distribution.archive}`,
      'Core backend release identity differs',
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
      let backend;
      if (runtime) {
        backend = await downloadReleaseAsset(
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
      }
      identity.runtime = [
        {
          name: MACHINE_METADATA_NAME,
          size: carrier.length,
          sha256: digest(carrier),
          bytes: carrier,
        },
        {
          name: distribution.archive,
          size: distribution.archiveBytes,
          sha256: distribution.archiveSha256,
          ...(backend ? { bytes: backend } : {}),
        },
      ];
      identity.core = core;
      identity.originals = originals;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  const bootstrapName = `Mizar-v${identity.version}-Windows-x64-WebInstaller.exe`;
  const bootstrapAssets = release.assets.filter((asset) => asset.name === bootstrapName);
  if (bootstrapAssets.length) {
    requireValue(
      bootstrapAssets.length === 1 &&
        Number.isSafeInteger(bootstrapAssets[0].size) &&
        bootstrapAssets[0].size > 0 &&
        bootstrapAssets[0].size <= 16777216 &&
        /^sha256:[a-f0-9]{64}$/.test(bootstrapAssets[0].digest) &&
        bootstrapAssets[0].browser_download_url ===
          `https://github.com/Starfie1d1272/Mizar/releases/download/${tag}/${bootstrapName}`,
      'Bootstrap release identity differs',
    );
    let data;
    if (bootstrap) {
      data = await downloadReleaseAsset(release, tag, bootstrapName, 16777216);
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
    }
    identity.bootstrap = {
      name: bootstrapName,
      version: identity.version,
      gitSha: identity.gitSha,
      releaseId: release.id,
      size: bootstrapAssets[0].size,
      sha256: bootstrapAssets[0].digest.slice(7),
      ...(data ? { data } : {}),
    };
  }
  return identity;
}

// Verify both original update signatures before the index can authorize a pointer.
export async function verifiedUpdateIndex(identity, tag) {
  const release = identity.release;
  const metadata = release.assets.filter((a) =>
    [
      'update-manifest.json',
      'update-provenance.json',
      'update-publication.json',
      'update-publication-provenance.json',
    ].includes(a.name),
  );
  let updateIndex, originalIndex;
  const indexAsset = release.assets.filter((a) => a.name === 'update-index.json');
  if (identity.originals) updateIndex = identity.originals.get('update-index.json');
  if (indexAsset.length || updateIndex) {
    requireValue(updateIndex || indexAsset.length === 1, '更新信封不唯一');
    updateIndex ??= await downloadReleaseAsset(release, tag, 'update-index.json', 2097152);
    originalIndex = updateIndex;
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
  requireValue(updateIndex, '正式发行缺少已签更新信封');
  return originalIndex ?? updateIndex;
}

export async function resolveBoxTag() {
  let tag = process.env.RELEASE_TAG;
  if (process.env.GITHUB_EVENT_NAME === 'workflow_run') {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const run = await github(`actions/runs/${event.workflow_run.id}`);
    requireValue(
      run.conclusion === 'success' &&
        ['workflow_dispatch', 'workflow_run'].includes(run.event) &&
        run.path === '.github/workflows/release-promotion.yml' &&
        run.repository.full_name === process.env.GITHUB_REPOSITORY,
      '触发来源不是成功的发布晋级',
    );
    const { jobs } = await github(`actions/runs/${run.id}/jobs?per_page=100`);
    tag = promotionTag(run, jobs);
  }
  return tag;
}

async function main() {
  const mode = process.env.BOX_SYNC_MODE || 'sync';
  requireValue(['sync', 'probe', 'verify-downloads'].includes(mode), '未知镜像操作');
  const tag = await resolveBoxTag();
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
  if (mode === 'verify-downloads') {
    const identity = await releaseIdentity(tag, { runtime: false });
    return verifyPublicDownloads({ identity, bootstrap: { identity: identity.bootstrap } });
  }
  // The phased workflow is the only publication entry point. This avoids an
  // alternate CLI path uploading or moving historical executable/resource files.
  throw new MirrorError('请通过 Box Sync 工作流同步兼容元数据');
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
  } finally {
    if (process.env.GITHUB_OUTPUT && recoveryStartedAt)
      await appendFile(process.env.GITHUB_OUTPUT, `recovery_started_at=${recoveryStartedAt}\n`);
  }
}
