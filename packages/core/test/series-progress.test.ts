import { describe, expect, it } from 'vitest';

import {
  createSeriesProgress,
  reconcileSeriesProgressResults,
  syncSeriesProgress,
  type SeriesProgressEvent,
  type SeriesMapObservation,
  type SeriesSideProof,
} from '../src/series-progress/index.js';
import type { MatchContext } from '../src/match-context/index.js';

function contextFixture(format: MatchContext['format'] = 'bo3'): MatchContext {
  const mapNames =
    format === 'bo1'
      ? ['Mirage']
      : format === 'bo3'
        ? ['Mirage', 'Dust 2', 'de_inferno']
        : ['Mirage', 'Dust 2', 'de_inferno', 'de_overpass', 'de_vertigo'];
  const entrant = (entryId: 'a' | 'b', name: string) => ({
    entryId,
    name,
    logoUrl: null,
    rosterId: `${entryId}-roster`,
    players: [],
  });
  return {
    matchId: 'series-test',
    competition: {
      competitionId: 'competition-test',
      slug: 'series-test',
      name: 'Series Test',
      themeColor: null,
    },
    status: 'in_progress',
    format,
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
    maps: mapNames.map((mapName, index) => ({
      mapId: `map-${index + 1}`,
      mapOrder: index + 1,
      mapName,
      pickedByEntryId: index === 0 ? 'a' : index === 1 ? 'b' : null,
      teamAStartSide: index === 0 ? 'CT' : 'T',
      scoreA: null,
      scoreB: null,
      completedAt: null,
    })),
    veto: [
      {
        stepOrder: 5,
        actionType: 'decider',
        mapName: 'de_inferno',
        entryId: null,
        side: null,
      },
    ],
    commentators: [],
  };
}

function observation(
  mapName: string,
  mapEpoch: number,
  score: { readonly ct: number | null; readonly t: number | null } = { ct: 0, t: 0 },
  roundWins: readonly {
    readonly roundNumber: number;
    readonly winnerSide: 'CT' | 'T' | 'unknown';
    readonly winCondition: 'elimination' | 'bomb' | 'defuse' | 'time' | 'unknown';
  }[] = [],
) {
  return {
    sourceGeneration: 0,
    mapEpoch,
    mapName,
    mapEnded: false,
    roundNumber: score.ct === null || score.t === null ? null : score.ct + score.t,
    score,
    roundWins,
  } as const;
}

function proof(mapEpoch: number, a: 'CT' | 'T' = 'CT'): SeriesSideProof {
  return {
    sourceGeneration: 0,
    mapEpoch,
    a,
    b: a === 'CT' ? 'T' : 'CT',
  };
}

function reduce(
  progress: ReturnType<typeof createSeriesProgress>,
  events: readonly SeriesProgressEvent[] = [],
  currentObservation: SeriesMapObservation = observation('Mirage', 1),
  currentProof: SeriesSideProof | null = proof(currentObservation.mapEpoch),
) {
  return syncSeriesProgress(progress, {
    events,
    observation: currentObservation,
    sideProof: currentProof,
  }).progress;
}

function mapEnded(mapEpoch: number, finalScore: { ct: number; t: number }): SeriesProgressEvent {
  return { kind: 'map-ended', sourceGeneration: 0, mapEpoch, finalScore };
}

describe('SeriesProgress', () => {
  it('reconciles the final absolute round history before the same observation freezes the map', () => {
    // Real RC20 Nuke: gameover arrives with round=18, score=5:13,
    // round.phase=freezetime and all 18 round_wins; there is no round_ended transition.
    const wins = Array.from({ length: 18 }, (_, index) => ({
      roundNumber: index + 1,
      winnerSide: index < 5 ? ('CT' as const) : ('T' as const),
      winCondition: index === 17 ? ('bomb' as const) : ('elimination' as const),
    }));
    let progress = reduce(
      createSeriesProgress(contextFixture()),
      [],
      observation('Mirage', 1, { ct: 5, t: 12 }, wins.slice(0, 17)),
    );
    progress = reduce(
      progress,
      [mapEnded(1, { ct: 5, t: 13 })],
      observation('Mirage', 1, { ct: 5, t: 13 }, wins),
    );
    expect(progress.maps[0]).toMatchObject({ status: 'completed', finalScore: { a: 5, b: 13 } });
    expect(progress.maps[0]?.roundHistory.rounds).toHaveLength(18);
    expect(progress.maps[0]?.roundHistory.rounds[17]).toMatchObject({
      roundNumber: 18,
      winnerSide: 'T',
      winCondition: 'bomb',
    });
    expect(progress.maps[0]?.roundHistory.completeness).toBe('complete');
    const frozen = progress.maps[0];
    progress = reduce(
      progress,
      [],
      observation(
        'Mirage',
        1,
        { ct: 13, t: 5 },
        wins.map((win) => ({ ...win, winnerSide: 'CT' as const })),
      ),
    );
    expect(progress.maps[0]).toEqual(frozen);
  });

  it('fails closed on an unexpected map and supports a reasoned operator bind', () => {
    const context = contextFixture();
    let progress = reduce(createSeriesProgress(context), [], observation('de_overpass', 1));
    expect(progress).toMatchObject({ bindingState: 'needs_operator', currentMapOrder: null });
    expect(progress.score).toEqual({ a: 0, b: 0 });
    expect(progress.maps.every((map) => map.roundHistory.rounds.length === 0)).toBe(true);

    progress = reduce(
      progress,
      [
        {
          kind: 'operator-map-bind',
          sourceGeneration: 0,
          mapEpoch: 1,
          mapOrder: 1,
          mapName: 'de_overpass',
          reason: '赛事席确认当前服务端地图对应计划第一图',
        },
      ],
      observation('de_overpass', 1),
    );
    expect(progress).toMatchObject({ bindingState: 'bound', currentMapOrder: 1 });
    expect(progress.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'operator_bind_applied' })]),
    );

    const rejected = reduce(
      createSeriesProgress(context),
      [
        {
          kind: 'operator-map-bind',
          sourceGeneration: 0,
          mapEpoch: 1,
          mapOrder: 4,
          mapName: 'de_overpass',
          reason: '错误的计划序号',
        },
      ],
      observation('de_overpass', 1),
    );
    expect(rejected.bindingState).toBe('needs_operator');
    expect(rejected.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'operator_bind_rejected' })]),
    );
  });
});

it('observed completion advances only the adjacent planned map without awarding a result', () => {
  const context = contextFixture();
  const displayProof = { ...proof(1), displayOnly: true };
  let progress = reduce(createSeriesProgress(context), [], observation('Mirage', 1), displayProof);
  progress = reduce(
    progress,
    [mapEnded(1, { ct: 13, t: 6 })],
    { ...observation('Mirage', 1, { ct: 13, t: 6 }), mapEnded: true },
    displayProof,
  );
  expect(progress.maps[0]).toMatchObject({
    status: 'completed',
    finalScore: null,
    winnerEntryId: null,
  });
  expect(progress.score).toEqual({ a: 0, b: 0 });
  const next = reduce(progress, [], observation('Dust 2', 2), { ...proof(2), displayOnly: true });
  expect(next.bindingState).toBe('bound');
  expect(next.currentMapOrder).toBe(2);
  expect(next.score).toEqual({ a: 0, b: 0 });
  const skipped = reduce(progress, [], observation('de_inferno', 2), {
    ...proof(2),
    displayOnly: true,
  });
  expect(skipped.bindingState).toBe('needs_operator');
  const withoutEnd = reduce(
    createSeriesProgress(context),
    [],
    observation('Mirage', 1),
    displayProof,
  );
  expect(
    reduce(withoutEnd, [], observation('Dust 2', 2), { ...proof(2), displayOnly: true })
      .bindingState,
  ).toBe('needs_operator');
});

it('preserves frozen results and history, exposes conflicts, and clears an agreeing result conflict', () => {
  const context = contextFixture();
  const progress = createSeriesProgress(context);
  const frozen = {
    ...progress,
    maps: progress.maps.map((map, index) =>
      index === 0
        ? {
            ...map,
            status: 'completed' as const,
            finalScore: { a: 13, b: 9 },
            winnerEntryId: 'a',
          }
        : map,
    ),
    score: { a: 1, b: 0 },
  };
  const website = {
    ...context,
    maps: context.maps.map((map, index) =>
      index === 0 ? { ...map, scoreA: 3, scoreB: 13, completedAt: '2026-10-13T14:13:45Z' } : map,
    ),
  };
  const conflict = reconcileSeriesProgressResults(frozen, website);
  expect(conflict.maps).toBe(frozen.maps);
  expect(conflict.score).toEqual({ a: 1, b: 0 });
  expect(conflict.issues).toContainEqual(
    expect.objectContaining({ code: 'context_result_conflict', mapOrder: 1 }),
  );
  const later = {
    ...website,
    maps: website.maps.map((map, index) =>
      index === 1 ? { ...map, scoreA: 3, scoreB: 13, completedAt: '2026-10-13T15:04:15Z' } : map,
    ),
  };
  const stillConflicted = reconcileSeriesProgressResults(conflict, later);
  expect(stillConflicted.score).toEqual({ a: 1, b: 0 });
  expect(stillConflicted.maps[1]?.finalScore).toBeNull();
  const agreeing = {
    ...website,
    maps: website.maps.map((map, index) => (index === 0 ? { ...map, scoreA: 13, scoreB: 9 } : map)),
  };
  expect(reconcileSeriesProgressResults(conflict, agreeing)).toEqual(frozen);
});

it('requires explicit completion, identical identity and plan, and does not skip missing results', () => {
  const context = contextFixture();
  const progress = createSeriesProgress(context);
  const scoreOnly = {
    ...context,
    maps: context.maps.map((map, index) => (index === 0 ? { ...map, scoreA: 13, scoreB: 3 } : map)),
  };
  const completed = {
    ...scoreOnly,
    maps: scoreOnly.maps.map((map, index) =>
      index === 0 ? { ...map, completedAt: '2026-10-13T14:13:45Z' } : map,
    ),
  };
  expect(reconcileSeriesProgressResults(progress, scoreOnly)).toBe(progress);
  expect(reconcileSeriesProgressResults(progress, { ...completed, matchId: 'another' })).toBe(
    progress,
  );
  expect(
    reconcileSeriesProgressResults(progress, {
      ...completed,
      entrants: {
        ...completed.entrants,
        a: { ...completed.entrants.a, entryId: 'replacement' },
      },
    }),
  ).toBe(progress);
  expect(
    reconcileSeriesProgressResults(progress, {
      ...completed,
      maps: completed.maps.map((map, index) =>
        index === 0 ? { ...map, teamAStartSide: 'T' as const } : map,
      ),
    }),
  ).toBe(progress);
  const laterOnly = {
    ...context,
    maps: context.maps.map((map, index) =>
      index === 1 ? { ...map, scoreA: 13, scoreB: 3, completedAt: '2026-10-13T14:13:45Z' } : map,
    ),
  };
  expect(reconcileSeriesProgressResults(progress, laterOnly)).toBe(progress);
  const completedSeries = {
    ...completed,
    maps: completed.maps.map((map, index) =>
      index > 0 ? { ...map, scoreA: 13, scoreB: 3, completedAt: '2026-10-13T15:04:15Z' } : map,
    ),
  };
  const result = reconcileSeriesProgressResults(progress, completedSeries);
  expect(result.score).toEqual({ a: 2, b: 0 });
  expect(result.maps[2]?.status).toBe('not_played');
  expect(result.maps[2]?.finalScore).toBeNull();
  expect(result.issues).toContainEqual(
    expect.objectContaining({ code: 'context_result_conflict', mapOrder: 3 }),
  );
});
