import { randomUUID } from 'node:crypto';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { SessionJournal } from './session-journal.js';
import { diagnosticValue } from './session-journal.js';
import {
  PerformanceSpool,
  performanceRecordEvent,
  type PendingPerformanceRecord,
} from './performance-spool.js';

/** A fixed technical selection; never copy auth, player names, chat or unknown payload fields. */
export function selectedGsiContext(payload: Record<string, unknown>) {
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const fields = (value: unknown, keys: string[]) => {
    const source = record(value);
    return Object.fromEntries(
      keys.flatMap<[string, string | number]>((key) => {
        const value = source[key];
        if (typeof value === 'number' && Number.isFinite(value)) return [[key, value]];
        if (typeof value === 'string') return [[key, value.slice(0, 128)]];
        return [];
      }),
    );
  };
  const players = Object.entries(record(payload.allplayers));
  return {
    map: fields(payload.map, ['name', 'phase', 'round']),
    round: fields(payload.round, ['phase', 'bomb']),
    countdown: fields(payload.phase_countdowns, ['phase', 'phase_ends_in']),
    bomb: fields(payload.bomb, ['state', 'position', 'countdown', 'player']),
    players: players.slice(0, 16).map(([id, value]) => ({
      id: id.slice(0, 128),
      ...fields(value, ['position', 'team', 'observer_slot']),
      state: fields(record(value).state, ['health', 'armor', 'flashed', 'smoked', 'burning']),
    })),
    omittedPlayers: Math.max(0, players.length - 16),
    stringLimit: 128,
  };
}

export const PERFORMANCE_WINDOW_LIMITS = {
  sampleMs: 250,
  preMs: 30000,
  postMs: 10000,
  maximumPostMs: 30000,
  ringBytes: 1024 * 1024,
  sampleBytes: 12 * 1024,
  chunkBytes: 128 * 1024,
  pendingBytes: 2 * 1024 * 1024,
};
type Sample = { time: string; monotonicMs: number; sequence: number; evidence: unknown };
type Active = {
  id: string;
  started: number;
  deadline: number;
  count: number;
  omittedAtStart: number;
  part: number;
  bytes: number;
  lastObserved: number | null;
  postSamples: number;
  samples: Sample[];
};
/** Selected technical context only. Full raw GSI remains in the existing local capture. */
export class PerformanceWindow {
  private ring: { sample: Sample; bytes: number }[] = [];
  private ringBytes = 0;
  private lastSample = -Infinity;
  private current: Active | null = null;
  private pending: { record: PendingPerformanceRecord; bytes: number }[] = [];
  private pendingBytes = 0;
  private writing: Promise<void> | undefined;
  private closed = false;
  private readonly spool: PerformanceSpool | undefined;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private exportSnapshot: ReturnType<typeof performanceRecordEvent>[] | undefined;
  private nextAttemptAt = 0;
  private writeFailures = 0;
  private writeError: unknown = null;
  private sourceSequence = 0;
  private exporting = 0;
  private coverage = {
    oversizedSamples: 0,
    ringBudgetEvictions: 0,
    omittedRecords: 0,
    omittedContextSamples: 0,
  };
  constructor(
    private readonly journal: SessionJournal,
    private readonly now: () => number,
    directory?: string,
  ) {
    this.spool = directory ? new PerformanceSpool(directory) : undefined;
    if (this.spool) this.startWriter();
  }
  shouldSample(monotonicMs: number): boolean {
    return !this.closed && monotonicMs - this.lastSample >= PERFORMANCE_WINDOW_LIMITS.sampleMs;
  }
  sample(value: Sample): void {
    if (this.closed) return;
    this.tick();
    if (value.monotonicMs - this.lastSample < PERFORMANCE_WINDOW_LIMITS.sampleMs) return;
    this.lastSample = value.monotonicMs;
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > PERFORMANCE_WINDOW_LIMITS.sampleBytes) {
      this.coverage.oversizedSamples++;
      return;
    }
    this.ring.push({ sample: value, bytes });
    this.ringBytes += bytes;
    this.prune(value.monotonicMs);
    if (this.current) {
      this.add(value, bytes, 'after');
      this.current.postSamples++;
    }
  }
  private prune(now: number) {
    while (
      this.ring.length &&
      (this.ringBytes > PERFORMANCE_WINDOW_LIMITS.ringBytes ||
        now - this.ring[0]!.sample.monotonicMs > PERFORMANCE_WINDOW_LIMITS.preMs)
    ) {
      if (this.ringBytes > PERFORMANCE_WINDOW_LIMITS.ringBytes) this.coverage.ringBudgetEvictions++;
      this.ringBytes -= this.ring.shift()!.bytes;
    }
  }
  trigger(reason: string, correlation: unknown = null): void {
    if (this.closed) return;
    const now = this.now();
    this.tick();
    this.prune(now);
    if (this.current) {
      this.current.deadline = Math.min(
        this.current.started + PERFORMANCE_WINDOW_LIMITS.maximumPostMs,
        now + PERFORMANCE_WINDOW_LIMITS.postMs,
      );
      this.enqueue('performance_anomaly_trigger', {
        id: this.current.id,
        reason,
        correlation,
        time: new Date().toISOString(),
        monotonicMs: now,
        sharedContext: true,
        postDeadlineMonotonicMs: this.current.deadline,
        requestedPostMs: PERFORMANCE_WINDOW_LIMITS.postMs,
      });
      return;
    }
    const id = randomUUID();
    this.current = {
      id,
      started: now,
      deadline: now + PERFORMANCE_WINDOW_LIMITS.postMs,
      count: 0,
      omittedAtStart: this.coverage.omittedContextSamples,
      part: 0,
      bytes: 0,
      lastObserved: null,
      postSamples: 0,
      samples: [],
    };
    const first = this.ring[0]?.sample.monotonicMs;
    const last = this.ring.at(-1)?.sample.monotonicMs;
    this.enqueue('performance_anomaly_begin', {
      id,
      reason,
      correlation,
      time: new Date().toISOString(),
      monotonicMs: now,
      requestedPreMs: PERFORMANCE_WINDOW_LIMITS.preMs,
      availablePreMs: first !== undefined && last !== undefined ? last - first : 0,
      lastPreSampleAgeMs: last !== undefined ? Math.max(0, now - last) : null,
      requestedPostMs: PERFORMANCE_WINDOW_LIMITS.postMs,
      maximumPostMs: PERFORMANCE_WINDOW_LIMITS.maximumPostMs,
      samplingMs: PERFORMANCE_WINDOW_LIMITS.sampleMs,
      coverageBefore: { ...this.coverage },
      scope:
        'process-local bounded selected input and pipeline context; not full raw GSI, past untriggered buffers or rendered pixels',
    });
    for (const { sample, bytes } of this.ring) this.add(sample, bytes, 'before');
    this.chunk('before');
  }
  private add(sample: Sample, bytes: number, phase: 'before' | 'after') {
    const value = this.current!;
    value.samples.push(sample);
    value.bytes += bytes;
    value.count++;
    value.lastObserved = sample.monotonicMs;
    if (value.bytes >= PERFORMANCE_WINDOW_LIMITS.chunkBytes / 2) this.chunk(phase);
  }
  tick(): void {
    if (this.current && this.now() >= this.current.deadline) this.finish('complete');
  }
  private chunk(phase: 'before' | 'after'): void {
    const value = this.current;
    if (!value?.samples.length) return;
    const samples = value.samples.splice(0);
    this.enqueue(
      'performance_anomaly_samples',
      { id: value.id, phase, part: value.part++, samples },
      value.bytes + 1024,
      samples.length,
    );
    value.bytes = 0;
  }
  private finish(reason: 'complete' | 'shutdown'): void {
    if (!this.current) return;
    this.chunk('after');
    const value = this.current;
    this.enqueue('performance_anomaly_end', {
      id: value.id,
      reason,
      sampled: value.count,
      postSamples: value.postSamples,
      omittedContextSamples: this.coverage.omittedContextSamples - value.omittedAtStart,
      elapsedSinceTriggerMs: Math.max(0, this.now() - value.started),
      observedPostSpanMs: Math.max(0, (value.lastObserved ?? value.started) - value.started),
      postIncomplete: reason === 'shutdown' && this.now() < value.deadline,
      coverageAfter: { ...this.coverage },
    });
    this.current = null;
  }
  private enqueue(
    stage: PendingPerformanceRecord['stage'],
    evidence: Record<string, unknown>,
    estimate?: number,
    samples = 0,
  ): void {
    const bytes = (estimate ?? Buffer.byteLength(JSON.stringify(evidence))) + 512;
    if (
      bytes > PERFORMANCE_WINDOW_LIMITS.chunkBytes ||
      this.pendingBytes + bytes > PERFORMANCE_WINDOW_LIMITS.pendingBytes
    ) {
      this.coverage.omittedRecords++;
      this.coverage.omittedContextSamples += samples;
      return;
    }
    this.pending.push({
      record: {
        id: randomUUID(),
        windowId: evidence.id as string,
        stage,
        evidence,
        source: {
          time: new Date().toISOString(),
          sessionId: this.journal.sessionId,
          hostSessionId: this.journal.hostStartupSessionId,
          queuedAfterSequence: this.journal.health().sequence,
          recordSequence: ++this.sourceSequence,
          monotonicMs: this.now(),
        },
      },
      bytes,
    });
    this.pendingBytes += bytes;
    this.startWriter();
  }
  private startWriter(force = false) {
    if (this.writing || this.exporting) return;
    if (!force) {
      this.batchTimer ??= setTimeout(() => {
        this.batchTimer = undefined;
        this.startWriter(true);
      }, 50);
      this.batchTimer.unref();
      return;
    }
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    this.writing = this.journal.withSystem(() =>
      this.drain()
        .catch((error: unknown) => {
          this.writeFailures++;
          this.writeError = diagnosticValue(error);
          if (this.nextAttemptAt <= Date.now()) this.nextAttemptAt = Date.now() + 1000;
        })
        .finally(() => {
          this.writing = undefined;
          if (
            !this.closed &&
            (this.pending.length ||
              this.spool?.health().pendingFiles ||
              this.spool?.health().unreadableFiles)
          ) {
            clearTimeout(this.retryTimer);
            this.retryTimer = setTimeout(
              () => {
                this.retryTimer = undefined;
                this.startWriter(true);
              },
              Math.max(
                this.spool?.health().unreadableFiles ? 1000 : 50,
                this.nextAttemptAt - Date.now(),
              ),
            );
            this.retryTimer.unref();
          }
        }),
    );
  }
  private remove(ids: string[]) {
    const committed = new Set(ids);
    this.pending = this.pending.filter((item) => {
      if (!committed.has(item.record.id)) return true;
      this.pendingBytes -= item.bytes;
      return false;
    });
  }
  private async promote(records: PendingPerformanceRecord[]) {
    let group: PendingPerformanceRecord[] = [];
    let bytes = 0;
    const commit = async () => {
      await yieldIO();
      await Promise.all(
        group.map((record) =>
          this.journal.recordCommitted(record.stage, performanceRecordEvent(record).evidence),
        ),
      );
      group = [];
      bytes = 0;
    };
    for (const record of records) {
      const size = Buffer.byteLength(JSON.stringify(record));
      if (bytes + size > 128 * 1024 && group.length) await commit();
      group.push(record);
      bytes += size;
    }
    if (group.length) await commit();
  }
  private async drain(): Promise<void> {
    await yieldIO();
    if (this.spool) {
      let appendFailure: unknown;
      try {
        if (this.pending.length)
          await this.spool.append(
            this.pending.map((item) => item.record),
            (ids) => this.remove(ids),
          );
        else await this.spool.initialize();
      } catch (error) {
        appendFailure = error;
      }
      if (Date.now() < this.nextAttemptAt) {
        if (appendFailure)
          throw new Error('performance_spool_append_failed', { cause: appendFailure });
        return;
      }
      let packet;
      while ((packet = await this.spool.oldest())) {
        await this.promote(packet.records);
        await this.spool.acknowledge(
          packet.name,
          packet.records.map((record) => record.id),
        );
        await yieldIO();
      }
      // A full spool must be drained before new input is admitted again; an
      // append failure cannot prevent already durable evidence from recovering.
      if (appendFailure && this.pending.length)
        await this.spool.append(
          this.pending.map((item) => item.record),
          (ids) => this.remove(ids),
        );
    } else {
      const records = this.pending.map((item) => item.record);
      await this.promote(records);
      this.remove(records.map((record) => record.id));
    }
    this.writeError = null;
    this.nextAttemptAt = 0;
  }
  health() {
    return {
      ringSamples: this.ring.length,
      ringBytes: this.ringBytes,
      pendingBytes: this.pendingBytes,
      pendingRecords: this.pending.length,
      spool: this.spool?.health() ?? null,
      writeFailures: this.writeFailures,
      writeError: this.writeError,
      coverage: { ...this.coverage },
      active: this.current?.id ?? null,
      limits: PERFORMANCE_WINDOW_LIMITS,
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.finish('shutdown');
    await this.flush();
    this.journal.record('performance_context_health', this.health());
  }
  async flush() {
    this.chunk('after');
    clearTimeout(this.batchTimer);
    this.batchTimer = undefined;
    await this.writing;
    this.nextAttemptAt = 0;
    this.startWriter(true);
    await this.writing;
  }
  exportMemory() {
    return (
      this.exportSnapshot ??
      this.pending.map((item) =>
        performanceRecordEvent(diagnosticValue(item.record) as PendingPerformanceRecord),
      )
    );
  }
  async beginExport(): Promise<() => Promise<void>> {
    this.exporting++;
    await this.writing;
    this.exportSnapshot = this.exportMemory();
    let release: (() => Promise<void>) | undefined;
    try {
      release = await this.spool?.pin();
    } catch (error) {
      this.writeError = diagnosticValue(error);
      this.writeFailures++;
    }
    if (release) {
      this.exporting--;
      this.startWriter();
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await release?.();
      } catch (error) {
        this.writeError = diagnosticValue(error);
        this.writeFailures++;
      } finally {
        this.exportSnapshot = undefined;
        if (!release) this.exporting--;
        if (!this.closed) this.startWriter();
      }
    };
  }
}
