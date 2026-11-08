import type { DocumentHandoffCoverage, HostPinCoverage } from '@mizar/protocol';
import { readHostPin, type IncidentParticipant, type PinReceipt } from './retention.js';
import { collectObsNativeEvidence } from '../obs/native-evidence.js';
import { constants } from 'node:fs';
import { mkdir, open, lstat, readdir, rm, type FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { atomicJson, safePath } from '../resource-store/files.js';
import { diagnosticSegmentPattern } from './segments.js';
import { diagnosticValue } from './session-journal.js';
import type { ArchiveWorkerData } from './archive-worker.js';
const currentProcessLogs = /^(?:supervisor\.ndjson|companion(?:\.stderr)?\.log)(?:\.[0-9]+)?$/;
const CACHE_LIMIT = 256 * 1024 * 1024;
const MANIFEST_RESERVE = 1024 * 1024;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
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
}
/** One bounded build. HTTP carries only status and trusted binary attachment routes. */
export class SupportExports {
  private readonly jobs = new Map<string, ExportJob>();
  private active:
    { id: string; outputCreated?: boolean; task?: Promise<void>; worker?: Worker } | undefined;
  readonly directory: string;
  constructor(
    private readonly logs: string,
    private readonly participants: () => IncidentParticipant[] = () => [],
    private readonly onDiagnostic?: (error: unknown, exportId: string) => void,
  ) {
    this.directory = join(dirname(logs), 'support-export');
  }
  status(id: string) {
    const job = this.jobs.get(id);
    return job && (!job.expiresAt || Date.parse(job.expiresAt) > Date.now())
      ? { ...job, settled: this.active?.id !== id }
      : null;
  }
  /** Only after a request was explicitly rejected; never authorizes retrying the same ID. */
  canReleaseRejectedHostPin(id: string) {
    return idPattern.test(id) && this.active?.id !== id && !this.jobs.has(id);
  }
  async begin(
    range: { from?: string; to?: string },
    snapshot: unknown,
    hostPinId?: string,
    documentHandoff?: DocumentHandoffCoverage,
    hostPinCoverage?: HostPinCoverage,
  ): Promise<ExportJob> {
    if (this.active) throw new Error('export_busy');
    for (const [id, cached] of this.jobs)
      if (cached.expiresAt && Date.parse(cached.expiresAt) <= Date.now()) this.jobs.delete(id);
    if (this.jobs.size >= 64) throw new Error('export_cache_job_budget');
    const id = hostPinId ?? randomUUID();
    if (!idPattern.test(id) || this.jobs.has(id)) throw new Error('export_identity_conflict');
    const job: ExportJob = { exportId: id, phase: 'collecting', inputBytes: 0, outputBytes: 0 };
    // Admission is owned before the first asynchronous boundary, including cache inspection.
    const active = { id } as NonNullable<SupportExports['active']>;
    this.active = active;
    this.jobs.set(id, job);
    active.task = (async () => {
      const diskBudgetBytes = await this.prepareCache();
      this.assertActive(job);
      await this.build(
        job,
        range,
        snapshot,
        diskBudgetBytes,
        hostPinId,
        documentHandoff,
        hostPinCoverage,
      );
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
  private async prepareCache() {
    await safePath(dirname(this.directory));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await safePath(this.directory);
    let used = 0;
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
      if (!idPattern.test(name)) throw new Error('export_cache_unknown_entry');
      const path = await safePath(join(this.directory, name));
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('export_cache_unsafe');
      if (Date.now() - stat.mtimeMs > 15 * 60_000) {
        let lease: FileHandle | undefined;
        try {
          lease = await open(
            join(path, 'saving.lease'),
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
            0o600,
          );
          await safePath(path);
          await lease.close();
          lease = undefined;
          await rm(path, { recursive: true });
          this.jobs.delete(name);
          continue;
        } catch (error) {
          await lease?.close();
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
      used += await size(path);
    }
    const remaining = CACHE_LIMIT - used - MANIFEST_RESERVE;
    if (remaining <= 0) throw new Error('export_cache_budget');
    return remaining;
  }
  private async build(
    job: ExportJob,
    range: { from?: string; to?: string },
    snapshot: unknown,
    diskBudgetBytes: number,
    hostPinId?: string,
    documentHandoff?: DocumentHandoffCoverage,
    hostPinCoverage?: HostPinCoverage,
  ) {
    const collectionStarted = performance.now();
    const handles: FileHandle[] = [];
    const participants = this.participants();
    const receipts: PinReceipt[] = [];
    let hostPin: Awaited<ReturnType<typeof readHostPin>> | null = null;
    const sources: {
      name: string;
      fd: number;
      bytes: number;
      rawAttachment?: boolean;
      rawIndex?: boolean;
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
        scope: 'source unavailable; retained original and unknown range',
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
          'requesting document only; unconfirmed at reported cutoff, not proof of omission from pinned files; lifetime loss may fall outside selected time range',
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
    ) => {
      try {
        const path = await safePath(directory, name);
        const before = await lstat(path);
        if (!before.isFile() || before.nlink !== 1 || before.size > 64 * 1024 * 1024)
          throw new Error('source_unsafe_or_oversize');
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        handles.push(handle);
        const actual = await handle.stat();
        if (actual.ino !== before.ino || actual.dev !== before.dev || actual.nlink !== 1)
          throw new Error('source_changed');
        const expected = [
          ...receipts.flatMap((receipt) => receipt.segments),
          ...(hostPin?.segments ?? []),
        ].find((segment) => segment.name === prefix + name);
        if (expected) {
          if (actual.size !== expected.bytes) throw new Error('pin_source_length_changed');
          const hash = createHash('sha256');
          const buffer = Buffer.alloc(65536);
          let position = 0;
          while (position < expected.bytes) {
            const { bytesRead } = await handle.read(
              buffer,
              0,
              Math.min(buffer.length, expected.bytes - position),
              position,
            );
            if (!bytesRead) throw new Error('pin_source_short_read');
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
          }
          if (hash.digest('hex') !== expected.sha256) throw new Error('pin_source_digest_changed');
        }
        sources.push({
          name: prefix + name,
          fd: handle.fd,
          bytes: expected?.bytes ?? actual.size,
          rawIndex,
          rawAttachment,
        });
      } catch (error) {
        gaps.push({ source: prefix + name, reason: String(error) });
      }
    };
    let readyResult: (ExportJob & Record<string, unknown>) | undefined;
    let failed = false;
    let primaryError: unknown;
    let cleanupFailures: unknown[];
    try {
      for (const participant of participants) {
        this.assertActive(job);
        let phase = 'prepare';
        try {
          const prepared = await participant.prepare(job.exportId);
          phase = 'commit';
          const committed = await participant.commit(job.exportId);
          if (
            committed.pinId !== job.exportId ||
            committed.producerId !== participant.producerId ||
            committed.kind !== 'export' ||
            committed.status !== 'committed' ||
            JSON.stringify(committed.segments) !== JSON.stringify(prepared.segments)
          )
            throw new Error('export_pin_receipt_invalid');
          receipts.push({ ...committed, sourceState: prepared.sourceState });
        } catch (error) {
          gap(participant.producerId, phase, error);
        }
      }
      if (hostPinCoverage && (hostPinCoverage.status !== 'committed' || !hostPinId))
        gaps.push({
          source: 'host',
          phase: 'pin',
          reason: 'host_pin_unconfirmed',
          cause: hostPinCoverage,
          scope: 'client-reported outcome; abandoned or unavailable pin is not used',
        });
      if (hostPinId && (!hostPinCoverage || hostPinCoverage.status === 'committed')) {
        try {
          hostPin = await readHostPin(this.logs, hostPinId, 'export');
          if (hostPin.status !== 'committed') throw new Error('host_pin_uncommitted');
          const state = hostPin.sourceState as
            | {
                memoryOnly: { events: number | null };
                unreportedLoss: Record<string, number>;
              }
            | undefined;
          if (
            state &&
            (state.memoryOnly.events === null ||
              state.memoryOnly.events > 0 ||
              Object.values(state.unreportedLoss).some((count) => count > 0))
          )
            gap('host', 'coverage', new Error('host_memory_only_or_unreported_loss'));
        } catch (error) {
          hostPin = null;
          gap('host', 'pin', error);
        }
      }
      const companionPin = receipts.find((receipt) => receipt.producerId === 'companion');
      const performancePin = receipts.find((receipt) => receipt.producerId === 'performance');
      const pinned = (receipt: { segments: { name: string }[] } | null | undefined, name: string) =>
        receipt?.segments.some((segment) => segment.name === name) ?? false;
      try {
        await safePath(this.logs);
        const names = (await readdir(this.logs)).sort();
        for (const name of names) {
          this.assertActive(job);
          if (diagnosticSegmentPattern.test(name)) {
            const pin = name.startsWith('session-') ? companionPin : hostPin;
            if (pinned(pin, name)) await capture(this.logs, name);
            else gap(name, 'pin', new Error('source_not_safely_fixed'));
          } else if (currentProcessLogs.test(name)) await capture(this.logs, name, '', false, true);
        }
        if (names.includes('host-retention.ndjson'))
          await capture(this.logs, 'host-retention.ndjson', 'attachments/retention/', false, true);
        if (names.includes('incident-pins.json'))
          await capture(this.logs, 'incident-pins.json', 'retention/', true);
      } catch (error) {
        gap('logs', 'enumerate', error);
      }
      for (const [folder, pattern] of [
        ['performance-pending', /^[a-f0-9-]{36}\.[a-f0-9]{4}\.gz$/],
        ['diagnostic-outbox', /^[a-f0-9]{64}\.gz$/],
      ] as const) {
        try {
          const directory = await safePath(join(this.logs, folder));
          for (const name of (await readdir(directory)).sort()) {
            if (!pattern.test(name)) continue;
            if (folder === 'performance-pending' && !pinned(performancePin, folder + '/' + name)) {
              gap(folder + '/' + name, 'pin', new Error('source_not_safely_fixed'));
              continue;
            }
            await capture(directory, name, folder + '/');
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') gap(folder, 'enumerate', error);
        }
      }
      const nativeObs = await collectObsNativeEvidence({
        includeRelatedLogs: true,
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
      });
      this.assertActive(job);
      const asOf = new Date().toISOString();
      const vector = {
        asOf,
        atomic: false,
        producerPins: receipts,
        documentHandoff: {
          clientReported: true,
          coverage: documentHandoff ?? null,
        },
        hostPinCoverage: { clientReported: true, coverage: hostPinCoverage ?? null },
        hostPin: hostPin
          ? {
              pinId: hostPin.pinId,
              status: hostPin.status,
              confirmedAt: hostPin.confirmedAt,
              sourceState: hostPin.sourceState,
              segments: hostPin.segments,
            }
          : { status: 'unconfirmed' },
        sources: sources.map(({ name, bytes }) => ({ name, bytes })),
        current: {
          snapshot:
            typeof snapshot === 'function'
              ? await Promise.resolve()
                  .then(() => snapshot())
                  .catch((error: unknown) => {
                    gap('snapshot', 'collect', error);
                    return { status: 'unavailable' };
                  })
              : snapshot,
          nativeObs,
          frameRateLive: await this.frameRateSnapshot(gap),
        },
        unknown: [
          'cross-process snapshot is not atomic',
          'other documents and events created after the requesting document cutoff',
          'unflushed producer buffers',
        ],
      };
      const collectionMs = performance.now() - collectionStarted;
      await new Promise<void>((resolve, reject) => {
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
        let settled = false;
        let finishing = false;
        worker.on('message', (message: ExportJob & Record<string, unknown>) => {
          if (this.active?.id !== job.exportId || job.phase === 'cancelled') return;
          if (message.phase === 'failed') {
            settled = true;
            reject(new Error(message.error));
          } else if (message.phase === 'ready') {
            finishing = true;
            const readyAt = Date.now();
            const downloadName = `mizar-support-${new Date(readyAt).toISOString().replaceAll(':', '-')}.zip`;
            const manifest = {
              schema: 'mizar-support-export/2',
              createdAt: new Date(readyAt).toISOString(),
              expiresAt: new Date(readyAt + 15 * 60_000).toISOString(),
              ...message,
              measurements: { ...(message.measurements as Record<string, unknown>), collectionMs },
              downloadName,
              exportId: job.exportId,
            };
            if (Buffer.byteLength(JSON.stringify(manifest)) > MANIFEST_RESERVE) {
              reject(new Error('export_manifest_budget'));
              return;
            }
            void atomicJson(join(output, 'generated.json'), manifest)
              .then(() => {
                this.assertActive(job);
                readyResult = {
                  ...message,
                  downloadName,
                  exportId: job.exportId,
                  expiresAt: new Date(readyAt + 15 * 60_000).toISOString(),
                };
                settled = true;
                resolve();
              })
              .catch(reject);
          } else Object.assign(job, message, { exportId: job.exportId });
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (!settled && (!finishing || code !== 0 || job.phase === 'cancelled'))
            reject(new Error(`export_worker_exit_${code}`));
        });
      });
    } catch (error) {
      failed = true;
      primaryError = error;
    } finally {
      if (this.active?.id === job.exportId) delete this.active.worker;
      const closed = await Promise.allSettled(handles.map((handle) => handle.close()));
      const released = await Promise.allSettled(
        participants.map((participant) => participant.release(job.exportId)),
      );
      cleanupFailures = [...closed, ...released]
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map((result) => result.reason);
    }
    if (failed && cleanupFailures.length)
      throw new AggregateError([primaryError, ...cleanupFailures], 'export_cleanup_failed', {
        cause: primaryError,
      });
    if (failed) throw primaryError;
    if (cleanupFailures.length) throw new AggregateError(cleanupFailures, 'export_cleanup_failed');
    this.assertActive(job);
    if (!readyResult) throw new Error('export_result_missing');
    Object.assign(job, readyResult);
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
