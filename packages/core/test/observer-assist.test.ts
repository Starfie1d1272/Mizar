import { describe, expect, it } from 'vitest';
import {
  ObserverHintTimeline,
  type ObserverProgramView,
} from '../src/projection/observer-assist.js';
import type { PlayerDeathGameEvent } from '../src/game-events/index.js';
const settings = { enabled: true, expectedDelaySeconds: 120, leadSeconds: 7 };
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
  timeline.project(program(1), settings, 0, source);
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
    expect(confirmed.players.find((p) => p.sourcePlayerId === '7')?.lifeState).toBe('dead');
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
    'clears %s buffers and requires newly received events after resuming',
    (phase) => {
      const timeline = aligned();
      const paused = { ...program(4, [8, 9]), clock: { phase } };
      expect(timeline.project(paused, settings, 123000, source).observer).toMatchObject({
        state: 'paused',
        measuredDelaySeconds: null,
        hints: [],
      });
      timeline.consume(kill(4, 6, 123500));
      expect(timeline.project(program(5), settings, 124000, source).observer).toMatchObject({
        state: 'ready',
        hints: [],
      });
      timeline.consume(kill(5, 8, 125000));
      timeline.consume(kill(6, 9, 126000));
      timeline.consume(kill(7, 7, 134000));
      expect(timeline.project(program(6, [8]), settings, 245000, source).observer).toMatchObject({
        state: 'ready',
        hints: [{ id: '1:6', remainingSeconds: 1 }],
      });
      expect(timeline.project(program(7, [8, 9]), settings, 246000, source).observer).toMatchObject(
        { state: 'ready', measuredDelaySeconds: null, hints: [] },
      );
      expect(
        timeline.project(program(7, [8, 9]), settings, 247000, source).observer?.hints,
      ).toMatchObject([{ id: '1:7', remainingSeconds: 7 }]);
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
  it('clears boundaries and waits for fresh events after setting, pause, map and source changes', () => {
    const cases = [
      (p: ObserverProgramView) => ({ ...p, clock: { phase: 'paused' as const } }),
      (p: ObserverProgramView) => ({ ...p, map: { name: 'de_nuke' } }),
      (p: ObserverProgramView) => ({ ...p, match: { matchId: 'next' } }),
      (p: ObserverProgramView) => ({ ...p, cursor: { ...p.cursor, liveSessionId: 'next' } }),
      (p: ObserverProgramView) => ({ ...p, cursor: { ...p.cursor, mapEpoch: 2 } }),
      (p: ObserverProgramView) => ({ ...p, cursor: { ...p.cursor, programSourceGeneration: 2 } }),
    ];
    for (const change of cases) {
      const reset = aligned();
      expect(
        reset.project(change(program(3, [8, 9])), settings, 123000, source).observer?.hints,
      ).toEqual([]);
      expect(reset.project(program(4, [8, 9]), settings, 123200, source).observer).toMatchObject({
        state: 'ready',
        hints: [],
      });
    }
    const timeline = aligned();
    timeline.settingsChanged(123000);
    expect(timeline.project(program(3, [8, 9]), settings, 123000, source).observer?.hints).toEqual(
      [],
    );
    expect(
      aligned().project(program(3, [8, 9]), settings, 123000, { ...source, generation: 2 }).observer
        ?.hints,
    ).toEqual([]);
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
      'ready',
    );
    expect(aligned().project(program(3, [8, 9]), settings, 303000, source).observer?.state).toBe(
      'unavailable',
    );
  });
});

it.each([0, 1])('estimates the 113-second window with %i anchors', (anchors) => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  if (anchors) timeline.consume(kill(1, 8, 1000));
  timeline.consume(kill(2, 7, 10000));
  const frame = program(2, anchors ? [8] : []);
  timeline.project(frame, settings, 120000, source); // 119-second reference, if present
  expect(timeline.project(frame, settings, 122999, source).observer?.hints).toEqual([]);
  expect(timeline.project(frame, settings, 123000, source).observer).toMatchObject({
    timingBasis: 'estimated',
    expectedDelaySeconds: 120,
    measuredDelaySeconds: null,
    hints: [{ remainingSeconds: 7 }],
  });
});

it('retires expired and currently dead hints without deleting later events for the same victim', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1, [7]), settings, 0, source);
  timeline.consume(kill(1, 7, 1000));
  timeline.consume(kill(2, 7, 50000));
  timeline.project(program(2, [7]), settings, 114000, source);
  expect(timeline.getDiagnostics().discarded['victim-already-dead']).toBe(1);
  expect(timeline.project(program(3), settings, 115000, source).observer?.hints).toEqual([]);
  expect(timeline.project(program(3), settings, 163000, source).observer?.hints).toMatchObject([
    { id: '1:2', remainingSeconds: 7 },
  ]);
  timeline.project(program(3), settings, 170000, source);
  // Expiry is permanent even if a caller supplies a larger expected delay directly.
  expect(
    timeline.project(
      program(3),
      { ...settings, expectedDelaySeconds: 125, leadSeconds: 10 },
      171000,
      source,
    ).observer?.hints,
  ).toEqual([]);
  timeline.consume(kill(2, 7, 50000));
  expect(
    timeline.project(program(3), { ...settings, expectedDelaySeconds: 125 }, 172000, source)
      .observer?.hints,
  ).toEqual([]);
});

it('keeps lead changes immediate and resets expected-delay changes without replaying old events', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  timeline.consume(kill(1, 7, 1000));
  expect(timeline.project(program(1), settings, 111000, source).observer?.hints).toEqual([]);
  expect(
    timeline.project(program(1), { ...settings, leadSeconds: 10 }, 111000, source).observer?.hints,
  ).toHaveLength(1);
  timeline.settingsChanged(112000);
  timeline.consume(kill(1, 7, 1000));
  expect(
    timeline.project(program(1), { ...settings, expectedDelaySeconds: 125 }, 120000, source)
      .observer?.hints,
  ).toEqual([]);
  expect(timeline.getDiagnostics().discarded['invalid-or-before-boundary']).toBe(1);
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
    nextWindowInMs: 112000,
  });
  expect(
    timeline.project(program(1), settings, 4000, { ...source, fresh: false }).observer
      ?.waitingReason,
  ).toBe('source-stale');
  timeline.project(program(1), settings, 5000, { ...source, generation: 2 });
  timeline.consume(kill(3, 7, 6000));
  expect(timeline.getDiagnostics()).toMatchObject({
    buffered: 0,
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

it('opens the 120/5 estimate 115 seconds after receiving a kill', () => {
  const timeline = new ObserverHintTimeline();
  const fiveSeconds = { ...settings, leadSeconds: 5 };
  timeline.project(program(1), fiveSeconds, 0, source);
  timeline.consume(kill(1, 7, 1000));
  expect(timeline.project(program(1), fiveSeconds, 115999, source).observer?.hints).toEqual([]);
  expect(timeline.project(program(1), fiveSeconds, 116000, source).observer?.hints).toMatchObject([
    { remainingSeconds: 5 },
  ]);
});

it.each([119000, 121000, 150000])(
  'calibrates a sequence at %i ms and holds it without new events',
  (delay) => {
    const timeline = new ObserverHintTimeline();
    timeline.project(program(1), settings, 0, source);
    timeline.consume(kill(1, 8, 1000));
    timeline.consume(kill(2, 9, 2000));
    timeline.consume(kill(3, 6, 3000));
    timeline.consume(kill(4, 7, 40000));
    timeline.project(program(2, [8]), settings, delay + 1000, source);
    timeline.project(program(3, [8, 9]), settings, delay + 2200, source);
    const locked = timeline.project(program(4, [6, 8, 9]), settings, delay + 2900, source);
    expect(locked.observer?.calibrationState).toBe('measured');
    expect(locked.observer?.effectiveDelaySeconds).toBeCloseTo(delay / 1000);
    const held = timeline.project(program(4, [6, 8, 9]), settings, delay + 70000, source);
    expect(held.observer?.calibrationState).toBe('held');
    expect(held.observer?.effectiveDelaySeconds).toBeCloseTo(delay / 1000);
  },
);

it('refuses competing or reversed sequences', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  for (const [seq, victim, time] of [
    [1, 8, 3000],
    [2, 9, 2000],
    [3, 6, 1000],
  ] as const)
    timeline.consume(kill(seq, victim, time));
  timeline.project(program(2, [8]), settings, 121000, source);
  timeline.project(program(3, [8, 9]), settings, 122000, source);
  timeline.project(program(4, [6, 8, 9]), settings, 123000, source);
  expect(timeline.getDiagnostics().calibration.state).toBe('uncalibrated');
});

it('never resurrects a retired event when a later sequence changes the estimate', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  timeline.consume(kill(1, 8, 1000));
  timeline.consume(kill(2, 9, 2000));
  timeline.consume(kill(3, 6, 3000));
  timeline.consume(kill(4, 7, 4000));
  timeline.project(program(2, [8]), settings, 151000, source);
  timeline.project(program(3, [8, 9]), settings, 152000, source);
  const locked = timeline.project(program(4, [6, 8, 9]), settings, 153000, source);
  expect(locked.observer?.effectiveDelaySeconds).toBe(150);
  expect(locked.observer?.hints).toEqual([]);
  expect(timeline.project(program(5, [6, 8, 9]), settings, 154000, source).observer?.hints).toEqual(
    [],
  );
});

it('rebuilds a shifted timeline only after a new consistent sequence', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  for (const [seq, victim, time] of [
    [1, 8, 1000],
    [2, 9, 2000],
    [3, 6, 3000],
    [4, 8, 80000],
    [5, 9, 81000],
    [6, 6, 82000],
  ] as const)
    timeline.consume(kill(seq, victim, time));
  timeline.project(program(2, [8]), settings, 121000, source);
  timeline.project(program(3, [8, 9]), settings, 122000, source);
  expect(
    timeline.project(program(4, [6, 8, 9]), settings, 123000, source).observer
      ?.effectiveDelaySeconds,
  ).toBe(120);
  timeline.project(program(5), settings, 229000, source);
  timeline.project(program(6, [8]), settings, 230000, source);
  timeline.project(program(7, [8, 9]), settings, 231000, source);
  expect(
    timeline.project(program(8, [6, 8, 9]), settings, 232000, source).observer
      ?.effectiveDelaySeconds,
  ).toBe(150);
  expect(timeline.getDiagnostics().calibration.reason).toBe('confirmed-timeline-shift');
});

it('moves only unshown events after calibration and freezes displayed deadlines', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  for (const [seq, victim, time] of [
    [1, 8, 1000],
    [2, 9, 2000],
    [3, 6, 3000],
    [4, 7, 40000],
  ] as const)
    timeline.consume(kill(seq, victim, time));
  timeline.project(program(2, [8]), settings, 151000, source);
  timeline.project(program(3, [8, 9]), settings, 152000, source);
  timeline.project(program(4, [6, 8, 9]), settings, 153000, source);
  expect(
    timeline.project(program(4, [6, 8, 9]), settings, 183000, source).observer?.hints,
  ).toMatchObject([{ id: '1:4', remainingSeconds: 7 }]);
});

it('keeps a displayed deadline when new measurements update the offset', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  for (const [seq, victim, time] of [
    [1, 8, 1000],
    [2, 9, 2000],
    [3, 6, 3000],
    [4, 8, 80000],
    [5, 9, 81000],
    [6, 6, 82000],
    [7, 7, 88000],
  ] as const)
    timeline.consume(kill(seq, victim, time));
  timeline.project(program(2, [8]), settings, 120000, source);
  timeline.project(program(3, [8, 9]), settings, 121000, source);
  timeline.project(program(4, [6, 8, 9]), settings, 122000, source);
  timeline.project(program(5), settings, 199000, source);
  expect(
    timeline
      .project(program(5), settings, 200000, source)
      .observer?.hints.find((hint) => hint.id === '1:7'),
  ).toMatchObject({ remainingSeconds: 7 });
  timeline.project(program(6, [8]), settings, 201000, source);
  timeline.project(program(7, [8, 9]), settings, 202000, source);
  const result = timeline.project(program(8, [6, 8, 9]), settings, 203000, source);
  expect(result.observer?.effectiveDelaySeconds).toBe(119.5);
  expect(result.observer?.hints).toMatchObject([{ id: '1:7', remainingSeconds: 4 }]);
});

it('does not choose between two equally plausible repeated-victim sequences', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  for (const [seq, victim, time] of [
    [1, 8, 1000],
    [2, 9, 2000],
    [3, 6, 3000],
    [4, 8, 41000],
    [5, 9, 42000],
    [6, 6, 43000],
  ] as const)
    timeline.consume(kill(seq, victim, time));
  timeline.project(program(2, [8]), settings, 121000, source);
  timeline.project(program(3, [8, 9]), settings, 122000, source);
  const result = timeline.project(program(4, [6, 8, 9]), settings, 123000, source);
  expect(result.observer?.calibrationState).toBe('uncalibrated');
  expect(timeline.getDiagnostics().calibration.reason).toBe('competing-offsets');
});

it('does not reuse confirmed early deaths after their program records leave the window', () => {
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
  expect(
    timeline.project(program(4, [6, 8, 9]), settings, 123000, source).observer
      ?.effectiveDelaySeconds,
  ).toBe(120);
  timeline.project(program(5), settings, 150000, source);
  timeline.project(program(6, [8]), settings, 161000, source);
  timeline.project(program(7, [8, 9]), settings, 162000, source);
  const later = timeline.project(program(8, [6, 8, 9]), settings, 163000, source);
  expect(later.observer?.effectiveDelaySeconds).toBe(120);
  expect(
    timeline.project(program(9, [5, 6, 8, 9]), settings, 185000, source).observer
      ?.effectiveDelaySeconds,
  ).toBe(120);
  expect(timeline.getDiagnostics().calibration.reason).toBe('insufficient-or-ambiguous');
});

it('rejects a competing offset even when its cluster has more evidence', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  for (const [seq, victim, time] of [
    [1, 8, 1000],
    [2, 9, 2000],
    [3, 6, 3000],
    [4, 8, 41000],
    [5, 9, 42000],
    [6, 6, 43000],
    [7, 5, 44000],
  ] as const)
    timeline.consume(kill(seq, victim, time));
  timeline.project(program(2, [8]), settings, 121000, source);
  timeline.project(program(3, [8, 9]), settings, 122000, source);
  timeline.project(program(4, [6, 8, 9]), settings, 123000, source);
  const result = timeline.project(program(5, [5, 6, 8, 9]), settings, 124000, source);
  expect(result.observer?.calibrationState).toBe('uncalibrated');
  expect(timeline.getDiagnostics().calibration.reason).toBe('competing-offsets');
});

it('holds briefly, then stops hints and reacquires a 190-second offset using four new events', () => {
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
  timeline.project(program(4, [6, 8, 9]), settings, 123000, source);
  expect(timeline.project(program(4, [6, 8, 9]), settings, 193000, source).observer).toMatchObject({
    state: 'ready',
    calibrationState: 'held',
    effectiveDelaySeconds: 120,
  });
  for (const [seq, victim, time] of [
    [4, 8, 160000],
    [5, 9, 161000],
    [6, 6, 162000],
    [7, 5, 163000],
  ] as const)
    timeline.consume(kill(seq, victim, time));
  expect(timeline.project(program(5), settings, 304000, source).observer).toMatchObject({
    state: 'unavailable',
    calibrationState: 'reacquiring',
    waitingReason: 'calibration-reacquiring',
    hints: [],
  });
  timeline.project(program(6, [8]), settings, 350000, source);
  timeline.project(program(7, [8, 9]), settings, 351000, source);
  expect(timeline.project(program(8, [6, 8, 9]), settings, 352000, source).observer?.state).toBe(
    'unavailable',
  );
  expect(
    timeline.project(program(9, [5, 6, 8, 9]), settings, 353000, source).observer,
  ).toMatchObject({ state: 'ready', calibrationState: 'measured', effectiveDelaySeconds: 190 });
  expect(timeline.getDiagnostics().calibration.reason).toBe('reacquired');
});

it('retains sufficient early history for a 650-second offset', () => {
  const timeline = new ObserverHintTimeline();
  const longDelay = { ...settings, expectedDelaySeconds: 600 };
  timeline.project(program(1), longDelay, 0, source);
  for (const [seq, victim, time] of [
    [1, 8, 1000],
    [2, 9, 2000],
    [3, 6, 3000],
    [4, 7, 100000],
  ] as const)
    timeline.consume(kill(seq, victim, time));
  timeline.project(program(2, [8]), longDelay, 651000, source);
  timeline.project(program(3, [8, 9]), longDelay, 652000, source);
  expect(
    timeline.project(program(4, [6, 8, 9]), longDelay, 653000, source).observer
      ?.effectiveDelaySeconds,
  ).toBe(650);
  expect(
    timeline.project(program(4, [6, 8, 9]), longDelay, 743000, source).observer?.hints,
  ).toMatchObject([{ id: '1:4', remainingSeconds: 7 }]);
});

it('moves an unshown hint after calibrating to 119 seconds', () => {
  const timeline = new ObserverHintTimeline();
  timeline.project(program(1), settings, 0, source);
  for (const [seq, victim, time] of [
    [1, 8, 1000],
    [2, 9, 2000],
    [3, 6, 3000],
    [4, 7, 40000],
  ] as const)
    timeline.consume(kill(seq, victim, time));
  timeline.project(program(2, [8]), settings, 120000, source);
  timeline.project(program(3, [8, 9]), settings, 121000, source);
  expect(
    timeline.project(program(4, [6, 8, 9]), settings, 122000, source).observer
      ?.effectiveDelaySeconds,
  ).toBe(119);
  expect(
    timeline.project(program(4, [6, 8, 9]), settings, 152000, source).observer?.hints,
  ).toMatchObject([{ id: '1:4', remainingSeconds: 7 }]);
});

it('does not trust an old estimate after a long stale source gap', () => {
  const timeline = aligned();
  timeline.project(program(3, [8, 9]), settings, 130000, { ...source, fresh: false });
  const resumed = timeline.project(program(4), settings, 600000, source);
  expect(resumed.observer).toMatchObject({
    state: 'unavailable',
    calibrationState: 'reacquiring',
    hints: [],
  });
});

it('keeps a calibrated offset through a long quiet period when both sources keep advancing', () => {
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
  timeline.project(program(4, [6, 8, 9]), settings, 123000, source);
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
