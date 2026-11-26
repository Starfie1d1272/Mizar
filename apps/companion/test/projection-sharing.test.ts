import { describe, expect, it } from 'vitest';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import {
  createCstvSourceManagers,
  type CstvSourceHealth,
  type CstvSourceManager,
  type CstvSourceManagers,
} from '../src/telemetry/cstv-source-manager.js';

import type { RoleScopedGameEventObservation } from '@mizar/core/game-events';
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

  it('throttles operator heartbeat during stable high-frequency GSI frames and publishes immediately on structural or source changes', async () => {
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
      getSnapshot: () => ({
        health: readHealth(),
        recentGameEvents: [],
        recentDiagnostics: [],
      }),
      subscribe: (listener) => {
        if (role === 'lookahead') healthListeners.add(listener);
        return () => {
          healthListeners.delete(listener);
        };
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

    // High-frequency coordinate-only frames within 1000ms window: program & radar update every frame, operator is throttled
    for (const [seq, ts, x] of [
      [3, 1150, 140],
      [4, 1200, 160],
      [5, 1250, 180],
    ] as const) {
      now = ts;
      coordinator.afterRuntimeMutation(runtime.acceptObservation(makeObservation(seq, x)));
    }

    expect(programPub.getCurrent()!.channelSeq).toBe(progSeqBefore + 3);
    expect(programPub.getCurrent()!.cursor.programReceiveSequence).toBe(5);
    expect(radarPub.getCurrent()!.channelSeq).toBe(radarSeqBefore + 3);
    expect(radarPub.getCurrent()!.cursor.programReceiveSequence).toBe(5);
    expect(operatorPub.getCurrent()!.channelSeq).toBe(opSeqBefore);
    expect(operatorPub.getCurrent()!.payload.runtime.lastAccepted?.receiveSequence).toBe(2);

    // Crossing the 1000ms throttle window refreshes operator heartbeat
    now = 2100;
    coordinator.afterRuntimeMutation(runtime.acceptObservation(makeObservation(6, 200)));
    expect(operatorPub.getCurrent()!.channelSeq).toBe(opSeqBefore + 1);
    expect(operatorPub.getCurrent()!.payload.runtime.lastAccepted?.receiveSequence).toBe(6);

    // Next frame within window is throttled again
    now = 2150;
    coordinator.afterRuntimeMutation(runtime.acceptObservation(makeObservation(7, 220)));
    expect(operatorPub.getCurrent()!.channelSeq).toBe(opSeqBefore + 1);

    // CSTV source health change publishes operator immediately
    now = 2180;
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

  it('deduplicates redundant assist broadcasts while preserving diagnostics, event precision, and timeline resets', async () => {
    let now = 1000;
    const runtime = createProgramRuntime('test-prod');
    const lookaheadListeners = new Set<
      (event: RoleScopedGameEventObservation<'lookahead'>) => void
    >();
    const resetListeners = new Set<() => void>();
    let lookaheadHealth: CstvSourceHealth<'lookahead'> = {
      role: 'lookahead',
      state: 'live',
      generation: 1,
      mapName: 'de_ancient',
      lastReceiveMonotonicMs: 1000,
    };
    const cstvSources: CstvSourceManagers = {
      program: {
        role: 'program',
        start: () => undefined,
        stop: () => Promise.resolve(),
        getHealth: () => ({ role: 'program', state: 'disabled', generation: 0 }),
        getRecentGameEvents: () => [],
        getRecentDiagnostics: () => [],
        getSnapshot: () => ({
          health: { role: 'program', state: 'disabled', generation: 0 },
          recentGameEvents: [],
          recentDiagnostics: [],
        }),
        subscribe: () => () => undefined,
        subscribeLiveGameEvents: () => () => undefined,
      },
      lookahead: {
        role: 'lookahead',
        start: () => undefined,
        stop: () => Promise.resolve(),
        getHealth: () => lookaheadHealth,
        getRecentGameEvents: () => [],
        getRecentDiagnostics: () => [],
        getSnapshot: () => ({
          health: lookaheadHealth,
          recentGameEvents: [],
          recentDiagnostics: [],
        }),
        subscribe: () => () => undefined,
        subscribeLiveGameEvents: (listener) => {
          lookaheadListeners.add(listener);
          return () => lookaheadListeners.delete(listener);
        },
        subscribeTimelineReset: (listener) => {
          resetListeners.add(listener);
          return () => resetListeners.delete(listener);
        },
      },
    };
    const diagnosticsCount = { value: 0 };
    const context = {
      schemaVersion: 'mizar.match-document.v1',
      matchId: 'match-assist',
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
    runtime.bindContext(context, 'local');
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources,
      observerSettings: () => ({ enabled: true, leadSeconds: 5, delaySeconds: 120 }),
      onObserverDiagnostics: () => {
        diagnosticsCount.value += 1;
      },
      matchContextBinding: {
        manifest: context as unknown as NonNullable<
          Parameters<typeof createProjectionCoordinator>[0]['matchContextBinding']
        >['manifest'],
        context,
        origin: 'local',
        freshness: 'fresh',
        diagnostics: [],
      },
      nowMonotonicMs: () => now,
    });

    const obs = (seq: number): TelemetryObservation => ({
      ...makeObservation(seq, 100 + seq),
      receive: {
        sequence: seq,
        receivedAt: '2026-11-26T00:00:00.000Z',
        receivedMonotonicMs: now,
      },
      telemetry: {
        ...makeObservation(seq, 100 + seq).telemetry,
        allPlayers: Array.from({ length: 10 }, (_, i) => ({
          sourcePlayerId: `765611980000000${String(i + 1).padStart(2, '0')}`,
          displayName: `Player${i + 1}`,
          side: (i < 5 ? 'CT' : 'T') as 'CT' | 'T',
          observerSlot: (i % 5) + 1,
          activity: 'playing',
          position: { x: 100 + seq + i * 10, y: 200, z: 0 },
          forward: { x: 1, y: 0, z: 0 },
          state: { health: 100 },
          matchStats: { kills: 0, assists: 0, deaths: 0, mvps: 0, score: 0 },
          weapons: [],
        })),
      },
    });

    now = 1050;
    coordinator.afterRuntimeMutation(runtime.acceptObservation(obs(1)));
    const assistPub = coordinator.getPublisher('assist');
    const steadyAssistSeq = assistPub.getCurrent()!.channelSeq;
    const diagBefore = diagnosticsCount.value;

    // Repeated refreshAssist & coordinate frames with unchanged assist state skip redundant broadcasts,
    // while still reporting diagnostics on every cycle.
    now = 1250;
    coordinator.afterRuntimeMutation(runtime.acceptObservation(obs(2)));
    now = 1450;
    coordinator.refreshAssist();
    now = 1650;
    coordinator.refreshAssist();

    expect(assistPub.getCurrent()!.channelSeq).toBe(steadyAssistSeq);
    expect(diagnosticsCount.value).toBe(diagBefore + 3);

    // Lookahead kill event + lead window arrival publishes hint with accurate timing
    for (const listener of lookaheadListeners) {
      listener({
        kind: 'player-death',
        cursor: {
          kind: 'cs2-cstv',
          role: 'lookahead',
          generation: 1,
          sequence: 1,
          tick: 1000,
          ticksPerSecond: 64,
          mapName: 'de_ancient',
          roundsCompleted: 1,
          observedAt: '2026-11-26T00:00:01.000Z',
          observedMonotonicMs: 1650,
          sourceArrivalMonotonicMs: 1650,
        },
        attacker: { sourcePlayerId: '76561198000000001', displayName: 'Player1', side: 'CT' },
        victim: { sourcePlayerId: '76561198000000006', displayName: 'Player6', side: 'T' },
        weapon: 'ak47',
        assistedFlash: false,
        headshot: true,
        penetratedObjects: 0,
        throughSmoke: false,
        attackerBlind: false,
        attackerInAir: false,
        noScope: false,
      });
    }

    // Advance into lead window (1650 + 120000 - 5000 = 116650)
    now = 117650;
    lookaheadHealth = { ...lookaheadHealth, lastReceiveMonotonicMs: now };
    coordinator.afterRuntimeMutation(runtime.acceptObservation(obs(3)));
    const withHint = assistPub.getCurrent()!;
    expect(withHint.payload.observer?.hints).toHaveLength(1);
    expect(withHint.payload.observer?.hints[0]?.remainingSeconds).toBeCloseTo(4, 3);
    expect(withHint.channelSeq).toBe(steadyAssistSeq + 2);

    // Timeline reset clears active hints and publishes immediately
    for (const listener of resetListeners) listener();
    const afterReset = assistPub.getCurrent()!;
    expect(afterReset.channelSeq).toBe(steadyAssistSeq + 3);
    expect(afterReset.payload.observer?.hints).toHaveLength(0);

    await coordinator.close();
  });
});
