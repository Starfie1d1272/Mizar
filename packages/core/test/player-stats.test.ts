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

it('computes the community approximation from one complete shared sample', async () => {
  const { calculateRating2Approx } = await import('../src/runtime/index.js');
  const sample = calculateRating2Approx({
    rounds: 24,
    kills: 20,
    assists: 5,
    deaths: 15,
    damage: 1800,
    kastRounds: 18,
  });
  expect(sample?.rating2Approx).toBeCloseTo(1.2569205, 8);
  expect(
    calculateRating2Approx({
      rounds: 0,
      kills: 0,
      assists: 0,
      deaths: 0,
      damage: 0,
      kastRounds: 0,
    }),
  ).toBeNull();
});

it('only uses bound program events and trades in game time for a completed round', async () => {
  const { projectPlayerStatistics } = await import('../src/runtime/index.js');
  const playerC = '76561198000000003';
  const frames = (seq: number, phase: 'freezetime' | 'live' | 'over') => {
    const base = frame(seq, seq, phase, 4, 60);
    return {
      ...base,
      telemetry: {
        ...base.telemetry,
        allPlayers: [
          {
            ...player(PLAYER_A, 60),
            side: 'CT' as const,
            state: { ...player(PLAYER_A, 60).state, health: phase === 'over' ? 0 : 100 },
          },
          {
            ...player(PLAYER_B, 30),
            side: 'T' as const,
            state: { ...player(PLAYER_B, 30).state, health: phase === 'over' ? 0 : 100 },
          },
          { ...player(playerC, 70), side: 'CT' as const },
        ],
      },
    };
  };
  let state = createInitialRuntimeState('trusted-events');
  state = accept(state, frames(1, 'freezetime')).state;
  state = accept(state, frames(2, 'live')).state;
  state = accept(state, frames(3, 'over')).state;
  const death = (seq: number, tick: number, victim: string, attacker: string) => ({
    kind: 'player-death' as const,
    cursor: {
      kind: 'cs2-cstv' as const,
      role: 'program' as const,
      generation: 2,
      sequence: seq,
      tick,
      ticksPerSecond: 64,
      observedAt: '2026-01-01T00:00:00Z',
      observedMonotonicMs: seq * 10000,
    },
    victim: { sourcePlayerId: victim },
    attacker: { sourcePlayerId: attacker },
    weapon: 'ak47',
    assistedFlash: false,
    headshot: false,
    penetratedObjects: 0,
    noScope: false,
    throughSmoke: false,
    attackerBlind: false,
    attackerInAir: false,
  });
  const events = {
    mapEpoch: state.map.epoch,
    roundNumberHint: 4,
    coverage: 'complete' as const,
    source: {
      role: 'program' as const,
      generation: 2,
      ticksPerSecond: 64,
      startTick: 90,
      endTick: 400,
    },
    deaths: [death(1, 100, PLAYER_A, PLAYER_B), death(2, 292, PLAYER_B, playerC)],
  };
  const noEvents = projectPlayerStatistics(
    state.playerStats,
    PLAYER_A,
    { kills: 99, assists: 0, deaths: 0 },
    1000,
  );
  expect(noEvents.completed.rating2Approx.value).toBeNull();
  expect(noEvents.scoreboard.kdRatio.reason).toBe('zero-denominator');
  const lookahead = {
    ...events,
    deaths: [
      { ...events.deaths[0]!, cursor: { ...events.deaths[0]!.cursor, role: 'lookahead' as const } },
    ],
  };
  expect(
    reduceRuntime(state, { kind: 'program-round-events', events: lookahead }, POLICY).disposition
      .kind,
  ).toBe('ignored');
  state = reduceRuntime(state, { kind: 'program-round-events', events }, POLICY).state;
  const result = projectPlayerStatistics(state.playerStats, PLAYER_A, { kills: 99 }, 1000);
  expect(result.completed.kastPercent.value).toBe(100);
  expect(result.completed.rating2Approx.basis.rounds).toBe(1);
  expect(result.completed.rating2Approx.value).toBeCloseTo(
    0.0073 * 100 - 0.5329 + 0.2372 * -0.41 + 0.0032 * 60 + 0.1587,
    8,
  );
});

it('settles missing final evidence only with the same terminal score and roster on a contiguous source', () => {
  const withScore = (obs: TelemetryObservation): TelemetryObservation => ({
    ...obs,
    telemetry: {
      ...obs.telemetry,
      map: { ...obs.telemetry.map!, sides: { ct: { score: 13 }, t: { score: 11 } } },
    },
  });
  let state = createInitialRuntimeState('terminal-settlement');
  state = accept(state, withScore(frame(1, 1, 'freezetime', 23, 0))).state;
  state = accept(state, withScore(frame(2, 2, 'live', 23, 80))).state;
  const over = withScore(frame(3, 3, 'over', 24, 80));
  const incomplete = {
    ...over,
    telemetry: {
      ...over.telemetry,
      allPlayers: over.telemetry.allPlayers!.map((p) =>
        p.sourcePlayerId === PLAYER_A
          ? {
              ...p,
              state: { roundTotalDamage: p.state!.roundTotalDamage!, money: p.state!.money! },
            }
          : p,
      ),
    },
  };
  state = accept(state, incomplete).state;
  expect(getPlayerCompletedAdr(state.playerStats, PLAYER_A)).toBeNull();
  const final = withScore(frame(4, 4, 'over', 24, 80));
  state = accept(state, {
    ...final,
    telemetry: { ...final.telemetry, map: { ...final.telemetry.map!, phase: 'gameover' } },
  }).state;
  expect(getPlayerCompletedAdr(state.playerStats, PLAYER_A)).toBe(80);
  expect(state.playerStats.countedCompletedRounds).toBe(1);
});

it('excludes an incomplete round without losing later valid ADR samples', async () => {
  const { projectPlayerStatistics } = await import('../src/runtime/index.js');
  let state = createInitialRuntimeState('adr-partial-rounds');
  const push = (
    sequence: number,
    phase: 'freezetime' | 'live' | 'over',
    round: number,
    damage: number,
    missingHealth = false,
  ) => {
    const obs = frame(sequence, sequence, phase, round, damage);
    const observation: TelemetryObservation = missingHealth
      ? {
          ...obs,
          telemetry: {
            ...obs.telemetry,
            allPlayers: obs.telemetry.allPlayers!.map((p) =>
              p.sourcePlayerId === PLAYER_B
                ? { ...p, state: { roundTotalDamage: p.state!.roundTotalDamage! } }
                : p,
            ),
          },
        }
      : obs;
    state = accept(state, observation).state;
  };
  const stats = () => projectPlayerStatistics(state.playerStats, PLAYER_A, undefined, null);
  push(1, 'freezetime', 0, 0);
  push(2, 'live', 0, 80);
  push(3, 'over', 0, 80);
  expect(stats().completed.adr).toMatchObject({
    value: 80,
    basis: { rounds: 1, coverage: 'complete' },
  });
  push(4, 'freezetime', 1, 0);
  push(5, 'live', 1, 20);
  push(6, 'over', 1, 20, true);
  expect(stats().completed.adr).toMatchObject({
    value: 80,
    basis: { rounds: 1, coverage: 'partial' },
  });
  push(7, 'freezetime', 2, 0);
  push(8, 'live', 2, 40);
  expect(stats().includingCurrentRound.adr).toMatchObject({
    value: 60,
    basis: { rounds: 2, coverage: 'partial' },
  });
  push(9, 'over', 2, 40);
  expect(stats().completed.adr).toMatchObject({
    value: 60,
    basis: { rounds: 2, coverage: 'partial' },
  });
  expect(getPlayerCompletedAdr(state.playerStats, PLAYER_A)).toBe(60);
  expect(getPlayerLiveAdr(state.playerStats, PLAYER_A)).toBe(60);
});

it('does not treat a missing current damage field as the earlier freezetime zero', async () => {
  const { projectPlayerStatistics } = await import('../src/runtime/index.js');
  let state = createInitialRuntimeState('adr-current-missing');
  state = accept(state, frame(1, 1, 'freezetime', 0, 0)).state;
  state = accept(state, frame(2, 2, 'live', 0, 80)).state;
  state = accept(state, frame(3, 3, 'over', 0, 80)).state;
  state = accept(state, frame(4, 4, 'freezetime', 1, 0)).state;
  const live = frame(5, 5, 'live', 1, 0);
  const withoutDamage: TelemetryObservation = {
    ...live,
    telemetry: {
      ...live.telemetry,
      allPlayers: live.telemetry.allPlayers!.map((p) =>
        p.sourcePlayerId === PLAYER_A ? { ...p, state: { health: 100, money: 4200 } } : p,
      ),
    },
  };
  state = accept(state, withoutDamage).state;
  const stats = projectPlayerStatistics(state.playerStats, PLAYER_A, undefined, null);
  expect(stats.currentRound.damage.value).toBeNull();
  expect(stats.includingCurrentRound.adr).toMatchObject({
    value: 80,
    basis: { rounds: 1, coverage: 'partial' },
  });
});
