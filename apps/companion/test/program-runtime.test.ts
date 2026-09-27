import { describe, expect, it } from 'vitest';
import type { TelemetryObservation } from '@mizar/core/telemetry';

import {
  createProgramRuntime,
  PROGRAM_RUNTIME_RECENT_TRANSITIONS_MAX,
  PRODUCTION_RUNTIME_CONTINUITY_POLICY,
} from '../src/runtime/program-runtime.js';

function observation(
  sequence: number,
  receivedMonotonicMs: number,
  options: {
    readonly mapName?: string;
    readonly roundPhase?: 'freezetime' | 'live' | 'over';
    readonly mapPhase?: 'live' | 'gameover';
  } = {},
): TelemetryObservation {
  return {
    receive: {
      sequence,
      receivedAt: new Date(
        Date.parse('2026-09-15T00:00:00.000Z') + receivedMonotonicMs,
      ).toISOString(),
      receivedMonotonicMs,
    },
    source: { kind: 'cs2-gsi' },
    coverage: {
      provider: 'present',
      map: 'present',
      round: 'present',
      phaseCountdowns: 'absent',
      player: 'absent',
      allPlayers: 'absent',
      bomb: 'absent',
      grenades: 'absent',
    },
    telemetry: {
      map: {
        name: options.mapName ?? 'de_mirage',
        phase: options.mapPhase ?? 'live',
      },
      round: { phase: options.roundPhase ?? 'freezetime' },
    },
  };
}

describe('ProgramRuntime', () => {
  it('owns one initial state with an injected producer identity and generation zero', () => {
    const runtime = createProgramRuntime('producer-test');

    expect(runtime.getSnapshot()).toMatchObject({
      producerInstanceId: 'producer-test',
      sourceGeneration: 0,
      continuityPolicy: PRODUCTION_RUNTIME_CONTINUITY_POLICY,
      current: {
        producerInstanceId: 'producer-test',
        runtimeSeq: 0,
        programSource: { generation: 0 },
        map: { epoch: 0 },
      },
      recentTransitions: [],
    });
    expect(runtime.getSourceFreshness(0)).toBe('awaiting');
  });

  it('reduces observations and keeps duplicate or out-of-order semantics in Core', () => {
    const runtime = createProgramRuntime('producer-test');

    const baseline = runtime.acceptObservation(observation(10, 100));
    expect(baseline.disposition).toEqual({ kind: 'accepted', reason: 'baseline' });
    expect(runtime.getCurrentState().programTelemetry?.receive.sequence).toBe(10);

    const duplicate = runtime.acceptObservation(observation(10, 101));
    expect(duplicate.disposition).toEqual({ kind: 'ignored', reason: 'duplicate' });
    expect(runtime.getCurrentState().runtimeSeq).toBe(1);

    const outOfOrder = runtime.acceptObservation(observation(9, 102));
    expect(outOfOrder.disposition).toEqual({ kind: 'ignored', reason: 'out-of-order' });
    expect(runtime.getLastDisposition()).toEqual({ kind: 'ignored', reason: 'out-of-order' });
  });

  it('preserves Core gap-resync semantics without inventing a cross-gap transition', () => {
    const runtime = createProgramRuntime('producer-test');
    runtime.acceptObservation(observation(1, 100, { roundPhase: 'freezetime' }));

    const gap = runtime.acceptObservation(observation(3, 110, { roundPhase: 'live' }));
    expect(gap.disposition).toEqual({
      kind: 'accepted',
      reason: 'gap-resync',
      missingSequenceRange: { from: 2, to: 2 },
    });
    expect(gap.transitions).toEqual([]);

    const afterResync = runtime.acceptObservation(observation(4, 120, { roundPhase: 'over' }));
    expect(afterResync.transitions).toEqual([
      expect.objectContaining({ kind: 'round_ended', receiveSequence: 4 }),
    ]);
  });

  it('advances source generation explicitly without resetting ingress sequence', () => {
    const runtime = createProgramRuntime('producer-test');
    runtime.acceptObservation(observation(10, 100));

    const advanced = runtime.advanceProgramSourceGeneration({
      monotonicMs: 200,
      utc: '2026-09-15T00:00:00.200Z',
    });

    expect(advanced.disposition).toEqual({
      kind: 'accepted',
      reason: 'source-generation-advanced',
    });
    expect(runtime.getCurrentState()).toMatchObject({
      programSource: {
        generation: 1,
        lastAccepted: { generation: 0, sequence: 10 },
      },
      map: { epoch: 1, name: 'de_mirage' },
    });
    expect(runtime.getCurrentState().programTelemetry).toBeUndefined();
    expect(runtime.getSourceFreshness(200)).toBe('awaiting');

    const recovered = runtime.acceptObservation(observation(11, 210));
    expect(recovered.disposition).toEqual({ kind: 'accepted', reason: 'contiguous' });
    expect(runtime.getCurrentState().programSource.generation).toBe(1);
    expect(runtime.getCurrentState().programTelemetry?.receive.sequence).toBe(11);
  });

  it('uses the explicit Core map reset seam and keeps the ingress cursor', () => {
    const runtime = createProgramRuntime('producer-test');
    runtime.acceptObservation(observation(10, 100));

    const reset = runtime.resetMapExecution('same-map-restart', {
      monotonicMs: 120,
      utc: '2026-09-15T00:00:00.120Z',
    });

    expect(reset.disposition).toEqual({ kind: 'accepted', reason: 'map-execution-reset' });
    expect(reset.transitions).toEqual([
      expect.objectContaining({
        kind: 'map_execution_changed',
        reason: 'explicit-reset',
        resetReason: 'same-map-restart',
        previousMapEpoch: 1,
        mapEpoch: 2,
      }),
    ]);
    expect(runtime.getCurrentState()).toMatchObject({
      programSource: { generation: 0, lastAccepted: { sequence: 10 } },
      map: { epoch: 2, name: 'de_mirage' },
    });
    expect(runtime.getCurrentState().programTelemetry).toBeUndefined();

    const newBaseline = runtime.acceptObservation(observation(11, 130));
    expect(newBaseline.transitions).toEqual([]);
    expect(newBaseline.disposition).toEqual({ kind: 'accepted', reason: 'contiguous' });
  });

  it('keeps the recent transition ring bounded and returns a defensive array snapshot', () => {
    const runtime = createProgramRuntime('producer-test');
    runtime.acceptObservation(observation(0, 0, { mapName: 'de_map_0' }));
    for (let index = 1; index <= 40; index += 1) {
      runtime.acceptObservation(observation(index, index, { mapName: `de_map_${index}` }));
    }

    const snapshot = runtime.getSnapshot();
    expect(snapshot.recentTransitions).toHaveLength(PROGRAM_RUNTIME_RECENT_TRANSITIONS_MAX);
    expect(snapshot.recentTransitions[0]).toMatchObject({
      kind: 'map_execution_changed',
      receiveSequence: 9,
    });

    const mutableView = snapshot.recentTransitions as Array<unknown>;
    mutableView.length = 0;
    expect(runtime.getSnapshot().recentTransitions).toHaveLength(
      PROGRAM_RUNTIME_RECENT_TRANSITIONS_MAX,
    );
  });

  it('derives freshness from the injected monotonic policy', () => {
    const runtime = createProgramRuntime('producer-test');
    runtime.acceptObservation(observation(1, 100));

    expect(runtime.getSourceFreshness(20_100)).toBe('fresh');
    expect(runtime.getSourceFreshness(20_101)).toBe('stale');
  });
});
