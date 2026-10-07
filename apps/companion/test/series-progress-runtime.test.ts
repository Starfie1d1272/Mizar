import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { MatchContext } from '@mizar/core/match-context';
import type {
  SeriesProgressCheckpoint,
  SeriesProgressCheckpointStore,
  SeriesSideProof,
} from '@mizar/core/series-progress';
import type { TelemetryObservation } from '@mizar/core/telemetry';

import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { JsonSeriesProgressCheckpointStore } from '../src/series-progress/checkpoint-store.js';

function contextFixture(): MatchContext {
  const entrant = (entryId: 'a' | 'b', name: string) => ({
    entryId,
    name,
    logoUrl: null,
    rosterId: null,
    players: [],
  });
  return {
    matchId: 'runtime-series',
    competition: {
      competitionId: 'runtime-series-competition',
      slug: 'runtime-series',
      name: 'Runtime Series',
      themeColor: null,
    },
    status: 'in_progress',
    format: 'bo3',
    stage: 'final',
    round: null,
    entryRound: null,
    scheduledAt: null,
    startedAt: null,
    completedAt: null,
    scoreA: null,
    scoreB: null,
    isForfeit: false,
    entrants: { a: entrant('a', 'Alpha'), b: entrant('b', 'Bravo') },
    maps: [1, 2, 3].map((mapOrder) => ({
      mapId: `map-${mapOrder}`,
      mapOrder,
      mapName: ['de_mirage', 'de_dust2', 'de_inferno'][mapOrder - 1]!,
      pickedByEntryId: null,
      teamAStartSide: 'CT' as const,
      scoreA: null,
      scoreB: null,
      completedAt: null,
    })),
    veto: [],
    commentators: [],
  };
}

it('accepts a map plan edited before any execution or result has been bound', () => {
  const runtime = createProgramRuntime('pristine-plan');
  const context = contextFixture();
  runtime.synchronizeSeriesProgress({ ...context, maps: [] }, null, 'local');
  const next = runtime.synchronizeSeriesProgress(context, null, 'local');
  expect(next?.maps).toHaveLength(3);
  expect(next?.issues.some((issue) => issue.code === 'context_result_conflict')).toBe(false);
});
it('accepts the first plan while telemetry is already live but no map execution was bound', () => {
  const runtime = createProgramRuntime('live-pristine-plan');
  const context = contextFixture();
  runtime.synchronizeSeriesProgress({ ...context, maps: [] }, null, 'local');
  runtime.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
  runtime.synchronizeSeriesProgress({ ...context, maps: [] }, null, 'local');
  const next = runtime.synchronizeSeriesProgress(context, null, 'local');
  expect(next?.maps[0]?.mapName).toBe('de_mirage');
  expect(next?.issues.some((issue) => issue.code === 'context_result_conflict')).toBe(false);
});

function frame(
  sequence: number,
  phase: 'live' | 'gameover' | 'warmup',
  roundPhase: 'freezetime' | 'live' | 'over',
  score: { readonly ct: number; readonly t: number },
  winnerSide?: 'CT' | 'T',
  roundNumber?: number,
): TelemetryObservation {
  return {
    receive: {
      sequence,
      receivedAt: `2026-09-18T00:00:00.00${sequence}Z`,
      receivedMonotonicMs: sequence,
    },
    source: { kind: 'cs2-gsi' },
    coverage: {
      provider: 'present',
      map: 'present',
      round: 'present',
      phaseCountdowns: 'absent',
      player: 'absent',
      allPlayers: 'absent',
      bomb: 'absent',
      grenades: 'absent',
    },
    telemetry: {
      map: {
        name: 'de_mirage',
        phase,
        roundNumber: roundNumber ?? (score.ct + score.t > 0 ? score.ct + score.t : 1),
        sides: { ct: { score: score.ct }, t: { score: score.t } },
      },
      round: {
        phase: roundPhase,
        ...(winnerSide === undefined ? {} : { winnerSide }),
      },
    },
  };
}

class MemoryCheckpointStore implements SeriesProgressCheckpointStore {
  checkpoint: SeriesProgressCheckpoint | undefined;
  flushCount = 0;

  load(): SeriesProgressCheckpoint | undefined {
    return this.checkpoint;
  }

  save(checkpoint: SeriesProgressCheckpoint): void {
    this.checkpoint = structuredClone(checkpoint);
  }

  flush(): Promise<void> {
    this.flushCount += 1;
    return Promise.resolve();
  }
}

const sideProof: SeriesSideProof = {
  sourceGeneration: 0,
  mapEpoch: 1,
  a: 'CT',
  b: 'T',
};

describe('ProgramRuntime SeriesProgress composition', () => {
  it.each(['empty', 'omitted'] as const)(
    'clears future frozen rounds after a witnessed same-map warmup with %s history',
    (history) => {
      const context = contextFixture();
      const runtime = createProgramRuntime('same-map-restart-series');
      const old = frame(1, 'live', 'freezetime', { ct: 11, t: 5 }, undefined, 16);
      runtime.acceptObservation({
        ...old,
        telemetry: {
          ...old.telemetry,
          map: {
            ...old.telemetry.map!,
            roundWins: Array.from({ length: 16 }, (_, index) => ({
              roundNumber: index + 1,
              winnerSide: index < 11 ? ('CT' as const) : ('T' as const),
              winCondition: 'elimination' as const,
            })),
          },
        },
      });
      const before = runtime.synchronizeSeriesProgress(context, sideProof)!;
      expect(before.maps[0]?.roundHistory.rounds).toHaveLength(16);
      const menu = frame(2, 'live', 'freezetime', { ct: 11, t: 5 });
      runtime.acceptObservation({
        ...menu,
        coverage: { ...menu.coverage, map: 'absent', round: 'absent' },
        telemetry: {},
      });
      const warmup = frame(3, 'warmup', 'freezetime', { ct: 0, t: 0 }, undefined, 0);
      runtime.acceptObservation({
        ...warmup,
        telemetry: {
          ...warmup.telemetry,
          map: { ...warmup.telemetry.map!, ...(history === 'empty' ? { roundWins: [] } : {}) },
        },
      });
      const after = runtime.synchronizeSeriesProgress(context, { ...sideProof, mapEpoch: 2 })!;
      expect(after.maps[0]).toMatchObject({
        status: 'current',
        executionMapEpoch: 2,
        finalScore: null,
        roundHistory: { rounds: [] },
      });
      expect(after.score).toEqual({ a: 0, b: 0 });
      expect(before.maps[0]?.roundHistory.rounds).toHaveLength(16);
    },
  );

  it('feeds reliable transitions once and immediately freezes a local map result', () => {
    const context = contextFixture();
    const runtime = createProgramRuntime('series-runtime');
    runtime.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
    runtime.synchronizeSeriesProgress(context, sideProof);
    runtime.acceptObservation(frame(2, 'live', 'live', { ct: 0, t: 0 }));
    runtime.acceptObservation(frame(3, 'live', 'over', { ct: 0, t: 0 }));
    runtime.acceptObservation(frame(4, 'gameover', 'over', { ct: 13, t: 9 }));

    const progress = runtime.synchronizeSeriesProgress(context, sideProof);
    expect(progress?.score).toEqual({ a: 1, b: 0 });
    expect(progress?.maps[0]).toMatchObject({
      status: 'completed',
      finalScore: { a: 13, b: 9 },
      winnerEntryId: 'a',
    });

    runtime.acceptObservation(frame(5, 'gameover', 'over', { ct: 13, t: 9 }));
    const repeated = runtime.synchronizeSeriesProgress(context, sideProof);
    expect(repeated).toEqual(progress);
  });

  it('flushes pre-existing production checkpoint work when closing during fixture mode', async () => {
    const context = contextFixture();
    const store = new MemoryCheckpointStore();
    const runtime = createProgramRuntime('series-runtime', {
      seriesProgressCheckpointStore: store,
    });

    runtime.synchronizeSeriesProgress(context, null, 'online');
    expect(store.checkpoint).toBeDefined();

    runtime.activateFixtureSeriesProgress(context);
    await runtime.close();

    expect(store.flushCount).toBe(1);
  });

  it('restores a completed local map from a compatible checkpoint without MatchContext score writeback', () => {
    const context = contextFixture();
    const store = new MemoryCheckpointStore();
    const first = createProgramRuntime('series-runtime', {
      seriesProgressCheckpointStore: store,
    });
    first.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
    first.synchronizeSeriesProgress(context, sideProof);
    first.acceptObservation(frame(2, 'live', 'live', { ct: 0, t: 0 }));
    first.acceptObservation(frame(3, 'live', 'over', { ct: 0, t: 0 }));
    first.acceptObservation(frame(4, 'gameover', 'over', { ct: 13, t: 9 }));
    first.synchronizeSeriesProgress(context, sideProof);
    expect(store.checkpoint?.progress.score).toEqual({ a: 1, b: 0 });

    const restarted = createProgramRuntime('new-process', {
      seriesProgressCheckpointStore: store,
    });
    const restored = restarted.synchronizeSeriesProgress(context, null);
    expect(restored?.score).toEqual({ a: 1, b: 0 });
    expect(restored?.maps[0]?.finalScore).toEqual({ a: 13, b: 9 });
  });

  it('flushes the real async JSON checkpoint before a process restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'rivalhub-series-checkpoint-'));
    const checkpointPath = join(directory, 'series-progress.json');
    try {
      const context = contextFixture();
      const first = createProgramRuntime('series-runtime', {
        seriesProgressCheckpointStore: new JsonSeriesProgressCheckpointStore({
          filePath: checkpointPath,
        }),
      });
      first.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
      first.synchronizeSeriesProgress(context, sideProof);
      first.acceptObservation(frame(2, 'live', 'live', { ct: 0, t: 0 }));
      first.acceptObservation(frame(3, 'live', 'over', { ct: 0, t: 0 }));
      first.acceptObservation(frame(4, 'gameover', 'over', { ct: 13, t: 9 }));
      first.synchronizeSeriesProgress(context, sideProof);
      await first.close();

      expect(JSON.parse(await readFile(checkpointPath, 'utf8'))).toMatchObject({
        progress: { score: { a: 1, b: 0 } },
      });

      const restarted = createProgramRuntime('new-process', {
        seriesProgressCheckpointStore: new JsonSeriesProgressCheckpointStore({
          filePath: checkpointPath,
        }),
      });
      restarted.acceptObservation(frame(5, 'gameover', 'over', { ct: 13, t: 9 }));
      const restored = restarted.synchronizeSeriesProgress(context, null);
      await restarted.close();

      expect(restored?.score).toEqual({ a: 1, b: 0 });
      expect(restored?.maps[0]?.status).toBe('completed');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('keeps restore reconciliation pending until the first post-restart map observation', () => {
    const context = contextFixture();
    const store = new MemoryCheckpointStore();
    const first = createProgramRuntime('series-runtime', {
      seriesProgressCheckpointStore: store,
    });
    first.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
    first.synchronizeSeriesProgress(context, sideProof);
    first.acceptObservation(frame(2, 'live', 'live', { ct: 0, t: 0 }));
    first.acceptObservation(frame(3, 'live', 'over', { ct: 0, t: 0 }, 'CT'));
    const checkpointed = first.synchronizeSeriesProgress(context, sideProof);
    expect(checkpointed?.maps[0]?.roundHistory.completeness).toBe('complete');

    const restarted = createProgramRuntime('new-process', {
      seriesProgressCheckpointStore: store,
    });
    const withoutTelemetry = restarted.synchronizeSeriesProgress(context, null);
    expect(withoutTelemetry?.maps[0]?.roundHistory.completeness).toBe('complete');

    restarted.acceptObservation(frame(4, 'live', 'freezetime', { ct: 0, t: 0 }));
    const reconciled = restarted.synchronizeSeriesProgress(context, null);
    expect(reconciled?.maps[0]?.roundHistory.completeness).toBe('partial');
    expect(reconciled?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'round_history_partial' })]),
    );
  });

  it('A.1 preserves SeriesProgress across source generation reconnect on the same mapEpoch and requires fresh generation proof for freeze', () => {
    const context = contextFixture();
    const runtime = createProgramRuntime('series-runtime');
    runtime.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
    runtime.synchronizeSeriesProgress(context, sideProof);
    runtime.acceptObservation(frame(2, 'live', 'live', { ct: 0, t: 0 }));
    runtime.acceptObservation(frame(3, 'live', 'over', { ct: 1, t: 0 }, 'CT'));
    let progress = runtime.synchronizeSeriesProgress(context, sideProof);
    expect(progress?.maps[0]?.roundHistory.rounds).toHaveLength(1);
    expect(progress?.currentMapOrder).toBe(1);

    // Source reconnect / advance source generation:
    runtime.advanceProgramSourceGeneration({ monotonicMs: 100, utc: '2026-09-18T00:00:00.100Z' });
    expect(runtime.getSnapshot().sourceGeneration).toBe(1);
    expect(runtime.getSnapshot().current.map.epoch).toBe(1);

    // Same map continues on generation 1:
    progress = runtime.synchronizeSeriesProgress(context, sideProof);
    expect(progress?.currentMapOrder).toBe(1);
    expect(progress?.maps[0]?.roundHistory.rounds).toHaveLength(1);

    // Old side proof (sourceGeneration: 0) with new generation (1) cannot freeze canonical map result:
    runtime.acceptObservation({
      ...frame(4, 'gameover', 'over', { ct: 13, t: 9 }),
      receive: { sequence: 4, receivedAt: '2026-09-18T00:00:00.004Z', receivedMonotonicMs: 101 },
    });
    progress = runtime.synchronizeSeriesProgress(context, sideProof);
    // Old sideProof fails generation match (sideProof.sourceGeneration=0 != runtime=1)
    expect(progress?.score).toEqual({ a: 0, b: 0 });
    expect(progress?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'side_mapping_unproven' })]),
    );

    // Once fresh generation side proof is provided, freezes immediately:
    const freshProof: SeriesSideProof = { ...sideProof, sourceGeneration: 1 };
    progress = runtime.synchronizeSeriesProgress(context, freshProof);
    expect(progress?.score).toEqual({ a: 1, b: 0 });
    expect(progress?.maps[0]?.status).toBe('completed');
  });

  it('A.2 same-map restart advances mapEpoch, clears volatile round history, preserves completed maps and score, and persists checkpoint', () => {
    const context = contextFixture();
    const store = new MemoryCheckpointStore();
    const runtime = createProgramRuntime('series-runtime', {
      seriesProgressCheckpointStore: store,
    });

    // Map 1 completed:
    runtime.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
    runtime.synchronizeSeriesProgress(context, sideProof);
    runtime.acceptObservation(frame(2, 'live', 'live', { ct: 0, t: 0 }));
    runtime.acceptObservation(frame(3, 'gameover', 'over', { ct: 13, t: 8 }));
    let progress = runtime.synchronizeSeriesProgress(context, sideProof);
    expect(progress?.score).toEqual({ a: 1, b: 0 });
    expect(progress?.maps[0]?.status).toBe('completed');

    // Map 2 starts (mapEpoch 2) and has 1 round:
    const map2Proof: SeriesSideProof = { sourceGeneration: 0, mapEpoch: 2, a: 'CT', b: 'T' };
    runtime.acceptObservation({
      ...frame(4, 'live', 'freezetime', { ct: 0, t: 0 }),
      telemetry: {
        map: {
          name: 'de_dust2',
          phase: 'live',
          roundNumber: 1,
          sides: { ct: { score: 0 }, t: { score: 0 } },
        },
        round: { phase: 'freezetime' },
      },
    });
    runtime.synchronizeSeriesProgress(context, map2Proof);
    runtime.acceptObservation({
      ...frame(5, 'live', 'live', { ct: 0, t: 0 }),
      telemetry: {
        map: {
          name: 'de_dust2',
          phase: 'live',
          roundNumber: 1,
          sides: { ct: { score: 0 }, t: { score: 0 } },
        },
        round: { phase: 'live' },
      },
    });
    runtime.acceptObservation({
      ...frame(6, 'live', 'over', { ct: 1, t: 0 }, 'CT'),
      telemetry: {
        map: {
          name: 'de_dust2',
          phase: 'live',
          roundNumber: 1,
          sides: { ct: { score: 1 }, t: { score: 0 } },
        },
        round: { phase: 'over', winnerSide: 'CT' },
      },
    });
    progress = runtime.synchronizeSeriesProgress(context, map2Proof);
    expect(progress?.currentMapOrder).toBe(2);
    expect(progress?.maps[1]?.roundHistory.rounds).toHaveLength(1);

    // Same-map restart triggered:
    runtime.resetMapExecution('same-map-restart', {
      monotonicMs: 200,
      utc: '2026-09-18T00:00:00.200Z',
    });
    expect(runtime.getSnapshot().current.map.epoch).toBe(3);

    const restartedMap2Proof: SeriesSideProof = {
      sourceGeneration: 0,
      mapEpoch: 3,
      a: 'CT',
      b: 'T',
    };
    progress = runtime.synchronizeSeriesProgress(context, restartedMap2Proof);

    // Map 1 still completed, series score 1:0 preserved:
    expect(progress?.score).toEqual({ a: 1, b: 0 });
    expect(progress?.maps[0]?.status).toBe('completed');
    expect(progress?.maps[0]?.finalScore).toEqual({ a: 13, b: 8 });

    // Map 2 current history cleared, new executionMapEpoch=3:
    expect(progress?.currentMapOrder).toBe(2);
    expect(progress?.maps[1]?.status).toBe('current');
    expect(progress?.maps[1]?.executionMapEpoch).toBe(3);
    expect(progress?.maps[1]?.roundHistory.rounds).toHaveLength(0);

    // Checkpoint persisted with reset state:
    expect(store.checkpoint?.progress.score).toEqual({ a: 1, b: 0 });
    expect(store.checkpoint?.progress.maps[1]?.roundHistory.rounds).toHaveLength(0);
    expect(store.checkpoint?.progress.maps[1]?.executionMapEpoch).toBe(3);
  });

  it('A.3 / A.4 handles mid-map process restart, idempotency, and prevents double counting', () => {
    const context = contextFixture();
    const store = new MemoryCheckpointStore();
    const runtime1 = createProgramRuntime('runtime-1', {
      seriesProgressCheckpointStore: store,
    });

    runtime1.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
    runtime1.synchronizeSeriesProgress(context, sideProof);

    // Round 1 ended
    runtime1.acceptObservation(frame(2, 'live', 'live', { ct: 0, t: 0 }));
    runtime1.acceptObservation(frame(3, 'live', 'over', { ct: 1, t: 0 }, 'CT'));
    let progress = runtime1.synchronizeSeriesProgress(context, sideProof);
    expect(progress?.maps[0]?.roundHistory.rounds).toHaveLength(1);

    // Duplicate round_ended frame with same roundNumber / scores:
    runtime1.acceptObservation(frame(4, 'live', 'over', { ct: 1, t: 0 }, 'CT'));
    progress = runtime1.synchronizeSeriesProgress(context, sideProof);
    expect(progress?.maps[0]?.roundHistory.rounds).toHaveLength(1);

    // Duplicate synchronize:
    const syncAgain = runtime1.synchronizeSeriesProgress(context, sideProof);
    expect(syncAgain).toEqual(progress);

    // Process restarts mid-map with compatible checkpoint:
    const runtime2 = createProgramRuntime('runtime-2', {
      seriesProgressCheckpointStore: store,
    });
    // First observation matches checkpoint:
    runtime2.acceptObservation(frame(5, 'live', 'live', { ct: 1, t: 0 }));
    const restored = runtime2.synchronizeSeriesProgress(context, sideProof);
    expect(restored?.maps[0]?.roundHistory.rounds).toHaveLength(1);
    expect(restored?.maps[0]?.roundHistory.completeness).toBe('complete');

    // Round 2 ends:
    runtime2.acceptObservation(frame(6, 'live', 'live', { ct: 1, t: 0 }, undefined, 2));
    runtime2.acceptObservation(frame(7, 'live', 'over', { ct: 2, t: 0 }, 'CT', 2));
    const round2 = runtime2.synchronizeSeriesProgress(context, sideProof);
    expect(round2?.maps[0]?.roundHistory.rounds).toHaveLength(2);

    // Map ends:
    runtime2.acceptObservation(frame(8, 'gameover', 'over', { ct: 13, t: 7 }));
    const mapEnded = runtime2.synchronizeSeriesProgress(context, sideProof);
    expect(mapEnded?.score).toEqual({ a: 1, b: 0 });

    // Repeated gameover and duplicate map_ended:
    runtime2.acceptObservation(frame(9, 'gameover', 'over', { ct: 13, t: 7 }));
    const repeated = runtime2.synchronizeSeriesProgress(context, sideProof);
    expect(repeated?.score).toEqual({ a: 1, b: 0 });
    expect(repeated?.maps[0]?.status).toBe('completed');
  });

  it('A.5 sequence gaps do not corrupt transitions, and stale frames are rejected by runtime', () => {
    const context = contextFixture();
    const runtime = createProgramRuntime('runtime-continuity');
    runtime.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
    runtime.synchronizeSeriesProgress(context, sideProof);

    // Sequence gap from 1 to 20:
    const resultGap = runtime.acceptObservation(frame(20, 'live', 'live', { ct: 0, t: 0 }));
    expect(resultGap.disposition.kind).toBe('accepted');
    const progress = runtime.synchronizeSeriesProgress(context, sideProof);
    expect(progress?.currentMapOrder).toBe(1);

    // Stale frame with sequence 5 (older than 20):
    const resultStale = runtime.acceptObservation(frame(5, 'gameover', 'over', { ct: 13, t: 0 }));
    expect(resultStale.disposition.kind).toBe('ignored');
    expect(resultStale.disposition.reason).toBe('out-of-order');
    // Stale frame does NOT advance map truth or end map:
    const progressAfterStale = runtime.synchronizeSeriesProgress(context, sideProof);
    expect(progressAfterStale?.score).toEqual({ a: 0, b: 0 });
    expect(progressAfterStale?.maps[0]?.status).toBe('current');
  });

  it('B.1 / B.2 / B.3 protects local frozen score from stale MatchContext, allows offline local freeze, and survives 0:0 context recovery', () => {
    const context = contextFixture();
    const runtime = createProgramRuntime('series-runtime');
    runtime.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
    runtime.synchronizeSeriesProgress(context, sideProof);
    runtime.acceptObservation(frame(2, 'gameover', 'over', { ct: 13, t: 9 }));

    // Local freeze succeeds without waiting for RivalHub:
    const frozen = runtime.synchronizeSeriesProgress(context, sideProof);
    expect(frozen?.score).toEqual({ a: 1, b: 0 });
    expect(frozen?.maps[0]?.status).toBe('completed');

    // RivalHub temporary offline / MatchContext not updated (stale scoreA: 0, scoreB: 0):
    const staleContext: MatchContext = {
      ...context,
      scoreA: 0,
      scoreB: 0,
      maps: context.maps.map((m, idx) =>
        idx === 0 ? { ...m, scoreA: 0, scoreB: 0, completedAt: null } : m,
      ),
    };
    const afterStale = runtime.synchronizeSeriesProgress(staleContext, sideProof);
    // Local frozen 1:0 does NOT rollback to 0:0!
    expect(afterStale?.score).toEqual({ a: 1, b: 0 });
    expect(afterStale?.maps[0]?.status).toBe('completed');
    expect(afterStale?.maps[0]?.finalScore).toEqual({ a: 13, b: 9 });
  });

  it('B.4 matchId switch rejects incompatible checkpoint and does not bleed SeriesProgress to the new match', () => {
    const contextA = contextFixture();
    const store = new MemoryCheckpointStore();
    const runtimeA = createProgramRuntime('match-a', {
      seriesProgressCheckpointStore: store,
    });
    runtimeA.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
    runtimeA.synchronizeSeriesProgress(contextA, sideProof);
    runtimeA.acceptObservation(frame(2, 'gameover', 'over', { ct: 13, t: 5 }));
    runtimeA.synchronizeSeriesProgress(contextA, sideProof);
    expect(store.checkpoint?.identity.matchId).toBe('runtime-series');
    expect(store.checkpoint?.progress.score).toEqual({ a: 1, b: 0 });

    // New match started with different matchId:
    const contextB: MatchContext = {
      ...contextA,
      matchId: 'new-match-2026',
      maps: contextA.maps.map((m) => ({ ...m, mapId: `new-${m.mapId}` })),
    };
    const runtimeB = createProgramRuntime('match-b', {
      seriesProgressCheckpointStore: store,
    });
    const progressB = runtimeB.synchronizeSeriesProgress(contextB, null);
    // Incompatible checkpoint from previous match is ignored and flagged:
    expect(progressB?.matchId).toBe('new-match-2026');
    expect(progressB?.score).toEqual({ a: 0, b: 0 });
    expect(progressB?.maps[0]?.status).toBe('pending');
    expect(progressB?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'checkpoint_incompatible' })]),
    );
  });

  it('B.5 standalone mode with minimal context shares identical Series Core semantics without manifest dependency', () => {
    const entrant = (entryId: 'a' | 'b', name: string) => ({
      entryId,
      name,
      logoUrl: null,
      rosterId: null,
      players: [],
    });
    const standaloneContext: MatchContext = {
      matchId: 'standalone-match',
      competition: {
        competitionId: 'local-comp',
        slug: 'local-comp',
        name: 'Local Standalone',
        themeColor: null,
      },
      status: 'in_progress',
      format: 'bo1',
      stage: 'final',
      round: null,
      entryRound: null,
      scheduledAt: null,
      startedAt: null,
      completedAt: null,
      scoreA: null,
      scoreB: null,
      isForfeit: false,
      entrants: { a: entrant('a', 'Team Alpha'), b: entrant('b', 'Team Bravo') },
      maps: [
        {
          mapId: 'map-1',
          mapOrder: 1,
          mapName: 'de_mirage',
          pickedByEntryId: null,
          teamAStartSide: 'CT',
          scoreA: null,
          scoreB: null,
          completedAt: null,
        },
      ],
      veto: [],
      commentators: [],
    };

    const runtime = createProgramRuntime('standalone-runtime');
    runtime.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
    const initial = runtime.synchronizeSeriesProgress(standaloneContext, sideProof);
    expect(initial?.currentMapOrder).toBe(1);
    expect(initial?.bindingState).toBe('bound');

    runtime.acceptObservation(frame(2, 'gameover', 'over', { ct: 13, t: 11 }));
    const completed = runtime.synchronizeSeriesProgress(standaloneContext, sideProof);
    expect(completed?.score).toEqual({ a: 1, b: 0 });
    expect(completed?.maps[0]?.status).toBe('completed');
    expect(completed?.maps[0]?.winnerEntryId).toBe('a');
  });

  it('B.6 MatchContext refresh does not act as a second mutable score owner or advance/overwrite active SeriesProgress', () => {
    const context = contextFixture();
    const runtime = createProgramRuntime('ownership-guard-runtime');

    // 1. Enter Map 1 locally
    runtime.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
    const running = runtime.synchronizeSeriesProgress(context, sideProof);
    expect(running?.currentMapOrder).toBe(1);
    expect(running?.maps[0]?.status).toBe('current');
    expect(running?.score).toEqual({ a: 0, b: 0 });

    // 2. Incoming MatchContext update has map score, but local runtime has not finished the map:
    // MatchContext must NOT directly mark Map 1 completed or overwrite finalScore!
    const scoredContext: MatchContext = {
      ...context,
      scoreA: 1,
      scoreB: 0,
      maps: context.maps.map((m, idx) =>
        idx === 0 ? { ...m, scoreA: 13, scoreB: 5, completedAt: '2026-09-17T00:00:00.000Z' } : m,
      ),
    };
    const afterScoredContext = runtime.synchronizeSeriesProgress(scoredContext, sideProof);
    expect(afterScoredContext?.maps[0]?.status).toBe('current');
    expect(afterScoredContext?.maps[0]?.finalScore).toBeNull();
    expect(afterScoredContext?.score).toEqual({ a: 0, b: 0 });

    // 3. Stale context (scoreA: 0, scoreB: 0) cannot advance local SeriesProgress
    const staleContext: MatchContext = {
      ...context,
      scoreA: 0,
      scoreB: 0,
    };
    const afterStale = runtime.synchronizeSeriesProgress(staleContext, sideProof);
    expect(afterStale?.score).toEqual({ a: 0, b: 0 });
    expect(afterStale?.maps[0]?.status).toBe('current');

    // 4. Local telemetry produces map end -> local freeze completes Map 1 with 13:9
    runtime.acceptObservation(frame(2, 'gameover', 'over', { ct: 13, t: 9 }));
    const frozen = runtime.synchronizeSeriesProgress(context, sideProof);
    expect(frozen?.score).toEqual({ a: 1, b: 0 });
    expect(frozen?.maps[0]?.status).toBe('completed');
    expect(frozen?.maps[0]?.finalScore).toEqual({ a: 13, b: 9 });

    // 5. Subsequent MatchContext refresh with conflicting score (13:5) does NOT overwrite frozen 13:9 score
    const afterConflictingContext = runtime.synchronizeSeriesProgress(scoredContext, sideProof);
    expect(afterConflictingContext?.maps[0]?.status).toBe('completed');
    expect(afterConflictingContext?.maps[0]?.finalScore).toEqual({ a: 13, b: 9 });
    expect(afterConflictingContext?.score).toEqual({ a: 1, b: 0 });

    // 6. Conflicting context identity (different entryId) triggers context_result_conflict and preserves local fact
    const conflictingIdentityContext: MatchContext = {
      ...context,
      entrants: {
        ...context.entrants,
        a: { ...context.entrants.a, entryId: 'rogue-entry-a' },
      },
    };
    const afterConflict = runtime.synchronizeSeriesProgress(conflictingIdentityContext, sideProof);
    expect(afterConflict?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'context_result_conflict' })]),
    );
    expect(afterConflict?.score).toEqual({ a: 1, b: 0 });
    expect(afterConflict?.maps[0]?.finalScore).toEqual({ a: 13, b: 9 });
  });
});
