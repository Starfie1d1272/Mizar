/** Already parsed by the source adapter; receipt time is monotonic in this process. */
export interface ProgramClockSample {
  readonly timeDomain: string;
  readonly continuity: string;
  readonly tick: number;
  readonly receivedMonotonicMs: number;
  readonly readSucceeded: boolean;
  readonly paused?: boolean;
}

/** Tracks samples from one connection; reset when its owner or map execution changes. */
type ClockState = 'syncing' | 'progressing' | 'paused' | 'stalled';

export class ProgramClockTracker {
  private last: ProgramClockSample | null = null;
  private progressing = false;
  private state: ClockState = 'syncing';
  private broken = false;
  private brokenContinuity: string | null = null;

  reset() {
    this.last = null;
    this.progressing = false;
    this.state = 'syncing';
    this.broken = false;
    this.brokenContinuity = null;
  }

  observe(sample: ProgramClockSample) {
    if (
      !sample.readSucceeded ||
      !sample.timeDomain ||
      !sample.continuity ||
      !Number.isSafeInteger(sample.tick) ||
      !Number.isFinite(sample.receivedMonotonicMs)
    ) {
      this.broken = true;
      this.brokenContinuity = sample.continuity;
      this.state = 'syncing';
      return;
    }
    if (this.broken && this.brokenContinuity !== sample.continuity) this.reset();
    let last = this.last;
    if (last && last.continuity !== sample.continuity) {
      this.reset();
      last = null;
    }
    if (
      last &&
      (sample.receivedMonotonicMs <= last.receivedMonotonicMs ||
        sample.receivedMonotonicMs - last.receivedMonotonicMs > 3000 ||
        sample.tick < last.tick)
    ) {
      this.broken = true;
      this.brokenContinuity = sample.continuity;
    }
    if (this.broken) {
      this.state = 'syncing';
      return;
    }
    if (
      !last ||
      last.timeDomain !== sample.timeDomain ||
      last.continuity !== sample.continuity ||
      sample.tick < last.tick
    ) {
      this.progressing = false;
      this.state = 'syncing';
    } else if (sample.tick > last.tick) {
      this.progressing = true;
      this.state = 'progressing';
    } else {
      this.state = sample.paused === true && this.progressing ? 'paused' : 'stalled';
    }
    this.last = sample;
  }

  current(now: number): {
    state: ClockState | 'stale';
    clock: { timeDomain: string; continuity: string; tick: number; usable: boolean } | null;
  } {
    const last = this.last;
    if (!last || this.broken) return { state: 'syncing', clock: null };
    if (
      !Number.isFinite(now) ||
      now < last.receivedMonotonicMs ||
      now - last.receivedMonotonicMs > 3000
    )
      return { state: 'stale', clock: null };
    return {
      state: this.state,
      clock: {
        timeDomain: last.timeDomain,
        continuity: last.continuity,
        tick: last.tick,
        usable: this.state === 'progressing' || this.state === 'paused',
      },
    };
  }
}
