import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { BroadcastManifest } from '@mizar/rivalhub';
import { describe, expect, it, vi } from 'vitest';
import { BombDamageResources } from '../src/projections/bomb-damage-resources.js';

import {
  createProjectionCoordinator,
  type ProjectionCoordinatorOptions,
} from '../src/projections/projection-coordinator.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import {
  createCstvSourceManagers,
  createObserverSourceManager,
} from '../src/telemetry/cstv-source-manager.js';
import type { TelemetryObservation } from '@mizar/core/telemetry';

function observation(): TelemetryObservation {
  return {
    receive: {
      sequence: 1,
      receivedAt: '2026-09-16T00:00:00.000Z',
      receivedMonotonicMs: 0,
    },
    source: { kind: 'cs2-gsi' },
    coverage: {
      provider: 'present',
      map: 'present',
      round: 'absent',
      phaseCountdowns: 'absent',
      player: 'absent',
      allPlayers: 'absent',
      bomb: 'absent',
      grenades: 'absent',
    },
    telemetry: { map: { name: 'de_mirage', phase: 'live' } },
  };
}

function objectiveObservation(
  sequence: number,
  receivedMonotonicMs: number,
  state: 'planted' | 'defusing',
  countdownSeconds: number,
): TelemetryObservation {
  const base = observation();
  return {
    ...base,
    receive: {
      ...base.receive,
      sequence,
      receivedAt: new Date(Date.parse(base.receive.receivedAt) + receivedMonotonicMs).toISOString(),
      receivedMonotonicMs,
    },
    coverage: {
      ...base.coverage,
      round: 'present',
      bomb: 'present',
    },
    telemetry: {
      ...base.telemetry,
      round: { phase: 'live' },
      bomb: { state, countdownSeconds },
    },
  };
}

async function readManifest(): Promise<BroadcastManifest> {
  return JSON.parse(
    await readFile(
      resolve(process.cwd(), 'packages/rivalhub/test/fixtures/broadcast-manifest-v1.valid.json'),
      'utf8',
    ),
  ) as BroadcastManifest;
}

function matchedObservation(manifest: BroadcastManifest): TelemetryObservation {
  const entrantPlayers = (entry: 'a' | 'b', side: 'CT' | 'T') =>
    manifest.entrants[entry].roster.players.slice(0, 5).map((player, index) => ({
      sourcePlayerId:
        player.steam64 ??
        (() => {
          throw new Error('fixture player lacks Steam64');
        })(),
      ...(player.displayName === null ? {} : { displayName: player.displayName }),
      side,
      observerSlot: index,
      state: { health: 100 },
    }));
  const allPlayers = [...entrantPlayers('a', 'CT'), ...entrantPlayers('b', 'T')];
  return {
    receive: {
      sequence: 1,
      receivedAt: '2026-09-16T00:00:00.000Z',
      receivedMonotonicMs: 0,
    },
    source: { kind: 'cs2-gsi' },
    coverage: {
      provider: 'present',
      map: 'present',
      round: 'absent',
      phaseCountdowns: 'absent',
      player: 'present',
      allPlayers: 'present',
      bomb: 'absent',
      grenades: 'absent',
    },
    telemetry: {
      map: {
        name: 'de_ancient',
        phase: 'live',
        sides: {
          ct: { name: manifest.entrants.a.name },
          t: { name: manifest.entrants.b.name },
        },
      },
      allPlayers,
      player: allPlayers[0]!,
    },
  };
}

describe('ProjectionCoordinator', () => {
  it.each([0, 7])(
    'coalesces prediction waits with %i dead players, bounds slow waits, and clears hard boundaries',
    async (deadCount) => {
      let waiting = false;
      let now = 0;
      let flush: (() => void) | undefined;
      const resources = vi.spyOn(BombDamageResources.prototype, 'get').mockReturnValue({
        status: 'ready',
        value: {
          mapName: 'de_mirage',
          modelRevision: 'synthetic-regression',
          resourceSha256: 'a'.repeat(64),
          predict: () =>
            waiting
              ? { status: 'unavailable', reason: 'prediction-loading' }
              : {
                  status: 'predicted',
                  stance: 'standing',
                  damage: 10,
                  hpAfter: 90,
                  lethal: false,
                  modelRevision: 'synthetic-regression',
                  assumptions: [],
                  unknownInputs: [],
                },
        },
      });
      const runtime = createProgramRuntime('batch-regression');
      const coordinator = createProjectionCoordinator({
        programRuntime: runtime,
        cstvSources: createCstvSourceManagers({}),
        nowMonotonicMs: () => now,
        scheduler: {
          setTimeout(callback, delay) {
            if (delay === 16) flush = callback;
            return callback;
          },
          clearTimeout(handle) {
            if (flush === handle) flush = undefined;
          },
        },
      });
      try {
        const players = matchedObservation(await readManifest()).telemetry.allPlayers!.map(
          (p, index) => ({
            ...p,
            state: { ...p.state, health: index < deadCount ? 0 : 100 },
            position: { x: -1000, y: 0, z: 0 },
            forward: { x: 1, y: 0, z: 0 },
          }),
        );
        const send = (sequence: number) => {
          now = sequence * 30;
          const frame = objectiveObservation(sequence, now, 'planted', 8);
          coordinator.afterRuntimeMutation(
            runtime.acceptObservation({
              ...frame,
              coverage: { ...frame.coverage, allPlayers: 'present' },
              telemetry: {
                ...frame.telemetry,
                allPlayers: players,
                bomb: { ...frame.telemetry.bomb!, position: { x: 0, y: 0, z: 0 } },
              },
            }),
          );
        };
        const published = () => coordinator.getPublisher('program').getCurrent()!;
        send(1);
        expect(
          published().payload.bombDamage.players.filter((p) => p.status === 'predicted'),
        ).toHaveLength(10 - deadCount);
        waiting = true;
        send(2);
        expect(coordinator.getCurrent().program.cursor.programReceiveSequence).toBe(2);
        expect(published().cursor.programReceiveSequence).toBe(1);
        waiting = false;
        coordinator.refresh();
        expect(published().cursor.programReceiveSequence).toBe(2);
        expect(flush).toBeUndefined();
        waiting = true;
        send(3);
        expect(published().cursor.programReceiveSequence).toBe(2);
        flush!();
        expect(published().cursor.programReceiveSequence).toBe(3);
        expect(
          published().payload.bombDamage.players.every((p) => p.status === 'unavailable'),
        ).toBe(true);
        send(4);
        expect(flush).toBeDefined();
        players[deadCount]!.state.health = 0;
        send(5);
        expect(published().cursor.programReceiveSequence).toBe(5);
        expect(flush).toBeUndefined();
        coordinator.afterRuntimeMutation(
          runtime.advanceProgramSourceGeneration({
            monotonicMs: now + 1,
            utc: new Date(Date.parse('2026-09-16T00:00:00Z') + now + 1).toISOString(),
          }),
        );
        expect(published().payload.bombDamage.status).toBe('unavailable');
        expect(published().cursor.programSourceGeneration).toBe(1);
        expect(flush).toBeUndefined();
      } finally {
        await coordinator.close();
        resources.mockRestore();
      }
    },
  );
});

it('publishes assist refreshes independently of Program and public radar snapshots', async () => {
  const runtime = createProgramRuntime('assist-isolation');
  const coordinator = createProjectionCoordinator({
    programRuntime: runtime,
    cstvSources: createCstvSourceManagers({}),
    observerSettings: () => ({
      enabled: true,
      expectedDelaySeconds: 120,
      leadSeconds: 7,
    }),
  });
  try {
    const program = coordinator.getPublisher('program').getCurrent();
    const radar = coordinator.getPublisher('radar').getCurrent();
    const before = coordinator.getPublisher('assist').getCurrent()!.channelSeq;
    coordinator.resetAssist();
    coordinator.refreshAssist();
    expect(coordinator.getPublisher('program').getCurrent()).toBe(program);
    expect(coordinator.getPublisher('radar').getCurrent()).toBe(radar);
    expect(coordinator.getPublisher('assist').getCurrent()!.channelSeq).toBeGreaterThan(before);
    expect(JSON.stringify(program)).not.toContain('observer');
  } finally {
    await coordinator.close();
  }
});

it('keeps calibrated anchors and buffered kills when the lead window is reprojected', async () => {
  const manifest = await readManifest();
  const initial = matchedObservation(manifest);
  const sources = createCstvSourceManagers({});
  const health = sources.lookahead.getHealth();
  const live = vi
    .spyOn(sources.lookahead, 'getHealth')
    .mockReturnValue({ ...health, state: 'live', generation: 1 });
  let consume: Parameters<typeof sources.lookahead.subscribeLiveGameEvents>[0] | undefined;
  const subscription = vi
    .spyOn(sources.lookahead, 'subscribeLiveGameEvents')
    .mockImplementation((listener) => {
      consume = listener;
      return () => {};
    });
  const runtime = createProgramRuntime('lead-calibration-regression');
  let now = 0,
    sequence = 0;
  const diagnostics = vi.fn<NonNullable<ProjectionCoordinatorOptions['onObserverDiagnostics']>>();
  const settings = { enabled: true, expectedDelaySeconds: 120, leadSeconds: 7 };
  const coordinator = createProjectionCoordinator({
    programRuntime: runtime,
    cstvSources: sources,
    nowMonotonicMs: () => now,
    observerSettings: () => settings,
    onObserverDiagnostics: diagnostics,
  });
  const send = (time: number, dead: number[] = []) => {
    now = time;
    const players = initial.telemetry.allPlayers!.map((player, index) => ({
      ...player,
      observerSlot: index,
      state: { health: dead.includes(index) ? 0 : 100 },
    }));
    coordinator.afterRuntimeMutation(
      runtime.acceptObservation({
        ...initial,
        receive: {
          sequence: ++sequence,
          receivedAt: new Date(Date.parse(initial.receive.receivedAt) + now).toISOString(),
          receivedMonotonicMs: now,
        },
        coverage: { ...initial.coverage, round: 'present' },
        telemetry: {
          ...initial.telemetry,
          round: { phase: 'live' },
          allPlayers: players,
          player: players[0]!,
        },
      }),
    );
  };
  const kill = (eventSequence: number, victim: number, time: number) => {
    send(time);
    consume!({
      kind: 'player-death',
      cursor: {
        kind: 'cs2-cstv',
        role: 'lookahead',
        generation: 1,
        sequence: eventSequence,
        tick: (time * 64) / 1000,
        ticksPerSecond: 64,
        observedAt: new Date(Date.parse(initial.receive.receivedAt) + time).toISOString(),
        observedMonotonicMs: time,
        mapName: 'de_ancient',
      },
      victim: {
        sourceUserId: victim,
        sourcePlayerId: initial.telemetry.allPlayers![victim]!.sourcePlayerId,
      },
      attacker: {
        sourceUserId: 3,
        sourcePlayerId: initial.telemetry.allPlayers![3]!.sourcePlayerId,
      },
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
    });
  };
  try {
    send(0);
    kill(1, 8, 1000);
    kill(2, 9, 2000);
    kill(3, 7, 10000);
    send(121000, [8]);
    send(122000, [8, 9]);
    expect(coordinator.getCurrent().assist.observer).toMatchObject({
      state: 'ready',
      timingBasis: 'estimated',
      waitingReason: 'buffering',
      nextWindowSeconds: 1,
      measuredDelaySeconds: null,
      hints: [],
    });
    expect(diagnostics.mock.lastCall?.[0].source).toMatchObject({
      freshness: 'unknown',
      lastReceiveMonotonicMs: null,
      receiveAgeMs: null,
    });
    const program = coordinator.getPublisher('program').getCurrent();
    const radar = coordinator.getPublisher('radar').getCurrent();
    expect(coordinator.getPublisher('assist').getCurrent()!.payload.observer).toMatchObject({
      timingBasis: 'estimated',
      nextWindowSeconds: 1,
    });
    const before = coordinator.getPublisher('assist').getCurrent()!.channelSeq;
    settings.leadSeconds = 10;
    coordinator.refreshAssist();
    expect(coordinator.getCurrent().assist.observer).toMatchObject({
      state: 'ready',
      measuredDelaySeconds: null,
      hints: [{ remainingSeconds: 8, victim: { observerSlot: 7 } }],
    });
    expect(coordinator.getPublisher('assist').getCurrent()!.channelSeq).toBeGreaterThan(before);
    expect(coordinator.getPublisher('program').getCurrent()).toBe(program);
    expect(coordinator.getPublisher('radar').getCurrent()).toBe(radar);
    settings.expectedDelaySeconds = 130;
    coordinator.resetAssist();
    expect(coordinator.getCurrent().assist.observer).toMatchObject({
      state: 'ready',
      measuredDelaySeconds: null,
      hints: [],
    });
    live.mockReturnValue({
      ...health,
      state: 'live',
      generation: 1,
      lastReceiveMonotonicMs: now,
      lastSync: {
        protocol: 1,
        tick: 1,
        ticksPerSecond: 64,
        fragment: 1,
        signupFragment: 0,
        mapName: 'de_ancient',
        receiveAgeSeconds: 9999,
      },
    });
    coordinator.refreshAssist();
    expect(coordinator.getCurrent().assist.observer?.state).toBe('ready');
    live.mockReturnValue({
      ...health,
      state: 'live',
      generation: 1,
      lastReceiveMonotonicMs: 0,
      lastSync: {
        protocol: 1,
        tick: 1,
        ticksPerSecond: 64,
        fragment: 1,
        signupFragment: 0,
        mapName: 'de_ancient',
        receiveAgeSeconds: 30,
      },
    });
    coordinator.refreshAssist();
    expect(coordinator.getCurrent().assist.observer).toMatchObject({
      state: 'unavailable',
      waitingReason: 'source-stale',
      hints: [],
    });
    live.mockReturnValue({
      ...health,
      state: 'live',
      generation: 1,
      lastReceiveMonotonicMs: now,
      lastSync: {
        protocol: 1,
        tick: 1,
        ticksPerSecond: 64,
        fragment: 1,
        signupFragment: 0,
        mapName: 'de_nuke',
        receiveAgeSeconds: 0,
      },
    });
    coordinator.refreshAssist();
    expect(coordinator.getCurrent().assist.observer).toMatchObject({
      state: 'unavailable',
      waitingReason: 'source-map-mismatch',
      hints: [],
    });
  } finally {
    await coordinator.close();
    live.mockRestore();
    subscription.mockRestore();
  }
});

it('isolates only observer diagnostic sink failures from assist and Program publication', async () => {
  const sink = vi.fn(() => {
    throw new Error('diagnostic disk unavailable');
  });
  const onDiagnostic = vi.fn();
  let businessFailure = false;
  const coordinator = createProjectionCoordinator({
    programRuntime: createProgramRuntime('diagnostic-sink-failure'),
    cstvSources: createCstvSourceManagers({}),
    observerSettings: () => {
      if (businessFailure) throw new Error('business settings failure');
      return { enabled: true, expectedDelaySeconds: 120, leadSeconds: 7 };
    },
    onObserverDiagnostics: sink,
    onDiagnostic,
  });
  try {
    const programSequence = coordinator.getPublisher('program').getCurrent()!.channelSeq;
    const assistSequence = coordinator.getPublisher('assist').getCurrent()!.channelSeq;
    expect(() => coordinator.refreshAssist()).not.toThrow();
    expect(coordinator.getPublisher('assist').getCurrent()!.channelSeq).toBeGreaterThan(
      assistSequence,
    );
    expect(coordinator.getPublisher('program').getCurrent()!.channelSeq).toBe(programSequence);
    expect(() => coordinator.refresh()).not.toThrow();
    expect(coordinator.getPublisher('program').getCurrent()!.channelSeq).toBeGreaterThan(
      programSequence,
    );
    expect(sink).toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith({ code: 'observer-assist-diagnostic-sink-failed' });
    businessFailure = true;
    expect(() => coordinator.refreshAssist()).toThrow('business settings failure');
  } finally {
    await coordinator.close();
  }
});

it('uses actual observer cursor reception without kills and detects an open but silent source', async () => {
  const initial = matchedObservation(await readManifest());
  let now = 0,
    sequence = 0;
  const diagnostics = vi.fn<NonNullable<ProjectionCoordinatorOptions['onObserverDiagnostics']>>();
  const identity = {
    source: 'ahead:cursor-freshness',
    role: 'ahead' as const,
    channel: 1,
    world: 1,
  };
  const lookahead = createObserverSourceManager({
    role: 'lookahead',
    identity,
    clock: { now: () => ({ observedAt: '2026-10-25T00:00:00Z', observedMonotonicMs: now }) },
  });
  lookahead.start();
  const sources = { ...createCstvSourceManagers({}), lookahead };
  const runtime = createProgramRuntime('cursor-freshness');
  const coordinator = createProjectionCoordinator({
    programRuntime: runtime,
    cstvSources: sources,
    nowMonotonicMs: () => now,
    observerSettings: () => ({ enabled: true, expectedDelaySeconds: 120, leadSeconds: 7 }),
    onObserverDiagnostics: diagnostics,
  });
  const sendProgram = () =>
    coordinator.afterRuntimeMutation(
      runtime.acceptObservation({
        ...initial,
        receive: { ...initial.receive, sequence: ++sequence, receivedMonotonicMs: now },
        coverage: { ...initial.coverage, round: 'present' },
        telemetry: { ...initial.telemetry, round: { phase: 'live' } },
      }),
    );
  const cursor = (id: number) => ({
    ...identity,
    kind: 'cursor',
    sequence: id,
    tick: id * 640,
    tickInterval: 1 / 64,
    map: 'de_ancient',
  });
  try {
    for (let id = 1; id <= 13; id++) {
      now = (id - 1) * 10000;
      lookahead.consumeObserverRecord(cursor(id));
      sendProgram();
      expect(coordinator.getCurrent().assist.observer).toMatchObject({
        state: 'ready',
        waitingReason: 'waiting-event',
        hints: [],
      });
      expect(diagnostics.mock.lastCall?.[0].source).toMatchObject({
        freshness: 'fresh',
        lastReceiveMonotonicMs: now,
        receiveAgeMs: 0,
      });
    }
    expect(lookahead.getRecentGameEvents()).toEqual([]);
    expect(lookahead.getHealth().lastSync).toBeUndefined();
    now += 20001;
    sendProgram();
    expect(lookahead.getHealth().state).toBe('live'); // Pipe lifecycle has not ended.
    expect(coordinator.getCurrent().assist.observer).toMatchObject({
      state: 'unavailable',
      waitingReason: 'source-stale',
      hints: [],
    });
    expect(diagnostics.mock.lastCall?.[0].source).toMatchObject({
      freshness: 'stale',
      receiveAgeMs: 20001,
    });
    lookahead.consumeObserverRecord({ ...cursor(14), tickInterval: 0 });
    expect(lookahead.getHealth().lastReceiveMonotonicMs).toBe(120000);
    lookahead.consumeObserverRecord(cursor(15));
    sendProgram();
    expect(coordinator.getCurrent().assist.observer?.state).toBe('ready');
    lookahead.consumeObserverRecord({ ...cursor(16), map: 'de_nuke' });
    sendProgram();
    expect(coordinator.getCurrent().assist.observer).toMatchObject({
      state: 'unavailable',
      waitingReason: 'source-map-mismatch',
      hints: [],
    });
    lookahead.disconnectObserver();
    expect(lookahead.getHealth().lastReceiveMonotonicMs).toBeUndefined();
  } finally {
    await coordinator.close();
    await lookahead.stop();
  }
});
