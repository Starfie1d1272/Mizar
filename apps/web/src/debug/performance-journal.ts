import type { SnapshotCursorLike } from '@mizar/protocol/acceptance';
import { sendControlEvidence } from './control-journal';

// One bounded aggregate per document/window. No snapshot bodies or per-frame logging.
let active = false;
let started = 0;
let previousFrame: number | null = null;
let frames = 0;
let maxFrameGapMs = 0;
let slowFrames = 0;
let longTasks = 0;
let maxLongTaskMs = 0;
let longTaskSupport = false;
let anomalyCount = 0;
const channels = new Map<
  string,
  {
    messages: number;
    accepted: number;
    unchanged: number;
    maxHandleMs: number;
    maxReceiveGapMs: number;
    lastReceived: number;
    state: string;
    firstChannelSeq: number | null;
    firstCursor: SnapshotCursorLike | null;
    channelSeq: number | null;
    cursor: SnapshotCursorLike | null;
  }
>();
const anomalies: unknown[] = [];
const surfaces = new Map<
  HTMLCanvasElement,
  { id: number; sequence: number | null; changedAt: number; stalled: boolean }
>();
let nextSurfaceId = 1;

function sampleSurfaces() {
  const now = performance.now();
  for (const element of surfaces.keys()) if (!element.isConnected) surfaces.delete(element);
  const elements = document
    .getElementById('root')
    ?.querySelectorAll<HTMLCanvasElement>('canvas[data-radar-source]');
  const channel = channels.get('radar');
  const receivedSequence = channel?.cursor?.programReceiveSequence ?? null;
  const result = [];
  const selected = Array.from(elements ?? []).slice(0, 8);
  for (const element of surfaces.keys()) if (!selected.includes(element)) surfaces.delete(element);
  for (const element of selected) {
    const raw = element.dataset.radarDrawnSequence;
    const sequence = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    let state = surfaces.get(element);
    if (!state) {
      state = { id: nextSurfaceId++, sequence, changedAt: now, stalled: false };
      surfaces.set(element, state);
    }
    if (sequence !== state.sequence) {
      state.changedAt = now;
      state.sequence = sequence;
      state.stalled = false;
    }
    const paused = element.dataset.radarPaused === 'true';
    const source = element.dataset.radarSource;
    const visible = document.visibilityState === 'visible' && element.getClientRects().length > 0;
    const ageMs = Math.max(0, now - state.changedAt);
    // A static preview, an intentional pause or absent input is not a draw failure.
    const stalled =
      source === 'client' &&
      visible &&
      !paused &&
      channel?.state === 'live' &&
      now - channel.lastReceived < 1000 &&
      receivedSequence !== null &&
      (sequence === null || receivedSequence > sequence) &&
      ageMs >= 3000;
    if (stalled && !state.stalled)
      anomaly({
        time: new Date().toISOString(),
        kind: 'radar_draw_not_advancing',
        surfaceId: state.id,
        drawnSequence: sequence,
        receivedSequence,
        ageMs,
      });
    state.stalled = stalled;
    result.push({
      id: state.id,
      drawnSequence: sequence,
      receivedSequence,
      lastDrawChangeAgeMs: ageMs,
      paused,
      source,
      visible,
      stalled,
    });
  }
  return { observed: result, omittedSurfaces: Math.max(0, (elements?.length ?? 0) - 8) };
}

function anomaly(value: unknown): void {
  anomalyCount++;
  if (anomalies.length === 8) anomalies.shift();
  anomalies.push(value);
}

export function recordChannelConsumption(
  channel: string,
  durationMs: number,
  state: string,
  current: { channelSeq: number; cursor: SnapshotCursorLike } | null,
  changed: boolean,
): void {
  if (!active || (!channels.has(channel) && channels.size >= 8)) return;
  const now = performance.now();
  const prior = channels.get(channel);
  const gapMs = prior ? now - prior.lastReceived : 0;
  const value = prior ?? {
    messages: 0,
    accepted: 0,
    unchanged: 0,
    maxHandleMs: 0,
    maxReceiveGapMs: 0,
    lastReceived: now,
    state,
    firstChannelSeq: null,
    firstCursor: null,
    channelSeq: null,
    cursor: null,
  };
  if (value.messages === 0) {
    value.firstChannelSeq = current?.channelSeq ?? null;
    value.firstCursor = current?.cursor ?? null;
  }
  value.messages++;
  if (changed) value.accepted++;
  else value.unchanged++;
  value.maxHandleMs = Math.max(value.maxHandleMs, durationMs);
  value.maxReceiveGapMs = Math.max(value.maxReceiveGapMs, gapMs);
  value.lastReceived = now;
  value.state = state;
  value.channelSeq = current?.channelSeq ?? null;
  value.cursor = current?.cursor ?? null;
  channels.set(channel, value);
  if (durationMs >= 50 || gapMs >= 1000 || state === 'protocol-error')
    anomaly({
      time: new Date().toISOString(),
      channel,
      durationMs,
      gapMs,
      state,
      channelSeq: value.channelSeq,
      cursor: value.cursor,
    });
}

export async function flushPerformanceJournal(reason = 'export'): Promise<void> {
  if (!active) return;
  const now = performance.now();
  const evidence = {
    page: location.pathname,
    reason,
    windowMs: now - started,
    visibility: document.visibilityState,
    frames: { callbacks: frames, maxGapMs: maxFrameGapMs, over50ms: slowFrames },
    longTasks: { supported: longTaskSupport, count: longTasks, maxDurationMs: maxLongTaskMs },
    surfaces: sampleSurfaces(),
    channels: [...channels].map(([channel, value]) => ({
      channel,
      ...value,
      lastMessageAgeMs: now - value.lastReceived,
    })),
    anomalyCount,
    omittedAnomalySamples: Math.max(0, anomalyCount - anomalies.length),
    anomalies: anomalies.splice(0),
    scope:
      'own document RAF cadence, accepted channel cursors and completed radar Canvas draw sequence; not GPU paint, screen capture, OBS or glass-to-glass latency',
  };
  started = now;
  anomalyCount = 0;
  frames = maxFrameGapMs = slowFrames = longTasks = maxLongTaskMs = 0;
  for (const value of channels.values()) {
    value.firstChannelSeq = null;
    value.firstCursor = null;
    value.messages =
      value.accepted =
      value.unchanged =
      value.maxHandleMs =
      value.maxReceiveGapMs =
        0;
  }
  await sendControlEvidence('browser_performance', 'window', evidence);
}

export function installPerformanceJournal(): void {
  if (active) return;
  active = true;
  started = performance.now();
  const frame = (now: number) => {
    if (document.visibilityState === 'visible') {
      frames++;
      if (previousFrame !== null) {
        const gap = now - previousFrame;
        maxFrameGapMs = Math.max(maxFrameGapMs, gap);
        if (gap >= 50) slowFrames++;
        if (gap >= 100) anomaly({ time: new Date().toISOString(), frameGapMs: gap });
      }
      previousFrame = now;
    } else previousFrame = null;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.addEventListener('visibilitychange', () => {
    previousFrame = null;
  });
  try {
    longTaskSupport = PerformanceObserver.supportedEntryTypes.includes('longtask');
    if (longTaskSupport) {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks++;
          maxLongTaskMs = Math.max(maxLongTaskMs, entry.duration);
        }
      });
      observer.observe({ type: 'longtask' });
    }
  } catch {
    longTaskSupport = false;
  }
  setInterval(() => {
    void flushPerformanceJournal('interval');
  }, 15000);
  setInterval(sampleSurfaces, 1000);
  window.addEventListener('pagehide', () => {
    void flushPerformanceJournal('pagehide');
  });
}
