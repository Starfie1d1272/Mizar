import { describe, expect, it } from 'vitest';
import { createReplaySession } from '../src/session.js';
import type { ReplaySessionFrame, ReplaySessionScheduler } from '../src/session.js';

interface TestFrame extends ReplaySessionFrame {
  readonly value: string;
}

class ManualScheduler implements ReplaySessionScheduler {
  currentMs = 0;
  private nextId = 0;
  readonly timers = new Map<number, { deadline: number; callback: () => void }>();

  nowMs(): number {
    return this.currentMs;
  }

  setTimeout(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.timers.set(id, { deadline: this.currentMs + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advanceBy(durationMs: number): void {
    const end = this.currentMs + durationMs;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.deadline <= end)
        .sort((left, right) => left[1].deadline - right[1].deadline)[0];
      if (due === undefined) break;
      this.currentMs = due[1].deadline;
      this.timers.delete(due[0]);
      due[1].callback();
    }
    this.currentMs = end;
  }

  fireNextAt(actualTimeMs: number): void {
    const due = [...this.timers.entries()].sort(
      (left, right) => left[1].deadline - right[1].deadline,
    )[0];
    if (due === undefined) throw new Error('No replay timer is scheduled');
    if (actualTimeMs < due[1].deadline)
      throw new RangeError('Timer cannot fire before its deadline');
    this.currentMs = actualTimeMs;
    this.timers.delete(due[0]);
    due[1].callback();
  }
}

function frames(elapsedMs: readonly number[]): readonly TestFrame[] {
  return elapsedMs.map((scheduledElapsedMs, captureIndex) => ({
    cursor: {
      captureIndex,
      sequence: 100 + captureIndex,
      scheduledElapsedUs: scheduledElapsedMs * 1_000,
    },
    value: `frame-${captureIndex}`,
  }));
}

describe('shared ReplaySession', () => {
  it('keeps media time between data frames across pause, resume, seek, and completion', async () => {
    const scheduler = new ManualScheduler();
    const sourceFrames = frames([1000, 1250, 1500]);
    const session = createReplaySession(
      { frames: sourceFrames, events: [], rebuild: (index) => sourceFrames[index]! },
      scheduler,
    );
    expect(session.getPlaybackElapsedUs()).toBe(1_000_000);
    session.play();
    scheduler.advanceBy(120);
    expect(session.getPlaybackElapsedUs()).toBe(1_120_000);
    expect(session.getSnapshot().currentIndex).toBe(0);
    session.pause();
    scheduler.advanceBy(900);
    expect(session.getPlaybackElapsedUs()).toBe(1_120_000);
    session.play(2);
    expect(session.getPlaybackSpeed()).toBe(2);
    scheduler.advanceBy(65);
    expect(session.getPlaybackElapsedUs()).toBe(1_250_000);
    expect(session.getSnapshot().currentIndex).toBe(1);
    await session.restart();
    expect(session.getPlaybackElapsedUs()).toBe(1_000_000);
    await session.seekCaptureIndex(1);
    expect(session.getPlaybackElapsedUs()).toBe(1_250_000);
    session.play();
    scheduler.fireNextAt(scheduler.currentMs + 1000);
    expect(session.getPlaybackElapsedUs()).toBe(1_500_000);
    expect(session.getSnapshot().isPlaying).toBe(false);
    session.dispose();
  });

  it('freezes media time while seeking and preserves it when reconstruction fails', async () => {
    const scheduler = new ManualScheduler();
    const sourceFrames = frames([0, 250, 500]);
    let rejectSeek!: (error: Error) => void;
    const session = createReplaySession(
      {
        frames: sourceFrames,
        events: [],
        rebuild: () =>
          new Promise<TestFrame>((_, reject) => {
            rejectSeek = reject;
          }),
      },
      scheduler,
    );
    session.play();
    scheduler.advanceBy(120);
    const seek = session.seekCaptureIndex(2);
    scheduler.advanceBy(1000);
    expect(session.getPlaybackElapsedUs()).toBe(120_000);
    rejectSeek(new Error('unavailable'));
    await expect(seek).rejects.toThrow('unavailable');
    expect(session.getPlaybackElapsedUs()).toBe(120_000);
    expect(session.getSnapshot().currentIndex).toBe(0);
    session.play();
    scheduler.advanceBy(130);
    expect(session.getSnapshot().currentIndex).toBe(1);
    session.abort();
    scheduler.advanceBy(1000);
    expect(session.getPlaybackElapsedUs()).toBe(250_000);
    session.dispose();
  });

  it('rebuilds seeks, restarts, and steps through frames', async () => {
    const scheduler = new ManualScheduler();
    const sourceFrames = frames([0, 100, 200]);
    const rebuilt: number[] = [];
    const session = createReplaySession(
      {
        frames: sourceFrames,
        events: [],
        rebuild: (captureIndex) => {
          rebuilt.push(captureIndex);
          return sourceFrames[captureIndex]!;
        },
      },
      scheduler,
    );

    expect(session.getSnapshot().presentationRevision).toBe(0);
    await session.stepFrame(1);
    expect(session.getSnapshot().presentationRevision).toBe(1);
    await session.seekElapsedUs(200_000);
    await session.restart();

    expect(rebuilt).toEqual([1, 2, 0]);
    expect(session.getSnapshot().currentIndex).toBe(0);
    expect(session.getSnapshot().presentationRevision).toBe(3);
    session.dispose();
  });

  it('catches up to the latest eligible frame after a delayed callback', () => {
    const scheduler = new ManualScheduler();
    const sourceFrames = frames([0, 250, 500, 750]);
    const session = createReplaySession(
      { frames: sourceFrames, events: [], rebuild: (captureIndex) => sourceFrames[captureIndex]! },
      scheduler,
    );

    session.play();
    expect(scheduler.timers.size).toBe(1);
    scheduler.fireNextAt(620);

    expect(session.getSnapshot().currentIndex).toBe(2);
    expect(session.getSnapshot().current?.cursor.scheduledElapsedUs).toBe(500_000);
    expect(scheduler.timers.size).toBe(1);
    expect([...scheduler.timers.values()][0]!.deadline).toBe(750);
    session.dispose();
  });

  it('keeps the original playback anchor through repeated timer lateness', () => {
    const scheduler = new ManualScheduler();
    const sourceFrames = frames([0, 250, 500, 750]);
    const session = createReplaySession(
      { frames: sourceFrames, events: [], rebuild: (captureIndex) => sourceFrames[captureIndex]! },
      scheduler,
    );

    session.play();
    scheduler.fireNextAt(300);
    expect(session.getSnapshot().currentIndex).toBe(1);
    scheduler.fireNextAt(630);
    expect(session.getSnapshot().currentIndex).toBe(2);
    scheduler.fireNextAt(910);
    expect(session.getSnapshot().currentIndex).toBe(3);
    expect(session.getSnapshot().isPlaying).toBe(false);
    session.dispose();
  });

  it('keeps one scheduler timer and cancels it on pause or dispose', () => {
    const scheduler = new ManualScheduler();
    const sourceFrames = frames([0, 100, 200, 300]);
    const session = createReplaySession(
      { frames: sourceFrames, events: [], rebuild: (captureIndex) => sourceFrames[captureIndex]! },
      scheduler,
    );

    session.play();
    expect(scheduler.timers.size).toBe(1);
    session.pause();
    expect(scheduler.timers.size).toBe(0);
    session.play();
    session.dispose();
    expect(scheduler.timers.size).toBe(0);
  });
});
