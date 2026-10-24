import { describe, expect, it } from 'vitest';
import {
  ObserverHintTimeline,
  type ObserverProgramView,
} from '../src/projection/observer-assist.js';
import type { PlayerDeathGameEvent } from '../src/game-events/index.js';
const settings = { enabled: true, expectedDelaySeconds: 120, leadSeconds: 7, displaySeconds: 10 };
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
  expect(timeline.project(program(2, [8]), settings, 121000, source).observer?.state).toBe(
    'aligning',
  );
  expect(
    timeline.project(program(3, [8, 9]), settings, 122000, source).observer?.measuredDelaySeconds,
  ).toBe(120);
  return timeline;
}
describe('private observer hints against Program', () => {
  it('shows real Program slots seven seconds ahead and expires after ten seconds total', () => {
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
      occurred: false,
      attacker: { observerSlot: 3, name: 'Player 3' },
      victim: { observerSlot: 7 },
    });
    expect(
      timeline.project(program(4, [7, 8, 9]), settings, 130000, source).observer?.hints[0]
        ?.occurred,
    ).toBe(true);
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
  it('clears boundaries and waits for fresh anchors after setting, pause, map and source changes', () => {
    const cases = [
      (p: ObserverProgramView) => ({ ...p, clock: { phase: 'paused' as const } }),
      (p: ObserverProgramView) => ({ ...p, map: { name: 'de_nuke' } }),
      (p: ObserverProgramView) => ({ ...p, cursor: { ...p.cursor, liveSessionId: 'next' } }),
      (p: ObserverProgramView) => ({ ...p, status: { ...p.status, telemetry: 'stale' as const } }),
    ];
    for (const change of cases)
      expect(
        aligned().project(change(program(3, [8, 9])), settings, 123000, source).observer?.hints,
      ).toEqual([]);
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
  it('keeps unknown health from becoming a death anchor and expires old alignment', () => {
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
      'aligning',
    );
    expect(aligned().project(program(3, [8, 9]), settings, 303000, source).observer?.state).toBe(
      'aligning',
    );
  });
});
