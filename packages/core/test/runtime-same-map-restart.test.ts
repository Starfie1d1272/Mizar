import { describe, expect, it } from 'vitest';
import { createInitialRuntimeState, reduceRuntime } from '../src/runtime/index.js';
import { observation, telemetryInput, TEST_POLICY } from './helpers.js';

function warmup(sequence = 3, history: 'empty' | 'omitted' = 'empty') {
  const frame = observation(sequence, sequence * 10, {
    mapName: 'de_nuke',
    mapPhase: 'warmup',
    roundPhase: 'unknown',
    roundNumber: 0,
  });
  return {
    ...frame,
    telemetry: {
      ...frame.telemetry,
      map: {
        name: 'de_nuke',
        phase: 'warmup' as const,
        roundNumber: 0,
        sides: { ct: { score: 0 }, t: { score: 0 } },
        ...(history === 'empty' ? { roundWins: [] } : {}),
      },
    },
  };
}

function priorExecution() {
  return reduceRuntime(
    createInitialRuntimeState('restart-regression'),
    telemetryInput(0, observation(1, 10, { mapName: 'de_nuke', roundNumber: 16 })),
    TEST_POLICY,
  ).state;
}

describe('observed same-map restart', () => {
  it('recognizes real live → menu → empty warmup evidence once and resets map consumers', () => {
    const menu = reduceRuntime(
      priorExecution(),
      telemetryInput(0, observation(2, 20, { mapCoverage: 'absent', roundCoverage: 'absent' })),
      TEST_POLICY,
    ).state;
    expect(menu.map.competitiveObserved).toBe(true);
    const restarted = reduceRuntime(menu, telemetryInput(0, warmup()), TEST_POLICY);
    expect(restarted.state.map).toEqual({ epoch: 2, name: 'de_nuke' });
    expect(restarted.transitions).toEqual([
      expect.objectContaining({
        kind: 'map_execution_changed',
        reason: 'observed-same-map-restart',
        previousMapEpoch: 1,
        mapEpoch: 2,
        sourceGeneration: 0,
        receiveSequence: 3,
      }),
    ]);
    expect(restarted.state.playerStats.mapEpoch).toBe(2);
    expect(restarted.state.playerStats.countedCompletedRounds).toBe(0);
    expect(restarted.state.objectiveTiming.mapEpoch).toBe(2);
    const repeated = reduceRuntime(restarted.state, telemetryInput(0, warmup(4)), TEST_POLICY);
    expect(repeated.state.map.epoch).toBe(2);
    expect(repeated.transitions).toEqual([]);
  });

  it('treats a cold warmup as a baseline, not a second execution', () => {
    const baseline = reduceRuntime(
      createInitialRuntimeState('restart-regression'),
      telemetryInput(0, warmup()),
      TEST_POLICY,
    );
    expect(baseline.state.map).toEqual({ epoch: 1, name: 'de_nuke' });
    expect(baseline.transitions).toEqual([]);
  });

  it('recognizes real CS2 warmup that omits round history, without repeating the boundary', () => {
    const omittedHistory = warmup(3, 'omitted');
    const restarted = reduceRuntime(
      priorExecution(),
      telemetryInput(0, omittedHistory),
      TEST_POLICY,
    );
    expect(restarted.state.map).toEqual({ epoch: 2, name: 'de_nuke' });
    expect(restarted.transitions).toEqual([
      expect.objectContaining({
        kind: 'map_execution_changed',
        reason: 'observed-same-map-restart',
      }),
    ]);
    const repeated = reduceRuntime(
      restarted.state,
      telemetryInput(0, warmup(4, 'omitted')),
      TEST_POLICY,
    );
    expect(repeated.state.map.epoch).toBe(2);
    expect(repeated.transitions).toEqual([]);
  });

  it.each(['degraded', 'nonempty-history', 'missing-score', 'nonzero-score'])(
    'does not advance from insufficient %s evidence',
    (kind) => {
      const frame = warmup();
      const map = frame.telemetry.map;
      const candidate = {
        ...frame,
        coverage: {
          ...frame.coverage,
          map: kind === 'degraded' ? ('degraded' as const) : ('present' as const),
        },
        telemetry: {
          ...frame.telemetry,
          map: {
            name: map.name,
            phase: map.phase,
            roundNumber: map.roundNumber,
            roundWins:
              kind === 'nonempty-history'
                ? [
                    {
                      roundNumber: 1,
                      winnerSide: 'CT' as const,
                      winCondition: 'defuse' as const,
                    },
                  ]
                : [],
            ...(kind === 'missing-score'
              ? {}
              : {
                  sides:
                    kind === 'nonzero-score' ? { ct: { score: 1 }, t: { score: 0 } } : map.sides,
                }),
          },
        },
      };
      const result = reduceRuntime(priorExecution(), telemetryInput(0, candidate), TEST_POLICY);
      expect(result.state.map.epoch).toBe(1);
      expect(result.transitions.filter((t) => t.kind === 'map_execution_changed')).toEqual([]);
    },
  );

  it('does not infer a restart from a lower live round or a rejected duplicate warmup', () => {
    const prior = priorExecution();
    const rewind = reduceRuntime(
      prior,
      telemetryInput(0, observation(2, 20, { mapName: 'de_nuke', roundNumber: 14 })),
      TEST_POLICY,
    );
    expect(rewind.state.map.epoch).toBe(1);
    const duplicate = reduceRuntime(prior, telemetryInput(0, warmup(1)), TEST_POLICY);
    expect(duplicate.disposition).toEqual({ kind: 'ignored', reason: 'duplicate' });
    expect(duplicate.state).toBe(prior);
  });
});
