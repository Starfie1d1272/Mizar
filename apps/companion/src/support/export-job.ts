import type { DocumentHandoffCoverage } from '@mizar/protocol';
import type { DesktopResult } from '@mizar/protocol/desktop-ipc';
import { collectObsNativeEvidence } from '../obs/native-evidence.js';
import { constants, lstatSync, unlinkSync, utimesSync, type Stats } from 'node:fs';
import { mkdir, open, lstat, readdir, rm, rmdir, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { atomicJson, safePath } from '../resource-store/files.js';
import { diagnosticSegmentPattern, performanceSegmentPattern } from './segments.js';
import { diagnosticValue } from './session-journal.js';
import type { ArchiveWorkerData } from './archive-worker.js';
const currentProcessLogs = /^(?:supervisor\.ndjson|companion(?:\.stderr)?\.log)(?:\.[0-9]+)?$/;
const CACHE_LIMIT = 256 * 1024 * 1024;
const MANIFEST_RESERVE = 1024 * 1024;
const INDEX_READ_MAX = 4 * 1024 * 1024;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

async function readBoundedIndex(
  directory: string,
  name: string,
): Promise<Record<string, unknown> | null> {
  let handle: FileHandle | undefined;
  try {
    const path = await safePath(directory, name);
    const before = await lstat(path);
    if (!before.isFile() || before.nlink !== 1 || before.size > INDEX_READ_MAX) return null;
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.nlink !== 1 ||
      stat.size > INDEX_READ_MAX
    )
      return null;
    const parsed = JSON.parse(await handle.readFile('utf8')) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readExcludedSourcesByRange(
  logsDirectory: string,
  rangeStart: number,
): Promise<Set<string>> {
  const excluded = new Set<string>();
  if (!Number.isFinite(rangeStart)) return excluded;
  const [companionRetention, performanceRetention, deliveryState] = await Promise.all([
    readBoundedIndex(logsDirectory, 'retention-companion.json'),
    readBoundedIndex(logsDirectory, 'retention-performance.json'),
    readBoundedIndex(join(logsDirectory, 'diagnostic-outbox'), 'state.json'),
  ]);
  for (const inventory of [companionRetention, performanceRetention]) {
    if (!inventory || !Array.isArray(inventory.segments)) continue;
    for (const seg of inventory.segments as unknown[]) {
      if (!seg || typeof seg !== 'object') continue;
      const entry = seg as { name?: unknown; lastObservedAt?: unknown };
      if (typeof entry.name !== 'string' || typeof entry.lastObservedAt !== 'string') continue;
      const lastMs = Date.parse(entry.lastObservedAt);
      if (Number.isFinite(lastMs) && lastMs < rangeStart) excluded.add(entry.name);
    }
  }
  if (deliveryState && Array.isArray(deliveryState.queue)) {
    for (const item of deliveryState.queue as unknown[]) {
      if (!item || typeof item !== 'object') continue;
      const batch = item as { id?: unknown; index?: { to?: unknown } };
      if (typeof batch.id !== 'string' || typeof batch.index?.to !== 'string') continue;
      const toMs = Date.parse(batch.index.to);
      if (Number.isFinite(toMs) && toMs < rangeStart) {
        excluded.add(`diagnostic-outbox/${batch.id}.gz`);
      }
    }
  }
  return excluded;
}
/** Own only the lease created by this cleanup attempt, never a native saver or peer. */
async function removeExpiredExport(path: string, directory: Stats): Promise<boolean> {
  const leasePath = join(path, 'saving.lease');
  let lease: FileHandle;
  try {
    lease = await open(
      leasePath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  let owner: Stats | undefined;
  let failure: unknown;
  try {
    owner = await lease.stat();
    await safePath(path);
    const actual = await lstat(path);
    if (actual.dev !== directory.dev || actual.ino !== directory.ino)
      throw new Error('export_cache_directory_changed');
    // Keep the lease in place throughout partial deletion. Recursive removal of
    // the whole directory could delete it before failing on another entry.
    for (const name of await readdir(path)) {
      if (name !== 'saving.lease') await rm(join(path, name), { recursive: true });
    }
  } catch (error) {
    failure = error;
  }
  try {
    await lease.close();
    // Keep check/release in one turn. Compliant peers cannot acquire this path
    // until unlink; an unexpected replacement must never be released by us.
    const current = lstatSync(leasePath);
    if (!owner || current.dev !== owner.dev || current.ino !== owner.ino || current.nlink !== 1)
      throw new Error('export_cache_lease_changed');
    unlinkSync(leasePath);
    const currentDirectory = lstatSync(path);
    if (currentDirectory.dev !== directory.dev || currentDirectory.ino !== directory.ino)
      throw new Error('export_cache_directory_changed');
    // Lease creation/removal must not give failed, already-expired content a
    // new lifetime. Preserve its age for the next attempt, including restart.
    utimesSync(path, directory.atime, directory.mtime);
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], 'export_cache_cleanup_unconfirmed')
      : error;
  }
  if (failure) throw failure;
  try {
    // A peer may acquire a new lease after release. Never recursively remove it.
    await rmdir(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return false;
    throw error;
  }
}
export interface ExportJob {
  exportId: string;
  phase: 'collecting' | 'encoding' | 'ready' | 'failed' | 'cancelled';
  inputBytes: number;
  outputBytes: number;
  error?: string;
  expiresAt?: string;
  parts?: { name: string; bytes: number; sha256: string }[];
  knownGaps?: number;
  downloadName?: string;
  cleanupStatus?: 'unconfirmed';
}
export interface LocalExportEvidence {
  sessionSegments: readonly string[];
  session: { pendingRecords: number } | null;
  performance: { pendingRecords: number } | null;
}
/** One bounded build. HTTP carries only status and trusted binary attachment routes. */
export class SupportExports {
  private readonly jobs = new Map<string, ExportJob>();
  private active:
    { id: string; outputCreated?: boolean; task?: Promise<void>; worker?: Worker } | undefined;
  readonly directory: string;
  constructor(
    private readonly logs: string,
    private readonly flushLocalEvidence?: () => Promise<LocalExportEvidence>,
    private readonly onDiagnostic?: (
      error: unknown,
      exportId: string,
      stage?: 'build' | 'cleanup',
    ) => void,
  ) {
    this.directory = join(dirname(logs), 'support-export');
  }
  status(id: string) {
    const job = this.jobs.get(id);
    return job && (!job.expiresAt || Date.parse(job.expiresAt) > Date.now())
      ? { ...job, settled: this.active?.id !== id }
      : null;
  }
  async whenSettled(id: string) {
    if (this.active?.id === id) await this.active.task;
    return this.status(id);
  }
  async begin(
    range: { from?: string; to?: string },
    snapshot: unknown,
    documentHandoff?: DocumentHandoffCoverage,
    host?: DesktopResult<'read_support_log_state'>,
  ): Promise<ExportJob> {
    if (this.active) throw new Error('export_busy');
    for (const [id, cached] of this.jobs)
      if (cached.expiresAt && Date.parse(cached.expiresAt) <= Date.now()) this.jobs.delete(id);
    if (this.jobs.size >= 64) throw new Error('export_cache_job_budget');
    const id = randomUUID();
    const job: ExportJob = { exportId: id, phase: 'collecting', inputBytes: 0, outputBytes: 0 };
    // Admission is owned before the first asynchronous boundary, including cache inspection.
    const active = { id } as NonNullable<SupportExports['active']>;
    this.active = active;
    this.jobs.set(id, job);
    active.task = (async () => {
      const diskBudgetBytes = await this.prepareCache(job);
      this.assertActive(job);
      await this.build(job, range, snapshot, diskBudgetBytes, documentHandoff, host);
    })()
      .catch(async (error: unknown) => {
        if (job.phase !== 'cancelled') job.phase = 'failed';
        try {
          this.onDiagnostic?.(error, id);
        } catch {
          // Diagnostics cannot change export ownership or cleanup.
        }
        job.error = String(error);
        job.expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
        // Only this admitted job owns this output. Never clean another export's directory.
        if (active.outputCreated)
          await safePath(join(this.directory, id))
            .then((path) => rm(path, { recursive: true, force: true }))
            .catch(() => undefined);
      })
      .finally(() => {
        if (this.active === active) this.active = undefined;
      });
    return job;
  }
  private assertActive(job: ExportJob) {
    if (this.active?.id !== job.exportId || job.phase === 'cancelled')
      throw new Error('export_cancelled');
  }
  private async prepareCache(job: ExportJob) {
    await safePath(dirname(this.directory));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await safePath(this.directory);
    let used = 0;
    let leased = false;
    let cleanupFailed = false;
    const size = async (path: string): Promise<number> => {
      const stat = await lstat(path);
      if (stat.isFile() && stat.nlink === 1) {
        await safePath(dirname(path), basename(path));
        return stat.size;
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('export_cache_unsafe');
      await safePath(path);
      let bytes = 0;
      for (const name of await readdir(path)) bytes += await size(join(path, name));
      return bytes;
    };
    for (const name of await readdir(this.directory)) {
      const entryPath = join(this.directory, name);
      if (!idPattern.test(name)) {
        // Retain unknown entries untouched and charge their safe byte footprint against budget.
        const st = await lstat(entryPath);
        if (
          st.isSymbolicLink() ||
          (st.isFile() && st.nlink !== 1) ||
          (!st.isFile() && !st.isDirectory())
        )
          throw new Error('export_cache_unsafe');
        used += st.isFile() ? st.size : await size(entryPath);
        continue;
      }
      const path = await safePath(entryPath);
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('export_cache_unsafe');
      if (Date.now() - stat.mtimeMs > 15 * 60_000) {
        let removed = false;
        try {
          removed = await removeExpiredExport(path, stat);
          if (!removed) leased = true;
        } catch (cause) {
          cleanupFailed = true;
          job.cleanupStatus = 'unconfirmed';
          try {
            this.onDiagnostic?.(
              new Error('export_cache_cleanup_failed', { cause }),
              job.exportId,
              'cleanup',
            );
          } catch {
            // Reporting must not turn measurable retained cache into an export blocker.
          }
        }
        if (removed) {
          this.jobs.delete(name);
          continue;
        }
      }
      // Failed cleanup is not failed admission: retain and charge safe contents.
      // A replaced/unsafe directory or an unreadable size still blocks admission.
      await safePath(path);
      const retained = await lstat(path);
      if (retained.dev !== stat.dev || retained.ino !== stat.ino)
        throw new Error('export_cache_directory_changed');
      used += await size(path);
    }
    const remaining = CACHE_LIMIT - used - MANIFEST_RESERVE;
    if (remaining <= 0)
      throw new Error(
        cleanupFailed
          ? 'export_cache_cleanup_failed'
          : leased
            ? 'export_cache_lease_unconfirmed'
            : 'export_cache_budget',
      );
    return remaining;
  }
  private async build(
    job: ExportJob,
    range: { from?: string; to?: string },
    snapshot: unknown,
    diskBudgetBytes: number,
    documentHandoff?: DocumentHandoffCoverage,
    host?: DesktopResult<'read_support_log_state'>,
  ) {
    const collectionStarted = performance.now();
    const handles: FileHandle[] = [];
    const sources: {
      name: string;
      fd: number;
      bytes: number;
      rawAttachment?: boolean;
      rawIndex?: boolean;
      jsonAttachment?: boolean;
      secrets?: string[];
    }[] = [];
    const gaps: {
      source: string;
      reason: string;
      phase?: string;
      cause?: unknown;
      scope?: string;
    }[] = [];
    const gap = (source: string, phase: string, error: unknown) =>
      gaps.push({
        source,
        phase,
        reason: String(error),
        cause: diagnosticValue(error),
        scope: 'source unavailable; coverage unknown',
      });
    if (!documentHandoff)
      gap('document', 'handoff', new Error('document_handoff_coverage_unreported'));
    else if (
      documentHandoff.pendingRecords > 0 ||
      documentHandoff.unconfirmedRecordsObserved > 0 ||
      documentHandoff.stopReason !== 'drained'
    )
      gaps.push({
        source: 'document',
        phase: 'handoff',
        reason: 'document_handoff_unconfirmed',
        cause: documentHandoff,
        scope:
          'requesting document only; unconfirmed at reported cutoff, not proof of omission from the archived file prefixes; lifetime loss may fall outside selected time range',
      });
    const output = join(this.directory, job.exportId);
    await mkdir(output, { mode: 0o700 });
    if (this.active?.id === job.exportId) this.active.outputCreated = true;
    this.assertActive(job);
    const capture = async (
      directory: string,
      name: string,
      prefix = '',
      rawIndex = false,
      rawAttachment = false,
      jsonAttachment = false,
    ) => {
      try {
        const path = await safePath(directory, name);
        const before = await lstat(path);
        if (
          !before.isFile() ||
          before.nlink !== 1 ||
          before.size > (jsonAttachment ? 128 * 1024 : 64 * 1024 * 1024)
        )
          throw new Error('source_unsafe_or_oversize');
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        handles.push(handle);
        const actual = await handle.stat();
        if (actual.ino !== before.ino || actual.dev !== before.dev || actual.nlink !== 1)
          throw new Error('source_changed');
        return {
          name: prefix + name,
          fd: handle.fd,
          bytes: actual.size,
          rawIndex,
          rawAttachment,
          jsonAttachment,
        };
      } catch (error) {
        gap(prefix + name, 'read', error);
      }
    };
    const excludedSources: { source: string; reason: string }[] = [];
    const rangeStart = range.from ? Date.parse(range.from) : NaN;
    const excludedByRange = await readExcludedSourcesByRange(this.logs, rangeStart).catch(
      () => new Set<string>(),
    );
    const addSource = (source: (typeof sources)[number] | undefined) => {
      if (source) sources.push(source);
    };
    const filterByRange = (names: readonly string[], prefix = '') => {
      const kept: string[] = [];
      for (const name of names) {
        const key = prefix + name;
        if (excludedByRange.has(key)) {
          excludedSources.push({
            source: key,
            reason: 'outside-requested-range; original retained',
          });
        } else {
          kept.push(name);
        }
      }
      return kept;
    };
    const captureBatch = async (
      names: readonly string[],
      captureSource: (name: string) => ReturnType<typeof capture>,
    ) => {
      for (let index = 0; index < names.length; index += 16) {
        this.assertActive(job);
        const batch = await Promise.all(names.slice(index, index + 16).map(captureSource));
        batch.forEach(addSource);
      }
    };
    let readyResult: (ExportJob & Record<string, unknown>) | undefined;
    let failed = false;
    let primaryError: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      const local = await this.flushLocalEvidence?.().catch((error: unknown) => {
        gap('companion', 'flush', error);
        return undefined;
      });
      this.assertActive(job);
      for (const [source, health] of [
        ['companion', local?.session],
        ['performance', local?.performance],
      ] as const) {
        if (health && health.pendingRecords > 0) {
          gaps.push({ source, phase: 'flush', reason: 'not_durably_committed', cause: health });
        }
      }
      try {
        await safePath(this.logs);
        const names = [
          ...new Set([...(await readdir(this.logs)), ...(local?.sessionSegments ?? [])]),
        ].sort();
        const hasHostLogs = names.some(
          (name) => diagnosticSegmentPattern.test(name) && !name.startsWith('session-'),
        );
        if (hasHostLogs && !host) gap('host', 'flush', new Error('host_log_state_unavailable'));
        else if (
          host &&
          (host.memoryOnly.events === null ||
            host.memoryOnly.events > 0 ||
            Object.values(host.unreportedLoss).some((count) => count > 0))
        )
          gaps.push({
            source: 'host',
            phase: 'flush',
            reason: 'host_memory_only_or_unreported_loss',
            cause: host,
          });
        await captureBatch(
          filterByRange(
            names.filter(
              (name) => diagnosticSegmentPattern.test(name) || currentProcessLogs.test(name),
            ),
          ),
          (name) => capture(this.logs, name, '', false, currentProcessLogs.test(name)),
        );
        if (names.includes('host-retention.ndjson'))
          addSource(
            await capture(
              this.logs,
              'host-retention.ndjson',
              'attachments/retention/',
              false,
              true,
            ),
          );
        if (names.includes('incident-pins.json'))
          addSource(await capture(this.logs, 'incident-pins.json', 'retention/', true));
      } catch (error) {
        gap('logs', 'enumerate', error);
      }
      for (const [folder, pattern] of [
        ['performance-pending', performanceSegmentPattern],
        ['diagnostic-outbox', /^[a-f0-9]{64}\.gz$/],
      ] as const) {
        try {
          const directory = await safePath(join(this.logs, folder));
          await captureBatch(
            filterByRange(
              (await readdir(directory)).filter((name) => pattern.test(name)).sort(),
              folder + '/',
            ),
            (name) => capture(directory, name, folder + '/'),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') gap(folder, 'enumerate', error);
        }
      }
      // The pinned observer writes report.json atomically at termination. Include
      // earlier attempts too: their local journal may already have rotated.
      try {
        const directory = await safePath(join(dirname(this.logs), 'data', 'observer'));
        const names = (await readdir(directory))
          .filter((name) =>
            /^(?:retry-[1-9]\d*-)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(name),
          )
          .sort();
        if (names.length > 4096)
          gap('observer', 'enumerate', new Error('observer_report_count_budget'));
        for (const name of names.slice(0, 4096)) {
          this.assertActive(job);
          try {
            const parent = await safePath(join(directory, name));
            const report = await safePath(parent, 'report.json');
            const stat = await lstat(report);
            if (
              (range.from && stat.mtimeMs < Date.parse(range.from)) ||
              (range.to && stat.mtimeMs > Date.parse(range.to))
            )
              continue;
            addSource(
              await capture(
                parent,
                'report.json',
                `attachments/observer/${name}/`,
                false,
                false,
                true,
              ),
            );
          } catch (error) {
            gap(`observer/${name}/report.json`, 'collect', error);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') gap('observer', 'enumerate', error);
      }
      const maxLogAgeMs = Number.isFinite(rangeStart)
        ? Math.min(14 * 86_400_000, Math.max(24 * 3_600_000, Date.now() - rangeStart + 60_000))
        : 14 * 86_400_000;
      const [nativeObs, resolvedSnapshot, frameRateLive] = await Promise.all([
        collectObsNativeEvidence({
          includeRelatedLogs: true,
          maxLogAgeMs,
          retainRelatedLog: async (source) => {
            handles.push(source.handle);
            sources.push({
              name: `attachments/obs/${source.name}`,
              fd: source.handle.fd,
              bytes: source.bytes,
              rawAttachment: true,
              secrets: [...source.secrets],
            });
          },
        }).catch((error: unknown) => {
          gap('obs', 'collect', error);
          return { status: 'unavailable' };
        }),
        typeof snapshot === 'function'
          ? Promise.resolve()
              .then(() => snapshot())
              .catch((error: unknown) => {
                gap('snapshot', 'collect', error);
                return { status: 'unavailable' };
              })
          : Promise.resolve(snapshot),
        this.frameRateSnapshot(gap),
      ]);
      this.assertActive(job);
      const asOf = new Date().toISOString();
      const vector = {
        asOf,
        atomic: false,
        producers: { companion: local?.session ?? null, performance: local?.performance ?? null },
        documentHandoff: {
          clientReported: true,
          coverage: documentHandoff ?? null,
        },
        host: { clientReported: true, state: host ?? null },
        sources: sources.map(({ name, bytes }) => ({ name, bytes })),
        current: {
          snapshot: resolvedSnapshot,
          nativeObs,
          frameRateLive,
        },
        unknown: [
          'cross-process snapshot is not atomic',
          'other documents and events created after the requesting document cutoff',
          'unflushed producer buffers',
        ],
      };
      const collectionMs = performance.now() - collectionStarted;
      const message = await new Promise<ExportJob & Record<string, unknown>>((resolve, reject) => {
        const entry = new URL('./archive-worker-entry.js', import.meta.url);
        const workerEntry = import.meta.url.endsWith('.ts')
          ? new URL(
              'data:text/javascript,' +
                encodeURIComponent(
                  `import { tsImport } from ${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href)}; await tsImport(${JSON.stringify(new URL('./archive-worker-entry.ts', import.meta.url).href)}, ${JSON.stringify(import.meta.url)});`,
                ),
            )
          : entry;
        const worker = new Worker(workerEntry, {
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
          workerData: {
            sources,
            gaps,
            excludedSources,
            output,
            exportId: job.exportId,
            range,
            snapshot: vector,
            diskBudgetBytes,
            collectionMs,
          } satisfies ArchiveWorkerData,
        });
        if (this.active?.id === job.exportId) this.active.worker = worker;
        if (job.phase === 'cancelled') void worker.terminate();
        let result: (ExportJob & Record<string, unknown>) | undefined;
        const workerErrors: Error[] = [];
        worker.on('message', (message: ExportJob & Record<string, unknown>) => {
          if (this.active?.id !== job.exportId || this.active.worker !== worker) return;
          // Worker diagnostics never enter the public status or generated manifest.
          // Collect terminal failures even after cancellation, but ignore late progress/ready.
          const { cleanupFailures: workerCleanup, diagnostic, ...status } = message;
          if (Array.isArray(workerCleanup)) cleanupFailures.push(...workerCleanup);
          if (status.phase === 'failed')
            workerErrors.push(new Error(status.error, { cause: diagnostic }));
          else if (job.phase !== 'cancelled') {
            if (status.phase === 'ready') result = status;
            else if (!result && !workerErrors.length)
              Object.assign(job, status, { exportId: job.exportId });
          }
        });
        worker.on('error', (error) => {
          workerErrors.push(new Error('export_worker_error', { cause: error }));
        });
        // A message or error is not proof that the worker has stopped using
        // shared input descriptors. Cleanup waits for exit.
        worker.once('exit', (code) => {
          if (job.phase === 'cancelled') {
            const cancelled = new Error('export_cancelled');
            reject(
              workerErrors.length
                ? new AggregateError([cancelled, ...workerErrors], 'export_cancelled', {
                    cause: cancelled,
                  })
                : cancelled,
            );
          } else if (workerErrors.length)
            reject(new AggregateError(workerErrors, 'export_worker_failed'));
          else if (code !== 0 || !result) reject(new Error(`export_worker_exit_${code}`));
          else resolve(result);
        });
      });
      this.assertActive(job);
      const readyAt = Date.now();
      const downloadName = `mizar-support-${new Date(readyAt).toISOString().replaceAll(':', '-')}.zip`;
      const manifest = {
        schema: 'mizar-support-export/2',
        createdAt: new Date(readyAt).toISOString(),
        expiresAt: new Date(readyAt + 15 * 60_000).toISOString(),
        ...message,
        measurements: {
          ...(message.measurements as Record<string, unknown>),
          collectionMs,
        },
        downloadName,
        exportId: job.exportId,
      };
      if (Buffer.byteLength(JSON.stringify(manifest)) > MANIFEST_RESERVE)
        throw new Error('export_manifest_budget');
      await atomicJson(join(output, 'generated.json'), manifest);
      this.assertActive(job);
      readyResult = {
        ...message,
        downloadName,
        exportId: job.exportId,
        expiresAt: new Date(readyAt + 15 * 60_000).toISOString(),
      };
    } catch (error) {
      failed = true;
      primaryError = error;
    } finally {
      if (this.active?.id === job.exportId) delete this.active.worker;
      const closed = await Promise.allSettled(
        handles.map((handle) => Promise.resolve().then(() => handle.close())),
      );
      cleanupFailures.push(
        ...closed.flatMap((result) =>
          result.status === 'rejected'
            ? [new Error('export_input_close_failed', { cause: result.reason })]
            : [],
        ),
      );
    }
    if (!failed) {
      try {
        this.assertActive(job);
      } catch (error) {
        // Cancellation during cleanup remains primary without dropping any
        // close/release failures collected after the artifact was generated.
        failed = true;
        primaryError = error;
      }
    }
    if (failed && cleanupFailures.length)
      throw new AggregateError([primaryError, ...cleanupFailures], 'export_cleanup_failed', {
        cause: primaryError,
      });
    if (failed) throw primaryError;
    if (!readyResult) throw new Error('export_result_missing');
    Object.assign(job, readyResult);
    if (cleanupFailures.length) {
      // The archive and manifest are already complete; cleanup uncertainty is
      // separate from missing evidence and must not delete a usable artifact.
      job.cleanupStatus = 'unconfirmed';
      try {
        this.onDiagnostic?.(
          new AggregateError(cleanupFailures, 'export_cleanup_unconfirmed'),
          job.exportId,
          'cleanup',
        );
      } catch {
        // Diagnostics cannot invalidate the completed archive.
      }
    }
  }
  private async frameRateSnapshot(gap: (source: string, phase: string, error: unknown) => void) {
    const name = 'frame-rate-live.json';
    let file: FileHandle | undefined;
    try {
      const directory = await safePath(join(dirname(this.logs), 'data'));
      const path = await safePath(directory, name);
      const before = await lstat(path);
      if (!before.isFile() || before.nlink !== 1 || before.size > 4096)
        throw new Error('frame_rate_source_unsafe');
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await file.stat();
      if (
        stat.ino !== before.ino ||
        stat.dev !== before.dev ||
        stat.nlink !== 1 ||
        stat.size !== before.size
      )
        throw new Error('frame_rate_source_changed');
      const value = JSON.parse(
        await file.readFile('utf8'),
        (key: string, item: unknown, context?: { source?: string }) =>
          key === 'created' && typeof item === 'number' ? context?.source : item,
      ) as Record<string, unknown>;
      const after = await file.stat();
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
        throw new Error('frame_rate_source_changed');
      const marker = (item: unknown) =>
        typeof item === 'string' && /^MIZAR_FPS_[a-f0-9]{32}$/.test(item);
      if (
        value.version !== 1 ||
        !Number.isInteger(value.pid) ||
        Number(value.pid) <= 0 ||
        Number(value.pid) > 0xffffffff ||
        typeof value.created !== 'string' ||
        !/^[1-9][0-9]{0,19}$/.test(value.created) ||
        BigInt(value.created) > 0xffffffffffffffffn ||
        !marker(value.attemptId) ||
        (value.restoreAttemptId !== undefined && !marker(value.restoreAttemptId)) ||
        (value.phase === 'restore_pending' && !marker(value.restoreAttemptId)) ||
        ![
          'apply_pending',
          'applied',
          'restore_pending',
          'restored',
          'relinquished',
          'ended',
        ].includes(String(value.phase)) ||
        typeof value.original !== 'number' ||
        !Number.isFinite(value.original) ||
        value.original < 0 ||
        value.original > 10000 ||
        (value.applied !== 30 && value.applied !== 60)
      )
        throw new Error('frame_rate_source_invalid');
      return {
        status: 'available',
        asOf: new Date().toISOString(),
        ...Object.fromEntries(
          [
            'version',
            'pid',
            'created',
            'original',
            'applied',
            'attemptId',
            'restoreAttemptId',
            'phase',
          ].map((key) => [key, value[key] ?? null]),
        ),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'not_present' };
      gap(name, 'snapshot', error);
      return { status: 'unavailable' };
    } finally {
      await file?.close();
    }
  }
  async cancel(id: string) {
    const job = this.jobs.get(id);
    if (this.active?.id !== id || !job || job.phase === 'ready') return false;
    job.phase = 'cancelled';
    await this.active.worker?.terminate();
    return true;
  }
  async attachment(id: string, name: string) {
    if (!idPattern.test(id) || !(name === 'generated.json' || /^part-[1-9][0-9]*\.zip$/.test(name)))
      throw new Error('export_not_ready');
    const directory = await safePath(join(this.directory, id));
    const manifestPath = await safePath(directory, 'generated.json');
    const before = await lstat(manifestPath);
    if (before.size > 1024 * 1024) throw new Error('export_manifest_budget');
    const manifest = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let value: {
      schema: string;
      exportId: string;
      phase: string;
      expiresAt: string;
      parts: { name: string; bytes: number; sha256: string }[];
    };
    try {
      const stat = await manifest.stat();
      if (
        stat.ino !== before.ino ||
        stat.dev !== before.dev ||
        stat.size !== before.size ||
        stat.nlink !== 1
      )
        throw new Error('export_manifest_changed');
      value = JSON.parse(await manifest.readFile('utf8')) as typeof value;
    } finally {
      await manifest.close();
    }
    if (
      value.schema !== 'mizar-support-export/2' ||
      value.exportId !== id ||
      value.phase !== 'ready' ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      Date.parse(value.expiresAt) <= Date.now()
    )
      throw new Error('export_expired');
    const part = value.parts.find((part) => part.name === name);
    if (name !== 'generated.json' && !part) throw new Error('export_part_unknown');
    const path = await safePath(directory, name);
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== (part?.bytes ?? before.size)) {
      await file.close();
      throw new Error('export_part_changed');
    }
    return file;
  }
}
