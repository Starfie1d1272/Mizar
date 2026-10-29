import { diagnosticValue } from '../support/session-journal.js';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
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
import { transfer } from '../distribution/transfer.js';
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
  private downloadSource: string | null = null;
  private sourceMessage = '';
  private abort: AbortController | undefined;
  private task: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private startupSession: string | undefined;
  private startupPending = false;
  private companionCheck: ((force: boolean) => Promise<boolean>) | undefined;
  private companionStartupPending = false;
  private companionLastAttempt = 0;
  private companionRunning = false;
  private notifiedVersion: string | null = null;
  private closed = false;
  private prepared = false;
  private planning = false;
  private settingsInvalid = false;
  private initializationError: string | null = null;
  private checkFailure: unknown;
  private lastResult: string | null = null;
  private operationId = randomUUID();
  private failureDetails: ReturnType<typeof updateFailure>[] = [];
  private recoveryFailures: ReturnType<typeof updateFailure>[] = [];
  private settingsSave: Promise<void> = Promise.resolve();
  private preferenceChange: Promise<void> = Promise.resolve();
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
    if (stage === 'result_load' || stage === 'result_identity_load') {
      this.recoveryFailures = [updateFailure(stage, error, this.operationId)];
    } else this.failureDetails.push(updateFailure(stage, error, this.operationId));
    this.failureDetails = this.failureDetails.slice(-6);
    this.options.log?.(stage, safeCode(error), this.candidate?.version, {
      result: 'failure',
      operationId: this.operationId,
      error: diagnosticValue(error),
      ...(durationMs === undefined ? {} : { durationMs }),
    });
  }
  private saveConfig() {
    const save = this.settingsSave.then(async () => {
      try {
        await writeFile(join(this.root, 'settings.tmp'), JSON.stringify(this.config), {
          mode: 0o600,
        });
        await rename(join(this.root, 'settings.tmp'), join(this.root, 'settings.json'));
      } catch (cause) {
        throw new Error('update_settings_invalid', { cause });
      }
    });
    this.settingsSave = save.catch(() => {});
    return save;
  }
  private disableInitialization(stage: string, cause: unknown) {
    const code = safeCode(cause);
    this.initializationError =
      code === 'update_operation_failed' ? 'update_initialization_failed' : code;
    this.error = this.initializationError;
    this.phase = 'error';
    this.candidate = null;
    this.ready = null;
    this.failure(stage, new Error(this.initializationError, { cause }));
  }
  private requireInitialized() {
    if (this.initializationError) throw new Error(this.initializationError);
  }
  async load() {
    try {
      await mkdir(this.root, { recursive: true });
      const info = await lstat(this.root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('update_directory_invalid');
    } catch (cause) {
      this.disableInitialization('directory_load', cause);
      return;
    }
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
    let names: string[] = [];
    try {
      names = await readdir(this.root);
    } catch (cause) {
      this.disableInitialization('directory_scan', cause);
    }
    for (const name of names) {
      if (/^download-[A-Za-z0-9_-]+$/.test(name) && name !== this.ready?.directory) {
        try {
          await rm(join(this.root, name), { recursive: true, force: true });
        } catch (cause) {
          this.disableInitialization('download_cleanup', cause);
          break;
        }
      }
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
        } catch (error) {
          /* No reliable payload identity: retain the recorded result. */
          this.failure('result_identity_load', error);
        }
      }
    } catch (error) {
      /* No completed attempt. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.failure('result_load', error);
    }
  }
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    const tick = async () => {
      if (this.closed) return;
      void this.checkCompanion();
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
    this.companionStartupPending = true;
    void this.checkCompanion();
    if (this.task || this.prepared || this.planning)
      this.event(
        'check',
        this.phase === 'checking' ? 'update_check_startup_shared' : 'update_check_startup_deferred',
      );
    void this.automaticCheck('startup');
  }
  registerCompanionCheck(check: (force: boolean) => Promise<boolean>) {
    this.companionCheck = check;
    if (this.companionStartupPending) void this.checkCompanion();
  }
  private async checkCompanion() {
    if (
      !this.companionCheck ||
      this.companionRunning ||
      !this.config.automatic ||
      this.settingsInvalid ||
      this.initializationError ||
      this.closed
    )
      return;
    const force = this.companionStartupPending;
    if (!force && this.now() - this.companionLastAttempt < CHECK_INTERVAL) return;
    // Reserve before awaiting so repeated ticks do not start a second check.
    this.companionStartupPending = false;
    this.companionLastAttempt = this.now();
    this.companionRunning = true;
    try {
      const attempted = await this.companionCheck(force).catch(() => true);
      if (!attempted) {
        this.companionStartupPending ||= force;
        this.companionLastAttempt = 0;
      }
    } finally {
      this.companionRunning = false;
    }
  }
  private async automaticCheck(reason: 'startup' | 'periodic') {
    if (!this.config.automatic || this.settingsInvalid || this.initializationError || this.closed) {
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
      failureDetails: [...this.recoveryFailures, ...this.failureDetails],
      currentVersion: this.options.version,
      distribution: this.options.installed ? 'installed' : 'portable',
      automatic: this.config.automatic,
      lastCheckedAt: this.config.lastAttempt || null,
      downloadedBytes: this.downloaded,
      downloadSource: this.downloadSource,
      sourceMessage: this.sourceMessage,
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
  setAutomatic(automatic: boolean) {
    const change = this.preferenceChange.then(async () => {
      this.requireInitialized();
      if (this.settingsInvalid) throw new Error('update_settings_invalid');
      if (this.task || this.prepared || this.planning) throw new Error('update_busy');
      const previous = this.config.automatic;
      this.config.automatic = automatic;
      try {
        await this.saveConfig();
      } catch (error) {
        this.config.automatic = previous;
        throw error;
      }
    });
    this.preferenceChange = change.catch(() => {});
    return change;
  }
  async check(internal = false, reason: 'manual' | 'startup' | 'periodic' = 'manual') {
    await this.preferenceChange;
    this.requireInitialized();
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
    this.checkFailure = undefined;
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
          this.checkFailure = error;
          this.failure('cached_download_verify', error);
          await this.discard();
        }
      }
      this.phase = 'available';
      this.event('check', 'authenticated');
    } catch (e) {
      this.checkFailure = e;
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
    if (this.initializationError) return Promise.reject(new Error(this.initializationError));
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
    this.downloadSource = null;
    this.sourceMessage = '';
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
      await transfer({
        target: path,
        bytes: manifest.installer.bytes,
        sha256: manifest.installer.sha256,
        integrityError: 'update_download_corrupt',
        signal,
        sources: [
          async (attempt) =>
            updateRequest(
              await new BoxSource(this.options.fetcher).installer(manifest, attempt),
              attempt,
              this.options.fetcher,
            ),
          (attempt) => updateRequest(installerUrl(manifest), attempt, this.options.fetcher),
        ],
        progress: (bytes, source) => {
          this.downloaded = bytes;
          this.downloadSource = source === 0 ? '南大云盘' : 'GitHub';
        },
        fallback: (error) => {
          this.sourceMessage = '南大云盘连接或文件校验失败，已切换至 GitHub。';
          this.failure('box_download', error);
          this.event('download', 'mirror_fallback');
        },
      });
      this.event('download', 'verified');
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
      const timedOut =
        signal.aborted && signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
      const cancelled = signal.aborted && !timedOut;
      this.phase = cancelled ? 'available' : 'error';
      this.error = timedOut
        ? 'update_download_timeout'
        : cancelled
          ? 'update_cancelled'
          : safeCode(e);
      this.failure(
        'download',
        signal.aborted ? new Error(this.error, { cause: signal.reason }) : e,
      );
    }
  }
  async cancel() {
    this.requireInitialized();
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
    this.requireInitialized();
    if (this.phase !== 'ready' || !this.ready || this.task || this.prepared || this.planning)
      throw new Error('update_unavailable');
    this.planning = true;
    try {
      // Re-authenticate at installation time; a previously downloaded version can be revoked by publication of a newer Stable.
      await this.check(true);
      if (this.phase !== 'ready' || !this.ready || !this.candidate)
        throw new Error('update_recheck_required', { cause: this.checkFailure });
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
  const originalCode = safeCode(error);
  const code =
    stage === 'settings_load' && originalCode === 'update_operation_failed'
      ? 'update_settings_invalid'
      : originalCode;
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
    update_initialization_failed: '更新目录初始化未完成，更新功能暂不可用。',
    update_download_timeout: '安装包下载超时，未完成下载。',
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
  const recordFailure = [
    'settings_load',
    'ready_load',
    'result_load',
    'result_identity_load',
  ].includes(stage);
  const nextStep = security
    ? '保留现有版本，请导出诊断并从正式发布页核对安装包。'
    : code === 'update_initialization_failed'
      ? '保留当前版本及更新、备份和恢复记录；检查目录读写权限、文件占用与剩余空间，导出诊断。修复后重启 Mizar；不要删除记录绕过校验。'
      : code === 'update_settings_invalid' || recordFailure
        ? '保留当前版本及更新、备份和恢复记录；检查用户资料目录的读写权限与剩余空间，导出诊断。不要删除记录绕过校验。'
        : code === 'update_cleanup_failed' || stage === 'download_cleanup'
          ? '保留当前版本及备份和恢复目录；检查是否有进程占用暂存文件及目录权限，导出诊断后处理。清理未完成时不要继续安装。'
          : code === 'update_download_timeout'
            ? '保留当前版本；核对下载来源的连接、代理及暂存目录权限与空间后，重新检查并下载，或从正式发布页获取完整离线包。'
            : code === 'update_trust_metadata_failed'
              ? '检查到 Sigstore 的网络连接后重新检查更新；也可从正式发布页下载完整离线包，仍须核对来源。'
              : rateLimited
                ? '请等待 GitHub API 额度恢复后重新检查，或从正式发布页获取完整包；保留当前版本。'
                : status === 403
                  ? '请核对网络代理或访问限制，并导出诊断；保留当前版本。'
                  : code === 'update_network_failed'
                    ? '检查网络连接与代理后重新检查，或从正式发布页下载完整包；保留当前版本。'
                    : '保留当前版本，请导出诊断定位原因，或从正式发布页核对安装包。';
  const stageLabel =
    stage === 'directory_load'
      ? '初始化更新目录'
      : stage === 'directory_scan'
        ? '读取更新目录'
        : stage === 'download_cleanup'
          ? '清理更新暂存目录'
          : stage === 'trust_metadata'
            ? '刷新信任元数据'
            : stage.includes('download')
              ? '下载安装包'
              : stage === 'install_plan'
                ? '准备安装'
                : stage.startsWith('result')
                  ? '读取安装恢复记录'
                  : stage.includes('load')
                    ? '读取更新记录'
                    : stage === 'operator_action'
                      ? '执行更新操作'
                      : stage === 'qualification_proof_rejected'
                        ? '验证更新来源'
                        : '检查更新来源';
  return { code, stage, stageLabel, summary, nextStep, operationId };
}
