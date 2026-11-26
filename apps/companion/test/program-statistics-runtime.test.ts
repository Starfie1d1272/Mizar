import { describe, expect, it, vi } from 'vitest';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import { createCstvSourceManagers } from '../src/telemetry/cstv-source-manager.js';
import { readFileSync } from 'node:fs';
import type { MatchContext } from '@mizar/core/match-context';
import { createSeriesProgress, syncSeriesProgress } from '@mizar/core/series-progress';
import { projectSeries } from '@mizar/core/projection';

const ids = Array.from(
  { length: 10 },
  (_, i) => `765611980000000${String(i + 1).padStart(2, '0')}`,
);
function frame(sequence: number, phase: 'freezetime' | 'live' | 'over'): TelemetryObservation {
  return {
    receive: { sequence, receivedAt: '2026-01-01T00:00:00Z', receivedMonotonicMs: sequence },
    source: { kind: 'cs2-gsi' },
    coverage: {
      provider: 'present',
      map: 'present',
      round: 'present',
      phaseCountdowns: 'absent',
      player: 'absent',
      allPlayers: 'present',
      bomb: 'absent',
      grenades: 'absent',
    },
    telemetry: {
      map: { name: 'de_mirage', phase: 'live', roundNumber: 0 },
      round: { phase },
      allPlayers: ids.map((sourcePlayerId, i) => ({
        sourcePlayerId,
        side: i < 5 ? 'CT' : 'T',
        activity: 'playing',
        observerSlot: (i % 5) + 1,
        state: {
          health: i === 5 && phase === 'over' ? 0 : 100,
          roundTotalDamage: i === 0 ? 80 : 0,
          money: 3000,
          equipValue: 2500,
        },
        matchStats: { kills: i === 0 ? 1 : 0, assists: 0, deaths: i === 5 ? 1 : 0 },
        weapons: [{ sourceWeaponId: 'weapon_0', name: 'weapon_ak47', state: 'active' }],
      })),
    },
  };
}

describe('program statistics integration', () => {
  it('binds a unique later planned map without inventing earlier results', () => {
    const context: MatchContext = JSON.parse(
      readFileSync(
        new URL('../../../packages/protocol/test/fixtures/match-document-v1.json', import.meta.url),
        'utf8',
      ),
    );
    const planned: MatchContext = {
      ...context,
      status: 'in_progress',
      maps: ['de_ancient', 'de_mirage'].map((mapName, index) => ({
        mapId: `planned-${index + 1}`,
        mapOrder: index + 1,
        mapName,
        pickedByEntryId: null,
        teamAStartSide: null,
        scoreA: null,
        scoreB: null,
        completedAt: null,
      })),
    };
    const observe = (mapName: string, input = createSeriesProgress(planned)) =>
      syncSeriesProgress(input, {
        observation: {
          sourceGeneration: 0,
          mapEpoch: 1,
          mapName,
          roundNumber: 6,
          score: { ct: 4, t: 2 },
          roundWins: [],
        },
        events: [],
        sideProof: null,
      }).progress;
    const progress = observe('de_mirage');
    const projected = projectSeries(planned, progress)!;
    expect(projected.currentMapOrder).toBe(2);
    expect(projected.maps[1]?.mapId).toBe('planned-2');
    expect(projected.score).toEqual({ a: null, b: null });
    expect(projectSeries(planned, observe('de_ancient'))?.score).toEqual({ a: 0, b: 0 });
    expect(projected.maps[0]).toMatchObject({
      status: 'pending',
      finalScore: null,
      winnerEntryId: null,
    });
    expect(progress.score).toEqual({ a: 0, b: 0 });
    expect(observe('de_nuke').currentMapOrder).toBeNull();
    expect(observe('de_ancient', progress).currentMapOrder).toBeNull();
  });
  it('publishes a verified round through Core and wire without inventing a GSI sequence', async () => {
    const runtime = createProgramRuntime('verified-round');
    const sources = createCstvSourceManagers({});
    vi.spyOn(sources.program, 'getHealth').mockReturnValue({
      role: 'program',
      state: 'live',
      generation: 2,
      mapName: 'de_mirage',
    });
    const coordinator = createProjectionCoordinator({
      programRuntime: runtime,
      cstvSources: sources,
      nowMonotonicMs: () => 10,
    });
    for (const [index, phase] of (['freezetime', 'live', 'over'] as const).entries()) {
      coordinator.afterRuntimeMutation(runtime.acceptObservation(frame(index + 1, phase)));
    }
    const acceptTrustedRoundEvents = (
      input: Parameters<typeof runtime.acceptTrustedRoundEvents>[0],
    ) => {
      const result = runtime.acceptTrustedRoundEvents(input, sources.program.getHealth());
      if (!result) return false;
      coordinator.afterRuntimeMutation(result);
      return true;
    };
    const before = coordinator.getPublisher('program').getCurrent()!;
    expect(
      before.payload.players.find((p) => p.sourcePlayerId === ids[0])?.statistics.completed
        .rating2Approx.value,
    ).toBeNull();
    const events = {
      mapEpoch: runtime.getCurrentState().map.epoch,
      roundNumberHint: 0,
      coverage: 'complete' as const,
      source: {
        role: 'program' as const,
        generation: 2,
        ticksPerSecond: 64,
        startTick: 100,
        endTick: 200,
      },
      deaths: [
        {
          kind: 'player-death' as const,
          cursor: {
            kind: 'cs2-cstv' as const,
            role: 'program' as const,
            generation: 2,
            sequence: 1,
            tick: 150,
            ticksPerSecond: 64,
            observedAt: '2026-01-01T00:00:00Z',
            observedMonotonicMs: 3,
            mapName: 'de_mirage',
          },
          victim: { sourcePlayerId: ids[5]! },
          attacker: { sourcePlayerId: ids[0]! },
        },
      ],
    };
    expect(
      acceptTrustedRoundEvents({
        programSourceGeneration: 1,
        mapName: 'de_mirage',
        events,
      }),
    ).toBe(false);
    expect(
      acceptTrustedRoundEvents({
        programSourceGeneration: 0,
        mapName: 'de_nuke',
        events,
      }),
    ).toBe(false);
    expect(
      acceptTrustedRoundEvents({
        programSourceGeneration: 0,
        mapName: 'de_mirage',
        events,
      }),
    ).toBe(true);
    const after = coordinator.getPublisher('program').getCurrent()!;
    expect(after.cursor.programReceiveSequence).toBe(before.cursor.programReceiveSequence);
    expect(after.cursor.runtimeSeq).toBeGreaterThan(before.cursor.runtimeSeq);
    const player = after.payload.players.find((p) => p.sourcePlayerId === ids[0])!;
    expect(player.statistics.completed.rating2Approx.value).not.toBeNull();
    expect(player.statistics.completed.rating2Approx.basis.rounds).toBe(1);
    expect(
      acceptTrustedRoundEvents({
        programSourceGeneration: 0,
        mapName: 'de_mirage',
        events,
      }),
    ).toBe(false);
    runtime.advanceProgramSourceGeneration({ utc: '2026-01-01T00:00:00Z', monotonicMs: 11 });
    expect(
      acceptTrustedRoundEvents({
        programSourceGeneration: 0,
        mapName: 'de_mirage',
        events,
      }),
    ).toBe(false);
    await coordinator.close();
  });
});

it('freezes halftime and permits only same-execution final evidence to settle', async () => {
  const { readFileSync } = await import('node:fs');
  const { createMapPlayerStatsAccumulator, projectPlayerStatistics } =
    await import('@mizar/core/runtime');
  const { ProgramPresentationStore } = await import('../src/program-scenes/presentation.js');
  const fixture = JSON.parse(
    readFileSync(
      new URL(
        '../../web/src/program/fixtures/generated/real-program-fixtures.generated.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as {
    fixtures: Record<
      string,
      {
        snapshot: {
          cursor: import('@mizar/core/projection').ProgramProjection['cursor'];
          payload: import('@mizar/core/projection').ProgramProjection;
        };
      }
    >;
  };
  const captured = fixture.fixtures['real-gameover']!.snapshot;
  const base = {
    ...captured.payload,
    cursor: captured.cursor,
    status: {
      context: 'fresh' as const,
      telemetry: 'fresh' as const,
      identity: 'matched' as const,
    },
    players: captured.payload.players.map((p) => ({
      ...p,
      statistics: projectPlayerStatistics(
        createMapPlayerStatsAccumulator(),
        p.sourcePlayerId,
        undefined,
        null,
      ),
    })),
  };
  const store = new ProgramPresentationStore();
  const halftime = {
    ...base,
    map: { ...base.map, phase: 'intermission' as const, score: { ct: 6, t: 6 } },
  };
  const recovery = new ProgramPresentationStore();
  recovery.update(
    {
      ...halftime,
      players: halftime.players.map((p) => ({ ...p, lineupEvidence: 'retained' as const })),
    },
    'r',
  );
  expect(recovery.get().halftime!.players).toEqual({ a: [], b: [] });
  const partial = {
    ...halftime,
    cursor: {
      ...halftime.cursor,
      runtimeSeq: halftime.cursor.runtimeSeq + 1,
      programReceiveSequence: (halftime.cursor.programReceiveSequence ?? 0) + 1,
    },
    players: halftime.players.slice(0, 2),
  };
  recovery.update(partial, 'r');
  const firstEntries = recovery.get().halftime!.players;
  expect(firstEntries.a.length + firstEntries.b.length).toBe(2);
  const complete = {
    ...halftime,
    cursor: {
      ...halftime.cursor,
      runtimeSeq: halftime.cursor.runtimeSeq + 2,
      programReceiveSequence: (halftime.cursor.programReceiveSequence ?? 0) + 2,
    },
    players: halftime.players.map((p) => ({ ...p, displayName: 'later' })),
  };
  recovery.update(
    {
      ...complete,
      cursor: {
        ...complete.cursor,
        programSourceGeneration: complete.cursor.programSourceGeneration + 1,
      },
    },
    'r',
  );
  expect(recovery.get().halftime!.players).toEqual(firstEntries);
  recovery.update(complete, 'r');
  const restored = recovery.get().halftime!;
  expect(restored.players.a).toHaveLength(5);
  expect(restored.players.b).toHaveLength(5);
  for (const side of ['a', 'b'] as const)
    for (const player of firstEntries[side])
      expect(restored.players[side].find((p) => p.id === player.id)).toEqual(player);
  recovery.update(
    {
      ...complete,
      cursor: { ...complete.cursor, runtimeSeq: complete.cursor.runtimeSeq + 1 },
      map: { ...complete.map, phase: 'live' },
      clock: { phase: 'live', endsInSeconds: 90 },
      players: complete.players.map((p) => ({ ...p, displayName: 'second half' })),
    },
    'r',
  );
  expect(recovery.get().halftime).toEqual(restored);
  recovery.update(
    {
      ...complete,
      cursor: { ...complete.cursor, mapEpoch: complete.cursor.mapEpoch + 1 },
      players: [],
    },
    'r',
  );
  const newExecution = recovery.get().halftime!;
  recovery.update(complete, 'r');
  expect(recovery.get().halftime).toEqual(newExecution);
  store.update(halftime, 'r');
  const frozen = store.get().halftime!;
  const changed = {
    ...halftime,
    cursor: { ...halftime.cursor, runtimeSeq: halftime.cursor.runtimeSeq + 1 },
    players: halftime.players.map((p) => ({ ...p, displayName: 'changed' })),
  };
  store.update(changed, 'r');
  expect(store.get().halftime).toEqual(frozen);
  store.update(base, 'r');
  const final = store.get().completed[0]!;
  expect(final.players.a.length).toBeGreaterThan(0);
  const first = final.players.a[0]!;
  const updated = {
    ...base,
    cursor: { ...base.cursor, runtimeSeq: base.cursor.runtimeSeq + 1 },
    players: base.players.map((p) =>
      p.sourcePlayerId !== first.id
        ? p
        : {
            ...p,
            statistics: {
              ...p.statistics,
              completed: {
                ...p.statistics.completed,
                adr: {
                  ...p.statistics.completed.adr,
                  value: 80,
                  reason: null,
                  basis: {
                    ...p.statistics.completed.adr.basis,
                    rounds: 1,
                    coverage: 'complete' as const,
                  },
                },
              },
            },
          },
    ),
  };
  store.update(
    { ...updated, cursor: { ...updated.cursor, mapEpoch: updated.cursor.mapEpoch + 1 } },
    'r',
  );
  expect(store.get().completed[0]).toEqual(final);
  store.update(updated, 'r');
  expect(store.get().completed[0]!.players.a[0]!.statistics.completed.adr.value).toBe(80);
  expect(store.get().completed[0]!.cursor.programReceiveSequence).toBe(
    final.cursor.programReceiveSequence,
  );
});
