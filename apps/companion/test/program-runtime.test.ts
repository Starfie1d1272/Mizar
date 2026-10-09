import { describe, expect, it } from 'vitest';
import type { TelemetryObservation } from '@mizar/core/telemetry';

import {
  createProgramRuntime,
  PROGRAM_RUNTIME_RECENT_TRANSITIONS_MAX,
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
