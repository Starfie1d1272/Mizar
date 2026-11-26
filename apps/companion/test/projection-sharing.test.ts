import { describe, expect, it } from 'vitest';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import {
  createCstvSourceManagers,
  type CstvSourceHealth,
  type CstvSourceManager,
  type CstvSourceManagers,
} from '../src/telemetry/cstv-source-manager.js';

import type { MatchContext } from '@mizar/core/match-context';
import type { TelemetryObservation } from '@mizar/core/telemetry';

function makeObservation(receiveSeq: number, playerX = 100): TelemetryObservation {
  return {
    receive: {
      sequence: receiveSeq,
      receivedAt: '2026-11-26T00:00:00.000Z',
      receivedMonotonicMs: 1000 + receiveSeq * 50,
    },
    source: { kind: 'cs2-gsi' },
    coverage: {
      provider: 'present',
      map: 'present',
      round: 'present',
      phaseCountdowns: 'present',
      player: 'present',
      allPlayers: 'present',
      bomb: 'present',
      grenades: 'absent',
    },
    telemetry: {
      map: {
        name: 'de_ancient',
        mode: 'competitive',
        phase: 'live' as const,
        roundNumber: 1,
        sides: { ct: { score: 0 }, t: { score: 0 } },
      },
      round: { phase: 'live' as const },
      phaseCountdowns: { phase: 'live' as const, endsInSeconds: 100 },
      player: { sourcePlayerId: '76561198000000001' },
      allPlayers: [
        {
          sourcePlayerId: '76561198000000001',
          displayName: 'Player1',
          side: 'CT' as const,
          observerSlot: 1,
          activity: 'playing',
          position: { x: playerX, y: 200, z: 0 },
          forward: { x: 1, y: 0, z: 0 },
          state: { health: 100 },
          matchStats: { kills: 0, assists: 0, deaths: 0, mvps: 0, score: 0 },
          weapons: [],
        },
      ],
      bomb: { state: 'carried' as const },
    },
  };
}

describe('ProjectionCoordinator projection sharing and propagation', () => {
  it('shares program and gameplay projection when identity is not mismatched and propagates every frame', async () => {
    let now = 1000;
    const runtime = createProgramRuntime('test-prod');
    const cstvSources = createCstvSourceManagers();
    const notifications: number[] = [];
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources,
      nowMonotonicMs: () => now,
      onProjection: (bundle) => {
        notifications.push(bundle.program.cursor.programReceiveSequence ?? 0);
      },
    });

    const commit1 = runtime.acceptObservation(makeObservation(1, 100));
    now = 1050;
    const bundle1 = coordinator.afterRuntimeMutation(commit1);
    const pub1 = coordinator.getPublisher('program').getCurrent();
    expect(pub1?.payload.map.name).toBe('de_ancient');
    expect(bundle1.operator.runtime.lastAccepted?.receiveSequence).toBe(1);

    // Second frame with only position change still propagates operator receiveSequence & onProjection
    const commit2 = runtime.acceptObservation(makeObservation(2, 150));
    now = 1100;
    const bundle2 = coordinator.afterRuntimeMutation(commit2);
    expect(bundle2.operator.runtime.lastAccepted?.receiveSequence).toBe(2);
    expect(notifications).toEqual([0, 1, 2]);

    await coordinator.close();
  });

  it('throttles operator broadcasts during stable high-frequency GSI frames while keeping program/radar cursors aligned', async () => {
    let now = 1000;
    const runtime = createProgramRuntime('test-prod');
    let lookaheadHealth: CstvSourceHealth<'lookahead'> = {
      role: 'lookahead',
      state: 'disabled',
      generation: 0,
    };
    const healthListeners = new Set<() => void>();
    const makeSource = <R extends 'program' | 'lookahead'>(
      role: R,
      readHealth: () => CstvSourceHealth<R>,
    ): CstvSourceManager<R> => ({
      role,
      start: () => undefined,
      stop: () => Promise.resolve(),
      getHealth: readHealth,
      getRecentGameEvents: () => [],
      getRecentDiagnostics: () => [],
      getSnapshot: () => ({ health: readHealth(), recentGameEvents: [], recentDiagnostics: [] }),
      subscribe: (listener) => {
        if (role === 'lookahead') healthListeners.add(listener);
        return () => healthListeners.delete(listener);
      },
      subscribeLiveGameEvents: () => () => undefined,
    });
    const cstvSources: CstvSourceManagers = {
      program: makeSource('program', () => ({ role: 'program', state: 'disabled', generation: 0 })),
      lookahead: makeSource('lookahead', () => lookaheadHealth),
    };
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources,
      nowMonotonicMs: () => now,
    });

    // Frame 1 (baseline) and Frame 2 (contiguous) establish steady-state disposition
    now = 1050;
    coordinator.afterRuntimeMutation(runtime.acceptObservation(makeObservation(1, 100)));
    now = 1100;
    coordinator.afterRuntimeMutation(runtime.acceptObservation(makeObservation(2, 120)));

    const programPub = coordinator.getPublisher('program');
    const radarPub = coordinator.getPublisher('radar');
    const operatorPub = coordinator.getPublisher('operator');

    const opSeqBefore = operatorPub.getCurrent()!.channelSeq;
    const progSeqBefore = programPub.getCurrent()!.channelSeq;
    const radarSeqBefore = radarPub.getCurrent()!.channelSeq;

    // High-frequency coordinate-only frames within 1000ms window:
    // program & radar advance every frame with identical cursors; operator broadcast is throttled.
    for (const [seq, ts, x] of [
      [3, 1150, 140],
      [4, 1200, 160],
      [5, 1250, 180],
    ] as const) {
      now = ts;
      const bundle = coordinator.afterRuntimeMutation(
        runtime.acceptObservation(makeObservation(seq, x)),
      );
      expect(bundle.operator.runtime.lastAccepted?.receiveSequence).toBe(seq);
      expect(programPub.getCurrent()!.cursor).toEqual(radarPub.getCurrent()!.cursor);
    }

    expect(programPub.getCurrent()!.channelSeq).toBe(progSeqBefore + 3);
    expect(radarPub.getCurrent()!.channelSeq).toBe(radarSeqBefore + 3);
    expect(operatorPub.getCurrent()!.channelSeq).toBe(opSeqBefore);
    expect(operatorPub.getCurrent()!.payload.runtime.lastAccepted?.receiveSequence).toBe(2);

    // Crossing the 1000ms throttle window refreshes operator heartbeat
    now = 2100;
    coordinator.afterRuntimeMutation(runtime.acceptObservation(makeObservation(6, 200)));
    expect(operatorPub.getCurrent()!.channelSeq).toBe(opSeqBefore + 1);
    expect(operatorPub.getCurrent()!.payload.runtime.lastAccepted?.receiveSequence).toBe(6);

    // CSTV source health change publishes operator immediately
    now = 2150;
    lookaheadHealth = { role: 'lookahead', state: 'live', generation: 1, mapName: 'de_ancient' };
    for (const listener of healthListeners) listener();
    expect(operatorPub.getCurrent()!.channelSeq).toBe(opSeqBefore + 2);
    expect(operatorPub.getCurrent()!.payload.sources.cstvLookahead.state).toBe('live');

    // Match context binding change publishes operator immediately
    now = 2200;
    const context = {
      schemaVersion: 'mizar.match-document.v1',
      matchId: 'match-1',
      competition: {
        competitionId: 'comp-1',
        slug: 'comp-1',
        name: 'Test Cup',
        logoUrl: null,
        themeColor: null,
      },
      status: 'live',
      format: 'bo1',
      stage: 'group',
      stageLabel: 'Group',
      round: null,
      roundLabel: null,
      entryRound: null,
      matchLabel: null,
      stakesLabel: null,
      scheduledAt: null,
      startedAt: null,
      completedAt: null,
      scoreA: null,
      scoreB: null,
      isForfeit: false,
      entrants: {
        a: { entryId: 'a', name: 'Team A', logoUrl: null, rosterId: null, players: [] },
        b: { entryId: 'b', name: 'Team B', logoUrl: null, rosterId: null, players: [] },
      },
      mapPool: ['de_ancient'],
      maps: [],
      veto: [],
      commentators: [],
    } as unknown as MatchContext;
    const committed = runtime.bindContext(context, 'local');
    coordinator.setMatchContextBinding(
      {
        manifest: context as unknown as NonNullable<
          Parameters<typeof createProjectionCoordinator>[0]['matchContextBinding']
        >['manifest'],
        context,
        origin: 'local',
        freshness: 'fresh',
        diagnostics: [],
      },
      committed,
    );
    expect(operatorPub.getCurrent()!.channelSeq).toBe(opSeqBefore + 3);
    expect(operatorPub.getCurrent()!.payload.matchContext.summary?.matchId).toBe('match-1');

    await coordinator.close();
  });

  it('keeps program and radar cursors aligned across prediction coalescing and completion', async () => {
    let now = 1000;
    const runtime = createProgramRuntime('test-prod');
    const cstvSources = createCstvSourceManagers();
    const scheduled: (() => void)[] = [];
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources,
      nowMonotonicMs: () => now,
      predictionPublishCoalescing: true,
      scheduler: {
        setTimeout: (cb) => {
          scheduled.push(cb);
          return scheduled.length;
        },
        clearTimeout: () => undefined,
      },
    });

    const plantedObs = (seq: number): TelemetryObservation => ({
      ...makeObservation(seq, 100 + seq),
      receive: {
        sequence: seq,
        receivedAt: '2026-11-26T00:00:00.000Z',
        receivedMonotonicMs: now,
      },
      telemetry: {
        ...makeObservation(seq, 100 + seq).telemetry,
        bomb: {
          state: 'planted',
          countdownSeconds: 35,
          position: { x: 100, y: 200, z: 0 },
        },
      },
    });

    now = 1050;
    coordinator.afterRuntimeMutation(runtime.acceptObservation(plantedObs(1)));
    const programPub = coordinator.getPublisher('program');
    const radarPub = coordinator.getPublisher('radar');
    expect(programPub.getCurrent()!.cursor).toEqual(radarPub.getCurrent()!.cursor);

    now = 1100;
    const bundle2 = coordinator.afterRuntimeMutation(runtime.acceptObservation(plantedObs(2)));
    expect(bundle2.program.cursor.programReceiveSequence).toBe(2);
    expect(coordinator.getCurrent().program.cursor.programReceiveSequence).toBe(2);
    expect(programPub.getCurrent()!.cursor).toEqual(radarPub.getCurrent()!.cursor);

    // Drain any scheduled coalescing or stale timer callbacks
    for (const cb of scheduled.splice(0, scheduled.length)) cb();
    expect(programPub.getCurrent()!.cursor).toEqual(radarPub.getCurrent()!.cursor);

    await coordinator.close();
  });
});
