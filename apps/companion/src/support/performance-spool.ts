import { ProducerRetention, type IncidentParticipant } from './retention.js';
import { constants } from 'node:fs';
import { mkdir, open, opendir, lstat, unlink, link, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { z } from 'zod';
import { safePath, syncDirectory } from '../resource-store/files.js';
import { diagnosticValue } from './session-journal.js';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
export const PERFORMANCE_SPOOL_LIMITS = {
  expandedPacketBytes: 1024 * 1024,
  packetFileBytes: 1536 * 1024,
  diskBytes: 64 * 1024 * 1024,
  expandedDiskBytes: 256 * 1024 * 1024,
  files: 4096,
};
const stage = z.enum([
  'performance_anomaly_begin',
  'performance_anomaly_trigger',
  'performance_anomaly_samples',
  'performance_anomaly_end',
]);
const record = z
  .object({
    id: z.uuid(),
    windowId: z.uuid(),
    stage,
    source: z
      .object({
        time: z.iso.datetime(),
        sessionId: z.uuid(),
        hostSessionId: z.string().max(96).nullable(),
        queuedAfterSequence: z.number().int().nonnegative(),
        recordSequence: z.number().int().positive(),
        monotonicMs: z.number().finite(),
      })
      .strict(),
    evidence: z.record(z.string(), z.unknown()),
  })
  .strict();
export type PendingPerformanceRecord = z.infer<typeof record>;
type Packet = {
  windowId: string;
  part: number;
  firstTime: string;
  lastTime: string;
  expandedBytes: number;
};
type Entry = {
  name: string;
  bytes: number;
  expandedBytes: number;
  windowId: string;
  part: number;
  firstTime: string;
};
const filePattern = /^([a-f0-9-]{36})\.([a-f0-9]{4})\.gz$/i;

export function performanceRecordEvent(value: PendingPerformanceRecord) {
  const sampleTimes = Array.isArray(value.evidence.samples)
    ? value.evidence.samples
        .map((sample: { time?: unknown }) => sample?.time)
        .filter(
          (time): time is string => typeof time === 'string' && Number.isFinite(Date.parse(time)),
        )
        .sort()
    : [];
  return {
    schema: 'mizar-diagnostic-event/2',
    eventId: value.id,
    producerKind: 'companion',
    producerRunId: value.source.sessionId,
    sequence: value.source.recordSequence,
    kind: value.stage,
    phase: null,
    outcome: null,
    observedAt: value.source.time,
    recordedAt: value.source.time,
    monotonicMs: value.source.monotonicMs,
    sourceInterval: sampleTimes.length ? { from: sampleTimes[0], to: sampleTimes.at(-1) } : null,
    taskId: null,
    operationId: null,
    parentOperationId: null,
    attemptId: null,
    scope: { windowId: value.windowId },
    coverage: {
      durability: 'committed',
      unknown: ['performance-source-has-independent-sequence'],
      excluded: [],
      replayCount: 0,
      occurrences: 1,
    },
    time: value.source.time,
    startupSessionId: value.source.sessionId,
    hostStartupSessionId: value.source.hostSessionId,
    stage: value.stage,
    windowId: value.windowId,
    sourceRecordId: value.id,
    evidence: {
      ...value.evidence,
      sourceRecord: { id: value.id, ...value.source },
    },
  };
}

/** A bounded, compressed write-ahead copy for these windows only. Never evicts unacknowledged evidence. */
export class PerformanceSpool {
  private readonly directory: string;
  private readonly retained: ProducerRetention;
  private entries: Entry[] = [];
  private initialized = false;
  private unreadable = new Map<string, { bytes: number; error: unknown; retryAt: number }>();
  constructor(logDirectory: string) {
    this.directory = join(logDirectory, 'performance-pending');
    this.retained = new ProducerRetention(logDirectory, 'performance', {
      budgetBytes: PERFORMANCE_SPOOL_LIMITS.diskBytes,
      retentionMs: 14 * 86400_000,
    });
  }
  private ordinary(entries: readonly Entry[] = this.entries) {
    const extra = this.retained.incidentSegmentNames();
    return entries.filter((entry) => !extra.has('performance-pending/' + entry.name));
  }
  private used() {
    return (
      this.entries.reduce((bytes, item) => bytes + item.bytes, 0) +
      [...this.unreadable.values()].reduce((bytes, item) => bytes + item.bytes, 0)
    );
  }
  private async failed(name: string, error: unknown) {
    const bytes = await lstat(join(this.directory, name)).then(
      (value) => value.size,
      () => 0,
    );
    this.entries = this.entries.filter((entry) => entry.name !== name);
    this.unreadable.set(name, { bytes, error: diagnosticValue(error), retryAt: Date.now() + 1000 });
  }
  private entry(name: string, value: Awaited<ReturnType<PerformanceSpool['read']>>): Entry {
    return {
      name,
      bytes: value.bytes,
      expandedBytes: value.packet.expandedBytes,
      windowId: value.packet.windowId,
      part: value.packet.part,
      firstTime: value.packet.firstTime,
    };
  }
  private async read(
    name: string,
  ): Promise<{ packet: Packet; records: PendingPerformanceRecord[]; bytes: number }> {
    const path = await safePath(this.directory, name);
    const before = await lstat(path);
    if (before.size > PERFORMANCE_SPOOL_LIMITS.packetFileBytes)
      throw new Error('performance_spool_file_budget');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const actual = await file.stat();
      if (
        actual.ino !== before.ino ||
        actual.dev !== before.dev ||
        actual.nlink !== 1 ||
        actual.size > PERFORMANCE_SPOOL_LIMITS.packetFileBytes
      )
        throw new Error('performance_spool_file_changed');
      const bytes = Buffer.alloc(actual.size);
      let offset = 0;
      while (offset < bytes.length) {
        const result = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!result.bytesRead) throw new Error('performance_spool_incomplete_read');
        offset += result.bytesRead;
      }
      const raw = await decompress(bytes, {
        maxOutputLength: PERFORMANCE_SPOOL_LIMITS.expandedPacketBytes,
      });
      const events = JSON.parse(raw.toString('utf8')) as {
        eventId: string;
        windowId: string;
        stage: string;
        evidence: Record<string, unknown> & { sourceRecord: Record<string, unknown> };
      }[];
      const records = z
        .array(record)
        .min(1)
        .max(8192)
        .parse(
          events.map((event) => ({
            id: event.eventId,
            windowId: event.windowId,
            stage: event.stage,
            source: Object.fromEntries(
              Object.entries(event.evidence.sourceRecord).filter(([key]) => key !== 'id'),
            ),
            evidence: Object.fromEntries(
              Object.entries(event.evidence).filter(([key]) => key !== 'sourceRecord'),
            ),
          })),
        );
      const match = filePattern.exec(name)!;
      if (records.some((record) => record.windowId !== match[1]))
        throw new Error('performance_spool_identity_mismatch');
      const value: Packet = {
        windowId: records[0]!.windowId,
        part: parseInt(match[2]!, 16),
        firstTime: records[0]!.source.time,
        lastTime: records.at(-1)!.source.time,
        expandedBytes: raw.length,
      };
      return { packet: value, records, bytes: bytes.length };
    } finally {
      await file.close();
    }
  }
  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.retained.initialize();
    let directory: Awaited<ReturnType<typeof opendir>>;
    try {
      await safePath(this.directory);
      directory = await opendir(this.directory);
    } catch (error) {
      if (missing(error)) {
        this.initialized = true;
        return;
      }
      throw error;
    }
    const entries: Entry[] = [];
    this.unreadable.clear();
    // Repair publication links before reading any final, independent of directory order.
    for await (const file of directory) {
      if (/^[a-f0-9-]{36}\.[a-f0-9]{4}\.gz(?:\.[a-f0-9-]{36})?\.partial$/i.test(file.name)) {
        // Complete a publication interrupted between link and unlink, only for the identical inode.
        const target = file.name.slice(0, 44);
        await safePath(this.directory);
        const stagedPath = join(this.directory, file.name);
        const staged = await lstat(stagedPath);
        const published = await lstat(join(this.directory, target)).catch((error: unknown) => {
          if (!missing(error)) throw error;
          return null;
        });
        if (
          published &&
          staged.isFile() &&
          published.isFile() &&
          staged.ino === published.ino &&
          staged.dev === published.dev &&
          staged.nlink === 2 &&
          published.nlink === 2
        ) {
          await safePath(this.directory);
          const current = await lstat(stagedPath);
          if (
            !current.isFile() ||
            current.ino !== staged.ino ||
            current.dev !== staged.dev ||
            current.nlink !== 2
          )
            throw new Error('performance_partial_changed');
          await unlink(stagedPath);
          await syncDirectory(this.directory);
        } else {
          // Unknown unpublished evidence stays cold; it cannot borrow an incident exemption.
          await this.failed(file.name, new Error('unpublished_partial_retained'));
          if (this.unreadable.size > PERFORMANCE_SPOOL_LIMITS.files)
            throw new Error('performance_spool_file_count_budget');
        }
        continue;
      }
    }
    for await (const file of await opendir(this.directory)) {
      if (!filePattern.test(file.name) || entries.some((entry) => entry.name === file.name))
        continue;
      try {
        const value = await this.read(file.name);
        if (file.name.endsWith('.gz')) await this.register(file.name, value.records);
        entries.push(this.entry(file.name, value));
        this.unreadable.delete(file.name);
      } catch (error) {
        await this.failed(file.name, error);
      }
      if (
        entries.filter((entry) => !entry.name.endsWith('.gz')).length + this.unreadable.size >
        PERFORMANCE_SPOOL_LIMITS.files
      )
        throw new Error('performance_spool_file_count_budget');
      // Verified registered bodies may exceed ordinary capacity after an incident releases.
      // The bounded retention inventory restores them; append's unified collector decides writes.
      await yieldIO();
    }
    this.entries = entries;
    this.initialized = true;
  }
  private async retryUnreadable() {
    for (const [name, value] of this.unreadable) {
      if (name.endsWith('.partial') || Date.now() < value.retryAt) continue;
      try {
        const value = await this.read(name);
        if (name.endsWith('.gz')) await this.register(name, value.records);
        this.entries.push(this.entry(name, value));
        this.unreadable.delete(name);
      } catch (error) {
        await this.failed(name, error);
      }
      await yieldIO();
    }
  }
  private async save(
    windowId: string,
    part: number,
    records: PendingPerformanceRecord[],
  ): Promise<Entry> {
    if (part > 65535) throw new Error('performance_spool_part_budget');
    const raw = Buffer.from(JSON.stringify(records.map(performanceRecordEvent)));
    if (raw.length > PERFORMANCE_SPOOL_LIMITS.expandedPacketBytes)
      throw new Error('performance_spool_packet_budget');
    const compressed = await compress(raw);
    const bytes = compressed.length;
    if (bytes > PERFORMANCE_SPOOL_LIMITS.packetFileBytes)
      throw new Error('performance_spool_packet_budget');
    const name = `${windowId}.${part.toString(16).padStart(4, '0')}.gz`;
    const inventory = new Set(this.retained.snapshot().segments.map((segment) => segment.name));
    const unregistered = this.entries.filter(
      (entry) => !inventory.has('performance-pending/' + entry.name),
    );
    const expanded = new Map(
      this.entries.map((entry) => ['performance-pending/' + entry.name, entry.expandedBytes]),
    );
    const existing = this.ordinary().find((entry) => entry.name === name);
    const admission = await this.retained.collect({
      incomingBytes:
        bytes -
        (existing?.bytes ?? 0) +
        unregistered.reduce((total, entry) => total + entry.bytes, 0) +
        [...this.unreadable.values()].reduce((total, entry) => total + entry.bytes, 0),
      capacity: [
        {
          limit: PERFORMANCE_SPOOL_LIMITS.files,
          incoming: (existing ? 0 : 1) + unregistered.length + this.unreadable.size,
          cost: () => 1,
        },
        {
          limit: PERFORMANCE_SPOOL_LIMITS.expandedDiskBytes,
          incoming:
            raw.length -
            (existing?.expandedBytes ?? 0) +
            unregistered.reduce((total, entry) => total + entry.expandedBytes, 0) +
            this.unreadable.size * PERFORMANCE_SPOOL_LIMITS.expandedPacketBytes,
          cost: (segment) =>
            expanded.get(segment.name) ?? PERFORMANCE_SPOOL_LIMITS.expandedPacketBytes,
        },
      ],
    });
    const retained = new Set(admission.segments.map((segment) => segment.name));
    this.entries = this.entries.filter(
      (entry) =>
        !inventory.has('performance-pending/' + entry.name) ||
        retained.has('performance-pending/' + entry.name),
    );
    if (!admission.writable) throw new Error('performance_spool_disk_budget');
    const old = this.entries.find((item) => item.name === name);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await safePath(this.directory);
    await safePath(this.directory, name).catch((error: unknown) => {
      if (!missing(error)) throw error;
    });
    const temporary = join(this.directory, name + '.' + randomUUID() + '.partial');
    const file = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      try {
        await file.writeFile(compressed);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        // Atomic no-replace publication; a retry must never overwrite a sealed/pinned body.
        await link(temporary, join(this.directory, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.read(name); // Validate the fixed existing source before the idempotency check.
        const existing = await readFile(await safePath(this.directory, name));
        if (checksum(existing) !== checksum(compressed))
          throw new Error('performance_immutable_part_conflict', { cause: error });
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
    await syncDirectory(this.directory);
    await this.register(name, records);
    await this.retained.protectActiveSegment(
      records[0]!.source.sessionId,
      'performance-pending/' + name,
    );
    const entry = {
      name,
      windowId,
      part,
      bytes,
      expandedBytes: raw.length,
      firstTime: records[0]!.source.time,
    };
    if (old) this.entries.splice(this.entries.indexOf(old), 1, entry);
    else this.entries.push(entry);
    return entry;
  }
  async append(
    values: PendingPerformanceRecord[],
    committed: (ids: string[]) => void,
  ): Promise<void> {
    await this.initialize();
    await this.retryUnreadable();
    const currentRun = values[0]?.source.sessionId;
    if (currentRun) {
      await this.retained.initialize();
      for (const pin of this.retained.snapshot().pins)
        if (pin.kind === 'active' && pin.pinId !== currentRun)
          await this.retained.releasePin(pin.pinId);
    }
    for (const windowId of new Set(values.map((value) => value.windowId))) {
      const added = values
        .filter((value) => value.windowId === windowId)
        .map((value) => record.parse(diagnosticValue(value)));
      const last = this.entries
        .filter((entry) => entry.windowId === windowId)
        .sort((a, b) => b.part - a.part)[0];
      const pinned = Boolean(last); // Final compressed bodies are immutable, including between appends.
      const unreadableParts = [...this.unreadable.keys()]
        .filter((name) => name.startsWith(windowId + '.'))
        .map((name) => parseInt(name.slice(37, 41), 16));
      let part = Math.max(
        last ? last.part + (pinned ? 1 : 0) : 0,
        ...unreadableParts.map((part) => part + 1),
      );
      let records: PendingPerformanceRecord[] = [];
      if (last && !pinned && part === last.part) {
        try {
          records = (await this.read(last.name)).records;
        } catch (error) {
          await this.failed(last.name, error);
          part++;
        }
      }
      const existing = new Set(records.map((value) => value.id));
      const alreadyPresent = added.filter((value) => existing.has(value.id));
      if (alreadyPresent.length) {
        await syncDirectory(this.directory);
        committed(alreadyPresent.map((value) => value.id));
      }
      let newIds: string[] = [];
      let bytes = Buffer.byteLength(JSON.stringify(records.map(performanceRecordEvent)));
      for (const value of added) {
        if (existing.has(value.id)) continue;
        const size = Buffer.byteLength(JSON.stringify(performanceRecordEvent(value))) + 1;
        if (bytes + size > PERFORMANCE_SPOOL_LIMITS.expandedPacketBytes || records.length >= 8192) {
          if (records.length && newIds.length) {
            await this.save(windowId, part, records);
            committed(newIds);
          }
          part++;
          records = [];
          newIds = [];
          bytes = 2;
        }
        records.push(value);
        newIds.push(value.id);
        bytes += size;
      }
      if (newIds.length) {
        await this.save(windowId, part, records);
        committed(newIds);
      }
    }
  }
  private register(name: string, records: PendingPerformanceRecord[]) {
    return this.retained.registerSegment('performance-pending/' + name, {
      producerRunId: records[0]!.source.sessionId,
      firstSequence: records[0]!.source.recordSequence,
      lastSequence: records.at(-1)!.source.recordSequence,
      firstObservedAt: records[0]!.source.time,
      lastObservedAt: records.at(-1)!.source.time,
      records: records.length,
    });
  }
  incidentParticipant(kind: 'incident' | 'export' | 'delivery' = 'incident'): IncidentParticipant {
    return {
      producerId: 'performance',
      prepare: async (pinId) => {
        await this.initialize();
        return this.retained.preparePin({
          pinId,
          kind,
          names: this.retained.snapshot().segments.map((segment) => segment.name),
        });
      },
      commit: (pinId) => this.retained.commitPin(pinId),
      release: (pinId) => this.retained.releasePin(pinId),
    };
  }
  health() {
    return {
      files: this.entries.length,
      pendingFiles: this.entries.length,
      exportPinnedFiles: new Set(
        this.retained
          .snapshot()
          .pins.filter((pin) => pin.kind === 'export')
          .flatMap((pin) => pin.segments.map((segment) => segment.name)),
      ).size,
      unreadableFiles: this.unreadable.size,
      sourceErrors: [...this.unreadable].map(([name, value]) => ({ name, error: value.error })),
      bytes: this.used(),
      expandedBytes: this.entries.reduce((bytes, item) => bytes + item.expandedBytes, 0),
      limits: PERFORMANCE_SPOOL_LIMITS,
    };
  }
}
