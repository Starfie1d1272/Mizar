import { describe, expect, it } from 'vitest';

import {
  createInitialRuntimeState,
  getPlayerCompletedAdr,
  getPlayerCurrentRoundDamage,
  getPlayerCurrentRoundMoneySpent,
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

function completeRound(
  state: RuntimeState,
  startSequence: number,
  roundNumber: number,
  damage: number,
) {
  let next = accept(state, frame(startSequence, startSequence, 'freezetime', roundNumber)).state;
  next = accept(
    next,
    frame(startSequence + 1, startSequence + 1, 'live', roundNumber, damage),
  ).state;
  return accept(next, frame(startSequence + 2, startSequence + 2, 'over', roundNumber, 0)).state;
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

  it.each(['gap', 'missing-players', 'round-jump', 'mid-round-baseline'] as const)(
    'does not promote incomplete final-round evidence at gameover: %s',
    (kind) => {
      let state = createInitialRuntimeState('stats-gameover-incomplete');
      if (kind !== 'mid-round-baseline') state = accept(state, frame(1, 1, 'freezetime', 17)).state;
      state = accept(state, frame(kind === 'mid-round-baseline' ? 1 : 2, 2, 'live', 17, 80)).state;
      const final = frame(
        kind === 'gap' ? 4 : kind === 'mid-round-baseline' ? 2 : 3,
        3,
        'freezetime',
        kind === 'round-jump' ? 20 : 18,
        0,
        4200,
        kind === 'missing-players' ? 'absent' : 'present',
      );
      state = accept(state, {
        ...final,
        telemetry: {
          ...final.telemetry,
          map: { ...final.telemetry.map!, phase: 'gameover' as const },
        },
      }).state;
      expect(state.playerStats.countedCompletedRounds).toBe(0);
      expect(getPlayerCompletedAdr(state.playerStats, PLAYER_A)).toBeNull();
    },
  );

  it('starts counting from a complete freezetime → live round and includes current damage', () => {
    let state = createInitialRuntimeState('stats-test');
    state = accept(state, frame(1, 1, 'freezetime', 1)).state;
    expect(getPlayerLiveAdr(state.playerStats, PLAYER_A)).toBeNull();
    expect(getPlayerCompletedAdr(state.playerStats, PLAYER_A)).toBeNull();

    state = accept(state, frame(2, 2, 'live', 1, 80)).state;
    expect(state.playerStats.currentRound?.eligible).toBe(true);
    expect(getPlayerLiveAdr(state.playerStats, PLAYER_A)).toBe(80);
    expect(getPlayerCompletedAdr(state.playerStats, PLAYER_A)).toBeNull();

    state = accept(state, frame(3, 3, 'live', 1, 0)).state;
    expect(getPlayerLiveAdr(state.playerStats, PLAYER_A)).toBe(80);
    state = accept(state, frame(4, 4, 'over', 1, 0)).state;
    expect(state.playerStats.countedCompletedRounds).toBe(1);
    expect(getPlayerLiveAdr(state.playerStats, PLAYER_A)).toBe(80);
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

  it('keeps the per-round maximum when a dead player reports round damage zero', () => {
    let state = createInitialRuntimeState('stats-death-reset');
    state = accept(state, frame(1, 1, 'freezetime', 1)).state;
    state = accept(state, frame(2, 2, 'live', 1, 80)).state;
    state = accept(state, frame(3, 3, 'live', 1, 0)).state;
    expect(state.playerStats.currentRound?.damageBySteam64[PLAYER_A]).toBe(80);
    expect(getPlayerCurrentRoundDamage(state.playerStats, PLAYER_A)).toBe(80);
    state = accept(state, frame(4, 4, 'over', 1, 0)).state;
    expect(state.playerStats.completedDamageBySteam64[PLAYER_A]).toBe(80);
  });

  it('freezes the first healthy freezetime money and exposes max damage until evidence is invalidated', () => {
    let state = createInitialRuntimeState('stats-current-round-facts');
    state = accept(state, frame(1, 1, 'freezetime', 1, 0, 4_200)).state;
    state = accept(state, frame(2, 2, 'freezetime', 1, 0, 3_800)).state;
    expect(state.playerStats.currentRound?.startMoneyBySteam64[PLAYER_A]).toBe(4_200);
    expect(getPlayerCurrentRoundMoneySpent(state.playerStats, PLAYER_A, 3_800)).toBe(400);
    expect(getPlayerCurrentRoundMoneySpent(state.playerStats, PLAYER_A, 4_500)).toBe(0);

    state = accept(state, frame(3, 3, 'live', 1, 80, 3_700)).state;
    expect(getPlayerCurrentRoundDamage(state.playerStats, PLAYER_A)).toBe(80);
    expect(getPlayerCurrentRoundMoneySpent(state.playerStats, PLAYER_A, 3_700)).toBeNull();

    state = accept(state, frame(5, 5, 'live', 1, 0, 4_500)).state;
    expect(getPlayerCurrentRoundDamage(state.playerStats, PLAYER_A)).toBeNull();
    expect(getPlayerCurrentRoundMoneySpent(state.playerStats, PLAYER_A, 4_500)).toBeNull();

    state = accept(state, frame(6, 6, 'freezetime', 2, 0, 3_500)).state;
    state = accept(state, frame(7, 7, 'live', 2, 20, 3_400)).state;
    expect(getPlayerCurrentRoundMoneySpent(state.playerStats, PLAYER_A, 3_400)).toBeNull();
  });

  it('finalizes when map.round advances at phase=over', () => {
    let state = createInitialRuntimeState('stats-round-hint');
    state = accept(state, frame(1, 1, 'freezetime', 0)).state;
    state = accept(state, frame(2, 2, 'live', 0, 80)).state;
    state = accept(state, frame(3, 3, 'over', 1, 0)).state;

    expect(state.playerStats.countedCompletedRounds).toBe(1);
    expect(getPlayerCompletedAdr(state.playerStats, PLAYER_A)).toBe(80);
  });

  it('excludes the in-flight round after a gap and does not double-finalize an over frame', () => {
    let state = createInitialRuntimeState('stats-gap');
    state = accept(state, frame(1, 1, 'freezetime', 1)).state;
    state = accept(state, frame(2, 2, 'live', 1, 80)).state;
    state = accept(state, frame(4, 4, 'over', 1, 80)).state;
    expect(state.playerStats.countedCompletedRounds).toBe(0);

    state = accept(state, frame(5, 5, 'freezetime', 2)).state;
    state = accept(state, frame(6, 6, 'live', 2, 40)).state;
    state = accept(state, frame(7, 7, 'over', 2, 40)).state;
    state = accept(state, frame(8, 8, 'over', 2, 0)).state;
    expect(state.playerStats.countedCompletedRounds).toBe(1);
    expect(state.playerStats.completedDamageBySteam64[PLAYER_A]).toBe(40);
  });

  it('invalidates the current ADR round when allplayers evidence has a gap', () => {
    let state = createInitialRuntimeState('stats-evidence-gap');
    state = accept(state, frame(1, 1, 'freezetime', 1)).state;
    state = accept(state, frame(2, 2, 'live', 1, 40)).state;
    state = accept(state, frame(3, 3, 'live', 1, 0, undefined, 'absent')).state;
    expect(state.playerStats.currentRound).toMatchObject({
      invalidated: true,
      eligible: false,
      hasCompleteEvidence: false,
    });
    state = accept(state, frame(4, 4, 'live', 1, 0)).state;
    state = accept(state, frame(5, 5, 'over', 1, 0)).state;
    expect(state.playerStats.countedCompletedRounds).toBe(0);

    state = accept(state, frame(6, 6, 'freezetime', 2)).state;
    state = accept(state, frame(7, 7, 'live', 2, 20)).state;
    state = accept(state, frame(8, 8, 'over', 2, 0)).state;
    expect(state.playerStats.countedCompletedRounds).toBe(1);
  });

  it('keeps completedAdr stable while liveAdr includes the eligible current round', () => {
    let state = createInitialRuntimeState('stats-two-views');
    state = completeRound(state, 1, 1, 80);
    expect(getPlayerCompletedAdr(state.playerStats, PLAYER_A)).toBe(80);

    state = accept(state, frame(4, 4, 'freezetime', 1)).state;
    state = accept(state, frame(5, 5, 'live', 1, 20)).state;
    expect(getPlayerCompletedAdr(state.playerStats, PLAYER_A)).toBe(80);
    expect(getPlayerLiveAdr(state.playerStats, PLAYER_A)).toBe(50);

    state = accept(state, frame(6, 6, 'over', 1, 0)).state;
    expect(getPlayerCompletedAdr(state.playerStats, PLAYER_A)).toBe(50);
    expect(getPlayerLiveAdr(state.playerStats, PLAYER_A)).toBe(50);
  });

  it('preserves completed stats across source reconnect but clears them at map execution reset', () => {
    let state = completeRound(createInitialRuntimeState('stats-continuity'), 1, 1, 30);
    state = accept(
      state,
      { ...frame(4, 4, 'freezetime', 2), receive: { ...frame(4, 4, 'freezetime', 2).receive } },
      0,
    ).state;
    const advanced = reduceRuntime(
      state,
      {
        kind: 'advance-program-source-generation',
        nextGeneration: 1,
        at: { monotonicMs: 5, utc: '2026-09-17T00:00:00.005Z' },
      },
      POLICY,
    ).state;
    expect(advanced.playerStats.countedCompletedRounds).toBe(1);

    const recovered = accept(advanced, frame(1, 6, 'freezetime', 2), 1).state;
    expect(recovered.playerStats.countedCompletedRounds).toBe(1);

    const reset = reduceRuntime(
      recovered,
      {
        kind: 'reset-map-execution',
        reason: 'same-map-restart',
        at: { monotonicMs: 7, utc: '2026-09-17T00:00:00.007Z' },
      },
      POLICY,
    ).state;
    expect(reset.playerStats.mapEpoch).toBe(reset.map.epoch);
    expect(reset.playerStats.countedCompletedRounds).toBe(0);
    expect(reset.playerStats.completedDamageBySteam64).toEqual({});
  });

  it('does not invent ADR for a non-Steam64 source id', () => {
    expect(
      getPlayerLiveAdr(createInitialRuntimeState('stats-non-steam').playerStats, 'bot-1'),
    ).toBeNull();
  });
});
