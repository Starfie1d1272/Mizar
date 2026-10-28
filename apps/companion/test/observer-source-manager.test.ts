import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CstvParserSessionFactoryOptions, CstvSessionRunResult } from '@mizar/telemetry-cstv';
import type { GameEventObservation } from '@mizar/core/game-events';
import {
  createCstvSourceManager,
  createObserverSourceManager,
} from '../src/telemetry/cstv-source-manager.js';

// Generated through the actual pinned parser worker and Python pipe, using only synthetic inputs.
const event = JSON.parse(
  readFileSync(new URL('./fixtures/observer-event.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;
const identity = { source: 'ahead:fixture', role: 'ahead' as const, channel: 1, world: 2 };
const cursor = {
  kind: 'cursor',
  ...identity,
  sequence: 6,
  tick: 99,
  tickInterval: 1 / 64,
  map: 'de_test',
};
function setup() {
  const manager = createObserverSourceManager({
    role: 'lookahead',
    identity,
    clock: { now: () => ({ observedAt: '2026-10-20T08:00:00Z', observedMonotonicMs: 10 }) },
  });
  const received: GameEventObservation[] = [];
  manager.subscribeLiveGameEvents((row) => received.push(row));
  manager.start();
  return { manager, received };
}
describe('observer through the existing source owner', () => {
  it('requires committed cursor readiness and preserves actual userid', () => {
    const { manager, received } = setup();
    manager.consumeObserverRecord({ ...event, sequence: 5 });
    expect(received).toHaveLength(0);
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord(event);
    expect(manager.getHealth().state).toBe('live');
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      kind: 'weapon-fire',
      player: { sourceUserId: 42 },
      cursor: { role: 'lookahead' },
    });
    expect(manager.getHealth().lastReceiveMonotonicMs).toBe(10);
    expect(manager.getHealth().lastSync).toBeUndefined(); // Never invent HTTP fragment metadata.
  });
  it('requires a prior freeze-end lifecycle event and stops on pause or bomb', () => {
    const { manager, received } = setup();
    const roundClock = {
      totalRoundsPlayed: 3,
      phase: 'unknown',
      startTime: 1,
      duration: 115,
      committedTick: 128,
      freezePeriod: false,
      warmupPeriod: false,
      bombPlanted: false,
      pause: {
        active: false,
        totalPausedTicks: 0,
        startTick: null,
        technical: null,
        semantics: 'unknown',
      },
      status: 'partial',
    };
    manager.consumeObserverRecord({ ...cursor, roundClock });
    expect(manager.getHealth().roundClock).toBeUndefined();
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 7,
      type: 'raw-event',
      name: 'round_freeze_end',
      kind: 'round_freeze_end',
      tick: 0,
      committedTick: 100,
      round: 3,
    });
    expect(manager.getHealth().freezeEnd).toEqual({
      round: 3,
      received: 10,
      generation: 0,
      sequence: 7,
      committedTick: 100,
    });
    expect(received).toEqual([]);
    manager.consumeObserverRecord({ ...cursor, sequence: 8, roundClock });
    expect(manager.getHealth().roundClock).toEqual({
      round: 3,
      remaining: 114,
      received: 10,
      generation: 0,
    });
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 9,
      roundClock: { ...roundClock, pause: { ...roundClock.pause, totalPausedTicks: 64 } },
    });
    expect(manager.getHealth().roundClock).toBeUndefined();
    manager.consumeObserverRecord({ ...cursor, sequence: 10, roundClock });
    expect(manager.getHealth().roundClock).toBeUndefined();
  });
  it('rejects the same committed tick, wrong round/world and stale rules after round end', () => {
    const { manager } = setup();
    const roundClock = {
      totalRoundsPlayed: 3,
      phase: 'unknown',
      startTime: 1,
      duration: 115,
      committedTick: 100,
      freezePeriod: false,
      warmupPeriod: false,
      bombPlanted: false,
      pause: {
        active: false,
        totalPausedTicks: 0,
        startTick: null,
        technical: null,
        semantics: 'unknown',
      },
      status: 'partial',
    };
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 7,
      world: 3,
      type: 'raw-event',
      name: 'round_freeze_end',
      kind: 'round_freeze_end',
      committedTick: 100,
      round: 3,
    });
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 7,
      type: 'raw-event',
      name: 'round_freeze_end',
      kind: 'round_freeze_end',
      tick: 0,
      committedTick: 100,
      round: 3,
    });
    manager.consumeObserverRecord({ ...cursor, sequence: 8, roundClock });
    expect(manager.getHealth().roundClock).toBeUndefined();
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 9,
      roundClock: { ...roundClock, committedTick: 128, totalRoundsPlayed: 4 },
    });
    expect(manager.getHealth().roundClock).toBeUndefined();
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 10,
      type: 'raw-event',
      name: 'round_freeze_end',
      kind: 'round_freeze_end',
      committedTick: 100,
      round: 3,
    });
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 11,
      type: 'raw-event',
      name: 'round_end',
      kind: 'round_end',
    });
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 12,
      roundClock: { ...roundClock, committedTick: 128 },
    });
    expect(manager.getHealth().roundClock).toBeUndefined();
  });
  it.each([
    'bomb',
    'start-time',
    'duration',
    'interval',
    'tick-reversal',
    'map',
    'discontinuity',
  ] as const)('closes the live clock on %s without admitting old rules', (boundary) => {
    const { manager } = setup();
    const roundClock = {
      totalRoundsPlayed: 3,
      phase: 'unknown',
      startTime: 1,
      duration: 115,
      committedTick: 128,
      freezePeriod: false,
      warmupPeriod: false,
      bombPlanted: false,
      pause: {
        active: false,
        totalPausedTicks: 0,
        startTick: null,
        technical: null,
        semantics: 'unknown',
      },
      status: 'partial',
    };
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 7,
      type: 'raw-event',
      name: 'round_freeze_end',
      kind: 'round_freeze_end',
      tick: 0,
      committedTick: 100,
      round: 3,
    });
    manager.consumeObserverRecord({ ...cursor, sequence: 8, roundClock });
    expect(manager.getHealth().roundClock).toBeDefined();
    if (boundary === 'map') {
      manager.consumeObserverRecord({
        ...cursor,
        sequence: 9,
        map: 'de_other',
        roundClock: { ...roundClock, committedTick: 150 },
      });
    } else if (boundary === 'discontinuity') {
      manager.consumeObserverRecord({ ...cursor, sequence: 9, kind: 'discontinuity', world: 3 });
      manager.consumeObserverRecord({ ...cursor, sequence: 10, world: 3, roundClock });
    } else {
      manager.consumeObserverRecord({
        ...cursor,
        sequence: 9,
        ...(boundary === 'interval' ? { tickInterval: 1 / 128 } : {}),
        roundClock: {
          ...roundClock,
          ...(boundary === 'bomb'
            ? { bombPlanted: true }
            : boundary === 'start-time'
              ? { startTime: 2 }
              : boundary === 'duration'
                ? { duration: 116 }
                : boundary === 'tick-reversal'
                  ? { committedTick: 110 }
                  : {}),
        },
      });
      manager.consumeObserverRecord({ ...cursor, sequence: 10, roundClock });
    }
    expect(manager.getHealth().roundClock).toBeUndefined();
  });
  it('permits a new unpaused round after reconnect', () => {
    const { manager } = setup();
    const roundClock = {
      totalRoundsPlayed: 1,
      phase: 'unknown',
      startTime: 1,
      duration: 115,
      committedTick: 128,
      freezePeriod: false,
      warmupPeriod: false,
      bombPlanted: false,
      pause: {
        active: false,
        totalPausedTicks: 0,
        startTick: null,
        technical: null,
        semantics: 'unknown',
      },
      status: 'partial',
    };
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 7,
      roundClock: { ...roundClock, pause: { ...roundClock.pause, active: true } },
    });
    manager.disconnectObserver();
    manager.attachObserver({ ...identity, channel: 2 });
    manager.consumeObserverRecord({ ...cursor, channel: 2 });
    manager.consumeObserverRecord({
      ...cursor,
      channel: 2,
      sequence: 7,
      type: 'raw-event',
      kind: 'round_freeze_end',
      name: 'round_freeze_end',
      tick: 0,
      committedTick: 100,
      round: 1,
    });
    manager.consumeObserverRecord({ ...cursor, channel: 2, sequence: 8, roundClock });
    expect(manager.getHealth().roundClock?.remaining).toBe(114);
  });
  it('keeps the initial warmup-to-match transition in the initial execution', () => {
    const { manager } = setup();
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 7,
      type: 'raw-event',
      kind: 'round_announce_warmup',
      name: 'round_announce_warmup',
    });
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 8,
      type: 'raw-event',
      kind: 'begin_new_match',
      name: 'begin_new_match',
    });
    expect(manager.getHealth().clockExecution).toBe(0);
  });
  it('detects restart after legacy non-clock live evidence', () => {
    const { manager } = setup();
    manager.consumeObserverRecord({ ...cursor, warmup: false, round: 3 });
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 7,
      type: 'raw-event',
      kind: 'round_announce_warmup',
      name: 'round_announce_warmup',
    });
    expect(manager.getHealth().clockExecution).toBe(1);
  });
  it('fences one restart after a proven first-round freeze end', () => {
    const { manager } = setup();
    manager.consumeObserverRecord({ ...cursor, warmup: false, round: 0 });
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 7,
      type: 'raw-event',
      kind: 'round_freeze_end',
      name: 'round_freeze_end',
      tick: 0,
      committedTick: 99,
      round: 0,
    });
    manager.consumeObserverRecord({ ...cursor, sequence: 8, warmup: true, round: 0 });
    manager.consumeObserverRecord({
      ...cursor,
      sequence: 9,
      type: 'raw-event',
      kind: 'begin_new_match',
      name: 'begin_new_match',
    });
    expect(manager.getHealth().clockExecution).toBe(1);
  });
  it('rejects duplicate and out-of-order records', () => {
    const { manager, received } = setup();
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord(event);
    manager.consumeObserverRecord(event);
    manager.consumeObserverRecord({ ...event, sequence: 7 });
    expect(received).toHaveLength(1);
  });
  it('retires alignment and old-world data, then accepts cursor at the reset sequence', () => {
    const { manager, received } = setup();
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord(event);
    const before = manager.getHealth().generation;
    const reset = { kind: 'discontinuity', ...identity, world: 3, sequence: 10 };
    manager.consumeObserverRecord(reset);
    expect(manager.getRecentGameEvents()).toEqual([]);
    expect(manager.getHealth().lastReceiveMonotonicMs).toBeUndefined();
    manager.consumeObserverRecord({ ...event, sequence: 11 });
    expect(received).toHaveLength(1);
    manager.consumeObserverRecord({ ...cursor, world: 3, sequence: 10, tick: 1 });
    manager.consumeObserverRecord({ ...event, world: 3, sequence: 11, tick: 2, committedTick: 1 });
    expect(received).toHaveLength(2);
    expect(received[1]?.cursor.generation).toBe(before + 1);
    manager.consumeObserverRecord(reset);
    expect(manager.getHealth().state).toBe('live');
  });
  it('does not resume on a queued old cursor after disconnect', () => {
    const { manager, received } = setup();
    manager.consumeObserverRecord(cursor);
    manager.disconnectObserver();
    manager.consumeObserverRecord({ ...cursor, sequence: 10 });
    manager.consumeObserverRecord({ ...event, sequence: 11 });
    expect(received).toHaveLength(0);
    expect(manager.getHealth().state).toBe('reconnecting');
    manager.attachObserver({ ...identity, channel: 2 });
    manager.consumeObserverRecord({ ...cursor, channel: 2 });
    manager.consumeObserverRecord({ ...event, channel: 2 });
    expect(received).toHaveLength(1);
  });
  it('does not let unknown records reserve the ordering watermark', () => {
    const { manager, received } = setup();
    manager.consumeObserverRecord({ ...cursor, kind: 'unknown', sequence: 999 });
    manager.consumeObserverRecord({ ...cursor, world: 99, sequence: 999 });
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord(event);
    expect(received).toHaveLength(1);
  });
  it('rejects cross-role attachment and wrong source without disturbing the valid source', () => {
    expect(() => createObserverSourceManager({ role: 'program', identity })).toThrow();
    const { manager, received } = setup();
    manager.consumeObserverRecord({ ...cursor, source: 'ahead:other', sequence: 999 });
    manager.consumeObserverRecord(cursor);
    manager.consumeObserverRecord(event);
    expect(received).toHaveLength(1);
  });
  it('does not deliver after stop', async () => {
    const { manager, received } = setup();
    manager.consumeObserverRecord(cursor);
    await manager.stop();
    manager.consumeObserverRecord(event);
    expect(received).toHaveLength(0);
    expect(manager.getHealth().state).toBe('stopped');
  });
  it('leaves the default unconfigured HTTP source disabled', () => {
    const manager = createCstvSourceManager({ role: 'program' });
    manager.start();
    expect(manager.getHealth().state).toBe('disabled');
  });
});

it('timestamps actual HTTP sync/tail progress without refreshing cached upstream metadata', async () => {
  let now = 100,
    tail = 0;
  let callbacks: CstvParserSessionFactoryOptions | undefined;
  let finish!: (result: CstvSessionRunResult) => void;
  const running = new Promise<CstvSessionRunResult>((resolve) => {
    finish = resolve;
  });
  const manager = createCstvSourceManager({
    role: 'lookahead',
    url: 'http://127.0.0.1:27025',
    clock: { now: () => ({ observedAt: '2026-10-25T00:00:00Z', observedMonotonicMs: now }) },
    parserSessionFactory: (options) => {
      callbacks = options;
      return {
        sync: null,
        get tailTick() {
          return tail;
        },
        start: () => Promise.resolve({ status: 'ready' }),
        run: () => running,
        stop: () => finish({ status: 'cancelled' }),
      };
    },
  });
  manager.start();
  try {
    const sync = {
      protocol: 1,
      tick: 10,
      ticksPerSecond: 64,
      fragment: 1,
      signupFragment: 0,
      mapName: 'de_test',
      receiveAgeSeconds: 9999,
    };
    expect(manager.getHealth().lastReceiveMonotonicMs).toBeUndefined();
    callbacks!.onSync(sync);
    expect(manager.getHealth().lastReceiveMonotonicMs).toBe(100);
    now = 200;
    callbacks!.onSync(sync);
    expect(manager.getHealth().lastReceiveMonotonicMs).toBe(100);
    now = 300;
    tail = 20;
    expect(manager.getHealth().lastReceiveMonotonicMs).toBe(300);
    now = 400;
    callbacks!.onSync({ ...sync, tick: 20, fragment: 2 });
    expect(manager.getHealth().lastReceiveMonotonicMs).toBe(400);
    now = 500;
    expect(manager.getHealth().lastReceiveMonotonicMs).toBe(400);
    expect(manager.getRecentGameEvents()).toEqual([]);
  } finally {
    await manager.stop();
  }
});

it('calibrates through the manager after first start and again in the round after a pause', async () => {
  const { ObserverHintTimeline } = await import('@mizar/core/projection');
  let now = 0;
  const manager = createObserverSourceManager({
    role: 'lookahead',
    identity,
    clock: { now: () => ({ observedAt: '2026-10-20T08:00:00Z', observedMonotonicMs: now }) },
  });
  const timeline = new ObserverHintTimeline();
  const settings = { enabled: true, expectedDelaySeconds: 120, leadSeconds: 7 };
  let programSequence = 1;
  const program: Parameters<typeof timeline.project>[0] = {
    cursor: {
      producerInstanceId: 'test',
      liveSessionId: 'live',
      runtimeSeq: 1,
      programSourceGeneration: 1,
      programReceiveSequence: 1,
      mapEpoch: 1,
    },
    status: { telemetry: 'fresh', context: 'fresh', identity: 'matched' },
    match: { matchId: 'match' },
    map: { name: 'de_test' },
    clock: { phase: 'live' },
    coverage: { allPlayers: 'present' },
    players: Array.from({ length: 10 }, (_, i) => ({
      sourcePlayerId: String(i),
      displayName: `P${i}`,
      observerSlot: i,
      lineupEvidence: 'current' as const,
      lifeState: 'alive' as const,
    })),
  };
  let programClock:
    { round: number; remaining: number; received: number; generation: number } | undefined;
  const project = () => {
    const h = manager.getHealth();
    return timeline.project(
      { ...program, cursor: { ...program.cursor, programReceiveSequence: programSequence } },
      settings,
      now,
      {
        connected: h.state === 'live',
        generation: h.generation,
        fresh: true,
        sameMap: h.mapName === 'de_test',
        ...(h.mapName === undefined ? {} : { mapName: h.mapName }),
      },
      now,
      {
        ...(h.roundClock ? { source: h.roundClock } : {}),
        ...(programClock ? { program: programClock } : {}),
        ...(h.clockExecution === undefined ? {} : { sourceExecution: h.clockExecution }),
      },
    );
  };
  manager.subscribe(project);
  manager.start();
  let sequence = 6;
  now = 1000;
  manager.consumeObserverRecord({
    ...cursor,
    sequence: sequence++,
    warmup: false,
    round: 0,
    roundClock: {
      totalRoundsPlayed: 0,
      phase: 'freezetime',
      startTime: 1,
      duration: 115,
      committedTick: 99,
      freezePeriod: true,
      warmupPeriod: false,
      bombPlanted: false,
      pause: {
        active: false,
        totalPausedTicks: 0,
        startTick: null,
        technical: null,
        semantics: 'unknown',
      },
      status: 'partial',
    },
  });
  manager.consumeObserverRecord({
    ...cursor,
    sequence: sequence++,
    type: 'raw-event',
    kind: 'begin_new_match',
    name: 'begin_new_match',
    round: 0,
  });
  expect(manager.getHealth().clockExecution).toBe(0);
  const freeze = (round: number, committedTick: number) =>
    manager.consumeObserverRecord({
      ...cursor,
      sequence: sequence++,
      type: 'raw-event',
      kind: 'round_freeze_end',
      name: 'round_freeze_end',
      tick: 0,
      committedTick,
      round,
    });
  const clock = (round: number, committedTick: number, startTime: number, paused = false) => ({
    totalRoundsPlayed: round,
    phase: 'unknown',
    startTime,
    duration: 115,
    committedTick,
    freezePeriod: false,
    warmupPeriod: false,
    bombPlanted: false,
    pause: {
      active: paused,
      totalPausedTicks: 0,
      startTick: null,
      technical: null,
      semantics: 'unknown',
    },
    status: 'partial',
  });
  freeze(0, 100);
  for (let i = 0; i <= 8; i++) {
    now = 3000 + i * 1000;
    manager.consumeObserverRecord({
      ...cursor,
      sequence: sequence++,
      roundClock: clock(0, 128 + i * 64, 1),
    });
  }
  for (let i = 0; i <= 8; i++) {
    now = 123000 + i * 1000;
    programSequence++;
    programClock = { round: 0, remaining: 114 - i, received: now, generation: 1 };
    project();
  }
  expect(timeline.getDiagnostics().calibration).toMatchObject({
    state: 'measured',
    effectiveDelayMs: 120000,
  });
  programClock = undefined;
  now = 132000;
  manager.consumeObserverRecord({
    ...cursor,
    sequence: sequence++,
    roundClock: clock(0, 704, 1, true),
  });
  expect(manager.getHealth().roundClock).toBeUndefined();
  manager.consumeObserverRecord({
    ...cursor,
    sequence: sequence++,
    type: 'raw-event',
    kind: 'round_end',
    name: 'round_end',
  });
  freeze(1, 704);
  for (let i = 0; i <= 8; i++) {
    now = 133000 + i * 1000;
    manager.consumeObserverRecord({
      ...cursor,
      sequence: sequence++,
      roundClock: clock(1, 768 + i * 64, 11),
    });
  }
  expect(manager.getHealth().roundClock).toBeDefined();
  for (let i = 0; i <= 8; i++) {
    now = 253000 + i * 1000;
    programSequence++;
    programClock = { round: 1, remaining: 114 - i, received: now, generation: 1 };
    project();
  }
  expect(timeline.getDiagnostics().calibration).toMatchObject({
    state: 'measured',
    effectiveDelayMs: 120000,
    lastEvidenceMonotonicMs: 260000,
  });
});

it('retains new-map kills received by the manager before Program changes map', async () => {
  const { ObserverHintTimeline } = await import('@mizar/core/projection');
  let now = 0;
  const manager = createObserverSourceManager({
    role: 'lookahead',
    identity,
    clock: { now: () => ({ observedAt: '2026-10-20T08:00:00Z', observedMonotonicMs: now }) },
  });
  const timeline = new ObserverHintTimeline();
  const settings = { enabled: true, expectedDelaySeconds: 120, leadSeconds: 7 };
  const ids = Array.from({ length: 10 }, (_, i) => String(76561198000000123n + BigInt(i)));
  let view: Parameters<typeof timeline.project>[0] = {
    cursor: {
      producerInstanceId: 'test',
      liveSessionId: 'live',
      runtimeSeq: 1,
      programSourceGeneration: 1,
      programReceiveSequence: 1,
      mapEpoch: 1,
    },
    status: { telemetry: 'fresh', context: 'fresh', identity: 'matched' },
    match: { matchId: 'match' },
    map: { name: 'de_test' },
    clock: { phase: 'live' },
    coverage: { allPlayers: 'present' },
    players: ids.map((sourcePlayerId, i) => ({
      sourcePlayerId,
      displayName: `P${i}`,
      observerSlot: i,
      lineupEvidence: 'current' as const,
      lifeState: 'alive' as const,
    })),
  };
  const project = () => {
    const h = manager.getHealth();
    return timeline.project(
      view,
      settings,
      now,
      {
        connected: h.state === 'live',
        generation: h.generation,
        fresh: true,
        sameMap: h.mapName === view.map.name,
        ...(h.mapName ? { mapName: h.mapName } : {}),
      },
      now,
      { ...(h.clockExecution === undefined ? {} : { sourceExecution: h.clockExecution }) },
    );
  };
  manager.subscribe(project);
  manager.subscribeLiveGameEvents((event) => {
    timeline.consume(event);
    project();
  });
  manager.start();
  manager.consumeObserverRecord(cursor);
  now = 1000;
  manager.consumeObserverRecord({ ...cursor, sequence: 7, map: 'de_nuke' });
  const player = (slot: number) => ({
    domain: 'player-controller-slot',
    slot,
    steamId: ids[slot],
    userId: slot + 1,
    controller: { index: slot + 1, serial: 1 },
  });
  now = 2000;
  manager.consumeObserverRecord({
    ...cursor,
    sequence: 8,
    map: 'de_nuke',
    kind: 'player_death',
    name: 'player_death',
    type: 'raw-event',
    committedTick: 99,
    eventServerTick: null,
    fields: {
      userid: 0,
      attacker: 1,
      weapon: 'ak47',
      assistedflash: false,
      headshot: false,
      penetrated: 0,
      noscope: false,
      thrusmoke: false,
      attackerblind: false,
      attackerinair: false,
      distance: 1,
      dmg_health: 100,
      dmg_armor: 0,
      hitgroup: 1,
    },
    players: { userid: player(0), attacker: player(1) },
  });
  now = 3000;
  manager.consumeObserverRecord({ ...cursor, sequence: 9, map: 'de_nuke' });
  now = 4000;
  view = {
    ...view,
    map: { name: 'de_nuke' },
    cursor: { ...view.cursor, mapEpoch: 2, programReceiveSequence: 2 },
  };
  project();
  expect(timeline.getDiagnostics().buffered).toBe(1);
  now = 115000;
  expect(project().observer?.hints).toMatchObject([{ remainingSeconds: 7 }]);
});
