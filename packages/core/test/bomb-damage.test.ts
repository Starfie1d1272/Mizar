import { beforeAll, describe, expect, it } from 'vitest';
import { loadBundledMap } from 'cs2-c4-damage/node';
import { createStandingC4Predictor, type BombDamageField } from 'cs2-c4-damage';
import {
  prepareBombDamage,
  projectBombDamage,
  selectProgramSafeRuntimeView,
  type ProgramProjectionInput,
} from '../src/projection/index.js';
import { createInitialRuntimeState, reduceRuntime } from '../src/runtime/index.js';
import { resolveActiveLineup, unboundIdentityResolution } from '../src/identity/index.js';
import type { TelemetryObservation } from '../src/telemetry/index.js';

let field: BombDamageField;
beforeAll(async () => {
  field = await loadBundledMap('de_ancient');
});
function fixture(): ProgramProjectionInput {
  const site = field.bombsites[0]!;
  const observation: TelemetryObservation = {
    receive: { sequence: 1, receivedAt: '2026-10-04T00:00:00Z', receivedMonotonicMs: 100 },
    source: { kind: 'cs2-gsi' },
    coverage: {
      provider: 'present',
      map: 'present',
      round: 'present',
      phaseCountdowns: 'present',
      allPlayers: 'present',
      player: 'absent',
      bomb: 'present',
      grenades: 'absent',
    },
    telemetry: {
      map: { name: 'de_ancient', phase: 'live', roundNumber: 1 },
      round: { phase: 'live', winnerSide: 'unknown' },
      bomb: {
        state: 'planted',
        position: {
          x: (site.boundsMin.x + site.boundsMax.x) / 2,
          y: (site.boundsMin.y + site.boundsMax.y) / 2,
          z: (site.boundsMin.z + site.boundsMax.z) / 2,
        },
        countdownSeconds: 30,
      },
      allPlayers: Array.from({ length: 10 }, (_, i) => ({
        sourcePlayerId: String(76561198000000000n + BigInt(i)),
        side: i < 5 ? 'CT' : 'T',
        position: field.positions[100 + i]!,
        forward: { x: 1, y: 0, z: 0 },
        state: { health: 100 },
      })),
    },
  };
  const continuityPolicy = { staleAfterMs: 1000 };
  const state = reduceRuntime(
    createInitialRuntimeState('bomb-test'),
    { kind: 'program-telemetry', sourceGeneration: 0, observation },
    continuityPolicy,
  ).state;
  const identity = unboundIdentityResolution();
  const activeLineup = resolveActiveLineup({
    sourceGeneration: state.programSource.generation,
    mapEpoch: state.map.epoch,
    allPlayers: observation.telemetry.allPlayers!,
    allPlayersCoverage: 'present',
    identity,
  });
  return {
    runtime: selectProgramSafeRuntimeView(state),
    identity,
    activeLineup,
    nowMonotonicMs: 100,
    continuityPolicy,
    bombDamageResource: { status: 'ready', value: prepareBombDamage(field) },
  };
}
describe('current Program-safe standing prediction', () => {
  it('matches the pinned upstream predictor and never changes observed HP', () => {
    const input = fixture();
    const result = projectBombDamage(input);
    expect(result.status).toBe('available');
    expect(result.players).toHaveLength(10);
    expect(result.players.some((player) => player.status === 'predicted')).toBe(true);
    const predict = createStandingC4Predictor(field);
    for (const player of input.runtime.telemetry!.telemetry.allPlayers!) {
      expect(result.players.find((p) => p.sourcePlayerId === player.sourcePlayerId)).toEqual({
        sourcePlayerId: player.sourcePlayerId,
        ...predict({
          bombPosition: input.runtime.telemetry!.telemetry.bomb!.position!,
          playerPosition: player.position!,
          playerForward: player.forward!,
          health: 100,
        }),
      });
      expect(player.state!.health).toBe(100);
    }
  });
  it.each(['stale', 'generation', 'map', 'resource', 'coverage', 'round'])(
    'hides %s context',
    (kind) => {
      const input = fixture();
      const modified = structuredClone({ ...input, bombDamageResource: undefined });
      const runtime = modified.runtime;
      const next: ProgramProjectionInput = {
        ...input,
        ...(kind === 'stale' ? { nowMonotonicMs: 2000 } : {}),
        ...(kind === 'generation'
          ? { activeLineup: { ...input.activeLineup, sourceGeneration: 20 } }
          : {}),
        ...(kind === 'map' && input.bombDamageResource?.status === 'ready'
          ? {
              bombDamageResource: {
                status: 'ready' as const,
                value: { ...input.bombDamageResource.value, mapName: 'de_nuke' },
              },
            }
          : {}),
        ...(kind === 'resource'
          ? { bombDamageResource: { status: 'unavailable' as const, reason: 'resource-invalid' } }
          : {}),
        ...(kind === 'coverage'
          ? {
              runtime: {
                ...runtime,
                telemetry: {
                  ...runtime.telemetry!,
                  coverage: { ...runtime.telemetry!.coverage, allPlayers: 'absent' as const },
                },
              },
            }
          : {}),
        ...(kind === 'round'
          ? {
              runtime: {
                ...runtime,
                telemetry: {
                  ...runtime.telemetry!,
                  telemetry: {
                    ...runtime.telemetry!.telemetry,
                    round: { phase: 'over' as const, winnerSide: 'T' as const },
                  },
                },
              },
            }
          : {}),
      };
      expect(projectBombDamage(next).status).toBe('unavailable');
    },
  );
  it.each(['planting', 'carried', 'dropped', 'defused', 'exploded'] as const)(
    'clears prediction in %s state',
    (state) => {
      const input = fixture();
      const observation = input.runtime.telemetry!;
      const runtime = {
        ...input.runtime,
        telemetry: {
          ...observation,
          telemetry: { ...observation.telemetry, bomb: { ...observation.telemetry.bomb!, state } },
        },
      };
      expect(projectBombDamage({ ...input, runtime }).status).toBe('unavailable');
    },
  );
  it('accepts current defusing evidence and rejects a different accepted sequence', () => {
    const input = fixture();
    const observation = input.runtime.telemetry!;
    const runtime = {
      ...input.runtime,
      telemetry: {
        ...observation,
        telemetry: {
          ...observation.telemetry,
          bomb: { ...observation.telemetry.bomb!, state: 'defusing' as const },
        },
      },
    };
    expect(projectBombDamage({ ...input, runtime }).status).toBe('available');
    expect(
      projectBombDamage({
        ...input,
        runtime: { ...runtime, cursor: { ...runtime.cursor, programReceiveSequence: 99 } },
      }).status,
    ).toBe('unavailable');
  });

  it('does not predict retained, dead or missing-input players', () => {
    const input = fixture();
    const ct = input.activeLineup.ct.map((p, i) =>
      i === 0
        ? { ...p, lineupEvidence: 'retained' as const }
        : i === 1
          ? { ...p, observed: { ...p.observed!, state: { health: 0 } } }
          : { ...p, observed: { sourcePlayerId: p.sourcePlayerId, state: { health: 100 } } },
    );
    const result = projectBombDamage({ ...input, activeLineup: { ...input.activeLineup, ct } });
    expect(
      result.players
        .filter((p) => ct.some((c) => c.sourcePlayerId === p.sourcePlayerId))
        .every((p) => p.status === 'unavailable'),
    ).toBe(true);
  });
});
