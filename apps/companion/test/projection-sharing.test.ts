import { describe, expect, it } from 'vitest';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import { createCstvSourceManagers } from '../src/telemetry/cstv-source-manager.js';

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
});
