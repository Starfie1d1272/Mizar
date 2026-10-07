import { describe, expect, it } from 'vitest';

import {
  createSeriesProgress,
  isSeriesProgressCheckpoint,
  isSeriesProgressCheckpointCompatible,
  makeSeriesProgressCheckpoint,
  seriesMapPlanFingerprint,
  syncSeriesProgress,
  type SeriesProgressEvent,
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
  currentObservation = observation('Mirage', 1),
  currentProof: SeriesSideProof | null = proof(currentObservation.mapEpoch),
) {
  return syncSeriesProgress(progress, {
    events,
    observation: currentObservation,
    sideProof: currentProof,
  }).progress;
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
      [{ kind: 'map-ended', sourceGeneration: 0, mapEpoch: 1, finalScore: { ct: 5, t: 13 } }],
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

  it('binds maps, freezes side-aware results, and marks the BO3 remainder not played', () => {
    const context = contextFixture();
    let progress = reduce(createSeriesProgress(context));
    expect(progress.maps[0]).toMatchObject({
      mapName: 'de_mirage',
      selection: { kind: 'pick', entryId: 'a' },
      status: 'current',
      executionMapEpoch: 1,
    });

    progress = reduce(
      progress,
      [
        {
          kind: 'round-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          roundNumber: 1,
          winnerSide: 'CT',
          winCondition: 'unknown',
        },
        {
          kind: 'map-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          finalScore: { ct: 13, t: 9 },
        },
      ],
      observation('Mirage', 1, { ct: 13, t: 9 }),
    );
    expect(progress.score).toEqual({ a: 1, b: 0 });
    expect(progress.maps[0]).toMatchObject({
      status: 'completed',
      finalScore: { a: 13, b: 9 },
      winnerEntryId: 'a',
      roundHistory: {
        rounds: [{ winnerSide: 'CT', winnerEntryId: 'a' }],
      },
    });

    progress = reduce(
      progress,
      [
        {
          kind: 'map-execution-changed',
          sourceGeneration: 0,
          mapEpoch: 2,
          previousMapEpoch: 1,
          previousMapName: 'Mirage',
          mapName: 'Dust 2',
          resetReason: null,
        },
      ],
      observation('dust2', 2),
    );
    expect(progress).toMatchObject({ currentMapOrder: 2, bindingState: 'bound' });

    progress = reduce(
      progress,
      [
        {
          kind: 'round-ended',
          sourceGeneration: 0,
          mapEpoch: 2,
          roundNumber: 1,
          winnerSide: 'CT',
          winCondition: 'unknown',
        },
        {
          kind: 'map-ended',
          sourceGeneration: 0,
          mapEpoch: 2,
          finalScore: { ct: 8, t: 13 },
        },
      ],
      observation('dust2', 2, { ct: 8, t: 13 }),
      proof(2, 'T'),
    );
    expect(progress.score).toEqual({ a: 2, b: 0 });
    expect(progress.maps[0]?.roundHistory.rounds[0]?.winnerEntryId).toBe('a');
    expect(progress.maps[1]).toMatchObject({ status: 'completed', finalScore: { a: 13, b: 8 } });
    expect(progress.maps[2]).toMatchObject({ status: 'not_played' });
    expect(progress.currentMapOrder).toBeNull();
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

  it('uses the BO5 threshold without creating another score owner', () => {
    const progress = createSeriesProgress(contextFixture('bo5'));
    expect(progress.requiredWins).toBe(3);
    expect(progress.score).toEqual({ a: 0, b: 0 });
    expect(progress.maps).toHaveLength(5);
  });

  it('keeps round_ended winner side primary and marks a conflicting snapshot partial', () => {
    const context = contextFixture('bo1');
    const wins = [
      { roundNumber: 1, winnerSide: 'CT' as const, winCondition: 'elimination' as const },
      { roundNumber: 2, winnerSide: 'T' as const, winCondition: 'defuse' as const },
      { roundNumber: 3, winnerSide: 'CT' as const, winCondition: 'bomb' as const },
    ];
    const progress = reduce(
      createSeriesProgress(context),
      [],
      observation('mirage', 1, { ct: 2, t: 1 }, wins),
    );
    expect(progress.maps[0]?.roundHistory).toEqual({
      completeness: 'complete',
      rounds: wins.map((round) => ({ ...round, winnerEntryId: null })),
    });

    const primaryProgress = reduce(
      createSeriesProgress(context),
      [
        {
          kind: 'round-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          roundNumber: 1,
          winnerSide: 'T',
          winCondition: 'unknown',
        },
      ],
      observation('mirage', 1, { ct: 2, t: 1 }, wins),
      proof(1, 'T'),
    );
    expect(primaryProgress.maps[0]?.roundHistory.rounds[0]).toMatchObject({
      winnerSide: 'T',
      winnerEntryId: 'a',
      winCondition: 'elimination',
    });
    expect(primaryProgress.maps[0]?.roundHistory.completeness).toBe('partial');
    expect(primaryProgress.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'round_history_partial' })]),
    );

    const recoveredProgress = reduce(
      createSeriesProgress(context),
      [],
      observation('mirage', 1, { ct: 2, t: 1 }, wins),
      null,
    );
    expect(recoveredProgress.maps[0]?.roundHistory).toEqual({
      completeness: 'complete',
      rounds: wins.map((round) => ({ ...round, winnerEntryId: null })),
    });

    const otProgress = reduce(
      createSeriesProgress(context),
      [],
      observation('mirage', 1, { ct: 5, t: 5 }, wins.slice(0, 2)),
    );
    expect(otProgress.maps[0]?.roundHistory.completeness).toBe('partial');
    expect(otProgress.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'round_history_partial' })]),
    );
  });

  it('downgrades restored history when the new execution is behind the checkpoint', () => {
    const context = contextFixture('bo1');
    const checkpointed = reduce(
      createSeriesProgress(context),
      [
        {
          kind: 'round-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          roundNumber: 1,
          winnerSide: 'CT',
          winCondition: 'elimination',
        },
        {
          kind: 'round-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          roundNumber: 2,
          winnerSide: 'T',
          winCondition: 'defuse',
        },
        {
          kind: 'round-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          roundNumber: 3,
          winnerSide: 'CT',
          winCondition: 'bomb',
        },
      ],
      observation('mirage', 1, { ct: 2, t: 1 }),
    );

    const restored = syncSeriesProgress(checkpointed, {
      events: [],
      observation: observation('mirage', 1, { ct: 0, t: 1 }, [
        { roundNumber: 1, winnerSide: 'CT', winCondition: 'elimination' },
      ]),
      sideProof: proof(1),
      restore: true,
    }).progress;

    expect(restored.maps[0]?.roundHistory.rounds).toHaveLength(3);
    expect(restored.maps[0]?.roundHistory.completeness).toBe('partial');
    expect(restored.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'round_history_partial' })]),
    );
  });

  it('keeps checkpoint identity canonical and caps round history', () => {
    const context = contextFixture();
    let progress = reduce(createSeriesProgress(context));
    const events = Array.from({ length: 257 }, (_, index) => ({
      kind: 'round-ended' as const,
      sourceGeneration: 0,
      mapEpoch: 1,
      roundNumber: index + 1,
      winnerSide: 'CT' as const,
      winCondition: 'unknown' as const,
    }));
    progress = reduce(progress, events, observation('mirage', 1, { ct: 130, t: 127 }));
    expect(progress.maps[0]?.roundHistory.rounds).toHaveLength(256);
    expect(progress.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'round_history_cap' })]),
    );

    const checkpoint = makeSeriesProgressCheckpoint(progress);
    expect(isSeriesProgressCheckpointCompatible(checkpoint, context)).toBe(true);
    expect(seriesMapPlanFingerprint(context)).toBe(checkpoint.identity.mapPlanFingerprint);
    expect(isSeriesProgressCheckpointCompatible(checkpoint, { ...context, matchId: 'other' })).toBe(
      false,
    );
    expect(
      isSeriesProgressCheckpointCompatible(
        {
          ...checkpoint,
          progress: { ...checkpoint.progress, matchId: 'other' },
        },
        context,
      ),
    ).toBe(false);
  });

  it('completes a BO1 locally after a proven map result', () => {
    let progress = reduce(createSeriesProgress(contextFixture('bo1')));
    progress = reduce(
      progress,
      [
        {
          kind: 'map-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          finalScore: { ct: 13, t: 7 },
        },
      ],
      observation('de_mirage', 1, { ct: 13, t: 7 }),
      proof(1),
    );

    expect(progress.score).toEqual({ a: 1, b: 0 });
    expect(progress.maps[0]).toMatchObject({
      status: 'completed',
      finalScore: { a: 13, b: 7 },
      winnerEntryId: 'a',
    });
    expect(progress.currentMapOrder).toBeNull();
  });

  it('completes a BO5 at three map wins and marks the remainder not played', () => {
    let progress = reduce(createSeriesProgress(contextFixture('bo5')));

    progress = reduce(
      progress,
      [
        {
          kind: 'map-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          finalScore: { ct: 13, t: 9 },
        },
      ],
      observation('de_mirage', 1, { ct: 13, t: 9 }),
      proof(1),
    );
    expect(progress.score).toEqual({ a: 1, b: 0 });

    progress = reduce(
      progress,
      [
        {
          kind: 'map-execution-changed',
          sourceGeneration: 0,
          mapEpoch: 2,
          previousMapEpoch: 1,
          previousMapName: 'de_mirage',
          mapName: 'de_dust2',
          resetReason: null,
        },
        {
          kind: 'map-ended',
          sourceGeneration: 0,
          mapEpoch: 2,
          finalScore: { ct: 9, t: 13 },
        },
      ],
      observation('de_dust2', 2, { ct: 9, t: 13 }),
      proof(2, 'T'),
    );
    expect(progress.score).toEqual({ a: 2, b: 0 });

    progress = reduce(
      progress,
      [
        {
          kind: 'map-execution-changed',
          sourceGeneration: 0,
          mapEpoch: 3,
          previousMapEpoch: 2,
          previousMapName: 'de_dust2',
          mapName: 'de_inferno',
          resetReason: null,
        },
        {
          kind: 'map-ended',
          sourceGeneration: 0,
          mapEpoch: 3,
          finalScore: { ct: 13, t: 11 },
        },
      ],
      observation('de_inferno', 3, { ct: 13, t: 11 }),
      proof(3),
    );

    expect(progress.score).toEqual({ a: 3, b: 0 });
    expect(progress.maps.slice(0, 3).every((map) => map.status === 'completed')).toBe(true);
    expect(progress.maps.slice(3).every((map) => map.status === 'not_played')).toBe(true);
    expect(progress.currentMapOrder).toBeNull();
  });

  it('fails closed on a map-order exception and rejects binding over a completed slot', () => {
    const context = contextFixture();
    const outOfOrder = reduce(createSeriesProgress(context), [], observation('de_inferno', 1));
    expect(outOfOrder).toMatchObject({ bindingState: 'needs_operator', currentMapOrder: null });
    expect(outOfOrder.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'map_order_exception' })]),
    );

    let progress = reduce(createSeriesProgress(context));
    progress = reduce(
      progress,
      [
        {
          kind: 'map-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          finalScore: { ct: 13, t: 9 },
        },
      ],
      observation('de_mirage', 1, { ct: 13, t: 9 }),
      proof(1),
    );
    progress = reduce(
      progress,
      [
        {
          kind: 'map-execution-changed',
          sourceGeneration: 0,
          mapEpoch: 2,
          previousMapEpoch: 1,
          previousMapName: 'de_mirage',
          mapName: 'de_dust2',
          resetReason: null,
        },
      ],
      observation('de_dust2', 2),
      proof(2),
    );
    progress = reduce(
      progress,
      [
        {
          kind: 'operator-map-bind',
          sourceGeneration: 0,
          mapEpoch: 2,
          mapOrder: 1,
          mapName: 'de_dust2',
          reason: '尝试覆盖已完成地图',
        },
      ],
      observation('de_dust2', 2),
      proof(2),
    );

    expect(progress.currentMapOrder).toBe(2);
    expect(progress.maps[0]?.status).toBe('completed');
    expect(progress.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'operator_bind_rejected' })]),
    );
  });

  it('freezes entrant identity per round across side changes and never backfills missing proof', () => {
    let progress = reduce(createSeriesProgress(contextFixture('bo1')));

    progress = reduce(
      progress,
      [
        {
          kind: 'round-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          roundNumber: 1,
          winnerSide: 'CT',
          winCondition: 'elimination',
        },
      ],
      observation('de_mirage', 1, { ct: 1, t: 0 }),
      proof(1, 'CT'),
    );
    progress = reduce(
      progress,
      [
        {
          kind: 'round-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          roundNumber: 2,
          winnerSide: 'CT',
          winCondition: 'time',
        },
      ],
      observation('de_mirage', 1, { ct: 2, t: 0 }),
      proof(1, 'T'),
    );
    progress = reduce(
      progress,
      [
        {
          kind: 'round-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          roundNumber: 3,
          winnerSide: 'T',
          winCondition: 'bomb',
        },
      ],
      observation('de_mirage', 1, { ct: 2, t: 1 }),
      null,
    );

    expect(progress.maps[0]?.roundHistory.rounds).toMatchObject([
      { roundNumber: 1, winnerEntryId: 'a' },
      { roundNumber: 2, winnerEntryId: 'b' },
      { roundNumber: 3, winnerEntryId: null },
    ]);

    const laterProof = reduce(
      progress,
      [],
      observation('de_mirage', 1, { ct: 2, t: 1 }),
      proof(1, 'CT'),
    );
    expect(laterProof.maps[0]?.roundHistory.rounds[2]?.winnerEntryId).toBeNull();
  });

  it('retains same-map progress across source generation changes', () => {
    let progress = reduce(createSeriesProgress(contextFixture('bo1')));
    progress = reduce(
      progress,
      [
        {
          kind: 'round-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          roundNumber: 1,
          winnerSide: 'CT',
          winCondition: 'elimination',
        },
      ],
      observation('de_mirage', 1, { ct: 1, t: 0 }),
      proof(1),
    );

    const reconnected = syncSeriesProgress(progress, {
      events: [],
      observation: {
        ...observation('de_mirage', 1, { ct: 1, t: 0 }),
        sourceGeneration: 1,
      },
      sideProof: { ...proof(1), sourceGeneration: 1 },
    }).progress;

    expect(reconnected.currentMapOrder).toBe(1);
    expect(reconnected.maps[0]?.executionMapEpoch).toBe(1);
    expect(reconnected.maps[0]?.roundHistory.rounds).toEqual(progress.maps[0]?.roundHistory.rounds);
  });

  it('same-map restart clears only the unfinished current map history', () => {
    const context = contextFixture();
    let progress = reduce(createSeriesProgress(context));
    progress = reduce(
      progress,
      [
        {
          kind: 'map-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          finalScore: { ct: 13, t: 9 },
        },
      ],
      observation('de_mirage', 1, { ct: 13, t: 9 }),
      proof(1),
    );
    progress = reduce(
      progress,
      [
        {
          kind: 'map-execution-changed',
          sourceGeneration: 0,
          mapEpoch: 2,
          previousMapEpoch: 1,
          previousMapName: 'de_mirage',
          mapName: 'de_dust2',
          resetReason: null,
        },
        {
          kind: 'round-ended',
          sourceGeneration: 0,
          mapEpoch: 2,
          roundNumber: 1,
          winnerSide: 'CT',
          winCondition: 'elimination',
        },
      ],
      observation('de_dust2', 2, { ct: 1, t: 0 }),
      proof(2),
    );
    expect(progress.maps[1]?.roundHistory.rounds).toHaveLength(1);

    progress = reduce(
      progress,
      [
        {
          kind: 'map-execution-changed',
          sourceGeneration: 0,
          mapEpoch: 3,
          previousMapEpoch: 2,
          previousMapName: 'de_dust2',
          mapName: 'de_dust2',
          resetReason: 'same-map-restart',
        },
      ],
      observation('de_dust2', 3),
      proof(3),
    );

    expect(progress.score).toEqual({ a: 1, b: 0 });
    expect(progress.maps[0]).toMatchObject({
      status: 'completed',
      finalScore: { a: 13, b: 9 },
    });
    expect(progress.maps[1]).toMatchObject({
      status: 'current',
      executionMapEpoch: 3,
      roundHistory: { completeness: 'unavailable', rounds: [] },
    });
  });
  it('C.1 recovers regulation mid-map history from round_wins, preserves unknown win condition, and deduplicates round_ended with round_wins', () => {
    const context = contextFixture('bo1');
    const midMapWins = [
      { roundNumber: 1, winnerSide: 'CT' as const, winCondition: 'elimination' as const },
      { roundNumber: 2, winnerSide: 'T' as const, winCondition: 'bomb' as const },
      { roundNumber: 3, winnerSide: 'CT' as const, winCondition: 'unknown' as const },
      { roundNumber: 4, winnerSide: 'CT' as const, winCondition: 'defuse' as const },
    ];

    // Mid-map attach with score 3:1 and 4 round_wins:
    let progress = reduce(
      createSeriesProgress(context),
      [],
      observation('de_mirage', 1, { ct: 3, t: 1 }, midMapWins),
      proof(1, 'CT'),
    );
    expect(progress.maps[0]?.roundHistory.rounds).toHaveLength(4);
    expect(progress.maps[0]?.roundHistory.completeness).toBe('complete');
    // Round 3 preserves unknown winCondition
    expect(progress.maps[0]?.roundHistory.rounds[2]?.winCondition).toBe('unknown');

    // Live round_ended arrives for round 4 with known winCondition:
    progress = reduce(
      progress,
      [
        {
          kind: 'round-ended',
          sourceGeneration: 0,
          mapEpoch: 1,
          roundNumber: 4,
          winnerSide: 'CT',
          winCondition: 'defuse',
        },
      ],
      observation('de_mirage', 1, { ct: 3, t: 1 }, midMapWins),
      proof(1, 'CT'),
    );
    // Deduplicated: round 4 is NOT duplicated into 5 entries, and unproven historical entrant is not backfilled:
    expect(progress.maps[0]?.roundHistory.rounds).toHaveLength(4);
    expect(progress.maps[0]?.roundHistory.rounds[3]).toMatchObject({
      roundNumber: 4,
      winnerSide: 'CT',
      winnerEntryId: null,
      winCondition: 'defuse',
    });
  });

  it('C.2 flags partial when restore + round_wins + score have conflict combinations and unprovable OT indices without guessing round offsets', () => {
    const context = contextFixture('bo1');

    // Score is 7:5 (12 rounds total), but roundWins only has 8 rounds:
    const incompleteWins = Array.from({ length: 8 }, (_, i) => ({
      roundNumber: i + 1,
      winnerSide: 'CT' as const,
      winCondition: 'elimination' as const,
    }));
    const partialProgress = reduce(
      createSeriesProgress(context),
      [],
      observation('de_mirage', 1, { ct: 7, t: 5 }, incompleteWins),
      proof(1, 'CT'),
    );
    expect(partialProgress.maps[0]?.roundHistory.completeness).toBe('partial');
    expect(partialProgress.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'round_history_partial' })]),
    );

    // OT scenario: score is 16:15, but roundWins has fewer rounds than total score:
    const otWins = [
      { roundNumber: 1, winnerSide: 'CT' as const, winCondition: 'elimination' as const },
      { roundNumber: 2, winnerSide: 'T' as const, winCondition: 'bomb' as const },
    ];
    const otProgress = reduce(
      createSeriesProgress(context),
      [],
      observation('de_mirage', 1, { ct: 16, t: 15 }, otWins),
      proof(1, 'CT'),
    );
    // Must fail closed to partial, no guessing OT offset:
    expect(otProgress.maps[0]?.roundHistory.completeness).toBe('partial');
    expect(otProgress.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'round_history_partial' })]),
    );
  });

  it('D.1 verifies pick, decider, independent teamAStartSide across BO1, BO3, and BO5 formats', () => {
    const bo1 = createSeriesProgress(contextFixture('bo1'));
    expect(bo1.format).toBe('bo1');
    expect(bo1.requiredWins).toBe(1);
    expect(bo1.maps).toHaveLength(1);

    const bo3 = createSeriesProgress(contextFixture('bo3'));
    expect(bo3.format).toBe('bo3');
    expect(bo3.requiredWins).toBe(2);
    expect(bo3.maps).toHaveLength(3);
    expect(bo3.maps[0]?.selection).toEqual({ kind: 'pick', entryId: 'a' });
    expect(bo3.maps[0]?.teamAStartSide).toBe('CT');
    expect(bo3.maps[1]?.selection).toEqual({ kind: 'pick', entryId: 'b' });
    expect(bo3.maps[1]?.teamAStartSide).toBe('T');
    // Map 3 is decider, with start side independent from pick
    expect(bo3.maps[2]?.selection).toEqual({ kind: 'decider' });

    const bo5 = createSeriesProgress(contextFixture('bo5'));
    expect(bo5.format).toBe('bo5');
    expect(bo5.requiredWins).toBe(3);
    expect(bo5.maps).toHaveLength(5);
  });

  it('D.2 normalizes map aliases (Dust 2 / Dust II / dust2, Mirage / mirage) and fails closed on duplicate canonical map slot ambiguity', () => {
    // 1. Dust 2 / Dust II / dust2 aliases:
    const contextWithDust2: MatchContext = {
      ...contextFixture('bo3'),
      maps: [
        {
          mapId: 'map-1',
          mapOrder: 1,
          mapName: 'Dust II',
          pickedByEntryId: 'a',
          teamAStartSide: 'CT',
          scoreA: null,
          scoreB: null,
          completedAt: null,
        },
        {
          mapId: 'map-2',
          mapOrder: 2,
          mapName: 'Mirage',
          pickedByEntryId: 'b',
          teamAStartSide: 'T',
          scoreA: null,
          scoreB: null,
          completedAt: null,
        },
        {
          mapId: 'map-3',
          mapOrder: 3,
          mapName: 'de_inferno',
          pickedByEntryId: null,
          teamAStartSide: 'CT',
          scoreA: null,
          scoreB: null,
          completedAt: null,
        },
      ],
    };
    const progress = reduce(createSeriesProgress(contextWithDust2), [], observation('dust2', 1));
    expect(progress.bindingState).toBe('bound');
    expect(progress.currentMapOrder).toBe(1);
    expect(progress.maps[0]?.mapName).toBe('de_dust2');

    // 2. Duplicate canonical map slots ambiguity fails closed:
    const ambiguousContext: MatchContext = {
      ...contextFixture('bo3'),
      maps: [
        {
          mapId: 'map-1',
          mapOrder: 1,
          mapName: 'de_mirage',
          pickedByEntryId: 'a',
          teamAStartSide: 'CT',
          scoreA: null,
          scoreB: null,
          completedAt: null,
        },
        {
          mapId: 'map-2',
          mapOrder: 2,
          mapName: 'Mirage', // Both map 1 and map 2 canonicalize to de_mirage!
          pickedByEntryId: 'b',
          teamAStartSide: 'T',
          scoreA: null,
          scoreB: null,
          completedAt: null,
        },
        {
          mapId: 'map-3',
          mapOrder: 3,
          mapName: 'de_inferno',
          pickedByEntryId: null,
          teamAStartSide: 'CT',
          scoreA: null,
          scoreB: null,
          completedAt: null,
        },
      ],
    };
    const ambiguousProgress = reduce(
      createSeriesProgress(ambiguousContext),
      [],
      observation('mirage', 1),
    );
    expect(ambiguousProgress.bindingState).toBe('needs_operator');
    expect(ambiguousProgress.currentMapOrder).toBeNull();
    expect(ambiguousProgress.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'map_ambiguous' })]),
    );
  });
});

describe('unplanned map observations', () => {
  const context = (): MatchContext => ({
    ...contextFixture(),
    competition: null,
    maps: [],
    veto: [],
    mapPool: ['de_mirage', 'de_dust2', 'de_inferno'],
  });

  it('round-trips an empty checkpoint and rejects malformed empty progress', () => {
    const checkpoint = makeSeriesProgressCheckpoint(createSeriesProgress(context()));
    expect(isSeriesProgressCheckpoint(JSON.parse(JSON.stringify(checkpoint)))).toBe(true);
    expect(isSeriesProgressCheckpointCompatible(checkpoint, context())).toBe(true);
    expect(
      isSeriesProgressCheckpoint({
        ...checkpoint,
        progress: { ...checkpoint.progress, score: { a: 1, b: 0 } },
      }),
    ).toBe(false);
    expect(
      isSeriesProgressCheckpoint({
        ...checkpoint,
        progress: { ...checkpoint.progress, currentMapOrder: 1 },
      }),
    ).toBe(false);
  });

  it('observes and completes a BO3 without changing the frozen plan identity', () => {
    let progress = createSeriesProgress(context());
    const fingerprint = makeSeriesProgressCheckpoint(progress).identity.mapPlanFingerprint;
    for (const [index, mapName] of ['de_mirage', 'de_dust2'].entries()) {
      const epoch = index + 1;
      progress = reduce(progress, [], observation(mapName, epoch));
      expect(progress.maps[index]).toMatchObject({
        mapId: null,
        mapOrder: epoch,
        mapName,
        selection: { kind: 'unknown' },
        status: 'current',
      });
      progress = reduce(
        progress,
        [{ kind: 'map-ended', sourceGeneration: 0, mapEpoch: epoch, finalScore: { ct: 13, t: 7 } }],
        observation(mapName, epoch, { ct: 13, t: 7 }),
        proof(epoch),
      );
      const checkpoint: unknown = JSON.parse(
        JSON.stringify(makeSeriesProgressCheckpoint(progress)),
      );
      if (!isSeriesProgressCheckpoint(checkpoint)) throw new Error('Invalid checkpoint round-trip');
      expect(checkpoint.identity.mapPlanFingerprint).toBe(fingerprint);
      expect(isSeriesProgressCheckpointCompatible(checkpoint, context())).toBe(true);
      progress = checkpoint.progress;
    }
    expect(progress.score).toEqual({ a: 2, b: 0 });
    expect(reduce(progress, [], observation('de_inferno', 3)).maps).toHaveLength(2);
  });

  it('requires pool membership and a completed preceding map, never guesses side identity', () => {
    const initial = createSeriesProgress(context());
    const outsidePool = reduce(initial, [], observation('de_nuke', 1));
    expect(outsidePool.maps).toEqual([]);
    expect(isSeriesProgressCheckpoint(makeSeriesProgressCheckpoint(outsidePool))).toBe(true);
    let progress = reduce(initial);
    const interrupted = reduce(progress, [], observation('de_dust2', 2));
    expect(interrupted.maps).toHaveLength(1);
    expect(interrupted.bindingState).toBe('needs_operator');
    expect(reduce(interrupted).bindingState).toBe('bound');
    progress = reduce(
      progress,
      [{ kind: 'map-ended', sourceGeneration: 0, mapEpoch: 1, finalScore: { ct: 13, t: 7 } }],
      observation('de_mirage', 1, { ct: 13, t: 7 }),
      null,
    );
    expect(progress.score).toEqual({ a: 0, b: 0 });
    expect(progress.issues.some((issue) => issue.code === 'side_mapping_unproven')).toBe(true);
    expect(reduce(progress, [], observation('de_dust2', 2)).maps).toHaveLength(1);
  });

  it('does not append slots for repeated observations or same-map restart', () => {
    let progress = reduce(createSeriesProgress(context()));
    progress = reduce(progress);
    progress = reduce(
      progress,
      [
        {
          kind: 'map-execution-changed',
          sourceGeneration: 0,
          mapEpoch: 2,
          previousMapEpoch: 1,
          previousMapName: 'de_mirage',
          mapName: 'de_mirage',
          resetReason: 'same-map-restart',
        },
      ],
      observation('de_mirage', 2),
    );
    expect(progress.maps).toHaveLength(1);
    expect(progress.maps[0]?.executionMapEpoch).toBe(2);
    expect(
      isSeriesProgressCheckpointCompatible(makeSeriesProgressCheckpoint(progress), {
        ...context(),
        mapPool: ['de_nuke'],
      }),
    ).toBe(false);
  });
});
