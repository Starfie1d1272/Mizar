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

it('finishes buffered hints after normal drain (1038) and enters waiting-next-map once drained', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early, 1);
  timeline.consume(death(1, 1, 1000));
  const ended = { ...early, connected: false, fresh: false, normalDrain: true };
  expect(timeline.project(program(116000), settings, 116000, ended, 1).observer).toMatchObject({
    state: 'ready',
    waitingReason: 'normal-drain',
    hints: [{ id: '1:1', remainingSeconds: 5 }],
  });
  expect(
    timeline.project(program(116500), settings, 116500, ended, 1, true).observer,
  ).toMatchObject({
    state: 'ready',
    waitingReason: 'normal-drain',
    hints: [{ id: '1:1', remainingSeconds: 4.5 }],
  });
  // Once the buffered kill expires, waitingForNextMap surfaces connecting/waiting-next-map.
  expect(
    timeline.project(program(121000), settings, 121000, ended, 1, true).observer,
  ).toMatchObject({
    state: 'connecting',
    waitingReason: 'waiting-next-map',
    hints: [],
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

it('continues projecting buffered kills during transient disconnect or stale source, and hides on pause', () => {
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
    timeline.project(
      program(117000),
      settings,
      117000,
      { ...early, connected: false, fresh: false },
      1,
    ).observer,
  ).toMatchObject({
    state: 'ready',
    hints: [{ id: '1:1', remainingSeconds: 4 }],
  });
  expect(
    timeline.project(program(118000), settings, 118000, { ...early, fresh: false }, 1).observer,
  ).toMatchObject({
    state: 'ready',
    hints: [{ id: '1:1', remainingSeconds: 3 }],
  });
  // After the buffered kill expires, empty buffer reports source connection/freshness state.
  expect(
    timeline.project(
      program(121000),
      settings,
      121000,
      { ...early, connected: false, fresh: false },
      1,
    ).observer,
  ).toMatchObject({
    state: 'connecting',
    waitingReason: 'source-disconnected',
    hints: [],
  });
  expect(
    timeline.project(program(121100), settings, 121100, { ...early, fresh: false }, 1).observer,
  ).toMatchObject({
    state: 'unavailable',
    waitingReason: 'source-stale',
    hints: [],
  });
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

it('retains buffered kills across same-map reconnects and clears them on round regression or execution change', () => {
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
    ).observer,
  ).toMatchObject({
    state: 'ready',
    waitingReason: 'buffering',
    hints: [],
  });
  // Reconnect resumes on the same map and execution=1: 1:1 surfaces at its 120s window.
  expect(
    timeline.project(program(116000), settings, 116000, { ...early, generation: 2 }, 1).observer,
  ).toMatchObject({
    state: 'ready',
    hints: [{ id: '1:1', remainingSeconds: 5 }],
  });

  // Same-generation round regression (round 6 -> round 0) clears pre-restart kills immediately.
  timeline.consume({
    ...death(2, 1, 117000),
    cursor: { ...death(2, 1, 117000).cursor, roundsCompleted: 6 },
  });
  timeline.consume({
    ...death(2, 2, 118000),
    cursor: { ...death(2, 2, 118000).cursor, roundsCompleted: 0 },
  });
  expect(timeline.getDiagnostics().ended).toMatchObject({ 'source-execution': 2 });

  // Execution jump in project() (gen 2 exec 1 -> gen 3 exec 2) drops old execution kills.
  expect(
    timeline.project(program(120000), settings, 120000, { ...early, generation: 3 }, 2).observer,
  ).toMatchObject({
    state: 'ready',
    waitingReason: 'waiting-event',
    hints: [],
  });
  expect(timeline.getDiagnostics().ended).toMatchObject({ 'source-execution': 3 });
});

it('clears buffered kills on map change or resetForMap()', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(0), settings, 0, early, 1);
  timeline.consume(death(1, 1, 1000));
  timeline.resetForMap(2000);
  expect(timeline.getDiagnostics()).toMatchObject({
    pending: 0,
    ended: { 'map-connection': 1 },
  });

  timeline.consume(death(1, 2, 3000));
  const nextMap = { ...program(4000, 2), map: { name: 'de_other', roundNumber: 1 } };
  timeline.project(nextMap, settings, 4000, { ...early, mapName: 'de_other' }, 1);
  expect(timeline.getDiagnostics()).toMatchObject({
    pending: 0,
    ended: { 'map-connection': 1, 'program-context': 1 },
  });
});

it('keeps generation/execution continuity invariant whether consume() or project() observes reconnect first', () => {
  const runOrder = (consumeFirst: boolean) => {
    const timeline = new ObserverHintTimeline();
    timeline.project(program(0), settings, 0, early, 1);
    timeline.consume(death(1, 1, 1000));
    const reconnected = { ...early, generation: 2 };
    const newKill = {
      ...death(2, 1, 50_000),
      cursor: { ...death(2, 1, 50_000).cursor, sourceMapExecution: 0 },
    };
    if (consumeFirst) {
      timeline.consume(newKill);
      timeline.project(program(116000), settings, 116000, reconnected, 0);
    } else {
      timeline.project(program(50_000), settings, 50_000, reconnected, 0);
      timeline.consume(newKill);
    }
    return {
      at116: timeline.project(program(116000), settings, 116000, reconnected, 0).observer,
      at165: timeline.project(program(165000), settings, 165000, reconnected, 0).observer,
    };
  };
  const projectFirst = runOrder(false);
  const consumeFirst = runOrder(true);
  expect(consumeFirst.at116?.waitingReason).toBe(projectFirst.at116?.waitingReason);
  expect(consumeFirst.at116?.hints.map((h) => h.id)).toEqual(['1:1']);
  expect(projectFirst.at116?.hints.map((h) => h.id)).toEqual(['1:1']);
  expect(consumeFirst.at165?.hints.map((h) => h.id)).toEqual(['2:1']);
  expect(projectFirst.at165?.hints.map((h) => h.id)).toEqual(['2:1']);
});
