import { readHostPin, type IncidentParticipant, type PinReceipt } from './retention.js';
import { collectObsNativeEvidence } from '../obs/native-evidence.js';
import { constants } from 'node:fs';
import { mkdir, open, lstat, readdir, rm, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { atomicJson, safePath } from '../resource-store/files.js';
import { diagnosticSegmentPattern } from './segments.js';
import { archiveWorkerSource } from './archive-worker.js';
const legacy =
  /^(?:session\.ndjson(?:\.[0-9]+)?|desktop(?:\.[0-9]+)?\.ndjson|desktop\.ndjson\.[0-9]+|business(?:\.ndjson(?:\.[0-9]+)?|-history\.json)|supervisor\.ndjson(?:\.[0-9]+)?|companion(?:\.stderr)?\.log(?:\.[0-9]+)?)$/;
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export interface ExportJob {
  exportId: string;
  phase: 'collecting' | 'encoding' | 'ready' | 'failed' | 'cancelled';
  inputBytes: number;
  outputBytes: number;
  error?: string;
  expiresAt?: string;
  parts?: { name: string; bytes: number; sha256: string }[];
}
/** One bounded build. HTTP carries only status and trusted binary attachment routes. */
export class SupportExports {
  private job: ExportJob | undefined;
  private task: Promise<void> | undefined;
  private worker: Worker | undefined;
  readonly directory: string;
  constructor(
    private readonly logs: string,
    private readonly participants: () => IncidentParticipant[] = () => [],
  ) {
    this.directory = join(dirname(logs), 'support-export');
  }
  status(id: string) {
    return id === this.job?.exportId ? this.job : null;
  }
  async begin(
    range: { from?: string; to?: string },
    snapshot: unknown,
    hostPinId?: string,
  ): Promise<ExportJob> {
    if (this.task) throw new Error('export_busy');
    await safePath(dirname(this.directory));
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await safePath(this.directory);
    for (const name of await readdir(this.directory)) {
      if (!idPattern.test(name)) continue;
      const path = await safePath(join(this.directory, name));
      const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      if (Date.now() - stat.mtimeMs <= 15 * 60_000) continue;
      let lease: FileHandle | undefined;
      try {
        lease = await open(
          join(path, 'saving.lease'),
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        await safePath(join(this.directory, name));
        // Only an exclusively held lease permits cleanup; a saver wins by creating the same file.
        await lease.close();
        lease = undefined;
        await rm(path, { recursive: true });
      } catch (error) {
        await lease?.close();
        if (
          (error as NodeJS.ErrnoException).code !== 'EEXIST' &&
          (error as NodeJS.ErrnoException).code !== 'ENOENT'
        )
          throw error;
      }
    }
    const job: ExportJob = {
      exportId: hostPinId ?? randomUUID(),
      phase: 'collecting',
      inputBytes: 0,
      outputBytes: 0,
    };
    this.job = job;
    this.task = this.build(job, range, snapshot, hostPinId)
      .catch((error) => {
        if (job.phase !== 'cancelled') job.phase = 'failed';
        job.error = String(error);
        void rm(join(this.directory, job.exportId), { recursive: true, force: true }).catch(
          () => undefined,
        );
      })
      .finally(() => {
        this.task = undefined;
      });
    return job;
  }
  private async build(
    job: ExportJob,
    range: { from?: string; to?: string },
    snapshot: unknown,
    hostPinId?: string,
  ) {
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
      secrets?: readonly string[];
    }[] = [];
    const gaps: { source: string; reason: string }[] = [];
    const output = join(this.directory, job.exportId);
    await mkdir(output, { mode: 0o700 });
    const capture = async (directory: string, name: string, prefix = '', rawIndex = false) => {
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
        });
      } catch (error) {
        gaps.push({ source: prefix + name, reason: String(error) });
      }
    };
    try {
      for (const participant of participants) {
        const prepared = await participant.prepare(job.exportId);
        receipts.push({
          ...(await participant.commit(job.exportId)),
          sourceState: prepared.sourceState,
        });
      }
      hostPin = hostPinId ? await readHostPin(this.logs, hostPinId, 'export') : null;
      const companionPin = receipts.find((receipt) => receipt.producerId === 'companion');
      const performancePin = receipts.find((receipt) => receipt.producerId === 'performance');
      const pinned = (receipt: { segments: { name: string }[] } | null | undefined, name: string) =>
        !receipt || receipt.segments.some((segment) => segment.name === name);
      await safePath(this.logs);
      // Complete local sources precede narrower technical carriers, preserving conflicting variants.
      for (const name of (await readdir(this.logs)).sort())
        if (
          (legacy.test(name) || diagnosticSegmentPattern.test(name)) &&
          (!name.startsWith('session-') || pinned(companionPin, name)) &&
          (!/^(?:desktop|document)-/.test(name) || pinned(hostPin, name))
        )
          await capture(this.logs, name);
      if ((await readdir(this.logs)).includes('host-retention.ndjson'))
        await capture(this.logs, 'host-retention.ndjson', 'retention/', true);
      for (const [folder, pattern] of [
        ['performance-pending', /^[a-f0-9-]{36}\.[a-f0-9]{4}\.(?:json|gz)$/],
        ['marked-incidents', /^[a-f0-9-]{36}\.json$/],
        ['diagnostic-outbox', /^[a-f0-9]{64}\.gz$/],
      ] as const) {
        const directory = join(this.logs, folder);
        try {
          await safePath(directory);
          for (const name of (await readdir(directory)).sort())
            if (
              pattern.test(name) &&
              (folder !== 'performance-pending' ||
                !name.endsWith('.gz') ||
                pinned(performancePin, folder + '/' + name))
            )
              await capture(directory, name, folder + '/');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            gaps.push({ source: folder, reason: String(error) });
        }
      }
      const migrationDirectory = join(this.logs, 'diagnostic-migration');
      try {
        await safePath(migrationDirectory);
        for (const name of await readdir(migrationDirectory))
          if (name === 'inventory.json' || /^aliases-[a-f0-9-]{36}\.ndjson$/.test(name))
            await capture(migrationDirectory, name, 'diagnostic-migration/', true);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          gaps.push({ source: 'diagnostic-migration', reason: String(error) });
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
            secrets: source.secrets,
          });
        },
      });
      if (hostPin)
        for (const segment of hostPin.segments) {
          const source = sources.find((source) => source.name === segment.name);
          if (!source || source.bytes !== segment.bytes)
            throw new Error('host_pin_snapshot_incomplete');
        }
      const asOf = new Date().toISOString();
      const vector = {
        asOf,
        atomic: false,
        producerPins: receipts,
        hostPin: hostPin
          ? {
              pinId: hostPin.pinId,
              status: hostPin.status,
              confirmedAt: hostPin.confirmedAt,
              segments: hostPin.segments,
            }
          : { status: 'unconfirmed' },
        sources: sources.map(({ name, bytes }) => ({ name, bytes })),
        current: {
          snapshot: typeof snapshot === 'function' ? await snapshot() : snapshot,
          nativeObs,
        },
        unknown: [
          'cross-process snapshot is not atomic',
          'unhanded document events',
          'unflushed producer buffers',
        ],
      };
      await new Promise<void>((resolve, reject) => {
        const worker = new Worker(archiveWorkerSource, {
          eval: true,
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 },
          workerData: {
            sources,
            gaps,
            output,
            exportId: job.exportId,
            range,
            snapshot: vector,
            fflate: createRequire(import.meta.url).resolve('fflate'),
          },
        });
        this.worker = worker;
        if (job.phase === 'cancelled') void worker.terminate();
        let settled = false;
        worker.on('message', (message: ExportJob & Record<string, unknown>) => {
          if (message.phase === 'failed') {
            settled = true;
            reject(new Error(message.error));
          } else if (message.phase === 'ready') {
            const readyAt = Date.now();
            void atomicJson(join(output, 'generated.json'), {
              schema: 'mizar-support-export/2',
              createdAt: new Date(readyAt).toISOString(),
              expiresAt: new Date(readyAt + 15 * 60_000).toISOString(),
              ...message,
              exportId: job.exportId,
            }).then(() => {
              Object.assign(job, message, {
                exportId: job.exportId,
                expiresAt: new Date(readyAt + 15 * 60_000).toISOString(),
              });
              settled = true;
              resolve();
            }, reject);
          } else Object.assign(job, message, { exportId: job.exportId });
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (code && !settled) reject(new Error(`export_worker_exit_${code}`));
        });
      });
    } finally {
      this.worker = undefined;
      await Promise.all(handles.map((handle) => handle.close()));
      await Promise.all(
        participants.map((participant) => participant.release(job.exportId).catch(() => undefined)),
      );
    }
  }
  async cancel(id: string) {
    if (this.job?.exportId !== id || this.job.phase === 'ready') return false;
    this.job.phase = 'cancelled';
    await this.worker?.terminate();
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
