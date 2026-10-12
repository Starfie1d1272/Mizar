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
  it('does not turn a late two-second countdown or a sequence gap into a five/ten-second claim', () => {
    let s = createInitialRuntimeState('late-kit');
    s = accept(s, observation(1, 0, { bombState: 'defusing', countdownSeconds: 2 }));
    expect(project(s, 0).bomb?.action?.durationSeconds).toBeNull();
    s = accept(s, observation(2, 100, { bombState: 'planted', countdownSeconds: 20 }));
    s = accept(s, observation(4, 150, { bombState: 'defusing', countdownSeconds: 4.999 }));
    expect(project(s, 150).bomb?.action?.durationSeconds).toBeNull();
  });
});
