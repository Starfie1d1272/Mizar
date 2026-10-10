import { errorEvidence } from './diagnostics.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  compareVersions,
  isCompatible,
  RELEASES_URL,
  updateManifestSchema,
  type UpdateManifest,
} from './contract.js';
import { updateRequest, type UpdateFetch } from './network.js';
import { installerUrl, StableSource } from './source.js';
import { BoxSource } from './box.js';

const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const configSchema = z.strictObject({
  automatic: z.boolean().default(true),
  lastAttempt: z.number().nonnegative(),
  highestVersion: z.string().nullable(),
  highestIdentity: z.string().nullable(),
});
const readySchema = z.strictObject({
  directory: z.string().regex(/^download-[A-Za-z0-9_-]+$/),
  manifest: updateManifestSchema,
});
export interface UpdateSource {
  latest(signal: AbortSignal, minimumVersion?: string): Promise<{ tag_name: string } | null>;
  authenticate(release: { tag_name: string }, signal: AbortSignal): Promise<UpdateManifest>;
}
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'manual'
  | 'error';
export class UpdateManager {
  private config = {
    automatic: true,
    lastAttempt: 0,
    highestVersion: null as string | null,
    highestIdentity: null as string | null,
  };
  private phase: UpdatePhase = 'idle';
  private error: string | null = null;
  private candidate: UpdateManifest | null = null;
  private ready: z.infer<typeof readySchema> | null = null;
  private downloaded = 0;
  private abort: AbortController | undefined;
  private task: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private startupSession: string | undefined;
  private startupPending = false;
  private notifiedVersion: string | null = null;
  private closed = false;
  private prepared = false;
  private planning = false;
  private settingsInvalid = false;
  private lastResult: string | null = null;
  private operationId = randomUUID();
  private failureDetails: ReturnType<typeof updateFailure>[] = [];
  private readonly root: string;
  private readonly source: UpdateSource;
  constructor(
    private readonly options: {
      stateRoot: string;
      version: string;
      installed: boolean;
      bundleRoot: string;
      currentContentDigest: string;
      source?: UpdateSource;
      fetcher?: UpdateFetch;
      now?: () => number;
      log?: (stage: string, code: string, version?: string, diagnostic?: unknown) => void;
    },
  ) {
    this.root = join(options.stateRoot, 'updates');
    this.source =
      options.source ??
      new StableSource(
        join(this.root, 'trust'),
        options.fetcher,
        'auto',
        (stage, error, durationMs) => {
          if (error === undefined)
            this.options.log?.(stage, 'update_phase_completed', this.candidate?.version, {
              operationId: this.operationId,
              durationMs,
            });
          else this.failure(stage, error, durationMs);
        },
      );
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private event(stage: string, code: string) {
    this.options.log?.(stage, code, this.candidate?.version, { operationId: this.operationId });
  }
  failure(stage: string, error: unknown, durationMs?: number) {
    this.failureDetails.push(updateFailure(stage, error, this.operationId));
    this.failureDetails = this.failureDetails.slice(-6);
    this.options.log?.(stage, safeCode(error), this.candidate?.version, {
      operationId: this.operationId,
      error: errorEvidence(error),
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  }
  private async saveConfig() {
    await writeFile(join(this.root, 'settings.tmp'), JSON.stringify(this.config), { mode: 0o600 });
    await rename(join(this.root, 'settings.tmp'), join(this.root, 'settings.json'));
  }
  async load() {
    await mkdir(this.root, { recursive: true });
    if (!(await lstat(this.root)).isDirectory() || (await lstat(this.root)).isSymbolicLink())
      throw new Error('update_directory_invalid');
    try {
      this.config = configSchema.parse(
        JSON.parse(await readFile(join(this.root, 'settings.json'), 'utf8')),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.failure('settings_load', e);
        this.error = 'update_settings_invalid';
        this.phase = 'error';
        this.settingsInvalid = true;
      }
    }
    try {
      this.ready = readySchema.parse(
        JSON.parse(await readFile(join(this.root, 'ready.json'), 'utf8')),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.failure('ready_load', error);
      this.ready = null;
    }
    for (const name of await readdir(this.root)) {
      if (/^download-[A-Za-z0-9_-]+$/.test(name) && name !== this.ready?.directory)
        await rm(join(this.root, name), { recursive: true, force: true });
    }
    try {
      const result = z
        .object({
          status: z.enum(['installed', 'restored', 'recovery-required', 'cancelled']),
          version: z.unknown().optional(),
          recoveryDirectory: z.unknown().optional(),
        })
        .parse(JSON.parse(await readFile(join(this.root, 'result.json'), 'utf8')));
      this.lastResult = result.status;
      // Completed attempts describe a particular installed payload, not all future
      // installations using this state directory. Keep uncertain recovery visible.
      const recoveryDirectory = result.recoveryDirectory;
      if (
        result.status !== 'recovery-required' &&
        typeof recoveryDirectory === 'string' &&
        /^install-[a-f0-9]{32}$/.test(recoveryDirectory)
      ) {
        try {
          const stage = join(this.root, recoveryDirectory);
          const stageInfo = await lstat(stage);
          const planPath = join(stage, 'plan.json');
          const planInfo = await lstat(planPath);
          if (
            !stageInfo.isDirectory() ||
            stageInfo.isSymbolicLink() ||
            !planInfo.isFile() ||
            planInfo.isSymbolicLink()
          )
            throw new Error('update_result_plan_invalid');
          const plan = z
            .object({
              version: z.string().regex(/^\d+\.\d+\.\d+$/),
              contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
              previousContentDigest: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .parse(JSON.parse(await readFile(planPath, 'utf8')));
          if (plan.version !== result.version) throw new Error('update_result_plan_mismatch');
          const resultDigest =
            result.status === 'installed' ? plan.contentDigest : plan.previousContentDigest;
          if (resultDigest !== this.options.currentContentDigest) this.lastResult = null;
        } catch {
          /* No reliable payload identity: retain the recorded result. */
        }
      }
    } catch {
      /* No completed attempt. */
    }
  }
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    const tick = async () => {
      if (this.closed) return;
      if (this.startupPending || this.now() - this.config.lastAttempt >= CHECK_INTERVAL)
        await this.automaticCheck(this.startupPending ? 'startup' : 'periodic');
      if (!this.closed) {
        this.timer = setTimeout(() => void tick(), 60_000);
        this.timer.unref();
      }
    };
    // The Host reports a real launch separately, including when Companion is reused.
    this.timer = setTimeout(() => void tick(), 60_000);
    this.timer.unref();
  }
  desktopStartup(session: string) {
    if (this.startupSession === session || this.closed) return;
    this.startupSession = session;
    this.notifiedVersion = null;
    this.startupPending = true;
    if (this.task || this.prepared || this.planning)
      this.event(
        'check',
        this.phase === 'checking' ? 'update_check_startup_shared' : 'update_check_startup_deferred',
      );
    void this.automaticCheck('startup');
  }
  private async automaticCheck(reason: 'startup' | 'periodic') {
    if (!this.config.automatic || this.settingsInvalid || this.closed) {
      if (this.startupPending) this.event('check', 'update_check_startup_disabled');
      this.startupPending = false;
      return;
    }
    if (this.task || this.prepared || this.planning) {
      if (this.phase === 'checking') this.startupPending = false;
      return;
    }
    this.startupPending = false;
    await this.check(false, reason).catch((error: unknown) => this.failure('check', error));
  }
  notification(version: string) {
    if (!this.status().notificationPending || this.candidate?.version !== version) return null;
    return { version, notes: this.candidate.notes };
  }
  dismissNotification(version: string) {
    if (this.candidate?.version !== version || this.notifiedVersion === version) return false;
    this.notifiedVersion = version;
    this.event('check', 'update_notification_dismissed');
    return true;
  }
  status() {
    return {
      phase: this.phase,
      error: this.error,
      failureDetails: this.failureDetails,
      currentVersion: this.options.version,
      distribution: this.options.installed ? 'installed' : 'portable',
      automatic: this.config.automatic,
      lastCheckedAt: this.config.lastAttempt || null,
      downloadedBytes: this.downloaded,
      candidate: this.candidate,
      notificationPending:
        this.config.automatic &&
        !this.prepared &&
        !this.planning &&
        ['available', 'manual', 'ready'].includes(this.phase) &&
        this.candidate !== null &&
        this.notifiedVersion !== this.candidate.version,
      releaseUrl: this.candidate ? `${RELEASES_URL}/tag/v${this.candidate.version}` : RELEASES_URL,
      lastResult: this.lastResult,
    };
  }
  async setAutomatic(automatic: boolean) {
    if (this.settingsInvalid) throw new Error('update_settings_invalid');
    if (this.task || this.prepared || this.planning) throw new Error('update_busy');
    this.config.automatic = automatic;
    await this.saveConfig();
  }
  async check(internal = false, reason: 'manual' | 'startup' | 'periodic' = 'manual') {
    if (this.settingsInvalid) throw new Error('update_settings_invalid');
    if (this.task && this.phase === 'checking' && !this.prepared && !this.planning)
      return this.task;
    if (this.task || this.prepared || this.closed || (this.planning && !internal))
      throw new Error('update_busy');
    this.phase = 'checking';
    this.error = null;
    this.config.lastAttempt = this.now();
    const abort = new AbortController();
    this.abort = abort;
    this.task = this.doCheck(AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]), reason);
    try {
      await this.task;
    } finally {
      this.abort = undefined;
      this.task = undefined;
    }
  }
  private async doCheck(signal: AbortSignal, reason: 'manual' | 'startup' | 'periodic') {
    this.operationId = randomUUID();
    this.failureDetails = [];
    this.event('check', `update_check_${reason}`);
    try {
      await this.saveConfig();
      const release = await this.source.latest(
        signal,
        this.config.highestVersion ?? this.options.version.split('-')[0],
      );
      if (!release) {
        this.phase = 'current';
        return;
      }
      const target = release.tag_name.slice(1);
      const current = this.options.version.split('-')[0]!;
      if (this.config.highestVersion && compareVersions(target, this.config.highestVersion) < 0)
        throw new Error('update_rollback_rejected');
      if (
        compareVersions(target, current) < 0 ||
        (target === current && !this.options.version.includes('-'))
      ) {
        this.phase = 'current';
        this.candidate = null;
        return;
      }
      const manifest = await this.source.authenticate(release, signal);
      if (manifest.version !== target) throw new Error('update_tag_mismatch');
      signal.throwIfAborted();
      const identity = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
      if (
        this.config.highestVersion === manifest.version &&
        this.config.highestIdentity !== identity
      )
        throw new Error('update_identity_changed');
      this.config.highestVersion = manifest.version;
      this.config.highestIdentity = identity;
      await this.saveConfig();
      this.candidate = manifest;
      if (!isCompatible(this.options.version, manifest) || !this.options.installed) {
        this.phase = 'manual';
        return;
      }
      if (this.ready && JSON.stringify(this.ready.manifest) === JSON.stringify(manifest)) {
        try {
          await this.verifyFile(this.ready, signal);
          this.phase = 'ready';
          return;
        } catch (error) {
          this.failure('cached_download_verify', error);
          await this.discard();
        }
      }
      this.phase = 'available';
      this.event('check', 'authenticated');
    } catch (e) {
      this.phase = 'error';
      this.error = safeCode(e);
      this.failure('check', e);
    }
  }
  private async verifyFile(ready: z.infer<typeof readySchema>, signal?: AbortSignal) {
    const directory = join(this.root, ready.directory),
      path = join(directory, ready.manifest.installer.name);
    for (const entry of [directory, path]) {
      const info = await lstat(entry);
      if (info.isSymbolicLink()) throw new Error('update_directory_invalid');
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size !== ready.manifest.installer.bytes)
      throw new Error('update_download_corrupt');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
    if (hash.digest('hex') !== ready.manifest.installer.sha256)
      throw new Error('update_download_corrupt');
    return path;
  }
  download(): Promise<void> {
    if (
      this.task ||
      this.planning ||
      this.prepared ||
      this.closed ||
      !this.candidate ||
      !this.options.installed ||
      this.phase !== 'available' ||
      !isCompatible(this.options.version, this.candidate)
    )
      return Promise.reject(new Error('update_unavailable'));
    this.phase = 'downloading';
    this.error = null;
    this.downloaded = 0;
    const abort = new AbortController();
    this.abort = abort;
    this.task = this.doDownload(
      this.candidate,
      AbortSignal.any([abort.signal, AbortSignal.timeout(15 * 60_000)]),
    );
    // Download runs independently of the initiating HTTP request. Polling and cancellation remain available.
    void this.task.finally(() => {
      this.task = undefined;
      this.abort = undefined;
    });
    return Promise.resolve();
  }
  private async doDownload(manifest: UpdateManifest, signal: AbortSignal) {
    this.operationId = randomUUID();
    this.failureDetails = [];
    let directory: string | undefined;
    try {
      await this.discard();
      directory = await mkdtemp(join(this.root, 'download-'));
      const path = join(directory, manifest.installer.name);
      const sources = [null, installerUrl(manifest)];
      for (let i = 0; i < sources.length; i++) {
        try {
          this.downloaded = 0;
          const attempt = AbortSignal.any([
            signal,
            AbortSignal.timeout(i === 0 ? 120_000 : 10 * 60_000),
          ]);
          const url =
            i === 0
              ? await new BoxSource(this.options.fetcher).installer(manifest, attempt)
              : sources[i]!;
          const response = await updateRequest(url, attempt, this.options.fetcher);
          const length = response.headers.get('content-length');
          if (
            (length && Number(length) !== manifest.installer.bytes) ||
            response.headers.get('content-type')?.includes('text/html')
          ) {
            await response.body?.cancel();
            throw new Error('update_download_corrupt');
          }
          const file = await open(path, 'wx', 0o600);
          const reader = response.body!.getReader() as ReadableStreamDefaultReader<Uint8Array>,
            hash = createHash('sha256');
          let transferError: unknown;
          try {
            for (;;) {
              attempt.throwIfAborted();
              const chunk = await reader.read();
              if (chunk.done) break;
              this.downloaded += chunk.value.length;
              if (this.downloaded > manifest.installer.bytes)
                throw new Error('update_download_corrupt');
              hash.update(chunk.value);
              await file.writeFile(chunk.value);
            }
            if (
              this.downloaded !== manifest.installer.bytes ||
              hash.digest('hex') !== manifest.installer.sha256
            )
              throw new Error('update_download_corrupt');
            await file.sync();
          } catch (error) {
            transferError = error;
            throw error;
          } finally {
            await reader
              .cancel()
              .catch((error: unknown) => this.failure('download_cleanup', error));
            await file.close().catch((error: unknown) => {
              throw transferError === undefined
                ? error
                : new AggregateError([transferError, error], 'update_download_failed');
            });
          }
          this.event('download', i === 0 ? 'mirror_verified' : 'github_verified');
          break;
        } catch (e) {
          this.failure(i === 0 ? 'box_download' : 'github_download', e);
          await rm(path, { force: true }).catch((cleanup: unknown) => {
            this.failure('download_cleanup', cleanup);
            throw new AggregateError([e, cleanup], 'update_cleanup_failed');
          });
          signal.throwIfAborted();
          if (i === sources.length - 1) throw e;
          this.event('download', 'mirror_fallback');
        }
      }
      signal.throwIfAborted();
      this.ready = { directory: directory.slice(this.root.length + 1), manifest };
      await writeFile(join(this.root, 'ready.tmp'), JSON.stringify(this.ready), { mode: 0o600 });
      await rename(join(this.root, 'ready.tmp'), join(this.root, 'ready.json'));
      this.phase = 'ready';
    } catch (e) {
      if (directory)
        await rm(directory, { recursive: true, force: true }).catch((error: unknown) =>
          this.failure('download_cleanup', error),
        );
      this.ready = null;
      this.phase = signal.aborted ? 'available' : 'error';
      this.error = signal.aborted ? 'update_cancelled' : safeCode(e);
      this.failure(
        'download',
        signal.aborted ? new Error(this.error, { cause: signal.reason }) : e,
      );
    }
  }
  async cancel() {
    if (this.prepared || this.planning) throw new Error('update_busy');
    this.abort?.abort();
    await this.task;
    if (this.phase === 'ready') {
      await this.discard();
      this.phase = 'available';
    }
  }
  private async discard() {
    if (this.ready)
      await rm(join(this.root, this.ready.directory), { recursive: true, force: true });
    this.ready = null;
    await rm(join(this.root, 'ready.json'), { force: true });
  }
  async prepare() {
    if (this.phase !== 'ready' || !this.ready || this.task || this.prepared || this.planning)
      throw new Error('update_unavailable');
    this.planning = true;
    try {
      // Re-authenticate at installation time; a previously downloaded version can be revoked by publication of a newer Stable.
      await this.check(true);
      if (this.phase !== 'ready' || !this.ready || !this.candidate)
        throw new Error('update_recheck_required');
      const installer = await this.verifyFile(this.ready);
      this.prepared = true;
      this.phase = 'installing';
      return {
        schemaVersion: 1,
        installer,
        installerSha256: this.candidate.installer.sha256,
        installerBytes: this.candidate.installer.bytes,
        version: this.candidate.version,
        gitSha: this.candidate.gitSha,
        contentDigest: this.candidate.installer.contentDigest,
        ...(this.candidate.coreArchiveSha256
          ? { coreArchiveSha256: this.candidate.coreArchiveSha256 }
          : {}),
        previousContentDigest: this.options.currentContentDigest,
        bundleRoot: this.options.bundleRoot,
        stateRoot: this.options.stateRoot,
      };
    } finally {
      this.planning = false;
    }
  }
  release() {
    this.prepared = false;
    if (this.phase === 'installing') this.phase = 'ready';
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.abort?.abort();
    await this.task;
  }
}
export function safeCode(error: unknown): string {
  const value = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /^update_[a-z_]{1,50}$/.test(value) ? value : 'update_operation_failed';
}

export function updateFailure(stage: string, error: unknown, operationId: string) {
  const code = safeCode(error);
  const status = error instanceof Error ? (error as Error & { status?: number }).status : undefined;
  const rateLimited =
    error instanceof Error && (error as Error & { rateLimited?: boolean }).rateLimited;
  const reasons: Record<string, string> = {
    update_identity_changed: '同版本发行内容发生变化，已拒绝安装。',
    update_rollback_rejected: '发现版本回退，已拒绝安装。',
    update_subject_mismatch: '文件摘要与发布证明不一致。',
    update_source_mismatch: '发行源码身份与发布证明不一致。',
    update_asset_mismatch: '安装包身份与已认证清单不一致。',
    update_asset_invalid: '发行文件信息不符合安全要求。',
    update_metadata_corrupt: '更新元数据损坏或不完整。',
    update_metadata_missing: '发行版本缺少可验证的更新元数据。',
    update_directory_invalid: '更新暂存目录不符合安全要求。',
    update_url_forbidden: '下载地址不符合允许的安全来源。',
    update_settings_invalid: '更新记录无法读取或保存。',
    update_publication_mismatch: '正式发布确认与已认证版本不一致。',
    update_cleanup_failed: '下载失败后清理暂存文件也未完成。',
  };
  const summary =
    code === 'update_trust_metadata_failed'
      ? 'Sigstore 信任元数据未能刷新，尚未完成来源认证。'
      : code === 'update_network_failed'
        ? status === 403
          ? rateLimited
            ? 'GitHub API 访问额度已耗尽（HTTP 403）。'
            : '更新来源拒绝访问（HTTP 403），具体限制原因未知。'
          : status
            ? `更新来源返回 HTTP ${status}。`
            : '网络请求失败，具体原因请查看诊断。'
        : code === 'update_provenance_failed'
          ? '更新来源认证未通过。'
          : code === 'update_download_corrupt'
            ? '下载内容与已认证清单不一致。'
            : code === 'update_operation_failed'
              ? '操作未完成，原因未知。'
              : (reasons[code] ?? '更新未完成，具体原因未知。');
  const security =
    /provenance|identity|rollback|subject|source_mismatch|asset_mismatch|publication|metadata_corrupt|directory_invalid/.test(
      code,
    );
  const nextStep = security
    ? '保留现有版本，请导出诊断并从正式发布页核对安装包。'
    : code === 'update_trust_metadata_failed'
      ? '检查到 Sigstore 的网络连接后重新检查更新；也可从正式发布页下载完整离线包，仍须核对来源。'
      : rateLimited
        ? '请等待 GitHub API 额度恢复后重新检查，或从正式发布页获取完整包；保留当前版本。'
        : status === 403
          ? '请核对网络代理或访问限制，并导出诊断；保留当前版本。'
          : '请导出诊断定位原因；网络恢复后可重新检查，或从正式发布页下载完整包。';
  const stageLabel =
    stage === 'trust_metadata'
      ? '刷新信任元数据'
      : stage.includes('download')
        ? '下载安装包'
        : stage === 'install_plan'
          ? '准备安装'
          : stage.includes('load')
            ? '读取更新记录'
            : stage === 'operator_action'
              ? '执行更新操作'
              : stage === 'qualification_proof_rejected'
                ? '验证更新来源'
                : '检查更新来源';
  return { code, stage, stageLabel, summary, nextStep, operationId };
}
