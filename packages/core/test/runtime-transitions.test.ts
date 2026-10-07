import { describe, expect, it } from 'vitest';

import {
  createInitialRuntimeState,
  reduceRuntime,
  type RuntimeState,
} from '../src/runtime/index.js';
import { observation, telemetryInput, TEST_POLICY } from './helpers.js';

function apply(
  state: RuntimeState,
  sequence: number,
  receivedMonotonicMs: number,
  options: Parameters<typeof observation>[2] = {},
) {
  return reduceRuntime(
    state,
    telemetryInput(0, observation(sequence, receivedMonotonicMs, options)),
    TEST_POLICY,
  );
}

describe('RuntimeTransition derivation', () => {
  it('does not emit round transitions while map execution is not established', () => {
    let state = createInitialRuntimeState('producer-1');
    state = apply(state, 1, 0, {
      mapCoverage: 'absent',
      roundPhase: 'freezetime',
    }).state;
    const result = apply(state, 2, 10, {
      mapCoverage: 'absent',
      roundPhase: 'live',
    });

    expect(result.state.map).toEqual({ epoch: 0 });
    expect(result.transitions).toEqual([]);
  });

  it('emits round_started only for contiguous freezetime to live evidence', () => {
    let state = createInitialRuntimeState('producer-1', { kind: 'bound', liveSessionId: 'live-1' });
    state = apply(state, 1, 0, { roundPhase: 'freezetime', roundNumber: 1 }).state;
    const result = apply(state, 2, 10, { roundPhase: 'live', roundNumber: 1 });

    expect(result.transitions).toEqual([
      expect.objectContaining({
        kind: 'round_started',
        producerInstanceId: 'producer-1',
        liveSession: { kind: 'bound', liveSessionId: 'live-1' },
        mapEpoch: 1,
        runtimeSeq: 2,
        sourceGeneration: 0,
        receiveSequence: 2,
        roundNumber: 1,
        at: {
          monotonicMs: 10,
          utc: '2026-09-14T00:00:00.010Z',
        },
      }),
    ]);
  });

  it('emits round_ended with current round evidence', () => {
    let state = createInitialRuntimeState('producer-1');
    state = apply(state, 1, 0, { roundPhase: 'live', roundNumber: 7 }).state;
    const result = apply(state, 2, 10, {
      roundPhase: 'over',
      roundNumber: 7,
      winnerSide: 'T',
    });

    expect(result.transitions).toEqual([
      expect.objectContaining({
        kind: 'round_ended',
        mapEpoch: 1,
        runtimeSeq: 2,
        sourceGeneration: 0,
        receiveSequence: 2,
        roundNumber: 7,
        winnerSide: 'T',
      }),
    ]);
  });

  it('emits one map_ended edge and does not advance mapEpoch for gameover alone', () => {
    let state = createInitialRuntimeState('producer-1');
    state = apply(state, 1, 0, { mapPhase: 'live', roundPhase: 'freezetime' }).state;
    const gameover = apply(state, 2, 10, { mapPhase: 'gameover', roundPhase: 'freezetime' });

    expect(gameover.state.map).toEqual({ epoch: 1, name: 'de_mirage', competitiveObserved: true });
    expect(gameover.transitions).toEqual([
      expect.objectContaining({
        kind: 'map_ended',
        mapEpoch: 1,
        runtimeSeq: 2,
        sourceGeneration: 0,
        receiveSequence: 2,
      }),
    ]);

    const repeated = apply(gameover.state, 3, 20, {
      mapPhase: 'gameover',
      roundPhase: 'freezetime',
    });
    expect(repeated.transitions).toEqual([]);
    expect(repeated.state.map.epoch).toBe(1);
  });

  it('suppresses all old-execution edge comparison on an observed map-name change', () => {
    let state = createInitialRuntimeState('producer-1');
    state = apply(state, 1, 0, { mapName: 'de_mirage', roundPhase: 'freezetime' }).state;
    const result = apply(state, 2, 10, {
      mapName: 'de_nuke',
      roundPhase: 'live',
    });

    expect(result.state.map).toEqual({ epoch: 2, name: 'de_nuke', competitiveObserved: true });
    expect(result.transitions).toEqual([
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

  it('does not infer round edges across a gap', () => {
    let state = createInitialRuntimeState('producer-1');
    state = apply(state, 1, 0, { roundPhase: 'freezetime' }).state;
    const gap = apply(state, 3, 10, { roundPhase: 'live' });
    expect(gap.transitions).toEqual([]);
    expect(gap.disposition).toMatchObject({
      kind: 'accepted',
      reason: 'gap-resync',
    });

    const afterResync = apply(gap.state, 4, 20, { roundPhase: 'over', winnerSide: 'CT' });
    expect(afterResync.transitions).toEqual([
      expect.objectContaining({ kind: 'round_ended', receiveSequence: 4 }),
    ]);
  });

  it('does not infer round edges across stale recovery', () => {
    let state = createInitialRuntimeState('producer-1');
    state = apply(state, 1, 0, { roundPhase: 'freezetime' }).state;
    const recovery = apply(state, 2, 101, { roundPhase: 'live' });
    expect(recovery.disposition).toEqual({ kind: 'accepted', reason: 'stale-recovery' });
    expect(recovery.transitions).toEqual([]);

    const next = apply(recovery.state, 3, 102, { roundPhase: 'over', winnerSide: 'T' });
    expect(next.transitions).toEqual([
      expect.objectContaining({ kind: 'round_ended', receiveSequence: 3 }),
    ]);
  });

  it('does not emit an edge when coverage is absent or degraded', () => {
    let state = createInitialRuntimeState('producer-1');
    state = apply(state, 1, 0, { roundPhase: 'freezetime' }).state;
    const absent = apply(state, 2, 10, { roundPhase: 'live', roundCoverage: 'absent' });
    expect(absent.transitions).toEqual([]);
    const degraded = apply(absent.state, 3, 20, {
      roundPhase: 'over',
      roundCoverage: 'degraded',
    });
    expect(degraded.transitions).toEqual([]);
  });
});
