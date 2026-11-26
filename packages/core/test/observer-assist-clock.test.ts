import { expect, it } from 'vitest';
import {
  ObserverHintTimeline,
  type ObserverProgramView,
} from '../src/projection/observer-assist.js';
import type { PlayerDeathGameEvent } from '../src/game-events/index.js';

const settings = { enabled: true, leadSeconds: 5, delaySeconds: 120 };
const players = Array.from({ length: 10 }, (_, i) => ({
  sourcePlayerId: `player-${i}`,
  lineupEvidence: 'current' as const,
  lifeState: 'alive' as const,
  displayName: `Player ${i}`,
  observerSlot: i,
}));

function program(
  now: number,
  options: { mapEpoch?: number; mapName?: string; roundNumber?: number; phase?: string } = {},
): ObserverProgramView {
  return {
    cursor: {
      producerInstanceId: 'test',
      liveSessionId: 'session',
      runtimeSeq: now,
      programSourceGeneration: 1,
      programReceiveSequence: now,
      mapEpoch: options.mapEpoch ?? 1,
    },
    status: { telemetry: 'fresh', identity: 'matched' } as ObserverProgramView['status'],
    match: { matchId: 'match' },
    map: { name: options.mapName ?? 'de_test', roundNumber: options.roundNumber ?? 6 },
    clock: {
      phase: (options.phase ?? 'live') as NonNullable<ObserverProgramView['clock']>['phase'],
    },
    coverage: { allPlayers: 'present' },
    players,
  };
}

function death(
  generation: number,
  sequence: number,
  now: number,
  options: { mapName?: string; roundsCompleted?: number; sourceArrivalMonotonicMs?: number } = {},
): PlayerDeathGameEvent {
  return {
    kind: 'player-death',
    cursor: {
      kind: 'cs2-cstv',
      role: 'lookahead',
      generation,
      sequence,
      tick: sequence,
      observedAt: '2026-10-30T00:00:00Z',
      observedMonotonicMs: now,
      ...(options.sourceArrivalMonotonicMs === undefined
        ? {}
        : { sourceArrivalMonotonicMs: options.sourceArrivalMonotonicMs }),
      mapName: options.mapName ?? 'de_test',
      ticksPerSecond: 64,
      roundsCompleted: options.roundsCompleted ?? 6,
    },
    attacker: { sourcePlayerId: 'player-0' },
    victim: { sourcePlayerId: 'player-1' },
    weapon: 'ak47',
    assistedFlash: false,
    headshot: false,
    penetratedObjects: 0,
    noScope: false,
    throughSmoke: false,
    attackerBlind: false,
    attackerInAir: false,
  };
}

const early = { connected: true, fresh: true, sameMap: true, generation: 1 };

it('displays lookahead hints with local residence compensation during lead window', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early);
  // Observed at 1500ms with 500ms residence -> sourceArrivalMonotonicMs = 1000ms -> due at 121000ms.
  timeline.consume(death(1, 1, 1500, { sourceArrivalMonotonicMs: 1000 }));
  expect(timeline.project(program(115000), settings, 115000, early).observer).toMatchObject({
    state: 'ready',
    waitingReason: 'buffering',
    hints: [],
  });
  expect(timeline.project(program(116500), settings, 116500, early).observer).toMatchObject({
    state: 'ready',
    waitingReason: null,
    hints: [
      {
        id: '0:1:1',
        remainingSeconds: 4.5,
        attacker: { name: 'Player 0', observerSlot: 0 },
        victim: { name: 'Player 1', observerSlot: 1 },
      },
    ],
  });
  expect(timeline.getDiagnostics()).toMatchObject({
    receivedEvents: 1,
    acceptedDeaths: 1,
    pending: 1,
    timingBasis: { localResidence: 1, receipt: 0 },
  });
});

it('continues showing cached hints when early source disconnects, fails, or ends', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early);
  timeline.consume(death(1, 1, 1000));

  for (const source of [
    { connected: false, fresh: false, sameMap: true, generation: 1, state: 'reconnecting' },
    { connected: false, fresh: false, sameMap: true, generation: 1, state: 'failed' },
    { connected: false, fresh: false, sameMap: true, generation: 1, state: 'ended' },
  ]) {
    expect(timeline.project(program(116500), settings, 116500, source).observer).toMatchObject({
      state: 'ready',
      hints: [{ id: '0:1:1', remainingSeconds: 4.5 }],
    });
  }
});

it('retains cached kills across same-map reconnect and accepts new kills', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early);
  timeline.consume(death(1, 1, 1000));

  const reconnected = { ...early, generation: 2 };
  timeline.project(program(5000), settings, 5000, reconnected);
  timeline.consume(death(2, 1, 6000));

  expect(
    timeline.project(program(116500), settings, 116500, reconnected).observer?.hints,
  ).toMatchObject([{ id: '0:1:1' }]);
  expect(
    timeline.project(program(121500), settings, 121500, reconnected).observer?.hints,
  ).toMatchObject([{ id: '0:2:1' }]);
});

it('relaxes 10-player requirement when attacker and victim are matched', () => {
  const timeline = new ObserverHintTimeline();
  const partialProgram: ObserverProgramView = {
    ...program(0),
    coverage: { allPlayers: 'degraded' },
    players: [
      { ...players[0]!, observerSlot: 1 },
      { ...players[1]!, observerSlot: 1 }, // conflicting slot -> null
    ],
  };
  timeline.project(partialProgram, settings, 0, early);
  timeline.consume(death(1, 1, 1000));
  expect(
    timeline.project(
      { ...partialProgram, cursor: { ...partialProgram.cursor, runtimeSeq: 116500 } },
      settings,
      116500,
      early,
    ).observer?.hints,
  ).toEqual([
    {
      id: '0:1:1',
      remainingSeconds: 4.5,
      attacker: { name: 'Player 0', observerSlot: null },
      victim: { name: 'Player 1', observerSlot: null },
    },
  ]);
});

it('clears buffered kills on resetForMap', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0, { roundNumber: 6 }), settings, 0, early);
  timeline.consume(death(1, 1, 1000, { roundsCompleted: 6 }));
  expect(timeline.getDiagnostics().pending).toBe(1);

  timeline.resetForMap(2000);
  expect(timeline.getDiagnostics().pending).toBe(0);
});

it('retains kill when player is temporarily missing and accepts lower generation after resetForMap', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early);
  timeline.consume(death(5, 20, 1000));

  // Temporarily missing victim: skipped this frame, NOT permanently dropped
  const missingVictim: ObserverProgramView = {
    ...program(116500),
    players: players.filter((p) => p.sourcePlayerId !== 'player-1'),
  };
  expect(timeline.project(missingVictim, settings, 116500, early).observer?.hints).toEqual([]);
  expect(timeline.getDiagnostics().pending).toBe(1);

  // Player reappears on next frame -> hint is displayed
  expect(timeline.project(program(116600), settings, 116600, early).observer?.hints).toMatchObject([
    { id: '0:5:20' },
  ]);

  // Switch to map 2 with a fresh observer process starting at generation 1, sequence 1
  timeline.resetForMap(117000);
  timeline.consume(death(1, 1, 117500, { mapName: 'de_mirage', roundsCompleted: 0 }));
  expect(
    timeline.project(
      program(233000, { mapEpoch: 2, mapName: 'de_mirage', roundNumber: 0 }),
      settings,
      233000,
      { connected: true, fresh: true, sameMap: true, generation: 1 },
    ).observer?.hints,
  ).toMatchObject([{ id: '1:1:1' }]);
});

it('hides hints when disabled or when program match is paused', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early);
  timeline.consume(death(1, 1, 1000));

  expect(
    timeline.project(program(116500, { phase: 'paused' }), settings, 116500, early).observer,
  ).toMatchObject({
    state: 'paused',
    hints: [],
  });

  expect(
    timeline.project(program(116500), { ...settings, enabled: false }, 116500, early),
  ).toMatchObject({
    availability: 'unavailable',
  });
  expect(timeline.getDiagnostics().pending).toBe(0);
});
