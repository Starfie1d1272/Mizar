import { describe, expect, it } from 'vitest';
import {
  ObserverHintTimeline,
  type ObserverProgramView,
} from '../src/projection/observer-assist.js';
import type { PlayerDeathGameEvent } from '../src/game-events/index.js';
const settings = { enabled: true, leadSeconds: 7 };
const source = { connected: true, generation: 1, fresh: true };
function program(sequence: number, dead: number[] = []): ObserverProgramView {
  return {
    cursor: {
      producerInstanceId: 'test',
      liveSessionId: 'live',
      runtimeSeq: sequence,
      programSourceGeneration: 1,
      programReceiveSequence: sequence,
      mapEpoch: 1,
    },
    status: { telemetry: 'fresh', context: 'fresh', identity: 'matched' },
    match: { matchId: 'match' },
    map: { name: 'de_mirage' },
    clock: { phase: 'live' },
    coverage: { allPlayers: 'present' },
    players: Array.from({ length: 10 }, (_, i) => ({
      sourcePlayerId: String(i),
      displayName: `Player ${i}`,
      observerSlot: i,
      lineupEvidence: 'current',
      lifeState: dead.includes(i) ? 'dead' : 'alive',
    })),
  };
}
function kill(sequence: number, victim: number, time: number): PlayerDeathGameEvent {
  return {
    kind: 'player-death',
    cursor: {
      kind: 'cs2-cstv',
      role: 'lookahead',
      generation: 1,
      sequence,
      tick: (time * 64) / 1000,
      ticksPerSecond: 64,
      observedAt: '2026-10-25T00:00:00Z',
      observedMonotonicMs: time,
      mapName: 'de_mirage',
    },
    victim: { sourceUserId: victim, sourcePlayerId: String(victim) },
    attacker: { sourceUserId: 3, sourcePlayerId: '3' },
    weapon: 'ak47',
    assistedFlash: false,
    headshot: false,
    penetratedObjects: 0,
    noScope: false,
    throughSmoke: false,
    attackerBlind: false,
    attackerInAir: false,
    distance: 1,
    damageHealth: 100,
    damageArmor: 0,
    hitgroup: 1,
  };
}
function aligned() {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, -7000, source);
  for (let i = 0; i <= 7; i++) {
    const received = -6000 + i * 1000;
    timeline.project(program(1), settings, received, source, received, {
      source: { received, remaining: 100 - i, round: 3, generation: 1 },
    });
  }
  for (let i = 0; i <= 7; i++) {
    const received = 114000 + i * 1000;
    timeline.project(program(1), settings, received, source, received, {
      program: { received, remaining: 100 - i, round: 3, generation: 1 },
    });
  }
  timeline.consume(kill(1, 8, 1000));
  timeline.consume(kill(10, 6, 1000));
  timeline.consume(kill(2, 9, 2000));
  timeline.consume(kill(3, 7, 10000));
  expect(timeline.project(program(2, [6, 8]), settings, 121000, source).observer?.state).toBe(
    'ready',
  );
  expect(
    timeline.project(program(3, [8, 9]), settings, 122000, source).observer?.measuredDelaySeconds,
  ).toBe(120);
  return timeline;
}
describe('private observer hints against Program', () => {
  it('removes a confirmed death before its estimated due time while retaining its anchor', () => {
    const timeline = aligned();
    const event = kill(3, 7, 10000);
    timeline.consume(event);
    expect(
      timeline.project(program(3, [8, 9]), settings, 128000, source).observer?.hints,
    ).toMatchObject([{ id: '1:3', remainingSeconds: 2 }]);

    const confirmed = program(4, [7, 8, 9]);
    const result = timeline.project(confirmed, settings, 129000, source);
    expect(result.observer?.hints).toEqual([]);
    expect(result.observer?.state).toBe('ready');
    expect(result.observer?.measuredDelaySeconds).toBe(120);

    // Duplicate delivery and repeated projection cannot reintroduce the matched event.
    timeline.consume(event);
    expect(timeline.project(confirmed, settings, 129200, source).observer?.hints).toEqual([]);
    expect(timeline.project(program(5, [8, 9]), settings, 129500, source).observer?.hints).toEqual(
      [],
    );
    timeline.consume(kill(4, 6, 20000));
    expect(
      timeline.project(program(5, [8, 9]), settings, 133000, source).observer?.hints,
    ).toMatchObject([{ id: '1:4', remainingSeconds: 7 }]);
  });
  it('orders buffered events by source time and excludes late events at or past zero', () => {
    const timeline = aligned();
    timeline.consume(kill(5, 5, 20000));
    timeline.consume(kill(4, 6, 15000));
    timeline.consume(kill(4, 6, 15000));
    timeline.consume(kill(6, 4, 9000));
    const frame = program(3, [8, 9]);
    expect(timeline.project(frame, settings, 133000, source).observer?.hints).toMatchObject([
      { id: '1:4', remainingSeconds: 2 },
      { id: '1:5', remainingSeconds: 7 },
    ]);
    expect(timeline.project(frame, settings, 135000, source).observer?.hints).toMatchObject([
      { id: '1:5', remainingSeconds: 5 },
    ]);
    expect(timeline.project(frame, settings, 140000, source).observer?.hints).toEqual([]);
  });
  it.each(['paused', 'timeout_ct', 'timeout_t'] as const)(
    'keeps the timeline through %s and resume',
    (phase) => {
      const timeline = aligned();
      const paused = { ...program(4, [8, 9]), clock: { phase } };
      expect(timeline.project(paused, settings, 123000, source).observer).toMatchObject({
        state: 'ready',
        measuredDelaySeconds: 120,
        hints: [{ id: '1:3', remainingSeconds: 7 }],
      });
      timeline.consume(kill(4, 6, 20000));
      expect(
        timeline.project(program(5, [8, 9]), settings, 133000, source).observer?.hints,
      ).toMatchObject([{ id: '1:4', remainingSeconds: 7 }]);
    },
  );
  it('shows Program slots seven seconds ahead and removes hints at the event boundary', () => {
    const timeline = aligned(),
      frame = program(3, [8, 9]);
    expect(
      timeline
        .project(frame, settings, 122999, source)
        .observer?.hints.filter((h) => h.victim.observerSlot === 7),
    ).toEqual([]);
    const hint = timeline
      .project(frame, settings, 123000, source)
      .observer?.hints.find((h) => h.victim.observerSlot === 7);
    expect(hint).toMatchObject({
      remainingSeconds: 7,
      attacker: { observerSlot: 3, name: 'Player 3' },
      victim: { observerSlot: 7 },
    });
    expect(
      timeline.project(frame, settings, 129999, source).observer?.hints[0]?.remainingSeconds,
    ).toBeCloseTo(0.001);
    expect(timeline.project(frame, settings, 130000, source).observer?.hints).toEqual([]);
    expect(
      timeline.project(program(4, [7, 8, 9]), settings, 133000, source).observer?.hints,
    ).toEqual([]);
  });
  it('retains wall-clock delay when the game tick clock pauses', () => {
    const timeline = aligned();
    const event = kill(4, 6, 20000);
    timeline.consume({ ...event, cursor: { ...event.cursor, tick: 11 * 64 } });
    const hints = timeline.project(program(3, [8, 9]), settings, 133000, source).observer?.hints;
    expect(hints?.find((h) => h.victim.observerSlot === 6)?.remainingSeconds).toBe(7);
  });
  it('clears boundaries and waits for fresh events after setting, map and source changes', () => {
    const cases = [
      (p: ObserverProgramView) => ({ ...p, map: { name: 'de_nuke' } }),
      (p: ObserverProgramView) => ({ ...p, match: { matchId: 'next' } }),
      (p: ObserverProgramView) => ({ ...p, cursor: { ...p.cursor, liveSessionId: 'next' } }),
      (p: ObserverProgramView) => ({ ...p, cursor: { ...p.cursor, mapEpoch: 2 } }),
    ];
    for (const change of cases) {
      const reset = aligned();
      expect(
        reset.project(change(program(3, [8, 9])), settings, 123000, source).observer?.hints,
      ).toEqual([]);
      expect(reset.project(program(4, [8, 9]), settings, 123200, source).observer).toMatchObject({
        state: 'unavailable',
        hints: [],
      });
    }
    const timeline = aligned();
    expect(
      timeline.project(program(3, [8, 9]), settings, 123000, source).observer?.hints,
    ).toMatchObject([{ id: '1:3' }]);
    expect(
      timeline.project(program(3, [8, 9]), settings, 124000, { ...source, connected: false })
        .observer?.state,
    ).toBe('connecting');
    const reconnected = {
      ...program(4, [8, 9]),
      cursor: { ...program(4).cursor, programSourceGeneration: 2 },
    };
    expect(
      timeline.project(reconnected, settings, 125000, { ...source, generation: 2 }).observer?.hints,
    ).toMatchObject([{ id: '1:3', remainingSeconds: 5 }]);
    timeline.consume({
      ...kill(3, 6, 20000),
      cursor: { ...kill(3, 6, 20000).cursor, generation: 2 },
    });
    expect(
      timeline.project(reconnected, settings, 133000, { ...source, generation: 2 }).observer?.hints,
    ).toMatchObject([{ id: '2:3' }]);
    expect(
      aligned().project(program(3, [8, 9]), { ...settings, enabled: false }, 123000, source)
        .observer,
    ).toBeUndefined();
  });
  it('requires complete current identities and labels ambiguous slots without inventing keys', () => {
    const timeline = aligned(),
      frame = program(3, [8, 9]);
    const duplicateSlot = {
      ...frame,
      players: frame.players.map((p) => ({
        ...p,
        observerSlot: p.sourcePlayerId === '4' ? 3 : p.observerSlot,
      })),
    };
    expect(
      timeline
        .project(duplicateSlot, settings, 123000, source)
        .observer?.hints.find((h) => h.victim.observerSlot === 7)?.attacker.observerSlot,
    ).toBeNull();
    expect(
      timeline.project({ ...frame, players: frame.players.slice(0, 9) }, settings, 123000, source)
        .observer?.state,
    ).toBe('unavailable');
  });
  it('keeps unknown health from becoming a death anchor and expires old measurement', () => {
    const timeline = new ObserverHintTimeline();
    timeline.project(program(1), settings, 0, source);
    timeline.consume(kill(1, 8, 1000));
    timeline.consume(kill(2, 9, 2000));
    const unknown = program(2, [8]);
    timeline.project(
      {
        ...unknown,
        players: unknown.players.map((p) =>
          p.sourcePlayerId === '8' ? { ...p, lifeState: 'unknown' } : p,
        ),
      },
      settings,
      121000,
      source,
    );
    expect(timeline.project(program(3, [8, 9]), settings, 122000, source).observer?.state).toBe(
      'unavailable',
    );
    expect(aligned().project(program(3, [8, 9]), settings, 303000, source).observer?.state).toBe(
      'unavailable',
    );
  });
});

it('waits for clock calibration without guessing a countdown', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  timeline.consume(kill(1, 7, 10000));
  expect(timeline.project(program(2), settings, 123000, source).observer).toMatchObject({
    state: 'unavailable',
    waitingReason: 'calibration-pending',
    effectiveDelaySeconds: null,
    hints: [],
  });
});

it('reports counts and explicit blocks without identity or raw event payloads', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  timeline.consume({ ...kill(1, 7, 1000), attacker: { sourceUserId: 3 } });
  timeline.consume(kill(2, 7, 2000));
  timeline.project(program(1), settings, 3000, source);
  expect(timeline.getDiagnostics()).toMatchObject({
    eventCounts: { 'player-death': 2 },
    acceptedDeaths: 1,
    discarded: { 'missing-identity': 1 },
    pending: 1,
    anchors: 0,
    nextWindowInMs: null,
  });
  expect(
    timeline.project(program(1), settings, 4000, { ...source, fresh: false }).observer
      ?.waitingReason,
  ).toBe('source-stale');
  timeline.project(program(1), settings, 5000, { ...source, generation: 2 });
  timeline.consume(kill(3, 7, 6000));
  expect(timeline.getDiagnostics()).toMatchObject({
    buffered: 1,
    discarded: { 'old-generation': 1 },
  });
  expect(JSON.stringify(timeline.getDiagnostics())).not.toMatch(
    /sourcePlayerId|Player |weapon|steam|password/i,
  );
  for (let index = 0; index < 70; index++) timeline.consume(kill(index + 4, 7, 7000 + index));
  expect(
    Object.values(timeline.getDiagnostics().eventCounts).reduce((sum, count) => sum + count, 0),
  ).toBe(64);
});

function feedSourceClock(
  timeline: ObserverHintTimeline,
  start: number,
  round: number,
  generation = 1,
  execution = 0,
) {
  for (let i = 0; i <= 8; i++) {
    const received = start + i * 1000;
    timeline.project(program(1), settings, received, source, received, {
      sourceExecution: execution,
      source: { round, generation, received, remaining: 100 - i },
    });
  }
}
function feedProgramClock(
  timeline: ObserverHintTimeline,
  start: number,
  round: number,
  execution = 0,
) {
  for (let i = 0; i <= 8; i++) {
    const received = start + i * 1000;
    timeline.project(program(1), settings, received, source, received, {
      sourceExecution: execution,
      program: { round, generation: 1, received, remaining: 100 - i },
    });
  }
}

it.each([119000, 121000, 150000])('calibrates from a stable clock sequence at %i ms', (delay) => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  feedSourceClock(timeline, 1000, 3);
  feedProgramClock(timeline, delay + 1000, 3);
  expect(timeline.getDiagnostics().calibration).toMatchObject({
    state: 'measured',
    effectiveDelayMs: delay,
  });
});

it('does not calibrate from deaths when the source has no clock', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  for (const [seq, victim, time] of [
    [1, 8, 1000],
    [2, 9, 2000],
    [3, 6, 3000],
  ] as const)
    timeline.consume(kill(seq, victim, time));
  timeline.project(program(2, [8]), settings, 121000, source);
  timeline.project(program(3, [8, 9]), settings, 122000, source);
  const result = timeline.project(program(4, [6, 8, 9]), settings, 123000, source);
  expect(result.observer).toMatchObject({
    calibrationState: 'uncalibrated',
    measuredDelaySeconds: null,
    effectiveDelaySeconds: null,
  });
});

it('does not pair clocks from different raw rounds', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  feedSourceClock(timeline, 1000, 3);
  feedProgramClock(timeline, 121000, 4);
  expect(timeline.getDiagnostics().calibration.state).toBe('uncalibrated');
});

it('rejects multiple plausible source segments for the same remaining value', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  feedSourceClock(timeline, 1000, 3);
  feedSourceClock(timeline, 21000, 3, 2);
  feedProgramClock(timeline, 121000, 3);
  expect(timeline.getDiagnostics().calibration.state).toBe('uncalibrated');
});

it('fences source execution changes until the program execution changes', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  feedSourceClock(timeline, 1000, 3, 1, 0);
  feedSourceClock(timeline, 21000, 3, 1, 1);
  feedProgramClock(timeline, 141000, 3, 1);
  expect(timeline.getDiagnostics().calibration.state).toBe('uncalibrated');
  timeline.consume(kill(2, 7, 23000));
  const result = timeline.project(program(2), settings, 140000, source, 140000, {
    sourceExecution: 1,
  });
  expect(result.observer).toMatchObject({
    state: 'unavailable',
    waitingReason: 'source-execution-ahead',
    hints: [],
  });
  expect(timeline.getDiagnostics().buffered).toBe(1);
});

it('preserves buffered events and the measured delay through a brief stale interval', () => {
  const timeline = aligned();
  expect(
    timeline.project(program(3, [8, 9]), settings, 123000, { ...source, fresh: false }).observer
      ?.state,
  ).toBe('unavailable');
  expect(timeline.project(program(4, [8, 9]), settings, 125000, source).observer).toMatchObject({
    state: 'ready',
    measuredDelaySeconds: 120,
    hints: [{ id: '1:3', remainingSeconds: 5 }],
  });
});

it.each(['stale', 'disconnected'] as const)(
  'reacquires after continuous projections during a long %s gap',
  (gap) => {
    const timeline = aligned();
    timeline.project(program(4), settings, 130000, { ...source, lastReceiveMonotonicMs: 130000 });
    timeline.project(program(5), settings, 140000, { ...source, lastReceiveMonotonicMs: 140000 });
    expect(timeline.getDiagnostics().calibration.continuity).toBe('observed');
    timeline.consume(kill(4, 5, 145000));
    for (let now = 140200; now <= 200000; now += 200) {
      timeline.project(program(5), settings, now, {
        ...source,
        connected: gap !== 'disconnected',
        fresh: gap !== 'stale',
        lastReceiveMonotonicMs: 140000,
      });
    }
    const resumed = timeline.project(program(6), settings, 200200, {
      ...source,
      lastReceiveMonotonicMs: 200200,
    });
    expect(resumed.observer).toMatchObject({
      state: 'unavailable',
      calibrationState: 'reacquiring',
      effectiveDelaySeconds: 120,
      hints: [],
    });
    expect(timeline.getDiagnostics()).toMatchObject({
      buffered: 5,
      calibration: { continuity: 'lost', effectiveDelayMs: 120000 },
    });
  },
);

it('keeps a calibrated offset through a long quiet period when both sources keep advancing', () => {
  const timeline = aligned();
  let sequence = 5;
  const healthy = (now: number) =>
    timeline.project(program(sequence++), settings, now, {
      ...source,
      lastReceiveMonotonicMs: now,
      receiveAgeMs: 0,
    });
  for (let now = 130000; now <= 300000; now += 10000) healthy(now);
  expect(healthy(304000).observer).toMatchObject({
    state: 'ready',
    calibrationState: 'held',
    effectiveDelaySeconds: 120,
  });
  timeline.consume(kill(4, 7, 305000));
  for (let now = 310000; now <= 410000; now += 10000) healthy(now);
  expect(healthy(418000).observer).toMatchObject({
    state: 'ready',
    calibrationState: 'held',
    hints: [{ id: '1:4', remainingSeconds: 7 }],
  });
  expect(timeline.getDiagnostics().calibration.continuity).toBe('observed');
});

it('stops trusting the estimate when a supposedly fresh source cursor stops progressing', () => {
  const timeline = aligned();
  timeline.project(program(4), settings, 130000, { ...source, lastReceiveMonotonicMs: 130000 });
  timeline.project(program(5), settings, 140000, { ...source, lastReceiveMonotonicMs: 140000 });
  const stopped = timeline.project(program(6), settings, 171000, {
    ...source,
    lastReceiveMonotonicMs: 140000,
  });
  expect(stopped.observer).toMatchObject({ state: 'unavailable', calibrationState: 'reacquiring' });
});

it('does not restore trust just because health cursors resume after loss', () => {
  const timeline = aligned();
  expect(timeline.project(program(4), settings, 304000, source).observer?.state).toBe(
    'unavailable',
  );
  timeline.project(program(5), settings, 305000, { ...source, lastReceiveMonotonicMs: 305000 });
  expect(
    timeline.project(program(6), settings, 315000, { ...source, lastReceiveMonotonicMs: 315000 })
      .observer,
  ).toMatchObject({ state: 'unavailable', calibrationState: 'reacquiring' });
});

it('measures only continuous matching raw round clocks, retaining the configured fallback', () => {
  const timeline = new ObserverHintTimeline();
  const point = (received: number, remaining: number, round = 3) => ({
    received,
    remaining,
    round,
    generation: 1,
  });
  timeline.project(program(1), settings, 0, source);
  for (let i = 0; i <= 12; i++) {
    timeline.project(program(1), settings, i * 1000 + 1000, source, 0, {
      source: point(i * 1000 + 1000, 100 - i),
    });
  }
  expect(timeline.getDiagnostics().calibration.state).toBe('uncalibrated');
  for (let i = 0; i <= 9; i++) {
    const now = 121000 + i * 1000;
    timeline.project(program(2 + i), settings, now, source, now, {
      program: point(now, 100 - i),
    });
  }
  expect(timeline.getDiagnostics().calibration).toMatchObject({
    effectiveDelayMs: 120000,
    reason: 'consistent-round-clock',
  });
});

it('does not treat catch-up or paused clock values as calibration evidence', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  for (let i = 1; i <= 10; i++) {
    timeline.project(program(1), settings, i * 100, source, 0, {
      source: { received: i * 100, remaining: 100 - i, round: 3, generation: 1 },
    });
  }
  for (let i = 1; i <= 10; i++) {
    const now = 120000 + i * 1000;
    timeline.project(program(i + 1), settings, now, source, now, {
      program: { received: now, remaining: 100 - i, round: 3, generation: 1 },
    });
  }
  expect(timeline.getDiagnostics().calibration.state).toBe('uncalibrated');
});

it('rejects a stable clock offset that conflicts with the observed freeze boundary', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  timeline.project(program(1), settings, 1000, source, 1000, {
    freezeEnd: { round: 3, received: 1000, generation: 1 },
  });
  feedSourceClock(timeline, 2000, 3);
  timeline.project(program(1), settings, 110000, source, 110000, {
    phase: { phase: 'freezetime', round: 3, received: 110000, generation: 1 },
  });
  timeline.project(program(1), settings, 111000, source, 111000, {
    phase: { phase: 'live', round: 3, received: 111000, generation: 1 },
  });
  feedProgramClock(timeline, 122000, 3);
  expect(timeline.getDiagnostics().calibration).toMatchObject({
    state: 'uncalibrated',
    reason: 'freeze-boundary-conflict',
  });
});

it('does not count a burst as multiple independent clock samples', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  for (let i = 0; i < 100; i++) {
    timeline.project(program(1), settings, 1000, source, 1000, {
      source: { round: 3, generation: 1, received: 1000, remaining: 100 - i / 10 },
    });
  }
  feedProgramClock(timeline, 121000, 3);
  expect(timeline.getDiagnostics().calibration.state).toBe('uncalibrated');
});

it('does not retire an unseen future death for the same player', () => {
  const timeline = aligned();
  timeline.consume(kill(4, 7, 20000));
  timeline.project(program(4, [7]), settings, 125000, source);
  timeline.project(program(5), settings, 130000, source);
  expect(timeline.project(program(6), settings, 133000, source).observer?.hints).toMatchObject([
    { id: '1:4', remainingSeconds: 7 },
  ]);
});

it('keeps early new-map events while Program catches up, then discards the previous map', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  timeline.consume(kill(1, 8, 500));
  const ahead = { ...source, sameMap: false, mapName: 'de_nuke' };
  timeline.project(program(2), settings, 1000, ahead);
  const event = kill(2, 7, 2000);
  timeline.consume({ ...event, cursor: { ...event.cursor, mapName: 'de_nuke' } });
  timeline.project(program(3), settings, 3000, ahead);
  const next = {
    ...program(4),
    map: { name: 'de_nuke' },
    cursor: { ...program(4).cursor, mapEpoch: 2 },
  };
  timeline.project(next, settings, 4000, { ...source, sameMap: true, mapName: 'de_nuke' });
  expect(timeline.getDiagnostics().buffered).toBe(1);
  expect(
    timeline.project(next, settings, 115000, { ...source, sameMap: true, mapName: 'de_nuke' })
      .observer?.hints,
  ).toEqual([]);
});

it('does not mix executions when the early source restarts on the next map before Program arrives', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source, 0, { sourceExecution: 0 });
  const ahead = { ...source, sameMap: false, mapName: 'de_nuke' };
  timeline.project(program(2), settings, 1000, ahead, 1000, { sourceExecution: 1 });
  const event = kill(1, 7, 2000);
  timeline.consume({ ...event, cursor: { ...event.cursor, mapName: 'de_nuke' } });
  timeline.project(program(3), settings, 3000, ahead, 3000, { sourceExecution: 2 });
  const next = {
    ...program(4),
    map: { name: 'de_nuke' },
    cursor: { ...program(4).cursor, mapEpoch: 2 },
  };
  const result = timeline.project(
    next,
    settings,
    4000,
    { ...source, sameMap: true, mapName: 'de_nuke' },
    4000,
    { sourceExecution: 2 },
  );
  expect(result.observer).toMatchObject({
    state: 'unavailable',
    waitingReason: 'source-execution-ahead',
    hints: [],
  });
  expect(timeline.getDiagnostics().buffered).toBe(0);
});

it('does not carry pending map execution conflicts into a different match', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source, 0, { sourceExecution: 0 });
  const ahead = { ...source, sameMap: false, mapName: 'de_nuke' };
  timeline.project(program(2), settings, 1000, ahead, 1000, { sourceExecution: 1 });
  timeline.project(program(3), settings, 2000, ahead, 2000, { sourceExecution: 2 });
  const next = {
    ...program(4),
    match: { matchId: 'other' },
    map: { name: 'de_nuke' },
    cursor: { ...program(4).cursor, liveSessionId: 'other', mapEpoch: 2 },
  };
  const result = timeline.project(
    next,
    settings,
    3000,
    { ...source, sameMap: true, mapName: 'de_nuke' },
    3000,
    { sourceExecution: 2 },
  );
  expect(result.observer?.waitingReason).toBe('calibration-pending');
});

describe('explicit program playback clock', () => {
  it('follows position through pause and rewind and rejects mismatched timelines', () => {
    const timeline = new ObserverHintTimeline();
    const frame = program(1);
    const clock = {
      timeDomain: 'synthetic',
      continuity: 'execution-1',
      mapName: 'de_mirage',
      tick: 0,
      ticksPerSecond: 64,
      usable: true,
    };
    const project = (tick: number, now: number, patch = {}) =>
      timeline.project(frame, settings, now, source, now, {
        playback: { ...clock, tick, ...patch },
      });
    project(0, 0);
    const position = {
      timeDomain: clock.timeDomain,
      continuity: clock.continuity,
      mapName: clock.mapName,
      tick: 640,
      ticksPerSecond: 64,
    };
    timeline.consume(kill(1, 7, 1), position);
    timeline.consume(kill(1, 7, 1), position);
    expect(project(128, 1000).observer?.hints).toEqual([]);
    expect(project(192, 2000).observer?.hints).toMatchObject([{ remainingSeconds: 7 }]);
    expect(project(192, 200000).observer?.hints).toMatchObject([{ remainingSeconds: 7 }]);
    expect(project(640, 201000).observer?.hints).toEqual([]);
    expect(project(320, 202000).observer?.hints).toMatchObject([{ remainingSeconds: 5 }]);
    expect(project(320, 203000, { timeDomain: 'other' }).observer?.hints).toEqual([]);
    expect(project(320, 204000, { continuity: 'other' }).observer?.hints).toEqual([]);
    expect(project(320, 205000, { usable: false }).observer).toMatchObject({
      state: 'unavailable',
      timingBasis: 'program-clock',
      hints: [],
    });
    expect(
      timeline.project(frame, settings, 205500, source, 205500, { playback: null }).observer,
    ).toMatchObject({ state: 'unavailable', timingBasis: 'program-clock', hints: [] });
    timeline.consume(kill(2, 6, 2));
    expect(project(320, 206000).observer).toMatchObject({
      state: 'unavailable',
      waitingReason: 'program-clock-syncing',
      hints: [],
    });
  });
});
