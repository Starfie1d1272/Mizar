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
  timeline.consume(kill(2, 9, 2000));
  timeline.consume(kill(3, 7, 10000));
  expect(timeline.project(program(2, [8]), settings, 121000, source).observer?.state).toBe('ready');
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
    expect(result.observer?.measuredDelaySeconds).toBeCloseTo((120 + 120 + 119) / 3);

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
        { state: 'ready', measuredDelaySeconds: 120, hints: [] },
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
      (p: ObserverProgramView) => ({
        ...p,
        status: { ...p.status, identity: 'mismatch' as const },
      }),
      (p: ObserverProgramView) => ({ ...p, status: { ...p.status, telemetry: 'stale' as const } }),
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
      'ready',
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
    measuredDelaySeconds: anchors ? 119 : null,
    hints: [{ remainingSeconds: 7 }],
  });
});

it.each([121000, 138000])(
  'does not gate estimates on unstable or out-of-window reference %i',
  (delay) => {
    const timeline = new ObserverHintTimeline();
    timeline.project(program(1), settings, 0, source);
    timeline.consume(kill(1, 8, 1000));
    timeline.consume(kill(2, 9, 2000));
    timeline.consume(kill(3, 7, 30000));
    timeline.project(program(2, [8]), settings, 120000, source); // 119 s
    timeline.project(program(3, [8, 9]), settings, 2000 + delay, source);
    expect(
      timeline.project(program(3, [8, 9]), settings, 143000, source).observer?.hints,
    ).toMatchObject([{ id: '1:3', remainingSeconds: 7 }]);
    expect(timeline.getDiagnostics().anchors).toBe(delay === 121000 ? 2 : 1);
    if (delay === 121000) expect(timeline.getDiagnostics().measuredDelayMs?.spread).toBe(2000);
  },
);

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
