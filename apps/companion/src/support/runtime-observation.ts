import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import type { SessionJournal } from './session-journal.js';
import type { PerformanceWindow } from './performance-window.js';

const intervalMs = 15_000;
const inputGapMs = 1_000;
type RawInput = { sequence: number; receivedAt: string; receivedMonotonicMs: number };
type Reason = 'interval' | 'problem_report' | 'close';

/** Own the sample window, input gaps and timers; the app supplies domain snapshots. */
export function observeRuntime({
  journal,
  context,
  monotonicNow,
  snapshot,
}: {
  journal: Pick<SessionJournal, 'record'> | undefined;
  context: Pick<PerformanceWindow, 'tick' | 'trigger'> | undefined;
  monotonicNow: () => number;
  snapshot: () => Record<string, unknown>;
}) {
  let windowStart = performance.now();
  let processing = { count: 0, totalMs: 0, maxMs: 0 };
  let slowCount = 0;
  const slow: { time: string; sequence: number; durationMs: number }[] = [];
  let latestRaw: RawInput | null = null;
  let gapReported = false;
  const delay = journal ? monitorEventLoopDelay({ resolution: 20 }) : undefined;
  delay?.enable();

  const record = (reason: Reason) => {
    if (!journal) return;
    const now = performance.now();
    const eventLoop =
      delay && delay.count ? { p99Ms: delay.percentile(99) / 1e6, maxMs: delay.max / 1e6 } : null;
    delay?.reset();
    journal.record('runtime_performance_window', {
      reason,
      windowMs: now - windowStart,
      schedulerDelayMs: reason === 'interval' ? Math.max(0, now - windowStart - intervalMs) : null,
      processing: {
        ...processing,
        meanMs: processing.count ? processing.totalMs / processing.count : null,
        scope:
          'synchronous observation acceptance, runtime mutation and projection/output scheduling; excludes upstream adapter and asynchronous delivery',
      },
      eventLoop,
      slowProcessing: {
        count: slowCount,
        omittedSamples: Math.max(0, slowCount - slow.length),
        samples: slow.splice(0),
      },
      ...snapshot(),
      scope:
        'producer publish and local send counters do not prove pixels rendered or OBS capture latency',
    });
    processing = { count: 0, totalMs: 0, maxMs: 0 };
    slowCount = 0;
    windowStart = now;
  };
  const reportTimer = journal ? setInterval(() => record('interval'), intervalMs) : undefined;
  const contextTimer = context
    ? setInterval(() => {
        context.tick();
        const ageMs = latestRaw ? monotonicNow() - latestRaw.receivedMonotonicMs : 0;
        if (latestRaw && !gapReported && ageMs >= inputGapMs) {
          gapReported = true;
          context.trigger('input_silence', {
            lastRaw: latestRaw,
            ageMs,
            interpretation: 'source stopped sending; may be normal game/menu inactivity',
          });
        }
      }, inputGapMs)
    : undefined;
  reportTimer?.unref();
  contextTimer?.unref();

  return {
    record,
    get latestRaw() {
      return latestRaw;
    },
    acceptRaw({ sequence, receivedAt, receivedMonotonicMs }: RawInput) {
      const gapMs = latestRaw ? receivedMonotonicMs - latestRaw.receivedMonotonicMs : 0;
      if (latestRaw && gapMs >= inputGapMs)
        context?.trigger('input_resumed_after_gap', { previous: latestRaw, sequence, gapMs });
      gapReported = false;
      latestRaw = { sequence, receivedAt, receivedMonotonicMs };
    },
    observation(sequence: number, durationMs: number) {
      processing.count++;
      processing.totalMs += durationMs;
      processing.maxMs = Math.max(processing.maxMs, durationMs);
      if (durationMs >= 50) {
        context?.trigger('slow_observation', { sequence, durationMs });
        slowCount++;
        slow.push({ time: new Date().toISOString(), sequence, durationMs });
        if (slow.length > 8) slow.shift();
      }
    },
    close() {
      clearInterval(reportTimer);
      clearInterval(contextTimer);
      try {
        record('close');
      } finally {
        delay?.disable();
      }
    },
  };
}
