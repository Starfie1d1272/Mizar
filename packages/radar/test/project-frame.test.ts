import { describe, expect, it } from 'vitest';

import { unboundIdentityResolution } from '@mizar/core/identity';
import { derivePlayerLifeState } from '@mizar/core/projection';
import {
  createInitialRuntimeState,
  reduceRuntime,
  type RuntimeContinuityPolicy,
} from '@mizar/core/runtime';
import { selectProgramSafeRuntimeView } from '@mizar/core/projection';
import type { TelemetryObservation } from '@mizar/core/telemetry';

import { projectRadarFrame } from '../src/project-frame.js';

const POLICY: RuntimeContinuityPolicy = { staleAfterMs: 100 };

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
      player: 'present',
      allPlayers: 'present',
      bomb: 'present',
      grenades: 'present',
    },
    telemetry: {
      map: { name: 'de_nuke' },
      player: {
        sourcePlayerId: 'player-b',
        position: { x: 5, y: 5, z: 0 },
      },
      allPlayers: [
        {
          sourcePlayerId: 'player-b',
          side: 'T',
          state: { health: 0 },
          position: { x: 5, y: 5, z: 0 },
        },
        {
          sourcePlayerId: 'player-a',
          side: 'CT',
          state: { health: 100 },
          position: { x: 1, y: 2, z: 3 },
        },
        {
          sourcePlayerId: 'player-c',
          state: {},
        },
      ],
      bomb: { state: 'planted', position: { x: 8, y: 9, z: 1 } },
      grenades: [
        {
          sourceEntityId: 'grenade-b',
          kind: 'smoke',
          position: { x: 4, y: 4, z: 0 },
          flames: [],
        },
        {
          sourceEntityId: 'grenade-a',
          kind: 'flashbang',
          position: { x: 2, y: 2, z: 0 },
        },
      ],
    },
  };
}

describe('Radar frame projector', () => {
  it('projects sorted current world-space facts with explicit life state', () => {
    const initial = createInitialRuntimeState('radar-producer');
    const state = reduceRuntime(
      initial,
      { kind: 'program-telemetry', sourceGeneration: 0, observation: observation() },
      POLICY,
    ).state;
    const frame = projectRadarFrame({
      runtime: selectProgramSafeRuntimeView(state),
      identity: unboundIdentityResolution(),
      nowMonotonicMs: 0,
      continuityPolicy: POLICY,
    });

    expect(frame.mapName).toBe('de_nuke');
    expect(frame.telemetryFreshness).toBe('fresh');
    expect(frame.players.map((player) => player.sourcePlayerId)).toEqual([
      'player-a',
      'player-b',
      'player-c',
    ]);
    expect(frame.players.map((player) => player.lifeState)).toEqual(
      [...(observation().telemetry.allPlayers ?? [])]
        .sort((left, right) => left.sourcePlayerId.localeCompare(right.sourcePlayerId))
        .map((player) => derivePlayerLifeState(player.state?.health)),
    );
    expect(frame.grenades.map((grenade) => grenade.sourceEntityId)).toEqual([
      'grenade-a',
      'grenade-b',
    ]);
    expect(frame.players[0]).toHaveProperty('position');
    expect(frame).not.toHaveProperty('mapGeometry');
    expect(frame).not.toHaveProperty('future');
  });

  it('does not retain player facts when the current allplayers block is absent', () => {
    const initial = createInitialRuntimeState('radar-producer');
    const state = reduceRuntime(
      initial,
      { kind: 'program-telemetry', sourceGeneration: 0, observation: observation() },
      POLICY,
    ).state;
    const telemetryWithoutPlayers = { ...state.programTelemetry!.telemetry };
    delete telemetryWithoutPlayers.allPlayers;
    const absent = {
      ...state,
      programTelemetry: {
        ...state.programTelemetry!,
        coverage: { ...state.programTelemetry!.coverage, allPlayers: 'absent' as const },
        telemetry: telemetryWithoutPlayers,
      },
    };
    const frame = projectRadarFrame({
      runtime: selectProgramSafeRuntimeView(absent),
      identity: unboundIdentityResolution(),
      nowMonotonicMs: 0,
      continuityPolicy: POLICY,
    });

    expect(frame.coverage.allPlayers).toBe('absent');
    expect(frame.players).toEqual([]);
  });
});
