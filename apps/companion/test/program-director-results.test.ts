import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MatchContext } from '@mizar/core/match-context';
import { projectSeries, type ProgramProjection } from '@mizar/core/projection';
import { createSeriesProgress, syncSeriesProgress } from '@mizar/core/series-progress';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { BpSession } from '../src/bp/controller.js';
import { ProgramSceneController } from '../src/program-scenes/controller.js';
import { DEFAULT_PROGRAM_TIMINGS, ProgramDirector } from '../src/program-scenes/director.js';
import {
  ProgramPresentationStore,
  completedMapResult,
  hasFrozenMapResult,
} from '../src/program-scenes/presentation.js';

function loadFixtures() {
  const matchContext = JSON.parse(
    readFileSync(
      new URL('../../../packages/protocol/test/fixtures/match-document-v1.json', import.meta.url),
      'utf8',
    ),
  ) as MatchContext;
  const realFixtures = JSON.parse(
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
          cursor: ProgramProjection['cursor'];
          payload: ProgramProjection;
        };
      }
    >;
  };
  const base = realFixtures.fixtures['real-gameover']!.snapshot;
  const context: MatchContext = {
    ...matchContext,
    format: 'bo3',
    status: 'in_progress',
    maps: [
      {
        mapId: 'map-1',
        mapOrder: 1,
        mapName: 'de_inferno',
        pickedByEntryId: matchContext.entrants.a.entryId,
        teamAStartSide: 'CT',
        scoreA: null,
        scoreB: null,
        completedAt: null,
      },
      {
        mapId: 'map-2',
        mapOrder: 2,
        mapName: 'de_anubis',
        pickedByEntryId: matchContext.entrants.b.entryId,
        teamAStartSide: 'CT',
        scoreA: null,
        scoreB: null,
        completedAt: null,
      },
      {
        mapId: 'map-3',
        mapOrder: 3,
        mapName: 'de_mirage',
        pickedByEntryId: null,
        teamAStartSide: 'CT',
        scoreA: null,
        scoreB: null,
        completedAt: null,
      },
    ],
  };
  return { context, base };
}

function makeProjection(
  base: { cursor: ProgramProjection['cursor']; payload: ProgramProjection },
  context: MatchContext,
  series: NonNullable<ProgramProjection['series']>,
  overrides: {
    mapName: string;
    phase: 'live' | 'gameover';
    mapEpoch: number;
    telemetry?: 'fresh' | 'stale';
    runtimeSeq: number;
    ctScore: number;
    tScore: number;
  },
): ProgramProjection {
  const teamAIds = base.payload.players.slice(0, 5).map((p, index) => ({
    ...p,
    side: 'CT' as const,
    lineupEvidence: 'current' as const,
    sourcePlayerId: `765611980000000${index + 1}`,
  }));
  const teamBIds = base.payload.players.slice(5, 10).map((p, index) => ({
    ...p,
    side: 'T' as const,
    lineupEvidence: 'current' as const,
    sourcePlayerId: `765611980000001${index + 1}`,
  }));
  return {
    ...base.payload,
    cursor: {
      ...base.cursor,
      mapEpoch: overrides.mapEpoch,
      runtimeSeq: overrides.runtimeSeq,
      programReceiveSequence: overrides.runtimeSeq,
    },
    status: {
      context: 'fresh',
      telemetry: overrides.telemetry ?? 'fresh',
      identity: 'matched',
    },
    match: {
      ...base.payload.match!,
      matchId: context.matchId,
      format: 'bo3',
    },
    series,
    map: {
      ...base.payload.map,
      name: overrides.mapName,
      phase: overrides.phase,
      score: { ct: overrides.ctScore, t: overrides.tScore },
    },
    teams: {
      ct: {
        mode: 'canonical',
        entryId: context.entrants.a.entryId,
        name: context.entrants.a.name,
        logoUrl: context.entrants.a.logoUrl,
        seriesScore: series.score.a ?? 0,
      },
      t: {
        mode: 'canonical',
        entryId: context.entrants.b.entryId,
        name: context.entrants.b.name,
        logoUrl: context.entrants.b.logoUrl,
        seriesScore: series.score.b ?? 0,
      },
    },
    players: [...teamAIds, ...teamBIds],
  };
}

describe('final map result progression', () => {
  it('transitions gameplay -> map_result -> match_result after real series completion clears currentMapOrder', async () => {
    const { context, base } = loadFixtures();
    const sideProof = (mapEpoch: number) => ({
      sourceGeneration: base.cursor.programSourceGeneration,
      mapEpoch,
      a: 'CT' as const,
      b: 'T' as const,
    });
    let progress = createSeriesProgress(context);
    progress = syncSeriesProgress(progress, {
      observation: {
        sourceGeneration: base.cursor.programSourceGeneration,
        mapEpoch: 1,
        mapName: 'de_inferno',
        roundNumber: 1,
        score: { ct: 0, t: 0 },
        roundWins: [],
      },
      sideProof: sideProof(1),
      events: [],
    }).progress;
    progress = syncSeriesProgress(progress, {
      observation: {
        sourceGeneration: base.cursor.programSourceGeneration,
        mapEpoch: 1,
        mapName: 'de_inferno',
        mapEnded: true,
        roundNumber: 24,
        score: { ct: 13, t: 11 },
        roundWins: [],
      },
      sideProof: sideProof(1),
      events: [
        {
          kind: 'map-ended',
          sourceGeneration: base.cursor.programSourceGeneration,
          mapEpoch: 1,
          finalScore: { ct: 13, t: 11 },
        },
      ],
    }).progress;
    // Map 2 goes live.
    progress = syncSeriesProgress(progress, {
      observation: {
        sourceGeneration: base.cursor.programSourceGeneration,
        mapEpoch: 2,
        mapName: 'de_anubis',
        roundNumber: 19,
        score: { ct: 12, t: 7 },
        roundWins: [],
      },
      sideProof: sideProof(2),
      events: [],
    }).progress;
    expect(progress.currentMapOrder).toBe(2);

    const presentationStore = new ProgramPresentationStore();
    let currentProgram = makeProjection(base, context, projectSeries(context, progress)!, {
      mapName: 'de_anubis',
      phase: 'live',
      mapEpoch: 2,
      runtimeSeq: 100,
      ctScore: 12,
      tScore: 7,
    });
    const coordinator = {
      getCurrent: () => ({
        program: currentProgram,
        operator: {
          runtime: { telemetryFreshness: currentProgram.status.telemetry },
          matchContext: { freshness: 'fresh', origin: 'rivalhub' },
          identity: { state: 'matched' },
        },
      }),
      getBpAssessment: () => ({ readiness: 'unavailable' as const }),
    };

    const switched: ProgramSceneId[] = [];
    const bp = new BpSession(() => null);
    const controller = new ProgramSceneController(coordinator as never, bp, async (scene) => {
      switched.push(scene);
    });
    let now = 1000;
    const director = new ProgramDirector(
      coordinator as never,
      controller,
      bp,
      () => true,
      () => now,
      DEFAULT_PROGRAM_TIMINGS,
      () => presentationStore.get(),
    );
    controller.attachDirector(director);

    // Move director into gameplay on Map 2.
    await director.tick();
    expect(switched).toEqual(['gameplay']);

    // Map 2 finishes 13:7 -> BO3 ends 2:0, SeriesProgress clears currentMapOrder to null.
    progress = syncSeriesProgress(progress, {
      observation: {
        sourceGeneration: base.cursor.programSourceGeneration,
        mapEpoch: 2,
        mapName: 'de_anubis',
        mapEnded: true,
        roundNumber: 20,
        score: { ct: 13, t: 7 },
        roundWins: [],
      },
      sideProof: sideProof(2),
      events: [
        {
          kind: 'map-ended',
          sourceGeneration: base.cursor.programSourceGeneration,
          mapEpoch: 2,
          finalScore: { ct: 13, t: 7 },
        },
      ],
    }).progress;
    expect(progress.currentMapOrder).toBeNull();

    const finalSeries = projectSeries(context, progress)!;
    expect(finalSeries.status).toBe('completed');
    currentProgram = makeProjection(base, context, finalSeries, {
      mapName: 'de_anubis',
      phase: 'gameover',
      mapEpoch: 2,
      runtimeSeq: 101,
      ctScore: 13,
      tScore: 7,
    });
    presentationStore.update(currentProgram, 'rev-1');

    // Negative check: a stale Map 1 gameover frame cannot match Map 2 completion.
    const staleMap1 = makeProjection(base, context, finalSeries, {
      mapName: 'de_inferno',
      phase: 'gameover',
      mapEpoch: 1,
      telemetry: 'stale',
      runtimeSeq: 102,
      ctScore: 13,
      tScore: 11,
    });
    expect(completedMapResult(staleMap1)).toBeUndefined();
    expect(hasFrozenMapResult(staleMap1, presentationStore.get())).toBe(false);

    // Tick 1 starts GG hold, tick 2 after ggHoldMs switches to map_result.
    now = 2000;
    await director.tick();
    expect(director.get().mode).toBe('auto');
    expect(director.get().next).toBe('map_result');
    expect(switched).toEqual(['gameplay']);

    now = 5500;
    await director.tick();
    expect(switched).toEqual(['gameplay', 'map_result']);

    // Even if telemetry drops stale during map_result, frozen result still advances to match_result.
    currentProgram = makeProjection(base, context, finalSeries, {
      mapName: 'de_anubis',
      phase: 'gameover',
      mapEpoch: 2,
      telemetry: 'stale',
      runtimeSeq: 103,
      ctScore: 13,
      tScore: 7,
    });
    // delta per tick is capped at 1000ms in ProgramDirector, so advance in 1s steps across mapResultMs (12s).
    for (let step = 1; step <= 13; step++) {
      now = 5500 + step * 1000;
      await director.tick();
    }
    await director.tick();
    expect(switched).toEqual(['gameplay', 'map_result', 'match_result']);
    expect(director.get().nextStatus).toBe('complete');
  });
});
