import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { BroadcastManifest } from '@mizar/rivalhub';
import { describe, expect, it, vi } from 'vitest';
import { BombDamageResources } from '../src/projections/bomb-damage-resources.js';

import {
  createProjectionCoordinator,
  type ProjectionScheduler,
} from '../src/projections/projection-coordinator.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import {
  createCstvSourceManagers,
  type CstvSourceManager,
  type CstvSourceManagers,
} from '../src/telemetry/cstv-source-manager.js';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import {
  MatchContextController,
  MatchManifestLkgStore,
  SourceLoadError,
} from '../src/match-context/index.js';

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

class ManualProjectionScheduler implements ProjectionScheduler {
  readonly delays: number[] = [];
  private readonly callbacks = new Map<() => void, () => void>();

  setTimeout(callback: () => void, delayMs: number): unknown {
    this.delays.push(delayMs);
    this.callbacks.set(callback, callback);
    return callback;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as () => void);
  }

  runNext(): void {
    const callback = this.callbacks.values().next().value as (() => void) | undefined;
    if (callback === undefined) return;
    this.callbacks.delete(callback);
    callback();
  }

  pendingCount(): number {
    return this.callbacks.size;
  }
}

function observableCstvSources(): {
  readonly sources: CstvSourceManagers;
  readonly emitLookahead: () => void;
} {
  const createSource = <R extends 'program' | 'lookahead'>(role: R) => {
    const listeners = new Set<() => void>();
    const source: CstvSourceManager<R> & { emit(): void } = {
      role,
      start: () => {},
      stop: async () => {},
      getHealth: () => ({ role, state: 'disabled', generation: 0, reconnectAttempt: 0 }),
      getRecentGameEvents: () => [],
      getRecentDiagnostics: () => [],
      getSnapshot: () => ({
        health: { role, state: 'disabled', generation: 0, reconnectAttempt: 0 },
        recentGameEvents: [],
        recentDiagnostics: [],
      }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeLiveGameEvents: () => () => {},
      emit: () => {
        for (const listener of listeners) listener();
      },
    };
    return source;
  };
  const program = createSource('program');
  const lookahead = createSource('lookahead');
  return { sources: { program, lookahead }, emitLookahead: () => lookahead.emit() };
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
  it('routes CSTV health changes to Operator without advancing other channel sequences', async () => {
    const { sources, emitLookahead } = observableCstvSources();
    const runtime = createProgramRuntime('coordinator-cstv-side-channel');
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: sources,
      nowMonotonicMs: () => 0,
    });
    const initial = {
      program: coordinator.getPublisher('program').getCurrent()?.channelSeq,
      radar: coordinator.getPublisher('radar').getCurrent()?.channelSeq,
      operator: coordinator.getPublisher('operator').getCurrent()?.channelSeq,
      assist: coordinator.getPublisher('assist').getCurrent()?.channelSeq,
    };

    emitLookahead();

    expect(coordinator.getPublisher('program').getCurrent()?.channelSeq).toBe(initial.program);
    expect(coordinator.getPublisher('radar').getCurrent()?.channelSeq).toBe(initial.radar);
    expect(coordinator.getPublisher('assist').getCurrent()?.channelSeq).toBe(initial.assist);
    expect(coordinator.getPublisher('operator').getCurrent()?.channelSeq).toBe(
      (initial.operator ?? 0) + 1,
    );

    await coordinator.close();
  });

  it('publishes current baseline snapshots and refreshes after accepted runtime mutation', async () => {
    const runtime = createProgramRuntime('coordinator-producer');
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: createCstvSourceManagers({}),
      nowMonotonicMs: () => 0,
    });
    const sent: string[] = [];
    const subscription = coordinator.getPublisher('program').subscribe((snapshot) => {
      sent.push(`${snapshot.channel}:${snapshot.channelSeq}:${snapshot.payload.map.name}`);
      return Promise.resolve();
    });

    expect(sent).toEqual(['program:1:null']);
    const result = runtime.acceptObservation(observation());
    coordinator.afterRuntimeMutation(result);
    await Promise.resolve();
    await Promise.resolve();

    expect(sent).toEqual(['program:1:null', 'program:2:de_mirage']);
    expect(coordinator.getCurrent().program.status.telemetry).toBe('fresh');
    expect(coordinator.getPublisher('radar').getCurrent()?.channel).toBe('radar');
    expect(coordinator.getPublisher('operator').getCurrent()?.channel).toBe('operator');
    expect(coordinator.getPublisher('assist').getCurrent()?.payload).toEqual({
      availability: 'unavailable',
    });
    expect(coordinator.getPublisher('operator').getCurrent()?.payload).not.toHaveProperty(
      'recentGameEvents',
    );
    expect(coordinator.getPublisher('operator').getCurrent()?.payload.seriesProgress).toBeNull();

    await subscription.close();
    await coordinator.close();
  });

  it('retains the resolved 10-person Program lineup across same-map source reconnect', async () => {
    const manifest = await readManifest();
    const runtime = createProgramRuntime('coordinator-lineup-reconnect');
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: createCstvSourceManagers({}),
      nowMonotonicMs: () => 0,
    });
    const initialObservation = matchedObservation(manifest);

    coordinator.afterRuntimeMutation(runtime.acceptObservation(initialObservation));
    expect(coordinator.getCurrent().program.players).toHaveLength(10);

    const reconnect = runtime.advanceProgramSourceGeneration({
      monotonicMs: 1,
      utc: '2026-09-16T00:00:00.001Z',
    });
    coordinator.afterRuntimeMutation(reconnect);

    const retained = coordinator.getCurrent().program;
    expect(retained.players).toHaveLength(10);
    expect(retained.players.every((player) => player.lineupEvidence === 'retained')).toBe(true);
    expect(
      retained.players.every(
        (player) =>
          player.state === null &&
          player.matchStats === null &&
          player.weapons.length === 0 &&
          player.activity === null &&
          player.observerSlot === null &&
          player.lifeState === 'unknown',
      ),
    ).toBe(true);

    await coordinator.close();
  });

  it('publishes one time-driven stale transition and reschedules only for a new frame', async () => {
    let now = 0;
    const scheduler = new ManualProjectionScheduler();
    const runtime = createProgramRuntime('coordinator-stale', {
      continuityPolicy: { staleAfterMs: 100 },
    });
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: createCstvSourceManagers({}),
      nowMonotonicMs: () => now,
      scheduler,
    });
    const published: number[] = [];
    const subscription = coordinator.getPublisher('program').subscribe((snapshot) => {
      published.push(snapshot.channelSeq);
      return Promise.resolve();
    });

    coordinator.afterRuntimeMutation(runtime.acceptObservation(observation()));
    expect(coordinator.getCurrent().program.status.telemetry).toBe('fresh');
    expect(scheduler.delays).toEqual([100]);
    expect(scheduler.pendingCount()).toBe(1);

    now = 101;
    scheduler.runNext();
    expect(coordinator.getCurrent().program.status.telemetry).toBe('stale');
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toEqual([1, 3]);
    expect(scheduler.pendingCount()).toBe(0);

    const mapReset = runtime.resetMapExecution('operator-correction', {
      monotonicMs: 200,
      utc: '2026-09-16T00:00:00.200Z',
    });
    coordinator.afterRuntimeMutation(mapReset);
    expect(scheduler.pendingCount()).toBe(0);

    const next = observation();
    now = 300;
    coordinator.afterRuntimeMutation(
      runtime.acceptObservation({
        ...next,
        receive: {
          ...next.receive,
          sequence: 2,
          receivedAt: '2026-09-16T00:00:00.300Z',
          receivedMonotonicMs: 300,
        },
      }),
    );
    expect(coordinator.getCurrent().program.status.telemetry).toBe('fresh');
    expect(scheduler.delays).toEqual([100, 100]);
    expect(scheduler.pendingCount()).toBe(1);

    await subscription.close();
    await coordinator.close();
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('expires objective numeric clocks on the existing stale timer without marking telemetry stale', async () => {
    let now = 0;
    const scheduler = new ManualProjectionScheduler();
    const runtime = createProgramRuntime('coordinator-objective-clock', {
      continuityPolicy: { staleAfterMs: 20_000 },
    });
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: createCstvSourceManagers({}),
      nowMonotonicMs: () => now,
      scheduler,
    });

    coordinator.afterRuntimeMutation(
      runtime.acceptObservation(objectiveObservation(1, 0, 'planted', 30)),
    );
    expect(coordinator.getCurrent().program.bomb?.explosion?.remainingSeconds).toBe(30);
    expect(scheduler.delays).toEqual([1_000]);

    now = 1_001;
    scheduler.runNext();
    expect(coordinator.getCurrent().program.status.telemetry).toBe('fresh');
    expect(coordinator.getCurrent().program.bomb?.explosion?.remainingSeconds).toBeNull();
    expect(scheduler.pendingCount()).toBe(1);

    now = 1_002;
    coordinator.afterRuntimeMutation(
      runtime.acceptObservation(objectiveObservation(2, now, 'planted', 29)),
    );
    expect(coordinator.getCurrent().program.bomb?.explosion?.remainingSeconds).toBe(29);
    expect(scheduler.delays.at(-1)).toBe(1_000);

    await coordinator.close();
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('preserves matched identity and branding across same-context stale memory fallback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rivalhub-projection-coordinator-'));
    try {
      const manifest = await readManifest();
      const manifestWithScore = {
        ...manifest,
        match: { ...manifest.match, scoreA: 1, scoreB: 0 },
      } as BroadcastManifest;
      const runtime = createProgramRuntime('coordinator-context', {
        continuityPolicy: { staleAfterMs: 100 },
      });
      let now = 0;
      const coordinator = createProjectionCoordinator({
        programRuntime: runtime,
        cstvSources: createCstvSourceManagers({}),
        nowMonotonicMs: () => now,
      });
      const controller = new MatchContextController({
        lkgStore: new MatchManifestLkgStore({ filePath: join(root, 'manifest.json') }),
        onBindingChanged: (binding) => coordinator.setMatchContextBinding(binding),
      });

      coordinator.afterRuntimeMutation(
        runtime.acceptObservation(matchedObservation(manifestWithScore)),
      );
      const fresh = await controller.selectMatch(manifestWithScore.match.matchId, {
        kind: 'fixture',
        load: () => Promise.resolve(manifestWithScore),
      });
      expect(fresh.ok).toBe(true);
      if (!fresh.ok) throw new Error('fixture match context should bind');
      expect(coordinator.getCurrent().identity.state).toBe('matched');
      expect(coordinator.getCurrent().program.teams.ct).toMatchObject({
        mode: 'canonical',
        name: manifestWithScore.entrants.a.name,
        seriesScore: 1,
      });
      const runtimeSeq = runtime.getSnapshot().current.runtimeSeq;
      const channelSeq = coordinator.getPublisher('program').getCurrent()?.channelSeq;

      now = 10;
      const stale = await controller.selectMatch(manifestWithScore.match.matchId, {
        kind: 'online',
        load: () => Promise.reject(new SourceLoadError('offline')),
      });
      expect(stale.ok).toBe(true);
      if (!stale.ok) throw new Error('same-match memory fallback should bind');
      expect(stale.binding.context).toBe(fresh.binding.context);
      expect(coordinator.getCurrent().identity.state).toBe('matched');
      expect(coordinator.getCurrent().program.status.context).toBe('stale');
      expect(coordinator.getCurrent().program.teams.ct).toMatchObject({
        mode: 'canonical',
        name: manifestWithScore.entrants.a.name,
        seriesScore: 1,
      });
      expect(coordinator.getCurrent().program.teams.t.seriesScore).toBe(0);
      expect(runtime.getSnapshot().current.runtimeSeq).toBe(runtimeSeq);
      expect(coordinator.getPublisher('program').getCurrent()?.channelSeq).toBe(
        (channelSeq ?? 0) + 1,
      );

      await coordinator.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
