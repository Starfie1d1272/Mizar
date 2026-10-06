import { describe, expect, it } from 'vitest';

import {
  createInitialRuntimeState,
  getProgramSourceFreshness,
  reduceRuntime,
  type RuntimeState,
} from '../src/runtime/index.js';
import { observation, telemetryInput, TEST_AT, TEST_POLICY } from './helpers.js';

function reduceTelemetry(
  state: RuntimeState,
  sequence: number,
  receivedMonotonicMs: number,
  options: Parameters<typeof observation>[2] = {},
  sourceGeneration = state.programSource.generation,
) {
  return reduceRuntime(
    state,
    telemetryInput(sourceGeneration, observation(sequence, receivedMonotonicMs, options)),
    TEST_POLICY,
  );
}

describe('RuntimeState reducer', () => {
  it('creates an unbound empty runtime with independent continuity layers', () => {
    expect(createInitialRuntimeState('producer-1')).toEqual({
      producerInstanceId: 'producer-1',
      liveSession: { kind: 'unbound' },
      runtimeSeq: 0,
      programSource: { kind: 'cs2-gsi', generation: 0 },
      map: { epoch: 0 },
      objectiveTiming: {
        sourceGeneration: 0,
        mapEpoch: 0,
        lastAcceptedReceiveSequence: null,
        lastAcceptedMonotonicMs: null,
        explosionAnchor: null,
        lastBombState: null,
        explosionDurationSeconds: null,
        plantActionDurationSeconds: null,
        defuseActionDurationSeconds: null,
        defuseActionSourcePlayerId: null,
      },
      playerStats: {
        mapEpoch: 0,
        countedCompletedRounds: 0,
        currentRound: null,
        completedDamageBySteam64: {},
      },
    });
  });

  it('accepts a current observation wholesale and establishes the first known map', () => {
    const initial = createInitialRuntimeState('producer-1', {
      kind: 'bound',
      liveSessionId: 'live-1',
    });
    const frame = observation(10, 25, { roundPhase: 'live', roundNumber: 1 });
    const result = reduceRuntime(initial, telemetryInput(0, frame), TEST_POLICY);

    expect(result.disposition).toEqual({ kind: 'accepted', reason: 'baseline' });
    expect(result.transitions).toEqual([]);
    expect(result.state).toMatchObject({
      producerInstanceId: 'producer-1',
      liveSession: { kind: 'bound', liveSessionId: 'live-1' },
      runtimeSeq: 1,
      programSource: {
        kind: 'cs2-gsi',
        generation: 0,
        lastAccepted: {
          generation: 0,
          sequence: 10,
          receivedMonotonicMs: 25,
        },
      },
      map: { epoch: 1, name: 'de_mirage' },
      programTelemetry: frame,
    });
  });

  it('does not mutate the previous state or input on an accepted reduction', () => {
    const state = createInitialRuntimeState('producer-1');
    const input = telemetryInput(0, observation(1, 0, { roundPhase: 'freezetime' }));
    const stateBefore = structuredClone(state);
    const inputBefore = structuredClone(input);

    const result = reduceRuntime(state, input, TEST_POLICY);

    expect(state).toEqual(stateBefore);
    expect(input).toEqual(inputBefore);
    expect(result.state).not.toBe(state);
  });

  it('replaces omitted source blocks instead of retaining the previous frame', () => {
    let state = createInitialRuntimeState('producer-1');
    const first = observation(1, 0, { roundPhase: 'live' });
    state = reduceRuntime(state, telemetryInput(0, first), TEST_POLICY).state;
    const second = observation(2, 10, { roundCoverage: 'absent' });
    const result = reduceRuntime(state, telemetryInput(0, second), TEST_POLICY);

    expect(result.state.programTelemetry).toEqual(second);
    expect(result.state.programTelemetry?.telemetry.round).toBeUndefined();
    expect(result.state.map).toEqual({ epoch: 1, name: 'de_mirage' });
  });

  it.each([
    ['duplicate', 1, 0, { roundPhase: 'freezetime' as const }, 1, 10, 'duplicate' as const],
    ['out-of-order', 2, 0, { roundPhase: 'live' as const }, 1, 10, 'out-of-order' as const],
  ])(
    '$name input is non-mutating',
    (_name, firstSeq, firstTime, firstOptions, nextSeq, nextTime, reason) => {
      let state = createInitialRuntimeState('producer-1');
      state = reduceTelemetry(state, firstSeq, firstTime, firstOptions).state;
      const before = state;
      const result = reduceTelemetry(state, nextSeq, nextTime, {}, 0);

      expect(result.disposition).toEqual({ kind: 'ignored', reason });
      expect(result.state).toBe(before);
      expect(result.state.runtimeSeq).toBe(before.runtimeSeq);
      expect(result.transitions).toEqual([]);
    },
  );

  it('accepts a sequence gap as current truth and reports the missing range', () => {
    let state = createInitialRuntimeState('producer-1');
    state = reduceTelemetry(state, 10, 0, { roundPhase: 'freezetime' }).state;
    const result = reduceTelemetry(state, 13, 10, { roundPhase: 'live' });

    expect(result.disposition).toEqual({
      kind: 'accepted',
      reason: 'gap-resync',
      missingSequenceRange: { from: 11, to: 12 },
    });
    expect(result.transitions).toEqual([]);
    expect(result.state.programTelemetry?.receive.sequence).toBe(13);
  });

  it('rejects a newer sequence with producer-local monotonic time regression', () => {
    let state = createInitialRuntimeState('producer-1');
    state = reduceTelemetry(state, 10, 100).state;
    const before = state;
    const result = reduceTelemetry(state, 11, 99);

    expect(result.disposition).toEqual({ kind: 'ignored', reason: 'non-monotonic-time' });
    expect(result.state).toBe(before);
  });

  it('requires an explicit consecutive source-generation control', () => {
    let state = createInitialRuntimeState('producer-1');
    state = reduceTelemetry(state, 10, 0).state;

    const aheadFrame = reduceTelemetry(state, 11, 10, {}, 1);
    expect(aheadFrame.disposition).toEqual({ kind: 'ignored', reason: 'generation-ahead' });
    expect(aheadFrame.state).toBe(state);

    const invalidAdvance = reduceRuntime(
      state,
      { kind: 'advance-program-source-generation', nextGeneration: 2, at: TEST_AT },
      TEST_POLICY,
    );
    expect(invalidAdvance.disposition).toEqual({
      kind: 'ignored',
      reason: 'invalid-generation-advance',
    });
    expect(invalidAdvance.state).toBe(state);

    const advance = reduceRuntime(
      state,
      { kind: 'advance-program-source-generation', nextGeneration: 1, at: TEST_AT },
      TEST_POLICY,
    );
    expect(advance.disposition).toEqual({
      kind: 'accepted',
      reason: 'source-generation-advanced',
    });
    expect(advance.state.programSource).toMatchObject({
      kind: 'cs2-gsi',
      generation: 1,
    });
    expect(advance.state.programSource.lastAccepted).toMatchObject({
      generation: 0,
      sequence: 10,
    });
    expect(advance.state.programTelemetry).toBeUndefined();
    expect(getProgramSourceFreshness(advance.state, 10, TEST_POLICY)).toBe('awaiting');

    const oldFrame = reduceTelemetry(advance.state, 11, 10, {}, 0);
    expect(oldFrame.disposition).toEqual({ kind: 'ignored', reason: 'stale-generation' });

    const nextFrame = reduceTelemetry(advance.state, 11, 10, { roundPhase: 'live' }, 1);
    expect(nextFrame.disposition).toEqual({ kind: 'accepted', reason: 'contiguous' });
    expect(nextFrame.transitions).toEqual([]);
    expect(nextFrame.state.programTelemetry?.receive.sequence).toBe(11);
    expect(nextFrame.state.programSource.lastAccepted).toMatchObject({
      generation: 1,
      sequence: 11,
    });
  });

  it('starts a completely fresh runtime when the producer instance restarts', () => {
    let previous = createInitialRuntimeState('producer-1', {
      kind: 'bound',
      liveSessionId: 'live-1',
    });
    previous = reduceTelemetry(previous, 42, 100, { roundPhase: 'live' }).state;

    const restarted = createInitialRuntimeState('producer-2', {
      kind: 'bound',
      liveSessionId: 'live-1',
    });

    expect(restarted).toEqual({
      producerInstanceId: 'producer-2',
      liveSession: { kind: 'bound', liveSessionId: 'live-1' },
      runtimeSeq: 0,
      programSource: { kind: 'cs2-gsi', generation: 0 },
      map: { epoch: 0 },
      objectiveTiming: {
        sourceGeneration: 0,
        mapEpoch: 0,
        lastAcceptedReceiveSequence: null,
        lastAcceptedMonotonicMs: null,
        explosionAnchor: null,
        lastBombState: null,
        explosionDurationSeconds: null,
        plantActionDurationSeconds: null,
        defuseActionDurationSeconds: null,
        defuseActionSourcePlayerId: null,
      },
      playerStats: {
        mapEpoch: 0,
        countedCompletedRounds: 0,
        currentRound: null,
        completedDamageBySteam64: {},
      },
    });
    expect(restarted).not.toEqual(previous);

    const first = reduceTelemetry(restarted, 42, 0, { roundPhase: 'freezetime' });
    expect(first.disposition).toEqual({ kind: 'accepted', reason: 'baseline' });
    expect(first.state.producerInstanceId).toBe('producer-2');
    expect(first.state.map).toEqual({ epoch: 1, name: 'de_mirage' });
  });

  it('does not reset the global receive sequence when the source generation advances', () => {
    let state = createInitialRuntimeState('producer-1');
    state = reduceTelemetry(state, 10, 0).state;
    state = reduceRuntime(
      state,
      { kind: 'advance-program-source-generation', nextGeneration: 1, at: TEST_AT },
      TEST_POLICY,
    ).state;

    const result = reduceTelemetry(state, 1, 10, {}, 1);
    expect(result.disposition).toEqual({ kind: 'ignored', reason: 'out-of-order' });
    expect(result.state).toBe(state);
  });

  it('requires an established map before accepting an explicit reset', () => {
    const initial = createInitialRuntimeState('producer-1');
    const result = reduceRuntime(
      initial,
      {
        kind: 'reset-map-execution',
        reason: 'same-map-restart',
        at: TEST_AT,
      },
      TEST_POLICY,
    );

    expect(result.disposition).toEqual({ kind: 'ignored', reason: 'map-not-established' });
    expect(result.state).toBe(initial);
  });

  it('rejects non-finite monotonic times on explicit controls', () => {
    const invalidAt = { ...TEST_AT, monotonicMs: Number.NaN };
    const initial = createInitialRuntimeState('producer-1');

    expect(() =>
      reduceRuntime(
        initial,
        { kind: 'advance-program-source-generation', nextGeneration: 1, at: invalidAt },
        TEST_POLICY,
      ),
    ).toThrow('RuntimeTime.monotonicMs must be a finite number');

    const established = reduceTelemetry(initial, 1, 0).state;
    expect(() =>
      reduceRuntime(
        established,
        { kind: 'reset-map-execution', reason: 'restore', at: invalidAt },
        TEST_POLICY,
      ),
    ).toThrow('RuntimeTime.monotonicMs must be a finite number');
  });

  it('valid reset clears programTelemetry and makes the next frame a new execution baseline', () => {
    let state = createInitialRuntimeState('producer-1');
    state = reduceTelemetry(state, 1, 0, { roundPhase: 'freezetime', roundNumber: 4 }).state;
    state = reduceTelemetry(state, 2, 10, { roundPhase: 'live', roundNumber: 4 }).state;
    const cursorBeforeReset = state.programSource.lastAccepted;

    const reset = reduceRuntime(
      state,
      {
        kind: 'reset-map-execution',
        reason: 'same-map-restart',
        at: { monotonicMs: 20, utc: '2026-09-14T00:00:00.020Z' },
      },
      TEST_POLICY,
    );

    expect(reset.disposition).toEqual({ kind: 'accepted', reason: 'map-execution-reset' });
    expect(reset.state).toMatchObject({
      runtimeSeq: 3,
      map: { epoch: 2, name: 'de_mirage' },
      programSource: {
        generation: 0,
        lastAccepted: cursorBeforeReset,
      },
    });
    expect(reset.state.programTelemetry).toBeUndefined();
    expect(reset.transitions).toEqual([
      expect.objectContaining({
        kind: 'map_execution_changed',
        previousMapEpoch: 1,
        mapEpoch: 2,
        previousMapName: 'de_mirage',
        mapName: 'de_mirage',
        reason: 'explicit-reset',
        resetReason: 'same-map-restart',
        runtimeSeq: 3,
      }),
    ]);
    expect(getProgramSourceFreshness(reset.state, 20, TEST_POLICY)).toBe('awaiting');

    const nextFrame = reduceTelemetry(reset.state, 3, 30, { roundPhase: 'live' });
    expect(nextFrame.disposition).toEqual({ kind: 'accepted', reason: 'contiguous' });
    expect(nextFrame.transitions).toEqual([]);
    expect(nextFrame.state.programTelemetry?.telemetry.round?.phase).toBe('live');
    expect(nextFrame.state.map.epoch).toBe(2);
  });

  it('auto-advances epoch only on a present, non-empty observed map-name change', () => {
    let state = createInitialRuntimeState('producer-1');
    state = reduceTelemetry(state, 1, 0).state;

    const absent = reduceTelemetry(state, 2, 10, { mapCoverage: 'absent', mapName: 'de_nuke' });
    expect(absent.state.map).toEqual({ epoch: 1, name: 'de_mirage' });
    expect(absent.transitions).toEqual([]);

    const changed = reduceTelemetry(state, 2, 10, { mapName: 'de_nuke' });
    expect(changed.state.map).toEqual({ epoch: 2, name: 'de_nuke' });
    expect(changed.transitions).toEqual([
      expect.objectContaining({
        kind: 'map_execution_changed',
        previousMapEpoch: 1,
        mapEpoch: 2,
        previousMapName: 'de_mirage',
        mapName: 'de_nuke',
        reason: 'observed-map-name-change',
        sourceGeneration: 0,
        receiveSequence: 2,
      }),
    ]);
  });
});
