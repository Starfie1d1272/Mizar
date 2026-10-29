import { describe, expect, it } from 'vitest';
import { ProgramClockTracker } from '../src/projection/program-clock.js';

describe('program clock samples', () => {
  it('requires progress, distinguishes pause from a stall, and rejects discontinuity', () => {
    const tracker = new ProgramClockTracker();
    const sample = {
      timeDomain: 'synthetic',
      continuity: '1',
      tick: 10,
      receivedMonotonicMs: 0,
      readSucceeded: true,
    };
    tracker.observe(sample);
    expect(tracker.current(0).clock?.usable).toBe(false);
    tracker.observe({ ...sample, tick: 74, receivedMonotonicMs: 1000 });
    expect(tracker.current(1000)).toMatchObject({
      state: 'progressing',
      clock: { tick: 74, usable: true },
    });
    tracker.observe({ ...sample, tick: 74, receivedMonotonicMs: 2000, paused: true });
    expect(tracker.current(2000)).toMatchObject({ state: 'paused', clock: { usable: true } });
    tracker.observe({ ...sample, tick: 74, receivedMonotonicMs: 3000 });
    expect(tracker.current(3000)).toMatchObject({ state: 'stalled', clock: { usable: false } });
    expect(tracker.current(6001)).toEqual({ state: 'stale', clock: null });
    tracker.observe({ ...sample, tick: 75, receivedMonotonicMs: 6001 });
    expect(tracker.current(6001)).toEqual({ state: 'syncing', clock: null });
    tracker.observe({ ...sample, continuity: '2', tick: 5, receivedMonotonicMs: 7000 });
    tracker.observe({ ...sample, continuity: '2', tick: 69, receivedMonotonicMs: 8000 });
    expect(tracker.current(8000).clock?.usable).toBe(true);
    tracker.observe({ ...sample, continuity: '2', tick: 4, receivedMonotonicMs: 9000 });
    expect(tracker.current(9000)).toEqual({ state: 'syncing', clock: null });
  });
});
