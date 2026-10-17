import { randomUUID } from 'node:crypto';
import { setImmediate as yieldIO } from 'node:timers/promises';
import type { SessionJournal } from './session-journal.js';

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
  chunkBytes: 64 * 1024,
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
  private pending: { stage: string; evidence: unknown; bytes: number }[] = [];
  private pendingBytes = 0;
  private writing: Promise<void> | undefined;
  private closed = false;
  private coverage = {
    oversizedSamples: 0,
    ringBudgetEvictions: 0,
    omittedRecords: 0,
    omittedContextSamples: 0,
  };
  constructor(
    private readonly journal: SessionJournal,
    private readonly now: () => number,
  ) {}
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
  private enqueue(stage: string, evidence: unknown, estimate?: number, samples = 0): void {
    const bytes = estimate ?? Buffer.byteLength(JSON.stringify(evidence));
    if (
      bytes > PERFORMANCE_WINDOW_LIMITS.chunkBytes ||
      this.pendingBytes + bytes > PERFORMANCE_WINDOW_LIMITS.pendingBytes
    ) {
      this.coverage.omittedRecords++;
      this.coverage.omittedContextSamples += samples;
      return;
    }
    this.pending.push({ stage, evidence, bytes });
    this.pendingBytes += bytes;
    this.startWriter();
  }
  private startWriter() {
    if (!this.writing)
      this.writing = this.drain().finally(() => {
        this.writing = undefined;
        if (this.pending.length) this.startWriter();
      });
  }
  private async drain(): Promise<void> {
    // Historical redaction/journal serialization yields after the ingress handoff.
    while (this.pending.length) {
      await yieldIO();
      const item = this.pending.shift()!;
      this.pendingBytes -= item.bytes;
      this.journal.record(item.stage, item.evidence);
    }
  }
  health() {
    return {
      ringSamples: this.ring.length,
      ringBytes: this.ringBytes,
      pendingBytes: this.pendingBytes,
      coverage: { ...this.coverage },
      active: this.current?.id ?? null,
      limits: PERFORMANCE_WINDOW_LIMITS,
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.finish('shutdown');
    await this.flush();
    this.journal.record('performance_context_health', this.health());
  }
  async flush() {
    this.chunk('after');
    while (this.writing) await this.writing;
  }
}
