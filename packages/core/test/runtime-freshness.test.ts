import { describe, expect, it } from 'vitest';

import {
  createInitialRuntimeState,
  getProgramSourceFreshness,
  reduceRuntime,
} from '../src/runtime/index.js';
import { observation, telemetryInput, TEST_POLICY } from './helpers.js';

describe('Program source freshness', () => {
  it('reports awaiting before the first current-generation frame', () => {
    const state = createInitialRuntimeState('producer-1');
    expect(getProgramSourceFreshness(state, 0, TEST_POLICY)).toBe('awaiting');
  });

  it('uses monotonic time and the explicit policy threshold', () => {
    const initial = createInitialRuntimeState('producer-1');
    const state = reduceRuntime(initial, telemetryInput(0, observation(1, 100)), TEST_POLICY).state;

    expect(getProgramSourceFreshness(state, 200, TEST_POLICY)).toBe('fresh');
    expect(getProgramSourceFreshness(state, 201, TEST_POLICY)).toBe('stale');
    expect(getProgramSourceFreshness(state, 10_000, TEST_POLICY)).toBe('stale');
  });

  it('fails fast when the selector clock moves behind the accepted receive time', () => {
    const initial = createInitialRuntimeState('producer-1');
    const state = reduceRuntime(initial, telemetryInput(0, observation(1, 100)), TEST_POLICY).state;

    expect(() => getProgramSourceFreshness(state, 99, TEST_POLICY)).toThrow(
      'nowMonotonicMs must not precede the program source receive monotonic time',
    );
  });

  it('ignores UTC jumps when monotonic order is unchanged', () => {
    const initial = createInitialRuntimeState('producer-1');
    const first = observation(1, 100);
    const state = reduceRuntime(initial, telemetryInput(0, first), TEST_POLICY).state;
    const jumped = observation(2, 150);
    const withJumpedUtc = {
      ...jumped,
      receive: { ...jumped.receive, receivedAt: '2036-01-01T00:00:00.000Z' },
    };
    const next = reduceRuntime(state, telemetryInput(0, withJumpedUtc), TEST_POLICY).state;

    expect(next.programSource.lastAccepted).toMatchObject({
      sequence: 2,
      receivedMonotonicMs: 150,
      receivedAt: '2036-01-01T00:00:00.000Z',
    });
    expect(getProgramSourceFreshness(next, 250, TEST_POLICY)).toBe('fresh');
  });

  it('rejects invalid thresholds rather than inventing a production default', () => {
    const state = createInitialRuntimeState('producer-1');
    expect(() => getProgramSourceFreshness(state, 0, { staleAfterMs: -1 })).toThrow(
      'staleAfterMs must be a finite non-negative number',
    );
    expect(() => getProgramSourceFreshness(state, 0, { staleAfterMs: Number.NaN })).toThrow(
      'staleAfterMs must be a finite non-negative number',
    );
  });
});
