import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

      const diagnostics: { code: string; error: unknown }[] = [];
      const onDiagnostic = (code: string, error: unknown) => diagnostics.push({ code, error });
      const healthy = new JsonSeriesProgressCheckpointStore({ filePath: checkpointPath });
      const checkpoint = healthy.load()!;
      const broken = new JsonSeriesProgressCheckpointStore({
        filePath: join(checkpointPath, 'child.json'),
        onDiagnostic,
      });
      expect(broken.load()).toBeUndefined();
      expect(diagnostics.at(-1)).toMatchObject({
        code: 'checkpoint_read_failed',
        error: { code: 'ENOTDIR' },
      });
      await broken.save(checkpoint);
      await broken.flush();
      expect(diagnostics.at(-1)?.code).toBe('checkpoint_write_failed');
      expect(diagnostics.at(-1)?.error).toBeInstanceOf(Error);
      expect(healthy.load()).toEqual(checkpoint);

      await writeFile(checkpointPath, '{broken', 'utf8');
      const malformed = new JsonSeriesProgressCheckpointStore({
        filePath: checkpointPath,
        onDiagnostic,
      });
      expect(malformed.load()).toBeUndefined();
      expect(diagnostics.at(-1)?.code).toBe('checkpoint_invalid');
      expect(diagnostics.at(-1)?.error).toBeInstanceOf(SyntaxError);
      await expect(readFile(checkpointPath, 'utf8')).resolves.toBe('{broken');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
  it.each(['refresh', 'restart'] as const)(
    'recovers a missing prior result from explicit website completion on %s',
    (mode) => {
      const context = contextFixture();
      const store = new MemoryCheckpointStore();
      let runtime = createProgramRuntime('before', { seriesProgressCheckpointStore: store });
      runtime.acceptObservation(frame(1, 'live', 'freezetime', { ct: 0, t: 0 }));
      runtime.synchronizeSeriesProgress(context, sideProof, 'online');
      runtime.acceptObservation(frame(2, 'live', 'live', { ct: 0, t: 0 }));
      runtime.acceptObservation(frame(3, 'live', 'over', { ct: 1, t: 0 }, 'CT'));
      runtime.synchronizeSeriesProgress(context, sideProof, 'online');
      const recordedRounds = store.checkpoint!.progress.maps[0]!.roundHistory.rounds;
      const nextFrame = frame(4, 'live', 'freezetime', { ct: 0, t: 0 });
      runtime.acceptObservation({
        ...nextFrame,
        telemetry: {
          ...nextFrame.telemetry,
          map: { ...nextFrame.telemetry.map!, name: 'de_dust2' },
        },
      });
      const blocked = runtime.synchronizeSeriesProgress(context, null, 'online');
      expect(blocked?.bindingState).toBe('needs_operator');
      const history = blocked!.maps[0]!.roundHistory;
      expect(history.rounds).toEqual(recordedRounds);
      const confirmed: MatchContext = {
        ...context,
        maps: context.maps.map((map, index) =>
          index === 0
            ? { ...map, scoreA: 13, scoreB: 3, completedAt: '2026-09-18T00:30:00Z' }
            : map,
        ),
      };
      if (mode === 'restart') {
        runtime = createProgramRuntime('after', { seriesProgressCheckpointStore: store });
        runtime.acceptObservation({
          ...nextFrame,
          telemetry: {
            ...nextFrame.telemetry,
            map: { ...nextFrame.telemetry.map!, name: 'de_dust2' },
          },
        });
      }
      const recovered = runtime.synchronizeSeriesProgress(confirmed, null, 'online');
      expect(recovered).toMatchObject({
        score: { a: 1, b: 0 },
        currentMapOrder: 2,
        bindingState: 'bound',
      });
      expect(recovered?.maps[0]).toMatchObject({
        status: 'completed',
        finalScore: { a: 13, b: 3 },
        roundHistory: history,
      });
      expect(store.checkpoint?.progress).toEqual(recovered);
      expect(runtime.synchronizeSeriesProgress(confirmed, null, 'online')).toEqual(recovered);
    },
  );
});
