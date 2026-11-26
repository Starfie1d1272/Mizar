import { MACHINE_METADATA_NAME } from '@mizar/resource-pack-contract/transport';
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
import { DistributionHttpError, type FetchLike as UpdateFetch } from '../distribution/http.js';
import { downloadVerifiedAsset } from '../distribution/transfer.js';
import { installerUrl, StableSource } from './source.js';

const CHECK_INTERVAL = 2 * 60 * 60 * 1000;
const STARTUP_CHECK_DELAY = 30_000;
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
  latest(signal: AbortSignal, minimumVersion?: string): Promise<UpdateManifest | null>;
  latestRelease?(
    signal: AbortSignal,
    minimumVersion?: string,
  ): Promise<{ manifest: UpdateManifest; metadataBytes: Buffer } | null>;
  authenticateMetadata?(carrier: Buffer, signal: AbortSignal): Promise<UpdateManifest>;
}
export type UpdateActivity = 'idle' | 'checking' | 'downloading' | 'installing';
export interface UpdateLastError {
  code: string;
  stage: string;
  stageLabel: string;
  summary: string;
  nextStep: string;
  operationId: string;
  manual: boolean;
  security: boolean;
}
function isSecurityCode(code: string): boolean {
  return /provenance|identity|rollback|subject|source_mismatch|asset_mismatch|publication|metadata_corrupt|directory_invalid/.test(
    code,
  );
}
function manifestIdentity(manifest: UpdateManifest): string {
  return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
}
export class UpdateManager {
  private config = {
    automatic: true,
    lastAttempt: 0,
    highestVersion: null as string | null,
    highestIdentity: null as string | null,
  };
  private activity: UpdateActivity = 'idle';
  private error: string | null = null;
  private lastError: UpdateLastError | null = null;
  private candidate: UpdateManifest | null = null;
  private candidateMetadataBytes: Buffer | null = null;
  private checkedCurrent = false;
  private ready: z.infer<typeof readySchema> | null = null;
  private downloaded = 0;
  private downloadSource: string | null = null;
  private sourceMessage = '';
  private transferStage: 'downloading' | 'verifying' = 'downloading';
  private abort: AbortController | undefined;
  private abortReason: 'user' | 'yield' | null = null;
  private currentDownloadKind: 'manual' | 'auto' | null = null;
  private suppressedAutoVersion: string | null = null;
  private task: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private startupTimer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private startupSession: string | undefined;
  private startupPending = false;
  private companionCheck: ((force: boolean) => Promise<boolean>) | undefined;
  private companionStartupPending = false;
  private companionLastAttempt = 0;
  private companionRunning = false;
  private canAutoDownloadCallback: (() => Promise<boolean>) | undefined;
  private closed = false;
  private prepared = false;
  private planning = false;
  private initializationError: string | null = null;
  private completedReadyCleanup = false;
  private lastResult: string | null = null;
  private lastResultVersion: string | null = null;
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
      startupDelayMs?: number;
      canAutoDownload?: () => Promise<boolean>;
      log?: (stage: string, code: string, version?: string, diagnostic?: unknown) => void;
    },
  ) {
    this.root = join(options.stateRoot, 'updates');
    this.canAutoDownloadCallback = options.canAutoDownload;
    this.source =
      options.source ??
      new StableSource(join(this.root, 'trust'), options.fetcher, (stage, error, durationMs) => {
        if (error === undefined)
          this.options.log?.(stage, 'update_phase_completed', this.candidate?.version, {
            operationId: this.operationId,
            durationMs,
          });
        else this.failure(stage, error, durationMs);
      });
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private event(stage: string, code: string) {
    this.options.log?.(stage, code, this.candidate?.version, { operationId: this.operationId });
  }
  setCanAutoDownload(check: () => Promise<boolean>) {
    this.canAutoDownloadCallback = check;
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
  private setLastError(stage: string, error: unknown, manual: boolean) {
    const detail = updateFailure(stage, error, this.operationId);
    this.error = detail.code;
    this.lastError = {
      ...detail,
      manual,
      security: isSecurityCode(detail.code),
    };
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
    this.activity = 'idle';
    this.candidate = null;
    this.candidateMetadataBytes = null;
    this.ready = null;
    this.failure(stage, new Error(this.initializationError, { cause }));
    this.setLastError(stage, new Error(this.initializationError, { cause }), true);
  }
  private requireInitialized() {
    if (this.initializationError) throw new Error(this.initializationError);
  }
  private isVersionAtOrBelowCurrent(targetVersion: string): boolean {
    const current = this.options.version.split('-')[0]!;
    return (
      compareVersions(targetVersion, current) < 0 ||
      (targetVersion === current && !this.options.version.includes('-'))
    );
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
        await rename(
          join(this.root, 'settings.json'),
          join(this.root, `settings.json.corrupt-${this.now()}`),
        ).catch(() => {});
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
      return;
    }
    if (this.ready) {
      if (this.isVersionAtOrBelowCurrent(this.ready.manifest.version)) {
        this.ready = null;
        this.completedReadyCleanup = true;
      } else {
        const metaPath = join(this.root, this.ready.directory, MACHINE_METADATA_NAME);
        const metaInfo = await lstat(metaPath).catch(() => null);
        if (!metaInfo || !metaInfo.isFile() || metaInfo.isSymbolicLink()) {
          this.ready = null;
          this.completedReadyCleanup = true;
        }
      }
    }
    await this.cleanupDownloads(names);
    try {
      const result = z
        .object({
          operation: z.enum(['install', 'apply-update', 'uninstall']).optional(),
          status: z.enum(['installed', 'rolled_back', 'cancelled', 'failed']),
          version: z.string().nullable().optional(),
        })
        .parse(
          JSON.parse(
            await readFile(
              join(this.options.stateRoot, 'logs', 'last-applier-result.json'),
              'utf8',
            ),
          ),
        );
      if (result.operation === 'apply-update') {
        this.lastResult = result.status === 'rolled_back' ? 'restored' : result.status;
        this.lastResultVersion = result.version ?? null;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.failure('result_load', error);
    }
  }
  private async cleanupDownloads(names?: string[], keepDirectory?: string) {
    if (this.completedReadyCleanup && !this.ready) {
      try {
        await rm(join(this.root, 'ready.json'), { force: true });
        this.completedReadyCleanup = false;
      } catch (cause) {
        this.failure('installed_download_cleanup', cause);
      }
    }
    try {
      for (const name of names ?? (await readdir(this.root))) {
        if (
          !/^download-[A-Za-z0-9_-]+$/.test(name) ||
          name === this.ready?.directory ||
          name === keepDirectory
        )
          continue;
        try {
          await rm(join(this.root, name), { recursive: true, force: true });
        } catch (cause) {
          // Abandoned downloads cannot authorize installation. Keep the failure
          // visible and retry on the next operation without disabling updates.
          this.failure('download_cleanup', cause);
        }
      }
    } catch (cause) {
      this.failure('download_cleanup_scan', cause);
    }
  }
  start() {
    if (this.started || this.closed) return;
    this.started = true;
    const tick = async () => {
      if (this.closed) return;
      void this.checkCompanion();
      if (this.now() - this.config.lastAttempt >= CHECK_INTERVAL)
        await this.automaticCheck('periodic');
      if (!this.closed) {
        this.timer = setTimeout(() => void tick(), 60_000);
        this.timer.unref();
      }
    };
    this.timer = setTimeout(() => void tick(), 60_000);
    this.timer.unref();
  }
  desktopStartup(session: string) {
    if (this.startupSession === session || this.closed) return;
    this.startupSession = session;
    this.startupPending = true;
    this.companionStartupPending = true;
    clearTimeout(this.startupTimer);
    const delay = this.options.startupDelayMs ?? STARTUP_CHECK_DELAY;
    this.startupTimer = setTimeout(() => {
      if (this.closed) return;
      void this.checkCompanion();
      if (this.task || this.prepared || this.planning)
        this.event(
          'check',
          this.activity === 'checking'
            ? 'update_check_startup_shared'
            : 'update_check_startup_deferred',
        );
      void this.automaticCheck('startup');
    }, delay);
    this.startupTimer.unref();
  }
  registerCompanionCheck(check: (force: boolean) => Promise<boolean>) {
    this.companionCheck = check;
  }
  private async checkCompanion() {
    if (
      !this.companionCheck ||
      this.companionRunning ||
      !this.config.automatic ||
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
    if (!this.config.automatic || this.initializationError || this.closed) {
      if (this.startupPending) this.event('check', 'update_check_startup_disabled');
      this.startupPending = false;
      return;
    }
    if (this.task || this.prepared || this.planning) {
      if (this.activity === 'checking') this.startupPending = false;
      return;
    }
    this.startupPending = false;
    await this.check('auto', reason).catch((error: unknown) => this.failure('check', error));
  }
  status() {
    const manual =
      this.candidate !== null &&
      (!isCompatible(this.options.version, this.candidate) || !this.options.installed);
    return {
      activity: this.activity,
      staged: this.ready?.manifest ?? null,
      candidate: this.candidate,
      manual,
      checkedCurrent: this.checkedCurrent,
      error: this.error,
      lastError: this.lastError,
      failureDetails: [...this.recoveryFailures, ...this.failureDetails],
      currentVersion: this.options.version,
      distribution: this.options.installed ? 'installed' : 'portable',
      automatic: this.config.automatic,
      lastCheckedAt: this.config.lastAttempt || null,
      downloadedBytes: this.downloaded,
      downloadSource: this.downloadSource,
      sourceMessage: this.sourceMessage,
      transferStage: this.transferStage,
      releaseUrl: this.candidate ? `${RELEASES_URL}/tag/v${this.candidate.version}` : RELEASES_URL,
      lastResult: this.lastResult,
      lastResultVersion: this.lastResultVersion,
    };
  }
  setAutomatic(automatic: boolean) {
    const change = this.preferenceChange.then(async () => {
      this.requireInitialized();
      if (this.prepared || this.planning) throw new Error('update_busy');
      if (this.task && (this.activity !== 'downloading' || this.currentDownloadKind !== 'auto'))
        throw new Error('update_busy');
      const previous = this.config.automatic;
      this.config.automatic = automatic;
      try {
        await this.saveConfig();
      } catch (error) {
        this.config.automatic = previous;
        throw error;
      }
      if (!automatic) {
        this.yieldAutoDownload();
      } else if (!this.task && !this.prepared && !this.planning && !this.closed) {
        void this.automaticCheck('periodic');
      }
    });
    this.preferenceChange = change.catch(() => {});
    return change;
  }
  async check(
    trigger: 'manual' | 'auto' = 'manual',
    reason: 'manual' | 'startup' | 'periodic' = trigger === 'manual' ? 'manual' : 'periodic',
  ) {
    await this.preferenceChange;
    this.requireInitialized();
    if (this.task && this.activity === 'checking' && !this.prepared && !this.planning)
      return this.task;
    if (this.task || this.prepared || this.planning || this.closed) throw new Error('update_busy');
    const manual = trigger === 'manual';
    this.activity = 'checking';
    this.error = null;
    this.config.lastAttempt = this.now();
    const abort = new AbortController();
    this.abort = abort;
    this.abortReason = null;
    this.task = this.doCheck(
      AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]),
      reason,
      manual,
    );
    try {
      await this.task;
    } finally {
      this.abort = undefined;
      this.abortReason = null;
      this.task = undefined;
      if (!this.prepared && this.activity === 'checking') this.activity = 'idle';
    }
    if (this.config.automatic && !this.closed && !this.planning && !this.prepared) {
      await this.maybeAutoDownload();
    }
  }
  private async doCheck(
    signal: AbortSignal,
    reason: 'manual' | 'startup' | 'periodic',
    manual: boolean,
  ) {
    this.operationId = randomUUID();
    this.failureDetails = [];
    this.event('check', `update_check_${reason}`);
    try {
      await this.cleanupDownloads();
      await this.saveConfig();
      let manifest: UpdateManifest | null = null;
      let metadataBytes: Buffer | null = null;
      if (this.source.latestRelease) {
        const release = await this.source.latestRelease(
          signal,
          this.config.highestVersion ?? undefined,
        );
        if (release) {
          manifest = release.manifest;
          metadataBytes = release.metadataBytes;
        }
      } else {
        manifest = await this.source.latest(signal, this.config.highestVersion ?? undefined);
      }
      if (!manifest) {
        this.candidate = null;
        this.candidateMetadataBytes = null;
        this.checkedCurrent = true;
        this.lastError = null;
        this.error = null;
        return;
      }
      const target = manifest.version;
      if (this.config.highestVersion && compareVersions(target, this.config.highestVersion) < 0)
        throw new Error('update_rollback_rejected');
      if (this.isVersionAtOrBelowCurrent(target)) {
        this.candidate = null;
        this.candidateMetadataBytes = null;
        this.checkedCurrent = true;
        this.lastError = null;
        this.error = null;
        return;
      }
      signal.throwIfAborted();
      const identity = manifestIdentity(manifest);
      if (
        this.config.highestVersion === manifest.version &&
        this.config.highestIdentity !== identity
      )
        throw new Error('update_identity_changed');
      this.config.highestVersion = manifest.version;
      this.config.highestIdentity = identity;
      await this.saveConfig();
      this.candidate = manifest;
      this.candidateMetadataBytes = metadataBytes;
      this.checkedCurrent = false;
      this.lastError = null;
      this.error = null;
      if (!isCompatible(this.options.version, manifest) || !this.options.installed) {
        return;
      }
      if (this.ready && manifestIdentity(this.ready.manifest) === identity) {
        try {
          await this.verifyFile(this.ready, this.ready.manifest, signal);
        } catch (error) {
          this.failure('cached_download_verify', error);
          await this.discard();
        }
      }
      this.event('check', 'authenticated');
    } catch (e) {
      if (signal.aborted && this.abortReason === 'yield') {
        this.error = null;
        return;
      }
      this.failure('check', e);
      this.setLastError('check', e, manual);
    }
  }
  private async verifyFile(
    ready: z.infer<typeof readySchema>,
    manifest: UpdateManifest,
    signal?: AbortSignal,
  ) {
    const directory = join(this.root, ready.directory);
    const path = join(directory, manifest.installer.name);
    for (const entry of [directory, path]) {
      const info = await lstat(entry);
      if (info.isSymbolicLink()) throw new Error('update_directory_invalid');
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size !== manifest.installer.bytes)
      throw new Error('update_download_corrupt');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
      signal?.throwIfAborted();
      hash.update(chunk);
    }
    if (hash.digest('hex') !== manifest.installer.sha256)
      throw new Error('update_download_corrupt');
    return path;
  }
  private canStartDownloadFor(manifest: UpdateManifest): boolean {
    if (!this.options.installed || !isCompatible(this.options.version, manifest)) return false;
    if (!this.ready) return true;
    return compareVersions(manifest.version, this.ready.manifest.version) > 0;
  }
  private async maybeAutoDownload(): Promise<void> {
    if (
      !this.config.automatic ||
      this.closed ||
      this.initializationError ||
      this.task ||
      this.prepared ||
      this.planning ||
      !this.candidate
    )
      return;
    if (this.suppressedAutoVersion === this.candidate.version) return;
    if (!this.canStartDownloadFor(this.candidate)) return;
    if (this.canAutoDownloadCallback) {
      const allowed = await this.canAutoDownloadCallback().catch(() => false);
      if (!allowed) return;
    }
    if (
      this.closed ||
      this.task ||
      this.prepared ||
      this.planning ||
      !this.config.automatic ||
      !this.candidate ||
      !this.canStartDownloadFor(this.candidate)
    )
      return;
    this.startDownload(this.candidate, this.candidateMetadataBytes, 'auto');
  }
  download(): Promise<void> {
    if (this.initializationError) return Promise.reject(new Error(this.initializationError));
    if (
      this.task ||
      this.planning ||
      this.prepared ||
      this.closed ||
      !this.candidate ||
      !this.canStartDownloadFor(this.candidate)
    )
      return Promise.reject(new Error('update_unavailable'));
    if (this.suppressedAutoVersion === this.candidate.version) {
      this.suppressedAutoVersion = null;
    }
    this.startDownload(this.candidate, this.candidateMetadataBytes, 'manual');
    return Promise.resolve();
  }
  private startDownload(
    manifest: UpdateManifest,
    metadataBytes: Buffer | null,
    kind: 'manual' | 'auto',
  ) {
    this.activity = 'downloading';
    this.currentDownloadKind = kind;
    this.error = null;
    this.downloaded = 0;
    this.downloadSource = null;
    this.sourceMessage = '';
    const abort = new AbortController();
    this.abort = abort;
    this.abortReason = null;
    this.task = this.doDownload(manifest, metadataBytes, abort.signal, kind);
    // Download runs independently of the initiating HTTP request. Polling and cancellation remain available.
    void this.task.finally(() => {
      this.task = undefined;
      this.abort = undefined;
      this.abortReason = null;
      this.currentDownloadKind = null;
      if (!this.prepared && this.activity === 'downloading') this.activity = 'idle';
    });
  }
  private async doDownload(
    manifest: UpdateManifest,
    metadataBytes: Buffer | null,
    signal: AbortSignal,
    kind: 'manual' | 'auto',
  ) {
    this.operationId = randomUUID();
    this.failureDetails = [];
    let directory: string | undefined;
    try {
      await this.cleanupDownloads();
      directory = await mkdtemp(join(this.root, 'download-'));
      const path = join(directory, manifest.installer.name);
      const origin = installerUrl(manifest);
      this.sourceMessage = '正在测试下载来源…';
      await downloadVerifiedAsset({
        origin,
        target: path,
        bytes: manifest.installer.bytes,
        sha256: manifest.installer.sha256,
        integrityError: 'update_download_corrupt',
        fetcher: this.options.fetcher,
        signal,
        onDiagnostic: ({ error, ...diagnostic }) =>
          this.options.log?.('download_sources', 'source_response_probe', manifest.version, {
            operationId: this.operationId,
            ...diagnostic,
            ...(error === undefined ? {} : { error: diagnosticValue(error) }),
          }),
        onProgress: (bytes, source) => {
          if (this.sourceMessage === '正在测试下载来源…') this.sourceMessage = '';
          this.transferStage = 'downloading';
          this.downloaded = bytes;
          this.downloadSource = source.name;
        },
        onVerifying: () => {
          this.transferStage = 'verifying';
        },
        onFallback: (error, source) => {
          this.sourceMessage = `${source.name}连接或文件校验失败，正在切换来源。`;
          this.failure(source.stage ?? 'proxy_download', error);
          this.event('download', 'mirror_fallback');
        },
      });
      this.sourceMessage = '';
      this.options.log?.('download', 'verified', manifest.version, {
        operationId: this.operationId,
        source: this.downloadSource,
      });
      signal.throwIfAborted();
      if (metadataBytes) {
        await writeFile(join(directory, MACHINE_METADATA_NAME), metadataBytes, { mode: 0o600 });
      }
      signal.throwIfAborted();
      if (this.planning || this.prepared || this.closed) {
        throw new Error('update_cancelled');
      }
      const previousReady = this.ready;
      const nextReady = { directory: directory.slice(this.root.length + 1), manifest };
      await writeFile(join(this.root, 'ready.tmp'), JSON.stringify(nextReady), { mode: 0o600 });
      await rename(join(this.root, 'ready.tmp'), join(this.root, 'ready.json'));
      this.ready = nextReady;
      this.lastError = null;
      this.error = null;
      if (previousReady && previousReady.directory !== nextReady.directory) {
        await rm(join(this.root, previousReady.directory), { recursive: true, force: true }).catch(
          (error: unknown) => this.failure('download_cleanup', error),
        );
      }
    } catch (e) {
      if (directory)
        await rm(directory, { recursive: true, force: true }).catch((error: unknown) =>
          this.failure('download_cleanup', error),
        );
      const timedOut =
        signal.aborted && signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
      const cancelled = signal.aborted && !timedOut;
      if (cancelled && this.abortReason === 'yield') {
        this.error = null;
        this.event('download', 'update_download_yielded');
        return;
      }
      if (cancelled) {
        this.error = 'update_cancelled';
        this.event('download', 'update_cancelled');
        return;
      }
      const errorToRecord = timedOut
        ? new Error('update_download_timeout', { cause: signal.reason })
        : e;
      this.failure('download', errorToRecord);
      this.setLastError('download', errorToRecord, kind === 'manual');
    }
  }
  async cancel() {
    this.requireInitialized();
    if (this.prepared || this.planning) throw new Error('update_busy');
    if (this.task && this.activity === 'downloading') {
      if (this.candidate) this.suppressedAutoVersion = this.candidate.version;
      this.abortReason = 'user';
      this.abort?.abort();
      await this.task;
    }
  }
  yieldAutoDownload() {
    if (this.task && this.activity === 'downloading' && this.currentDownloadKind === 'auto') {
      this.abortReason = 'yield';
      this.abort?.abort();
    }
  }
  async resumeAutoDownload() {
    if (!this.config.automatic || this.closed || this.initializationError) return;
    await this.maybeAutoDownload();
  }
  private async discard() {
    if (this.ready)
      await rm(join(this.root, this.ready.directory), { recursive: true, force: true });
    this.ready = null;
    await rm(join(this.root, 'ready.json'), { force: true });
    this.completedReadyCleanup = false;
  }
  async prepare() {
    this.requireInitialized();
    if (this.prepared || this.planning || this.closed || !this.ready)
      throw new Error('update_unavailable');
    this.planning = true;
    try {
      if (this.task) {
        this.abortReason = 'yield';
        this.abort?.abort();
        await this.task.catch(() => {});
      }
      const staged = this.ready;
      if (!staged) throw new Error('update_unavailable');
      const directory = join(this.root, staged.directory);
      const dirInfo = await lstat(directory).catch(() => null);
      if (!dirInfo || !dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
        await this.discard();
        throw new Error('update_directory_invalid');
      }
      const metadataPath = join(directory, MACHINE_METADATA_NAME);
      const metaInfo = await lstat(metadataPath).catch(() => null);
      if (!metaInfo || !metaInfo.isFile() || metaInfo.isSymbolicLink()) {
        await this.discard();
        throw new Error('update_metadata_missing');
      }
      const carrier = await readFile(metadataPath);
      if (!this.source.authenticateMetadata) throw new Error('update_metadata_missing');
      const verifiedManifest = await this.source.authenticateMetadata(
        carrier,
        AbortSignal.timeout(60_000),
      );
      if (this.isVersionAtOrBelowCurrent(verifiedManifest.version)) {
        await this.discard();
        throw new Error('update_rollback_rejected');
      }
      if (!isCompatible(this.options.version, verifiedManifest) || !this.options.installed) {
        throw new Error('update_unavailable');
      }
      const verifiedIdentity = manifestIdentity(verifiedManifest);
      if (
        verifiedManifest.version !== staged.manifest.version ||
        verifiedIdentity !== manifestIdentity(staged.manifest) ||
        (this.config.highestVersion === verifiedManifest.version &&
          this.config.highestIdentity !== null &&
          this.config.highestIdentity !== verifiedIdentity)
      ) {
        await this.discard();
        throw new Error('update_identity_changed');
      }
      let installer: string;
      try {
        installer = await this.verifyFile(staged, verifiedManifest, AbortSignal.timeout(60_000));
      } catch (error) {
        this.failure('cached_download_verify', error);
        await this.discard();
        throw error;
      }
      this.prepared = true;
      this.activity = 'installing';
      return {
        schemaVersion: 1,
        installer,
        installerSha256: verifiedManifest.installer.sha256,
        installerBytes: verifiedManifest.installer.bytes,
        version: verifiedManifest.version,
        gitSha: verifiedManifest.gitSha,
        contentDigest: verifiedManifest.installer.contentDigest,
        ...(verifiedManifest.coreArchiveSha256
          ? { coreArchiveSha256: verifiedManifest.coreArchiveSha256 }
          : {}),
        previousContentDigest: this.options.currentContentDigest,
        bundleRoot: this.options.bundleRoot,
        stateRoot: this.options.stateRoot,
      };
    } catch (error) {
      this.setLastError('install_plan', error, true);
      throw error;
    } finally {
      this.planning = false;
    }
  }
  release() {
    this.prepared = false;
    if (this.activity === 'installing') this.activity = 'idle';
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.startupTimer);
    this.abortReason = 'yield';
    this.abort?.abort();
    await this.task?.catch(() => {});
  }
}
export function safeCode(error: unknown): string {
  if (error instanceof DistributionHttpError) return 'update_network_failed';
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
  const security = isSecurityCode(code);
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
