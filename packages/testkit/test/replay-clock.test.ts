import { describe, expect, it } from 'vitest';

import { ReplayClock } from '../src/replay/clock.js';

describe('ReplayClock', () => {
  it('starts at zero and never moves backwards', () => {
    const clock = new ReplayClock();
    expect(clock.virtualElapsedUs).toBe(0);
    clock.advanceTo(12_000);
    expect(clock.virtualElapsedUs).toBe(12_000);
    expect(() => clock.advanceTo(8_000)).toThrow(RangeError);
    expect(clock.virtualElapsedUs).toBe(12_000);
  });

  it('rejects invalid virtual times', () => {
    const clock = new ReplayClock();
    expect(() => clock.advanceTo(-1)).toThrow(RangeError);
    expect(() => clock.advanceTo(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});
