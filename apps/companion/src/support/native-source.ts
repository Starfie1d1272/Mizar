import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { atomicJson, safePath } from '../resource-store/files.js';
import { ResourceStoreError } from '../resource-store/contract.js';
import { diagnosticValue, type SessionJournal } from './session-journal.js';

const names = ['desktop.ndjson', 'desktop.1.ndjson', 'desktop.2.ndjson', 'desktop.3.ndjson'];
const cursorName = 'native-source-cursor.json';
export const NATIVE_SOURCE_LIMITS = {
  pollMs: 1000,
  readBytes: 256 * 1024,
  lineBytes: 128 * 1024,
  groupBytes: 192 * 1024,
  sourceBytes: 25 * 1024 * 1024,
  cursorBytes: 8192,
};
type Cursor = { identity: string; offset: number; anchor: string; discarding: boolean };
type NativeRecord = {
  time: string;
  startupSessionId: string;
  stage: string;
  result: string;
  [key: string]: unknown;
};
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

// Only fixed Host names can use the Windows packaged-app mapping fallback.
async function nativePath(directory: string, name: string): Promise<string> {
  try {
    return await safePath(directory, name);
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !(error instanceof ResourceStoreError) ||
      error.code !== 'resource_path_unsafe'
    )
      throw error;
    if (name !== cursorName && !names.includes(name)) throw error;
    await safePath(directory);
    const path = join(directory, name);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw error;
    const resolved = await realpath(path);
    if (basename(resolved).toLowerCase() !== name.toLowerCase()) throw error;
    await safePath(dirname(resolved), basename(resolved));
    const actual = await lstat(resolved);
    await safePath(directory);
    const after = await lstat(path);
    if (
      !actual.isFile() ||
      actual.isSymbolicLink() ||
      actual.nlink !== 1 ||
      !Number.isSafeInteger(before.ino) ||
      before.ino === 0 ||
      actual.dev !== before.dev ||
      actual.ino !== before.ino ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1
    )
      throw error;
    return path;
  }
}

/** Incremental observer of the four fixed Mizar Host files, never a caller-supplied path. */
export class NativeSource {
  private cursors: Cursor[] = [];
  private checkpointPending = false;
  private failureReportedAt = new Map<string, { signature: string; time: number }>();
  private suppressedFailures = 0;
  private initialized = false;
  private closed = false;
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closing: Promise<void> | undefined;
  private error: string | null = null;
  private failures = 0;
  private copied = 0;
  private invalid = 0;
  private gaps = 0;
  private backlogBytes = 0;
  private recordFailure(key: string, evidence: Record<string, unknown>) {
    this.failures++;
    const now = Date.now();
    const last = this.failureReportedAt.get(key);
    const error = evidence.error;
    const signature = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    if (!last || last.signature !== signature || now - last.time >= 60_000) {
      this.journal.record('native_source_failure', {
        ...evidence,
        failures: this.failures,
        suppressedFailures: this.suppressedFailures,
      });
      this.failureReportedAt.set(key, { signature, time: now });
      this.suppressedFailures = 0;
    } else this.suppressedFailures++;
  }
  constructor(
    private readonly directory: string,
    private readonly journal: SessionJournal,
    private readonly onRecord?: (record: NativeRecord) => void,
  ) {}

  start(): void {
    if (this.closed || this.timer) return;
    this.timer ??= setInterval(() => {
      void this.poll();
    }, NATIVE_SOURCE_LIMITS.pollMs);
    this.timer.unref();
    void this.poll();
  }
  poll(): Promise<void> {
    if (this.running) return this.running;
    if (this.closed) return Promise.resolve();
    this.running = this.journal.withSystem(() =>
      this.read()
        .catch((error: unknown) => {
          this.error = 'native_source_unavailable';
          this.recordFailure('poll', { error });
        })
        .finally(() => {
          this.running = undefined;
        }),
    );
    return this.running;
  }
  private async initialize() {
    if (this.initialized) return;
    try {
      const path = await nativePath(this.directory, cursorName);
      const before = await lstat(path);
      if (before.size > NATIVE_SOURCE_LIMITS.cursorBytes) throw new Error('native_cursor_budget');
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const actual = await file.stat();
        const named = await lstat(await nativePath(this.directory, cursorName));
        if (
          actual.ino !== before.ino ||
          actual.dev !== before.dev ||
          actual.nlink !== 1 ||
          actual.ino !== named.ino ||
          actual.dev !== named.dev
        )
          throw new Error('native_cursor_changed');
        const buffer = Buffer.alloc(NATIVE_SOURCE_LIMITS.cursorBytes + 1);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead > NATIVE_SOURCE_LIMITS.cursorBytes) throw new Error('native_cursor_budget');
        const value = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as {
          schema?: number;
          cursors?: Cursor[];
        };
        if (
          value.schema !== 1 ||
          !Array.isArray(value.cursors) ||
          value.cursors.length > 4 ||
          value.cursors.some(
            (cursor) =>
              !cursor ||
              typeof cursor.identity !== 'string' ||
              !/^[a-f0-9]{64}$/.test(cursor.identity) ||
              !Number.isSafeInteger(cursor.offset) ||
              cursor.offset < 0 ||
              cursor.offset > NATIVE_SOURCE_LIMITS.sourceBytes ||
              typeof cursor.discarding !== 'boolean' ||
              !/^[a-f0-9]{64}$/.test(cursor.anchor),
          )
        )
          throw new Error('native_cursor_invalid');
        this.cursors = value.cursors;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (!missing(error)) {
        this.gaps++;
        this.journal.record('native_source_gap', {
          reason: 'cursor_unreadable_replay_possible',
          error,
        });
      }
    }
    this.initialized = true;
  }
  private async read(): Promise<void> {
    await this.initialize();
    const previous = structuredClone(this.cursors);
    const found = new Set<string>();
    this.backlogBytes = 0;
    let sourceFailed = false;
    try {
      for (const name of names) {
        const beforeFile = structuredClone(this.cursors);
        try {
          await this.file(name, found);
        } catch (error) {
          this.cursors = beforeFile;
          sourceFailed = true;
          this.recordFailure(name, { name, error });
        }
      }
      const removed = this.cursors.filter((cursor) => !found.has(cursor.identity));
      if (removed.length) {
        this.gaps++;
        this.journal.record('native_source_gap', {
          reason: 'source_rotation_or_removal',
          cursors: removed,
          scope: 'removed file may have unread bytes; retained Host files remain authoritative',
        });
      }
      this.cursors = this.cursors.filter((cursor) => found.has(cursor.identity));
      // The journal commit precedes this checkpoint. A crash in between can replay
      // stable sourceRecordIds, never skip evidence whose durable commit failed.
      if (this.checkpointPending || JSON.stringify(previous) !== JSON.stringify(this.cursors)) {
        this.checkpointPending = true;
        try {
          await nativePath(this.directory, cursorName).catch((error) => {
            if (!missing(error)) throw error;
          });
          await atomicJson(join(this.directory, cursorName), { schema: 1, cursors: this.cursors });
          this.checkpointPending = false;
        } catch (error) {
          // Committed records are already delivered. Keep advancing in memory while
          // retrying the checkpoint; restart may safely replay the old checkpoint.
          this.recordFailure('checkpoint', { error });
          sourceFailed = true;
        }
      }
      this.error = sourceFailed ? 'native_source_unavailable' : null;
      if (!sourceFailed && this.failureReportedAt.size) {
        this.journal.record('native_source_recovered', {
          failures: this.failures,
          suppressedFailures: this.suppressedFailures,
        });
        this.failureReportedAt.clear();
        this.suppressedFailures = 0;
      }
    } catch (error) {
      this.cursors = previous;
      throw error;
    }
  }
  private async anchor(file: Awaited<ReturnType<typeof open>>, offset: number) {
    const bytes = Buffer.alloc(Math.min(128, offset));
    const result = await file.read(bytes, 0, bytes.length, offset - bytes.length);
    if (result.bytesRead !== bytes.length) throw new Error('native_source_changed');
    return hash(bytes);
  }
  private async openSource(name: string) {
    const path = await nativePath(this.directory, name);
    const before = await lstat(path);
    if (before.size > NATIVE_SOURCE_LIMITS.sourceBytes)
      throw new Error('native_source_size_budget');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    return { before, file };
  }
  private async file(name: string, found: Set<string>) {
    const source = await this.openSource(name).catch((error: unknown) => {
      if (missing(error)) return null;
      throw error;
    });
    if (!source) return;
    const { before, file } = source;
    try {
      const actual = await file.stat();
      const named = await lstat(await nativePath(this.directory, name));
      if (
        !actual.isFile() ||
        actual.nlink !== 1 ||
        actual.size > NATIVE_SOURCE_LIMITS.sourceBytes ||
        actual.ino !== before.ino ||
        actual.dev !== before.dev ||
        actual.ino !== named.ino ||
        actual.dev !== named.dev
      )
        throw new Error('native_source_changed');
      const identity = hash(`${actual.dev}:${actual.ino}:${actual.birthtimeMs}`);
      found.add(identity);
      let cursor = this.cursors.find((value) => value.identity === identity);
      if (!cursor) {
        cursor = { identity, offset: 0, anchor: hash(''), discarding: false };
        this.cursors.push(cursor);
      }
      if (
        cursor.offset > actual.size ||
        cursor.anchor !== (await this.anchor(file, cursor.offset))
      ) {
        this.gaps++;
        this.journal.record('native_source_gap', {
          reason: 'source_truncated_or_rewritten',
          name,
          identity,
          offset: cursor.offset,
        });
        cursor.offset = 0;
        cursor.anchor = hash('');
        cursor.discarding = false;
      }
      const buffer = Buffer.alloc(
        Math.min(NATIVE_SOURCE_LIMITS.readBytes, actual.size - cursor.offset),
      );
      const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor.offset);
      const bytes = buffer.subarray(0, bytesRead);
      const entries: {
        sourceRecordId: string;
        offset: number;
        bytes: number;
        entry: NativeRecord;
      }[] = [];
      let groupBytes = 0;
      let invalid = 0;
      const invalidSamples: unknown[] = [];
      const invalidLine = (value: unknown) => {
        invalid++;
        this.invalid++;
        if (invalidSamples.length < 16) invalidSamples.push(value);
      };
      const commit = async () => {
        if (!entries.length) return;
        const committed = entries.splice(0);
        await this.journal.recordCommitted('native_host_records', {
          source: {
            name,
            identity,
            scope: 'fixed Mizar Host log; original source times and sessions preserved',
          },
          entries: committed,
        });
        this.copied += committed.length;
        for (const record of committed) this.onRecord?.(record.entry);
        groupBytes = 0;
      };
      let start = 0;
      while (start < bytes.length) {
        const end = bytes.indexOf(10, start);
        if (end < 0) {
          if (bytes.length - start > NATIVE_SOURCE_LIMITS.lineBytes || cursor.discarding) {
            cursor.discarding = true;
            cursor.offset += bytes.length - start;
            invalidLine({ reason: 'oversized_incomplete_line', bytes: bytes.length - start });
          }
          break;
        }
        const line = bytes.subarray(start, end);
        const offset = cursor.offset;
        cursor.offset += end + 1 - start;
        start = end + 1;
        if (cursor.discarding) {
          cursor.discarding = false;
          continue;
        }
        let entry: NativeRecord;
        try {
          if (line.length > NATIVE_SOURCE_LIMITS.lineBytes) throw new Error('native_line_budget');
          entry = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(line),
          ) as NativeRecord;
          if (
            !entry ||
            typeof entry !== 'object' ||
            entry.schemaVersion !== 1 ||
            !Number.isFinite(Date.parse(entry.time)) ||
            typeof entry.startupSessionId !== 'string' ||
            !/^[a-zA-Z0-9_-]{1,96}$/.test(entry.startupSessionId) ||
            typeof entry.stage !== 'string' ||
            !/^[a-z][a-z0-9_]{0,127}$/.test(entry.stage) ||
            typeof entry.result !== 'string' ||
            entry.result.length > 64
          )
            throw new Error('native_record_invalid');
        } catch (error) {
          invalidLine({
            reason: 'invalid_native_record',
            offset,
            bytes: line.length,
            sha256: hash(line),
            error,
          });
          continue;
        }
        // Keep I/O outside the malformed-record catch: a failed durable commit
        // aborts this poll and restores every source cursor for replay.
        const copied = {
          sourceRecordId: hash(`${identity}:${offset}:${hash(line)}`),
          offset,
          bytes: line.length + 1,
          entry: diagnosticValue(entry) as NativeRecord,
        };
        const size = Buffer.byteLength(JSON.stringify(copied));
        if (size > NATIVE_SOURCE_LIMITS.groupBytes) {
          invalidLine({
            reason: 'sanitized_native_record_budget',
            offset,
            bytes: line.length,
            sha256: hash(line),
          });
          continue;
        }
        if (groupBytes + size > NATIVE_SOURCE_LIMITS.groupBytes) await commit();
        entries.push(copied);
        groupBytes += size;
      }
      await commit();
      if (invalid)
        await this.journal.recordCommitted('native_source_gap', {
          reason: 'invalid_or_oversized_records',
          name,
          count: invalid,
          samples: invalidSamples,
          omittedSamples: Math.max(0, invalid - invalidSamples.length),
          scope: 'malformed bytes remain in original Host file; not copied as trustworthy records',
        });
      cursor.anchor = await this.anchor(file, cursor.offset);
      const after = await file.stat();
      if (after.nlink !== 1 || after.size < cursor.offset)
        throw new Error('native_source_changed_during_read');
      this.backlogBytes += Math.max(0, after.size - cursor.offset);
    } finally {
      await file.close();
    }
  }
  health() {
    return {
      copied: this.copied,
      invalidRecords: this.invalid,
      gaps: this.gaps,
      failures: this.failures,
      error: this.error,
      backlogBytes: this.backlogBytes,
      trackedFiles: this.cursors.length,
      cursorSemantics: 'at-least-once; stable sourceRecordId permits replay deduplication',
      limits: NATIVE_SOURCE_LIMITS,
    };
  }
  close(): Promise<void> {
    return (this.closing ??= this.finishClose());
  }
  private async finishClose() {
    clearInterval(this.timer);
    await this.running;
    await this.poll();
    this.closed = true;
    this.journal.record('native_source_health', this.health());
  }
}
