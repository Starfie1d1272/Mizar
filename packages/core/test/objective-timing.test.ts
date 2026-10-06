import { describe, expect, it } from 'vitest';

import { emptyActiveLineup, unboundIdentityResolution } from '../src/identity/index.js';
import { projectProgram, selectProgramSafeRuntimeView } from '../src/projection/index.js';
import {
  createInitialRuntimeState,
  reduceRuntime,
  type RuntimeContinuityPolicy,
} from '../src/runtime/index.js';
import type {
  BombState,
  CountdownPhase,
  ObservedPlayer,
  TelemetryObservation,
} from '../src/telemetry/index.js';

const POLICY: RuntimeContinuityPolicy = {
  staleAfterMs: 20_000,
  objectiveClockLeaseMs: 1_000,
};

function player(sourcePlayerId: string, hasDefuser: boolean): ObservedPlayer {
  return {
    sourcePlayerId,
    side: 'CT',
    state: { hasDefuser },
  };
}

function observation(
  sequence: number,
  receivedMonotonicMs: number,
  options: {
    readonly bombState?: BombState;
    readonly countdownSeconds?: number;
    readonly sourcePlayerId?: string;
    readonly bombCoverage?: 'present' | 'absent' | 'degraded';
    readonly phase?: CountdownPhase;
    readonly phaseEndsSeconds?: number;
    readonly roundPhase?: 'live' | 'over';
    readonly allPlayers?: readonly ObservedPlayer[];
    readonly player?: ObservedPlayer;
  } = {},
): TelemetryObservation {
  const bombCoverage = options.bombCoverage ?? 'present';
  const hasBomb = bombCoverage === 'present';
  return {
    receive: {
      sequence,
      receivedAt: new Date(
        Date.parse('2026-09-21T00:00:00.000Z') + receivedMonotonicMs,
      ).toISOString(),
      receivedMonotonicMs,
    },
    source: { kind: 'cs2-gsi' },
    coverage: {
      provider: 'present',
      map: 'present',
      round: 'present',
      phaseCountdowns: options.phase === undefined ? 'absent' : 'present',
      player: options.player === undefined ? 'absent' : 'present',
      allPlayers: options.allPlayers === undefined ? 'absent' : 'present',
      bomb: bombCoverage,
      grenades: 'absent',
    },
    telemetry: {
      map: { name: 'de_mirage', phase: 'live' },
      round: { phase: options.roundPhase ?? 'live' },
      ...(options.phase === undefined
        ? {}
        : {
            phaseCountdowns: {
              phase: options.phase,
              ...(options.phaseEndsSeconds === undefined
                ? {}
                : { endsInSeconds: options.phaseEndsSeconds }),
            },
          }),
      ...(options.allPlayers === undefined ? {} : { allPlayers: options.allPlayers }),
      ...(options.player === undefined ? {} : { player: options.player }),
      ...(hasBomb
        ? {
            bomb: {
              state: options.bombState ?? 'unknown',
              ...(options.countdownSeconds === undefined
                ? {}
                : { countdownSeconds: options.countdownSeconds }),
              ...(options.sourcePlayerId === undefined
                ? {}
                : { sourcePlayerId: options.sourcePlayerId }),
            },
          }
        : {}),
    },
  };
}

function accept(
  state: ReturnType<typeof createInitialRuntimeState>,
  frame: TelemetryObservation,
  sourceGeneration = state.programSource.generation,
) {
  return reduceRuntime(
    state,
    { kind: 'program-telemetry', sourceGeneration, observation: frame },
    POLICY,
  ).state;
}

function project(
  state: ReturnType<typeof createInitialRuntimeState>,
  nowMonotonicMs: number,
  continuityPolicy = POLICY,
) {
  return projectProgram({
    runtime: selectProgramSafeRuntimeView(state),
    identity: unboundIdentityResolution(),
    activeLineup: emptyActiveLineup(state.programSource.generation, state.map.epoch),
    nowMonotonicMs,
    continuityPolicy,
  });
}

describe('objective timing normalization', () => {
  it('keeps explosion time across defusing and derives kit duration only from player evidence', () => {
    let state = createInitialRuntimeState('objective-timing');
    state = accept(state, observation(1, 0, { bombState: 'planted', countdownSeconds: 30 }));
    state = accept(
      state,
      observation(2, 1_000, {
        bombState: 'defusing',
        countdownSeconds: 5,
        sourcePlayerId: 'defuser',
        allPlayers: [player('defuser', true)],
      }),
    );

    expect(state.objectiveTiming.explosionAnchor).toMatchObject({
      remainingSecondsAtSample: 30,
      sampledAtMonotonicMs: 0,
    });
    expect(project(state, 1_000).bomb).toEqual({
      state: 'defusing',
      sourcePlayerId: 'defuser',
      explosion: { remainingSeconds: 29, durationSeconds: null },
      action: {
        kind: 'defuse',
        sourcePlayerId: 'defuser',
        remainingSeconds: 5,
        durationSeconds: 5,
        hasDefuseKit: true,
      },
    });
  });

  it('does not synthesize an explosion clock when the first frame is defusing', () => {
    let state = createInitialRuntimeState('objective-timing');
    state = accept(
      state,
      observation(1, 0, {
        bombState: 'defusing',
        countdownSeconds: 9,
        sourcePlayerId: 'defuser',
        phase: 'defuse',
        phaseEndsSeconds: 9,
        allPlayers: [player('defuser', false)],
      }),
    );

    expect(project(state, 0).bomb).toMatchObject({
      explosion: null,
      action: {
        kind: 'defuse',
        durationSeconds: 10,
        hasDefuseKit: false,
      },
    });
  });

  it('recalibrates from a new planted sample without smoothing or restarting on defuse', () => {
    let state = createInitialRuntimeState('objective-timing');
    state = accept(state, observation(1, 0, { bombState: 'planted', countdownSeconds: 30 }));
    state = accept(
      state,
      observation(2, 1_000, {
        bombState: 'defusing',
        countdownSeconds: 5,
        sourcePlayerId: 'defuser',
        allPlayers: [player('defuser', false)],
      }),
    );
    state = accept(state, observation(3, 2_000, { bombState: 'planted', countdownSeconds: 20 }));
    state = accept(
      state,
      observation(4, 3_000, {
        bombState: 'defusing',
        countdownSeconds: 8,
        sourcePlayerId: 'defuser',
        allPlayers: [player('defuser', false)],
      }),
    );

    expect(project(state, 3_000).bomb?.explosion).toEqual({
      remainingSeconds: 19,
      durationSeconds: null,
    });
    expect(project(state, 3_000).bomb?.action?.remainingSeconds).toBe(8);
  });

  it('accepts a newer planted sample as an authoritative upward recalibration', () => {
    let state = createInitialRuntimeState('objective-timing');
    state = accept(state, observation(1, 0, { bombState: 'planted', countdownSeconds: 30 }));
    state = accept(state, observation(2, 1_000, { bombState: 'planted', countdownSeconds: 35 }));

    expect(state.objectiveTiming.explosionAnchor).toMatchObject({
      remainingSecondsAtSample: 35,
      sampledAtMonotonicMs: 1_000,
    });
    expect(project(state, 1_000).bomb?.explosion?.remainingSeconds).toBe(35);
  });

  it('clears the plant action and explosion on a plant abort', () => {
    let state = createInitialRuntimeState('objective-timing');
    state = accept(state, observation(1, 0, { bombState: 'planting', countdownSeconds: 3 }));
    state = accept(state, observation(2, 1_000, { bombState: 'carried' }));

    expect(project(state, 1_000).bomb).toEqual({
      state: 'carried',
      sourcePlayerId: null,
      explosion: null,
      action: null,
    });
  });

  it('invalidates an explosion anchor after stale recovery or a sequence gap', () => {
    let state = createInitialRuntimeState('objective-timing');
    state = accept(state, observation(1, 0, { bombState: 'planted', countdownSeconds: 30 }));
    state = accept(
      state,
      observation(2, 20_001, {
        bombState: 'defusing',
        countdownSeconds: 5,
        sourcePlayerId: 'defuser',
        allPlayers: [player('defuser', false)],
      }),
    );
    expect(project(state, 20_001).bomb?.explosion).toBeNull();

    state = createInitialRuntimeState('objective-timing');
    state = accept(state, observation(1, 0, { bombState: 'planted', countdownSeconds: 30 }));
    state = accept(
      state,
      observation(3, 1, {
        bombState: 'defusing',
        countdownSeconds: 5,
        sourcePlayerId: 'defuser',
        allPlayers: [player('defuser', false)],
      }),
    );
    expect(project(state, 1).bomb?.explosion).toBeNull();
  });

  it('gates objective numerics by global freshness when staleAfterMs is shorter than the lease', () => {
    let state = createInitialRuntimeState('objective-timing');
    state = accept(state, observation(1, 0, { bombState: 'planted', countdownSeconds: 30 }));

    expect(
      project(state, 101, { staleAfterMs: 100, objectiveClockLeaseMs: 1_000 }).bomb?.explosion,
    ).toEqual({ remainingSeconds: null, durationSeconds: null });
  });

  it('fails closed when current defuser evidence conflicts across player blocks', () => {
    let state = createInitialRuntimeState('objective-timing');
    state = accept(
      state,
      observation(1, 0, {
        bombState: 'defusing',
        countdownSeconds: 5,
        sourcePlayerId: 'defuser',
        allPlayers: [player('defuser', true)],
        player: player('defuser', false),
      }),
    );

    expect(project(state, 0).bomb?.action).toMatchObject({
      kind: 'defuse',
      durationSeconds: null,
      hasDefuseKit: null,
    });
  });

  it('clears round-over bomb residue before projecting actions', () => {
    let state = createInitialRuntimeState('objective-timing');
    state = accept(state, observation(1, 0, { bombState: 'planted', countdownSeconds: 30 }));
    state = accept(
      state,
      observation(2, 1, {
        bombState: 'defusing',
        countdownSeconds: 5,
        sourcePlayerId: 'defuser',
        roundPhase: 'over',
        allPlayers: [player('defuser', true)],
      }),
    );

    expect(project(state, 1).bomb).toEqual({
      state: 'defusing',
      sourcePlayerId: 'defuser',
      explosion: null,
      action: null,
    });
  });

  it('clears timing on terminal, absent/degraded bomb blocks, map resets, and source generations', () => {
    let state = createInitialRuntimeState('objective-timing');
    state = accept(state, observation(1, 0, { bombState: 'planted', countdownSeconds: 30 }));
    state = accept(state, observation(2, 1, { bombState: 'exploded' }));
    expect(state.objectiveTiming.explosionAnchor).toBeNull();
    expect(project(state, 1).bomb?.explosion).toBeNull();

    state = accept(state, observation(3, 2, { bombState: 'planted', countdownSeconds: 30 }));
    state = accept(state, observation(4, 3, { bombCoverage: 'degraded' }));
    expect(state.objectiveTiming.explosionAnchor).toBeNull();

    state = accept(state, observation(5, 4, { bombState: 'planted', countdownSeconds: 30 }));
    state = reduceRuntime(
      state,
      {
        kind: 'reset-map-execution',
        reason: 'operator-correction',
        at: { monotonicMs: 5, utc: '2026-09-21T00:00:00.005Z' },
      },
      POLICY,
    ).state;
    expect(state.objectiveTiming.explosionAnchor).toBeNull();
    expect(project(state, 5).bomb).toBeNull();

    state = accept(state, observation(6, 6, { bombState: 'planted', countdownSeconds: 30 }));
    state = reduceRuntime(
      state,
      {
        kind: 'advance-program-source-generation',
        nextGeneration: 1,
        at: { monotonicMs: 7, utc: '2026-09-21T00:00:00.007Z' },
      },
      POLICY,
    ).state;
    expect(state.objectiveTiming.explosionAnchor).toBeNull();
    expect(selectProgramSafeRuntimeView(state).telemetry).toBeNull();
  });

  it('advances action remaining from the accepted receive monotonic time on later projections', () => {
    let state = createInitialRuntimeState('objective-timing');
    state = accept(
      state,
      observation(1, 1_000, {
        bombState: 'defusing',
        countdownSeconds: 5,
        sourcePlayerId: 'defuser',
        allPlayers: [player('defuser', true)],
      }),
    );

    expect(project(state, 1_500).bomb?.action).toMatchObject({
      kind: 'defuse',
      remainingSeconds: 4.5,
      durationSeconds: 5,
    });
  });

  it('expires numeric interpolation after the short objective-clock lease', () => {
    let state = createInitialRuntimeState('objective-timing');
    state = accept(
      state,
      observation(1, 0, {
        bombState: 'defusing',
        countdownSeconds: 5,
        sourcePlayerId: 'defuser',
        allPlayers: [player('defuser', false)],
      }),
    );

    expect(project(state, 1_001).bomb).toEqual({
      state: 'defusing',
      sourcePlayerId: 'defuser',
      explosion: null,
      action: {
        kind: 'defuse',
        sourcePlayerId: 'defuser',
        remainingSeconds: null,
        durationSeconds: 10,
        hasDefuseKit: false,
      },
    });
  });
});

describe('defuse clocks with absent equipment fields', () => {
  it('retains proven ten-second duration after the countdown passes five, and resets on abort/actor change', () => {
    let s = createInitialRuntimeState('unknown-kit');
    s = accept(
      s,
      observation(1, 0, { bombState: 'defusing', countdownSeconds: 9.999, sourcePlayerId: 'a' }),
    );
    expect(project(s, 0).bomb?.action).toMatchObject({ durationSeconds: 10, hasDefuseKit: null });
    s = accept(
      s,
      observation(2, 100, { bombState: 'defusing', countdownSeconds: 4.9, sourcePlayerId: 'a' }),
    );
    expect(project(s, 100).bomb?.action?.durationSeconds).toBe(10);
    s = accept(
      s,
      observation(3, 200, { bombState: 'defusing', countdownSeconds: 2, sourcePlayerId: 'b' }),
    );
    expect(project(s, 200).bomb?.action?.durationSeconds).toBeNull();
    s = accept(s, observation(4, 300, { bombState: 'planted', countdownSeconds: 25 }));
    s = accept(
      s,
      observation(5, 350, { bombState: 'defusing', countdownSeconds: 4.99, sourcePlayerId: 'a' }),
    );
    expect(project(s, 350).bomb?.action).toMatchObject({ durationSeconds: 5, hasDefuseKit: null });
  });
  it('does not turn a late two-second countdown or a sequence gap into a five/ten-second claim', () => {
    let s = createInitialRuntimeState('late-kit');
    s = accept(s, observation(1, 0, { bombState: 'defusing', countdownSeconds: 2 }));
    expect(project(s, 0).bomb?.action?.durationSeconds).toBeNull();
    s = accept(s, observation(2, 100, { bombState: 'planted', countdownSeconds: 20 }));
    s = accept(s, observation(4, 150, { bombState: 'defusing', countdownSeconds: 4.999 }));
    expect(project(s, 150).bomb?.action?.durationSeconds).toBeNull();
  });
});

describe('witnessed objective progress denominators', () => {
  function planted() {
    let s = createInitialRuntimeState('duration');
    s = accept(s, observation(1, 0, { bombState: 'carried' }));
    s = accept(s, observation(2, 100, { bombState: 'planting', countdownSeconds: 3.1 }));
    expect(project(s, 100).bomb?.action?.durationSeconds).toBe(3.1);
    s = accept(s, observation(3, 200, { bombState: 'planting', countdownSeconds: 3 }));
    expect(project(s, 200).bomb?.action?.durationSeconds).toBe(3.1);
    return accept(s, observation(4, 3300, { bombState: 'planted', countdownSeconds: 39.8 }));
  }
  it('captures once, calibrates upwards and preserves explosion across defuse/abort', () => {
    let s = planted();
    expect(project(s, 3300).bomb?.explosion?.durationSeconds).toBe(39.8);
    expect(s.objectiveTiming.plantActionDurationSeconds).toBeNull();
    s = accept(s, observation(5, 3400, { bombState: 'planted', countdownSeconds: 39.9 }));
    s = accept(s, observation(6, 3500, { bombState: 'defusing', countdownSeconds: 4 }));
    expect(project(s, 3500).bomb).toMatchObject({
      explosion: { durationSeconds: 39.9 },
      action: { durationSeconds: null },
    });
    s = accept(s, observation(7, 3600, { bombState: 'planted', countdownSeconds: 39.6 }));
    expect(project(s, 3600).bomb?.explosion?.durationSeconds).toBe(39.9);
  });
  it.each(['planting', 'planted', 'defusing'] as const)(
    'does not invent %s baseline duration',
    (bombState) => {
      const s = accept(
        createInitialRuntimeState('late'),
        observation(1, 0, { bombState, countdownSeconds: 2 }),
      );
      expect(s.objectiveTiming.explosionDurationSeconds).toBeNull();
      expect(s.objectiveTiming.plantActionDurationSeconds).toBeNull();
    },
  );
  it.each(['defused', 'exploded', 'carried', 'dropped', 'unknown'] as const)(
    'clears on %s',
    (bombState) => {
      const s = accept(planted(), observation(5, 3400, { bombState }));
      expect(s.objectiveTiming.explosionDurationSeconds).toBeNull();
    },
  );
  it('clears on gap, stale recovery, generation and map reset', () => {
    for (const [sequence, ms, generation] of [
      [6, 3400, 0],
      [5, 30000, 0],
    ] as const) {
      const s = accept(
        planted(),
        observation(sequence, ms, { bombState: 'planted', countdownSeconds: 25 }),
        generation,
      );
      expect(s.objectiveTiming.explosionDurationSeconds).toBeNull();
    }
  });
  it('map reset and generation advance clear denominator authority', () => {
    const at = { monotonicMs: 3400, utc: '2026-09-21T00:00:03.400Z' };
    for (const command of [
      { kind: 'reset-map-execution', reason: 'operator-correction', at },
      { kind: 'advance-program-source-generation', nextGeneration: 1, at },
    ] as const) {
      const s = reduceRuntime(planted(), command, POLICY).state;
      expect(s.objectiveTiming.explosionDurationSeconds).toBeNull();
      expect(s.objectiveTiming.plantActionDurationSeconds).toBeNull();
    }
  });
  it('plant abort clears action and invalid countdown cannot establish duration', () => {
    let s = accept(createInitialRuntimeState('abort'), observation(1, 0, { bombState: 'dropped' }));
    s = accept(s, observation(2, 100, { bombState: 'planting', countdownSeconds: -1 }));
    expect(s.objectiveTiming.plantActionDurationSeconds).toBeNull();
    s = accept(s, observation(3, 200, { bombState: 'carried' }));
    expect(project(s, 200).bomb?.action).toBeNull();
    s = accept(s, observation(4, 300, { bombState: 'planting', countdownSeconds: 3 }));
    expect(s.objectiveTiming.plantActionDurationSeconds).toBe(3);
  });
  it('round over clears duration and expired lease hides progress remaining', () => {
    const s = planted();
    expect(project(s, 4401).bomb?.explosion).toEqual({
      remainingSeconds: null,
      durationSeconds: 39.8,
    });
    expect(
      accept(
        s,
        observation(5, 3400, { bombState: 'planted', countdownSeconds: 39, roundPhase: 'over' }),
      ).objectiveTiming.explosionDurationSeconds,
    ).toBeNull();
  });
});
