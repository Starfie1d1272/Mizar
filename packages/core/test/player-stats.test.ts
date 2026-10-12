import { describe, expect, it } from 'vitest';

import {
  createInitialRuntimeState,
  getPlayerCompletedAdr,
  getPlayerLiveAdr,
  reduceRuntime,
  type RuntimeState,
} from '../src/runtime/index.js';
import type { ObservedPlayer, TelemetryObservation } from '../src/telemetry/index.js';

const POLICY = { staleAfterMs: 100 } as const;
const PLAYER_A = '76561198000000001';
const PLAYER_B = '76561198000000002';

function player(sourcePlayerId: string, damage: number, money = 4_200): ObservedPlayer {
  return {
    sourcePlayerId,
    side: sourcePlayerId === PLAYER_A ? 'CT' : 'T',
    activity: 'playing',
    state: { health: damage === 0 ? 0 : 100, roundTotalDamage: damage, money },
  };
}

function frame(
  sequence: number,
  receivedMonotonicMs: number,
  phase: 'freezetime' | 'live' | 'over',
  roundNumber: number,
  damage = 0,
  money = 4_200,
  allPlayersCoverage: 'present' | 'absent' | 'degraded' = 'present',
): TelemetryObservation {
  const allPlayers = [player(PLAYER_A, damage, money), player(PLAYER_B, 0, 3_000)];
  return {
    receive: {
      sequence,
      receivedAt: new Date(
        Date.parse('2026-09-17T00:00:00.000Z') + receivedMonotonicMs,
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
      allPlayers: allPlayersCoverage,
      bomb: 'absent',
      grenades: 'absent',
    },
    telemetry: {
      map: { name: 'de_mirage', phase: 'live', roundNumber },
      round: { phase },
      ...(allPlayersCoverage === 'absent' ? {} : { allPlayers }),
    },
  };
}

function accept(state: RuntimeState, observation: TelemetryObservation, sourceGeneration = 0) {
  return reduceRuntime(state, { kind: 'program-telemetry', sourceGeneration, observation }, POLICY);
}

describe('map-scoped player stats accumulator', () => {
  it('completes an eligible final round at gameover without an over phase, once', () => {
    let state = createInitialRuntimeState('stats-gameover');
    state = accept(state, frame(1, 1, 'freezetime', 17)).state;
    state = accept(state, frame(2, 2, 'live', 17, 80)).state;
    const final = frame(3, 3, 'freezetime', 18, 0);
    const observation = {
      ...final,
      telemetry: {
        ...final.telemetry,
        map: { ...final.telemetry.map!, phase: 'gameover' as const },
      },
    };
    state = accept(state, observation).state;
    expect(state.playerStats.countedCompletedRounds).toBe(1);
    expect(getPlayerCompletedAdr(state.playerStats, PLAYER_A)).toBe(80);
    state = accept(state, { ...observation, receive: frame(4, 4, 'freezetime', 18).receive }).state;
    expect(state.playerStats.countedCompletedRounds).toBe(1);
    expect(getPlayerCompletedAdr(state.playerStats, PLAYER_A)).toBe(80);
  });

  it('does not count a mid-round baseline, then resumes on the next complete round', () => {
    let state = createInitialRuntimeState('stats-mid-join');
    state = accept(state, frame(1, 1, 'live', 6, 90)).state;
    state = accept(state, frame(2, 2, 'over', 6, 0)).state;
    expect(state.playerStats.countedCompletedRounds).toBe(0);
    expect(getPlayerLiveAdr(state.playerStats, PLAYER_A)).toBeNull();

    state = accept(state, frame(3, 3, 'freezetime', 7)).state;
    state = accept(state, frame(4, 4, 'live', 7, 50)).state;
    expect(getPlayerLiveAdr(state.playerStats, PLAYER_A)).toBe(50);
  });
});
