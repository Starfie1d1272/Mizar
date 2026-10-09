import { createHash } from 'node:crypto';
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

const DAY = 24 * 60 * 60 * 1000;
const configSchema = z.strictObject({
  automatic: z.boolean(),
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
    automatic: false,
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
  private closed = false;
  private prepared = false;
  private planning = false;
  private settingsInvalid = false;
  private lastResult: string | null = null;
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
      log?: (stage: string, code: string, version?: string) => void;
    },
  ) {
    this.root = join(options.stateRoot, 'updates');
    this.source = options.source ?? new StableSource(join(this.root, 'trust'));
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private event(stage: string, code: string) {
    this.options.log?.(stage, code, this.candidate?.version);
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
        this.error = 'update_settings_invalid';
        this.phase = 'error';
        this.settingsInvalid = true;
      }
    }
    try {
      this.ready = readySchema.parse(
        JSON.parse(await readFile(join(this.root, 'ready.json'), 'utf8')),
      );
    } catch {
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
    const tick = async () => {
      if (this.closed) return;
      if (
        this.config.automatic &&
        this.now() - this.config.lastAttempt >= DAY &&
        !this.task &&
        !this.prepared
      )
        await this.check().catch(() => undefined);
      if (!this.closed) {
        this.timer = setTimeout(() => void tick(), 60_000);
        this.timer.unref();
      }
    };
    void tick();
  }
  status() {
    return {
      phase: this.phase,
      error: this.error,
      currentVersion: this.options.version,
      distribution: this.options.installed ? 'installed' : 'portable',
      automatic: this.config.automatic,
      lastCheckedAt: this.config.lastAttempt || null,
      downloadedBytes: this.downloaded,
      candidate: this.candidate,
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
  async check(internal = false) {
    if (this.settingsInvalid) throw new Error('update_settings_invalid');
    if (this.task || this.prepared || this.closed || (this.planning && !internal))
      throw new Error('update_busy');
    this.phase = 'checking';
    this.error = null;
    this.config.lastAttempt = this.now();
    const abort = new AbortController();
    this.abort = abort;
    this.task = this.doCheck(AbortSignal.any([abort.signal, AbortSignal.timeout(60_000)]));
    try {
      await this.task;
    } finally {
      this.abort = undefined;
      this.task = undefined;
    }
  }
  private async doCheck(signal: AbortSignal) {
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
        } catch {
          await this.discard();
        }
      }
      this.phase = 'available';
      this.event('check', 'authenticated');
    } catch (e) {
      this.phase = 'error';
      this.error = safeCode(e);
      this.event('check', this.error);
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
          } finally {
            await reader.cancel().catch(() => undefined);
            await file.close();
          }
          this.event('download', i === 0 ? 'mirror_verified' : 'github_verified');
          break;
        } catch (e) {
          await rm(path, { force: true });
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
      if (directory) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      this.ready = null;
      this.phase = signal.aborted ? 'available' : 'error';
      this.error = signal.aborted ? 'update_cancelled' : safeCode(e);
      this.event('download', this.error);
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
  const value = error instanceof Error ? error.message : '';
  return /^update_[a-z_]{1,50}$/.test(value) ? value : 'update_verification_failed';
}
