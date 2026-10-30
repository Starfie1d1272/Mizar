import { describe, expect, it } from 'vitest';
import {
  ObserverHintTimeline,
  type ObserverProgramView,
} from '../src/projection/observer-assist.js';
import type { PlayerDeathGameEvent } from '../src/game-events/index.js';

const settings = { enabled: true, leadSeconds: 7 };
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
    map: { name: 'de_test' },
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
      mapName: 'de_test',
      ticksPerSecond: 64,
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
function run(
  timeline: ObserverHintTimeline,
  now: number,
  options: {
    generation?: number;
    execution?: number;
    epoch?: number;
    sourceRemaining?: number;
    programRemaining?: number;
    round?: number;
    victimDead?: boolean;
    programGeneration?: number;
  } = {},
) {
  const generation = options.generation ?? 1;
  const round = options.round ?? 6;
  const source = {
    connected: true,
    fresh: true,
    sameMap: true,
    generation,
    lastReceiveMonotonicMs: now,
  };
  const base = program(now, options.epoch);
  const view: ObserverProgramView = {
    ...base,
    cursor: { ...base.cursor, programSourceGeneration: options.programGeneration ?? 1 },
    players: options.victimDead
      ? base.players.map((player) =>
          player.sourcePlayerId === 'player-1' ? { ...player, lifeState: 'dead' } : player,
        )
      : base.players,
  };
  return timeline.project(view, settings, now, source, now, {
    sourceExecution: options.execution ?? 1,
    source: {
      round,
      remaining: options.sourceRemaining ?? 100 - now / 1000,
      received: now,
      generation,
    },
    ...(options.programRemaining === undefined
      ? {}
      : {
          program: {
            round,
            remaining: options.programRemaining,
            received: now,
            generation: 1,
          },
        }),
  });
}

describe('observer clock recovery', () => {
  it.each(['source', 'program', 'map'] as const)(
    'records only a uniquely matched shown death and clears it at the %s boundary',
    (boundary) => {
      const timeline = new ObserverHintTimeline();
      for (let now = 0; now <= 10000; now += 100)
        run(timeline, now, {
          sourceRemaining: 100 - now / 1000,
          ...(now >= 2000 ? { programRemaining: 100 - (now - 2000) / 1000 } : {}),
        });
      timeline.consume(death(1, 1, 10000));
      expect(run(timeline, 10100).observer?.hints).toHaveLength(1);
      expect(run(timeline, 11500, { victimDead: true }).observer?.hints).toHaveLength(0);
      expect(timeline.getDiagnostics().calibration.lastMatchedDeathOffsetMs).toBeCloseTo(-500);
      run(timeline, 11600);
      timeline.consume(death(1, 2, 11600));
      timeline.consume(death(1, 3, 11700));
      expect(run(timeline, 11700).observer?.hints).toHaveLength(2);
      run(timeline, 12000, { victimDead: true });
      expect(timeline.getDiagnostics().calibration.lastMatchedDeathOffsetMs).toBeCloseTo(-500);
      if (boundary === 'source') run(timeline, 12100, { generation: 2 });
      if (boundary === 'program') run(timeline, 12100, { programGeneration: 2 });
      if (boundary === 'map') timeline.resetForMap(12100);
      expect(timeline.getDiagnostics().calibration.lastMatchedDeathOffsetMs).toBeNull();
    },
  );
  it('calibrates a 120 second delay with 50 Hz quantized clocks', () => {
    const timeline = new ObserverHintTimeline();
    let result;
    for (let now = 0; now <= 132000; now += 20) {
      const quantize = (n: number) => Math.round(n * 10) / 10;
      result = run(timeline, now, {
        sourceRemaining: quantize(200 - now / 1000),
        ...(now >= 120000 ? { programRemaining: quantize(200 - (now - 120000) / 1000) } : {}),
      });
    }
    expect(result?.observer).toMatchObject({
      enabled: true,
      state: 'ready',
      calibrationState: 'measured',
    });
    expect(result?.observer?.effectiveDelaySeconds).toBeCloseTo(120, 0);
    expect(timeline.getDiagnostics().anchors).toBeGreaterThanOrEqual(3);
  });

  it('scopes execution counters to a generation and keeps proven future executions isolated until Program catches up', () => {
    const timeline = new ObserverHintTimeline();
    for (let now = 0; now <= 10000; now += 100)
      run(timeline, now, {
        sourceRemaining: 100 - now / 1000,
        ...(now >= 2000 ? { programRemaining: 100 - (now - 2000) / 1000 } : {}),
      });
    expect(timeline.getDiagnostics().calibration.effectiveDelayMs).toBeCloseTo(2000);
    timeline.consume(death(1, 1, 10000));
    // A replacement manager's execution 0 is a new namespace, not a future execution.
    const reconnect = run(timeline, 10100, { generation: 2, execution: 0 });
    expect(reconnect.observer?.waitingReason).not.toBe('source-execution-ahead');
    const ahead = run(timeline, 10200, { generation: 2, execution: 1 });
    expect(ahead.observer).toMatchObject({
      enabled: true,
      waitingReason: 'source-execution-ahead',
      hints: [],
      effectiveDelaySeconds: null,
    });
    expect(timeline.getDiagnostics().buffered).toBe(0);
    timeline.consume(death(2, 2, 10300));
    expect(run(timeline, 10300, { generation: 3, execution: 0 }).observer?.waitingReason).toBe(
      'source-execution-ahead',
    );
    const caughtUp = run(timeline, 10400, { generation: 3, execution: 0, epoch: 2 });
    expect(caughtUp.observer).toMatchObject({
      enabled: true,
      waitingReason: 'calibration-pending',
      effectiveDelaySeconds: null,
      hints: [],
    });
    expect(timeline.getDiagnostics().buffered).toBe(0);
    let result;
    for (let now = 10500; now <= 20500; now += 100)
      result = run(timeline, now, {
        generation: 3,
        execution: 0,
        epoch: 2,
        sourceRemaining: 100 - (now - 10400) / 1000,
        ...(now >= 12400 ? { programRemaining: 100 - (now - 12400) / 1000 } : {}),
      });
    expect(result?.observer).toMatchObject({ enabled: true, state: 'ready', hints: [] });
    expect(result?.observer?.effectiveDelaySeconds).toBeCloseTo(2);
    timeline.consume(death(3, 3, 20500));
    const withNewDeath = run(timeline, 20600, {
      generation: 3,
      execution: 0,
      epoch: 2,
      sourceRemaining: 89.8,
      programRemaining: 91.8,
    });
    expect(withNewDeath.observer?.hints).toHaveLength(1);
    expect(withNewDeath.observer?.hints[0]?.id).toBe('3:3');
  });

  it('does not carry partial evidence through a pause, a regression, or a round change', () => {
    for (const interruption of ['pause', 'regression', 'round'] as const) {
      const timeline = new ObserverHintTimeline();
      for (let now = 0; now <= 6000; now += 100)
        run(timeline, now, {
          sourceRemaining: 100 - now / 1000,
          ...(now >= 2000 ? { programRemaining: 100 - (now - 2000) / 1000 } : {}),
        });
      expect(timeline.getDiagnostics().calibration.effectiveDelayMs).toBeNull();
      const round = interruption === 'round' ? 7 : 6;
      run(timeline, 6100, {
        round,
        sourceRemaining: 93.9,
        ...(interruption === 'pause'
          ? {}
          : { programRemaining: interruption === 'regression' ? 105 : 95.9 }),
      });
      for (let now = 6200; now <= 9600; now += 100)
        run(timeline, now, {
          round,
          sourceRemaining: 100 - now / 1000,
          programRemaining: 100 - (now - 2000) / 1000,
        });
      expect(timeline.getDiagnostics().calibration.effectiveDelayMs).toBeNull();
    }
  });
});
