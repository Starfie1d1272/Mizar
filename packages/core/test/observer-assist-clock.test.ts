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
function program(now: number, mapEpoch = 1): ObserverProgramView {
  return {
    cursor: {
      producerInstanceId: 'test',
      liveSessionId: 'session',
      runtimeSeq: now,
      programSourceGeneration: 1,
      programReceiveSequence: now,
      mapEpoch,
    },
    status: { telemetry: 'fresh', identity: 'matched' } as ObserverProgramView['status'],
    match: { matchId: 'match' },
    map: { name: 'de_test', roundNumber: 6 },
    clock: { phase: 'live' },
    coverage: { allPlayers: 'present' },
    players,
  };
}
function death(generation: number, sequence: number, now: number): PlayerDeathGameEvent {
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
      sourceMapExecution: 1,
      mapName: 'de_test',
      ticksPerSecond: 64,
      roundsCompleted: 6,
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

it('finishes the verified map tail after normal drain and fences a new map execution', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early, 1);
  timeline.consume(death(1, 1, 1000));
  const ended = { ...early, connected: false, fresh: false, normalDrain: true };
  expect(timeline.project(program(116000), settings, 116000, ended, 1).observer).toMatchObject({
    waitingReason: 'normal-drain',
    hints: [{ id: '1:1', remainingSeconds: 5 }],
  });
  const nextSource = { ...early, generation: 2 };
  expect(
    timeline.project(program(116500), settings, 116500, nextSource, 1, true).observer,
  ).toMatchObject({
    waitingReason: 'normal-drain',
    hints: [{ id: '1:1', remainingSeconds: 4.5 }],
  });
  timeline.consume(death(2, 1, 116600));
  expect(
    timeline.project(program(117000, 2), settings, 117000, nextSource, 1, true).observer?.hints,
  ).toEqual([]);
  expect(timeline.getDiagnostics()).toMatchObject({ acceptedDeaths: 1, staged: 1 });
  // The kill enters the display window only after Program confirms the new map execution.
  expect(
    timeline.project(program(117100, 2), settings, 117100, nextSource, 1).observer?.hints,
  ).toEqual([]);
  expect(timeline.getDiagnostics()).toMatchObject({
    acceptedDeaths: 2,
    staged: 0,
    stagedReleased: 1,
    pending: 1,
    ended: { 'program-context': 1 },
    endedAfterGeneration: { 'program-context': 1 },
  });
  expect(
    timeline.project(program(232000, 2), settings, 232000, nextSource, 1).observer?.hints,
  ).toMatchObject([{ id: '2:1' }]);
});

it('discards staged next-map kills when Program confirms another execution', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early, 1);
  const ended = { ...early, connected: false, fresh: false, normalDrain: true };
  timeline.project(program(116000), settings, 116000, ended, 1);
  const nextSource = { ...early, generation: 2 };
  timeline.project(program(116000), settings, 116000, nextSource, 1, true);
  timeline.consume(death(2, 1, 116600));
  const other = { ...program(117000, 2), map: { name: 'de_other', roundNumber: 1 } };
  timeline.project(other, settings, 117000, nextSource, 1, false);
  expect(timeline.getDiagnostics()).toMatchObject({
    acceptedDeaths: 0,
    staged: 0,
    discarded: { 'staged-map-mismatch': 1 },
  });
});

it('discards staged kills from an earlier execution of the same source and map', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early, 1);
  const ended = { ...early, connected: false, fresh: false, normalDrain: true };
  timeline.project(program(1000), settings, 1000, ended, 1);
  const nextSource = { ...early, generation: 2 };
  timeline.project(program(2000), settings, 2000, nextSource, 1, true);
  timeline.consume(death(2, 1, 2100));
  timeline.project(program(3000, 2), settings, 3000, nextSource, 2);
  expect(timeline.getDiagnostics()).toMatchObject({
    acceptedDeaths: 0,
    staged: 0,
    discarded: { 'staged-source-mismatch': 1 },
  });
});

it('schedules from receive time and preserves the due time of a shown event', () => {
  const timeline = new ObserverHintTimeline();
  const project = (now: number, delaySeconds = 120) =>
    timeline.project(program(now), { ...settings, delaySeconds }, now, early, 1).observer;
  project(0);
  timeline.consume(death(1, 1, 1000));
  timeline.consume(death(1, 1, 1000));
  expect(project(115999)?.hints).toEqual([]);
  expect(project(116000)?.hints.map(({ id, remainingSeconds }) => [id, remainingSeconds])).toEqual([
    ['1:1', 5],
  ]);
  expect(project(117000, 108)?.hints[0]?.remainingSeconds).toBe(4);
  const published = project(117000, 108)?.hints ?? [];
  timeline.recordPublished(published);
  timeline.recordPublished(published);
  expect(project(121000, 120)?.hints).toEqual([]);
  expect(timeline.getDiagnostics()).toMatchObject({
    acceptedDeaths: 1,
    enteredWindow: 1,
    generatedHints: 1,
    publishedHints: 1,
    ended: { expired: 1 },
    expiredBeforeWindow: 0,
    discarded: { duplicate: 1, expired: 1 },
    endedAfterGeneration: { expired: 1 },
  });
  timeline.consume(death(1, 2, 122000));
  expect(project(224999, 108)?.hints).toEqual([]);
  expect(project(225000, 108)?.hints[0]?.remainingSeconds).toBe(5);
  timeline.consume(death(1, 3, 226000));
  expect(project(335000, 108)?.hints).toEqual([]);
  expect(timeline.getDiagnostics()).toMatchObject({
    ended: { expired: 3 },
    expiredBeforeWindow: 1,
    endedAfterGeneration: { expired: 2 },
    pending: 0,
  });
});

it('retires a death before its window and does not replay it after a respawn', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early, 1);
  timeline.consume(death(1, 1, 1000));
  const duringDeath = program(109000);
  const withDeath = {
    ...duringDeath,
    players: duringDeath.players.map((p) =>
      p.sourcePlayerId === 'player-1' ? { ...p, lifeState: 'dead' as const } : p,
    ),
  };
  expect(timeline.project(withDeath, settings, 109000, early, 1).observer?.hints).toEqual([]);
  expect(timeline.project(program(116000), settings, 116000, early, 1).observer?.hints).toEqual([]);
  const nextRound = { ...program(118000), map: { name: 'de_test', roundNumber: 7 } };
  expect(timeline.project(nextRound, settings, 118000, early, 1).observer?.hints).toEqual([]);
  expect(timeline.getDiagnostics()).toMatchObject({
    acceptedDeaths: 1,
    enteredWindow: 0,
    generatedHints: 0,
    discarded: { 'program-already-past-event': 1 },
    endedAfterGeneration: {},
  });
});

it('adjusts the fixed deadline by measured local residence without moving the receipt boundary', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early, 1);
  const event = death(1, 1, 1000);
  timeline.consume({ ...event, cursor: { ...event.cursor, sourceArrivalMonotonicMs: 500 } });
  expect(timeline.project(program(115499), settings, 115499, early, 1).observer?.hints).toEqual([]);
  expect(
    timeline.project(program(115500), settings, 115500, early, 1).observer?.hints[0],
  ).toMatchObject({ remainingSeconds: 5 });
  expect(timeline.getDiagnostics().timingBasis).toEqual({ localResidence: 1, receipt: 0 });
});

it('fences a same-map restart until Program advances its map epoch', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early, 1);
  timeline.consume(death(1, 1, 1000));
  const reconnected = { ...early, generation: 2 };
  expect(timeline.project(program(116000), settings, 116000, reconnected, 0).observer?.state).toBe(
    'ready',
  );
  expect(
    timeline.project(program(116001), settings, 116001, reconnected, 1).observer?.waitingReason,
  ).toBe('source-execution-ahead');
  timeline.consume(death(2, 1, 116002));
  const freshOwner = { ...early, generation: 3 };
  expect(
    timeline.project(program(116003), settings, 116003, freshOwner, 0).observer?.waitingReason,
  ).toBe('source-execution-ahead');
  expect(
    timeline.project(program(116004, 2), settings, 116004, freshOwner, 0).observer?.hints,
  ).toEqual([]);
  timeline.consume(death(3, 1, 116005));
  expect(
    timeline.project(program(231005, 2), settings, 231005, freshOwner, 0).observer?.hints[0]?.id,
  ).toBe('3:1');
});

it('holds hints across pauses and stale input, expires them, and ignores public-source events', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early, 1);
  timeline.consume(death(1, 1, 1000));
  const publicEvent = death(1, 2, 2000);
  timeline.consume({ ...publicEvent, cursor: { ...publicEvent.cursor, role: 'program' } });
  const pause = { ...program(116000), clock: { phase: 'paused' as const } };
  expect(timeline.project(pause, settings, 116000, early, 1).observer).toMatchObject({
    state: 'paused',
    hints: [],
  });
  expect(
    timeline.project(program(117000), settings, 117000, { ...early, fresh: false }, 1).observer
      ?.hints,
  ).toEqual([]);
  expect(
    timeline.project(program(121000), { ...settings, delaySeconds: 130 }, 121000, early, 1).observer
      ?.hints,
  ).toEqual([]);
});

it('opens a short-delay window at reception when the requested lead is longer', () => {
  const timeline = new ObserverHintTimeline();
  const short = { ...settings, delaySeconds: 2 };
  timeline.project(program(0), short, 0, early, 1);
  timeline.consume(death(1, 1, 1000));
  expect(
    timeline.project(program(1000), short, 1000, early, 1).observer?.hints[0]?.remainingSeconds,
  ).toBe(2);
});

it('recovers from source-execution-ahead on the same mapEpoch when Program enters live after warmup', () => {
  const timeline = new ObserverHintTimeline();
  const warmupProgram = (now: number): ObserverProgramView => ({
    ...program(now, 2),
    map: { name: 'de_test', roundNumber: 0, phase: 'warmup' },
    clock: { phase: 'paused' },
  });
  const liveProgram = (now: number): ObserverProgramView => ({
    ...program(now, 2),
    map: { name: 'de_test', roundNumber: 0, phase: 'live' },
    clock: { phase: 'live' },
  });
  timeline.project(warmupProgram(0), settings, 0, early, 0);
  // Lookahead sees warmup -> live transition (mapExecution 0 -> 1) 120s ahead of Program.
  expect(
    timeline.project(warmupProgram(1000), settings, 1000, early, 1).observer?.waitingReason,
  ).toBe('source-execution-ahead');
  const roundZeroKill = {
    ...death(1, 1, 2000),
    cursor: { ...death(1, 1, 2000).cursor, roundsCompleted: 0, sourceMapExecution: 1 },
  };
  timeline.consume(roundZeroKill);
  // Still blocked while Program remains in warmup.
  expect(
    timeline.project(warmupProgram(117500), settings, 117500, early, 1).observer?.waitingReason,
  ).toBe('source-execution-ahead');
  // Program enters live on the same mapEpoch=2: fence clears and buffered kill surfaces on time.
  expect(liveProgram(118000).cursor.mapEpoch).toBe(2);
  expect(timeline.project(liveProgram(118000), settings, 118000, early, 1).observer).toMatchObject({
    state: 'ready',
    hints: [{ id: '1:1', remainingSeconds: 4 }],
  });
});

it('retains buffered kills across same-map, same-execution reconnects and drops them on round regression', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early, 1);
  timeline.consume(death(1, 1, 1000));
  // Transient disconnect (connecting with sameMap=false, generation=2) must not drop buffered 1:1.
  expect(
    timeline.project(
      program(50000),
      settings,
      50000,
      {
        connected: false,
        fresh: false,
        sameMap: false,
        generation: 2,
      },
      1,
    ).observer?.state,
  ).toBe('connecting');
  // Reconnect resumes on the same map and execution=1: 1:1 surfaces at its 120s window.
  expect(
    timeline.project(program(116000), settings, 116000, { ...early, generation: 2 }, 1).observer,
  ).toMatchObject({
    state: 'ready',
    hints: [{ id: '1:1', remainingSeconds: 5 }],
  });

  // If a reconnect actually jumped back to round 0 after round 6, fence and clear pre-restart kills.
  timeline.consume({
    ...death(2, 1, 117000),
    cursor: { ...death(2, 1, 117000).cursor, roundsCompleted: 6 },
  });
  timeline.consume({
    ...death(3, 1, 118000),
    cursor: { ...death(3, 1, 118000).cursor, roundsCompleted: 0 },
  });
  expect(
    timeline.project(program(118500), settings, 118500, { ...early, generation: 3 }, 1).observer
      ?.waitingReason,
  ).toBe('source-execution-ahead');
});

it('unlocks round-0 live execution fence when Program progresses past round 0 without warmup', () => {
  const timeline = new ObserverHintTimeline();
  const roundProgram = (now: number, roundNumber: number): ObserverProgramView => ({
    ...program(now, 2),
    map: { name: 'de_test', roundNumber, phase: 'live' },
    clock: { phase: 'live' },
  });
  timeline.project(roundProgram(0, 0), settings, 0, early, 0);
  timeline.consume({
    ...death(1, 1, 1000),
    cursor: { ...death(1, 1, 1000).cursor, roundsCompleted: 0, sourceMapExecution: 0 },
  });
  // mp_restartgame during live round 0 increments lookahead execution 0 -> 1 without warmup.
  expect(
    timeline.project(roundProgram(2000, 0), settings, 2000, early, 1).observer?.waitingReason,
  ).toBe('source-execution-ahead');
  timeline.consume({
    ...death(1, 2, 3000),
    cursor: { ...death(1, 2, 3000).cursor, roundsCompleted: 1, sourceMapExecution: 1 },
  });
  // Once Program advances to round 1, it is unambiguously on the restarted execution.
  expect(
    timeline.project(roundProgram(119000, 1), settings, 119000, early, 1).observer,
  ).toMatchObject({
    state: 'ready',
    hints: [{ id: '1:2', remainingSeconds: 4 }],
  });
});
