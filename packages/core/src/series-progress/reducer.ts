import { canonicalizeCs2MapName } from '../map-name.js';
import type { MatchContext, MatchMapContext } from '../match-context/index.js';
import type { SourceSide } from '../telemetry/index.js';
import {
  SERIES_PROGRESS_CHECKPOINT_VERSION,
  SERIES_ROUND_HISTORY_MAX,
  type SeriesMapObservation,
  type SeriesMapProgress,
  type SeriesProgress,
  type SeriesProgressCheckpoint,
  type SeriesProgressEvent,
  type SeriesProgressIssue,
  type SeriesProgressReduceResult,
  type SeriesProgressSyncInput,
  type SeriesRoundHistory,
  type SeriesRoundResult,
  type SeriesSideProof,
} from './types.js';
import {
  requiredSeriesWins,
  isSeriesProgressCheckpoint,
  seriesCheckpointIdentity,
  seriesProgressMapPlanFingerprint,
} from './types.js';

const MAX_SERIES_ISSUES = 64;

function issue(
  code: SeriesProgressIssue['code'],
  severity: SeriesProgressIssue['severity'],
  message: string,
  mapOrder: number | null = null,
  mapEpoch: number | null = null,
): SeriesProgressIssue {
  return { code, severity, message, mapOrder, mapEpoch };
}

function addIssue(progress: SeriesProgress, nextIssue: SeriesProgressIssue): SeriesProgress {
  const duplicate = progress.issues.some(
    (existing) =>
      existing.code === nextIssue.code &&
      existing.mapOrder === nextIssue.mapOrder &&
      existing.mapEpoch === nextIssue.mapEpoch,
  );
  if (duplicate) return progress;
  const issues = [...progress.issues, nextIssue];
  if (issues.length > MAX_SERIES_ISSUES) issues.splice(0, issues.length - MAX_SERIES_ISSUES);
  return { ...progress, issues };
}

function canonicalMapName(value: string): string {
  return canonicalizeCs2MapName(value) ?? value.trim().toLowerCase();
}

function selectionFor(context: MatchContext, map: MatchMapContext) {
  if (map.pickedByEntryId !== null) return { kind: 'pick' as const, entryId: map.pickedByEntryId };
  const decider = context.veto.find(
    (step) =>
      step.actionType === 'decider' &&
      canonicalMapName(step.mapName) === canonicalMapName(map.mapName),
  );
  return decider === undefined ? { kind: 'unknown' as const } : { kind: 'decider' as const };
}

function finalScoreFromContext(map: MatchMapContext): SeriesMapProgress['finalScore'] {
  return map.scoreA !== null && map.scoreB !== null ? { a: map.scoreA, b: map.scoreB } : null;
}

function winnerForScore(
  score: SeriesMapProgress['finalScore'],
  entrants: SeriesProgress['entrants'],
): string | null {
  if (score === null || score.a === score.b) return null;
  return score.a > score.b ? entrants.a.entryId : entrants.b.entryId;
}

function emptyRoundHistory(): SeriesRoundHistory {
  return { completeness: 'unavailable', rounds: [] };
}

function initialMapStatus(map: MatchMapContext): SeriesMapProgress['status'] {
  return map.scoreA !== null && map.scoreB !== null ? 'completed' : 'pending';
}

function initialMaps(context: MatchContext): readonly SeriesMapProgress[] {
  return context.maps
    .slice()
    .sort((left, right) => left.mapOrder - right.mapOrder || left.mapId.localeCompare(right.mapId))
    .map((map) => {
      const finalScore = finalScoreFromContext(map);
      return {
        mapId: map.mapId,
        mapOrder: map.mapOrder,
        mapName: canonicalMapName(map.mapName),
        selection: selectionFor(context, map),
        teamAStartSide: map.teamAStartSide,
        status: initialMapStatus(map),
        executionMapEpoch: null,
        finalScore,
        winnerEntryId: winnerForScore(finalScore, {
          a: { entryId: context.entrants.a.entryId, name: '', logoUrl: null },
          b: { entryId: context.entrants.b.entryId, name: '', logoUrl: null },
        }),
        roundHistory: emptyRoundHistory(),
      };
    });
}

function scoreFromCompletedMaps(
  maps: readonly SeriesMapProgress[],
  entrants: SeriesProgress['entrants'],
): SeriesProgress['score'] {
  let a = 0;
  let b = 0;
  for (const map of maps) {
    if (map.status !== 'completed' || map.winnerEntryId === null) continue;
    if (map.winnerEntryId === entrants.a.entryId) a += 1;
    if (map.winnerEntryId === entrants.b.entryId) b += 1;
  }
  return { a, b };
}

function applySeriesCompletion(progress: SeriesProgress): SeriesProgress {
  const complete =
    progress.score.a >= progress.requiredWins || progress.score.b >= progress.requiredWins;
  if (!complete) return progress;
  const completedOrders = progress.maps
    .filter((map) => map.status === 'completed')
    .map((map) => map.mapOrder)
    .sort((a, b) => a - b);
  // Late evidence can skip an earlier map; unknown games are not "not played".
  if (!completedOrders.every((order, index) => order === index + 1)) return progress;
  const maps = progress.maps.map((map) =>
    map.status === 'pending' || map.status === 'current'
      ? { ...map, status: 'not_played' as const }
      : map,
  );
  return { ...progress, maps, currentMapOrder: null, bindingState: 'bound' };
}

function recomputeScore(progress: SeriesProgress, maps = progress.maps): SeriesProgress {
  const score = scoreFromCompletedMaps(maps, progress.entrants);
  return applySeriesCompletion({ ...progress, maps, score });
}

function isPlayable(map: SeriesMapProgress): boolean {
  return map.status === 'pending' || map.status === 'current';
}

function nextPlayableMap(progress: SeriesProgress): SeriesMapProgress | undefined {
  return progress.maps.find(isPlayable);
}

function mapIndex(progress: SeriesProgress, mapOrder: number): number {
  return progress.maps.findIndex((map) => map.mapOrder === mapOrder);
}

function setCurrentMap(
  progress: SeriesProgress,
  mapOrder: number,
  mapEpoch: number,
): SeriesProgress {
  const maps = progress.maps.map((map) => {
    if (map.mapOrder === mapOrder) {
      return {
        ...map,
        status: 'current' as const,
        executionMapEpoch: mapEpoch,
      };
    }
    if (map.status === 'current') return { ...map, status: 'pending' as const };
    return map;
  });
  return { ...progress, maps, currentMapOrder: mapOrder, bindingState: 'bound' };
}

function mapForEpoch(progress: SeriesProgress, mapEpoch: number): SeriesMapProgress | undefined {
  return progress.maps.find(
    (map) => map.executionMapEpoch === mapEpoch && map.status === 'current',
  );
}

function validSideProof(proof: SeriesSideProof | null, sourceGeneration: number, mapEpoch: number) {
  return (
    proof !== null &&
    proof.sourceGeneration === sourceGeneration &&
    proof.mapEpoch === mapEpoch &&
    proof.a !== 'unknown' &&
    proof.b !== 'unknown' &&
    proof.a !== proof.b
  );
}

function entrantForSide(proof: SeriesSideProof, side: SourceSide): string | null {
  if (side === proof.a) return 'a';
  if (side === proof.b) return 'b';
  return null;
}

function historyCompleteness(
  rounds: readonly SeriesRoundResult[],
): SeriesRoundHistory['completeness'] {
  if (rounds.length === 0) return 'unavailable';
  const sorted = rounds.slice().sort((left, right) => left.roundNumber - right.roundNumber);
  const consecutive = sorted.every(
    (round, index) => index === 0 || round.roundNumber === sorted[index - 1]!.roundNumber + 1,
  );
  const startsAtMapRoundOne = sorted[0]?.roundNumber === 1;
  const knownWinners = sorted.every((round) => round.winnerSide !== 'unknown');
  return consecutive && startsAtMapRoundOne && knownWinners ? 'complete' : 'partial';
}

function withHistory(
  map: SeriesMapProgress,
  rounds: readonly SeriesRoundResult[],
): SeriesMapProgress {
  const sorted = rounds.slice().sort((left, right) => left.roundNumber - right.roundNumber);
  const capped =
    sorted.length > SERIES_ROUND_HISTORY_MAX ? sorted.slice(-SERIES_ROUND_HISTORY_MAX) : sorted;
  return {
    ...map,
    roundHistory: {
      completeness: historyCompleteness(capped),
      rounds: capped,
    },
  };
}

function markHistoryPartial(
  progress: SeriesProgress,
  mapOrder: number,
  mapEpoch: number,
  message: string,
  severity: SeriesProgressIssue['severity'] = 'warning',
): SeriesProgress {
  const partialProgress: SeriesProgress = {
    ...progress,
    maps: progress.maps.map((candidate) =>
      candidate.mapOrder === mapOrder
        ? {
            ...candidate,
            roundHistory: {
              ...candidate.roundHistory,
              completeness: 'partial' as const,
            },
          }
        : candidate,
    ),
  };
  return addIssue(
    partialProgress,
    issue('round_history_partial', severity, message, mapOrder, mapEpoch),
  );
}

function ensureBinding(
  progress: SeriesProgress,
  observation: SeriesMapObservation | null,
): SeriesProgress {
  if (observation === null || observation.mapName === null) return progress;
  if (progress.score.a >= progress.requiredWins || progress.score.b >= progress.requiredWins) {
    return progress;
  }

  const actualMapName = canonicalMapName(observation.mapName);
  const currentlyBound =
    progress.currentMapOrder === null
      ? undefined
      : progress.maps.find((map) => map.mapOrder === progress.currentMapOrder);
  const hasOperatorBindingForEpoch = progress.issues.some(
    (item) =>
      item.code === 'operator_bind_applied' &&
      item.mapOrder === progress.currentMapOrder &&
      item.mapEpoch === observation.mapEpoch,
  );
  if (
    currentlyBound !== undefined &&
    currentlyBound.mapName === actualMapName &&
    (currentlyBound.status === 'completed' ||
      (currentlyBound.status === 'current' &&
        currentlyBound.executionMapEpoch === observation.mapEpoch))
  ) {
    return progress;
  }
  if (
    currentlyBound !== undefined &&
    currentlyBound.executionMapEpoch === observation.mapEpoch &&
    hasOperatorBindingForEpoch
  ) {
    return progress;
  }
  const expected = nextPlayableMap(progress);
  if (expected === undefined) {
    return addIssue(
      progress,
      issue(
        'map_unbound',
        'warning',
        '当前实际地图没有可用的未完成 series map slot。',
        null,
        observation.mapEpoch,
      ),
    );
  }

  const candidates = progress.maps.filter(
    (map) => isPlayable(map) && map.mapName === actualMapName,
  );
  if (candidates.length === 0) {
    return addIssue(
      { ...progress, currentMapOrder: null, bindingState: 'needs_operator' },
      issue(
        'map_mismatch',
        'error',
        `实际地图 ${actualMapName} 不属于当前 series 计划，等待 Operator 明确绑定。`,
        null,
        observation.mapEpoch,
      ),
    );
  }
  if (candidates.length > 1) {
    return addIssue(
      { ...progress, currentMapOrder: null, bindingState: 'needs_operator' },
      issue(
        'map_ambiguous',
        'error',
        `实际地图 ${actualMapName} 对应多个未完成 map slot，拒绝自动猜测。`,
        null,
        observation.mapEpoch,
      ),
    );
  }
  const candidate = candidates[0]!;
  if (candidate.mapOrder !== expected.mapOrder) {
    return addIssue(
      { ...progress, currentMapOrder: null, bindingState: 'needs_operator' },
      issue(
        'map_order_exception',
        'error',
        `实际地图 ${actualMapName} 跳过了下一张计划地图，等待 Operator 明确绑定。`,
        candidate.mapOrder,
        observation.mapEpoch,
      ),
    );
  }
  return setCurrentMap(progress, candidate.mapOrder, observation.mapEpoch);
}

function addRound(
  progress: SeriesProgress,
  event: Extract<SeriesProgressEvent, { readonly kind: 'round-ended' }>,
  sideProof: SeriesSideProof | null,
): SeriesProgress {
  const map = mapForEpoch(progress, event.mapEpoch);
  if (map === undefined) return progress;
  if (
    event.roundNumber === null ||
    !Number.isSafeInteger(event.roundNumber) ||
    event.roundNumber <= 0
  ) {
    return addIssue(
      progress,
      issue(
        'round_number_unavailable',
        'warning',
        'round_ended 没有可证明的绝对回合号。',
        map.mapOrder,
        event.mapEpoch,
      ),
    );
  }

  const proofIsValid = validSideProof(sideProof, event.sourceGeneration, event.mapEpoch);
  const winnerEntryId =
    proofIsValid && sideProof !== null && event.winnerSide !== 'unknown'
      ? entrantForSide(sideProof, event.winnerSide) === 'a'
        ? progress.entrants.a.entryId
        : entrantForSide(sideProof, event.winnerSide) === 'b'
          ? progress.entrants.b.entryId
          : null
      : null;
  const rounds = [...map.roundHistory.rounds];
  const existingIndex = rounds.findIndex((round) => round.roundNumber === event.roundNumber);
  if (existingIndex >= 0) {
    const existing = rounds[existingIndex]!;
    if (
      existing.winnerSide !== event.winnerSide &&
      existing.winnerSide !== 'unknown' &&
      event.winnerSide !== 'unknown'
    ) {
      return addIssue(
        progress,
        issue(
          'round_history_partial',
          'warning',
          '重复回合 evidence 冲突，保留第一次冻结的结果。',
          map.mapOrder,
          event.mapEpoch,
        ),
      );
    }
    const nextCondition =
      existing.winCondition === 'unknown' ? event.winCondition : existing.winCondition;
    if (nextCondition === existing.winCondition) return progress;
    rounds[existingIndex] = { ...existing, winCondition: nextCondition };
  } else {
    rounds.push({
      roundNumber: event.roundNumber,
      winnerSide: event.winnerSide,
      winnerEntryId,
      winCondition: event.winCondition,
    });
  }

  const next = withHistory(map, rounds);
  let result: SeriesProgress = {
    ...progress,
    maps: progress.maps.map((candidate) =>
      candidate.mapOrder === map.mapOrder ? next : candidate,
    ),
  };
  if (rounds.length > SERIES_ROUND_HISTORY_MAX) {
    result = addIssue(
      result,
      issue(
        'round_history_cap',
        'warning',
        `回合历史超过上限，已保留最近 ${SERIES_ROUND_HISTORY_MAX} 条。`,
        map.mapOrder,
        event.mapEpoch,
      ),
    );
  }
  if (!proofIsValid || winnerEntryId === null || event.winnerSide === 'unknown') {
    result = addIssue(
      result,
      issue(
        'round_history_partial',
        'info',
        '回合保留 source-side，但当前没有可用于 canonical entrant 的 side proof。',
        map.mapOrder,
        event.mapEpoch,
      ),
    );
  }
  return result;
}

function endMap(
  progress: SeriesProgress,
  event: Extract<SeriesProgressEvent, { readonly kind: 'map-ended' }>,
  sideProof: SeriesSideProof | null,
): SeriesProgress {
  const map = mapForEpoch(progress, event.mapEpoch);
  if (map === undefined) return progress;
  if (map.status === 'completed') return progress;
  const { ct, t } = event.finalScore;
  if (ct === null || t === null || ct < 0 || t < 0) {
    return addIssue(
      progress,
      issue(
        'final_score_unavailable',
        'warning',
        'map_ended 没有完整的 CT/T final score，Series 不推进。',
        map.mapOrder,
        event.mapEpoch,
      ),
    );
  }
  if (!validSideProof(sideProof, event.sourceGeneration, event.mapEpoch) || sideProof === null) {
    return addIssue(
      progress,
      issue(
        'side_mapping_unproven',
        'error',
        'map_ended 时没有同一 mapEpoch/source generation 的 canonical side proof。',
        map.mapOrder,
        event.mapEpoch,
      ),
    );
  }
  const aScore = sideProof.a === 'CT' ? ct : t;
  const bScore = sideProof.a === 'CT' ? t : ct;
  const finalScore = { a: aScore, b: bScore } as const;
  const winnerEntryId = winnerForScore(finalScore, progress.entrants);
  if (winnerEntryId === null) {
    return addIssue(
      progress,
      issue(
        'final_score_conflict',
        'error',
        'map_ended 的 CT/T final score 无法证明唯一胜者。',
        map.mapOrder,
        event.mapEpoch,
      ),
    );
  }
  const nextMap = {
    ...map,
    status: 'completed' as const,
    finalScore,
    winnerEntryId,
  };
  return recomputeScore(
    progress,
    progress.maps.map((candidate) => (candidate.mapOrder === map.mapOrder ? nextMap : candidate)),
  );
}

function resetCurrentMap(
  progress: SeriesProgress,
  event: Extract<SeriesProgressEvent, { readonly kind: 'map-execution-changed' }>,
): SeriesProgress {
  const current = progress.currentMapOrder;
  if (current === null || event.resetReason === 'restore') return progress;
  const map = progress.maps.find((candidate) => candidate.mapOrder === current);
  if (map === undefined || map.status === 'completed' || map.status === 'not_played')
    return progress;
  return {
    ...progress,
    maps: progress.maps.map((candidate) =>
      candidate.mapOrder === current
        ? {
            ...candidate,
            status: 'current' as const,
            executionMapEpoch: event.mapEpoch,
            finalScore: null,
            winnerEntryId: null,
            roundHistory: emptyRoundHistory(),
          }
        : candidate,
    ),
    bindingState: 'bound',
  };
}

function applyMapExecutionChange(
  progress: SeriesProgress,
  event: Extract<SeriesProgressEvent, { readonly kind: 'map-execution-changed' }>,
): SeriesProgress {
  if (event.resetReason !== null) return resetCurrentMap(progress, event);
  return ensureBinding(progress, {
    sourceGeneration: event.sourceGeneration,
    mapEpoch: event.mapEpoch,
    mapName: event.mapName,
    roundNumber: null,
    score: { ct: null, t: null },
    roundWins: [],
  });
}

function applyOperatorBind(
  progress: SeriesProgress,
  event: Extract<SeriesProgressEvent, { readonly kind: 'operator-map-bind' }>,
): SeriesProgress {
  const index = mapIndex(progress, event.mapOrder);
  const target = index < 0 ? undefined : progress.maps[index];
  const actualMapName = event.mapName === null ? null : canonicalMapName(event.mapName);
  if (
    target === undefined ||
    !isPlayable(target) ||
    actualMapName === null ||
    event.reason.trim().length === 0 ||
    progress.score.a >= progress.requiredWins ||
    progress.score.b >= progress.requiredWins
  ) {
    return addIssue(
      progress,
      issue(
        'operator_bind_rejected',
        'error',
        'Operator map binding 被拒绝：目标 slot、实际地图或系列状态不可用。',
        event.mapOrder,
        event.mapEpoch,
      ),
    );
  }
  return addIssue(
    setCurrentMap(progress, event.mapOrder, event.mapEpoch),
    issue(
      'operator_bind_applied',
      'info',
      `Operator 已将当前地图绑定到 mapOrder ${event.mapOrder}：${event.reason.trim()}`,
      event.mapOrder,
      event.mapEpoch,
    ),
  );
}

export function safeAbsoluteRoundWins(
  observation: Pick<SeriesMapObservation, 'roundWins' | 'score'>,
): boolean {
  const wins = observation.roundWins;
  if (wins.length === 0 || wins.length > SERIES_ROUND_HISTORY_MAX) return false;
  const scoreTotal =
    observation.score.ct !== null && observation.score.t !== null
      ? observation.score.ct + observation.score.t
      : null;
  if (scoreTotal === null || scoreTotal !== wins.length) return false;
  return wins.every((win, index) => win.roundNumber === index + 1);
}

function reconcileRoundWins(
  progress: SeriesProgress,
  observation: SeriesMapObservation,
): SeriesProgress {
  const map = mapForEpoch(progress, observation.mapEpoch);
  if (map === undefined || observation.roundWins.length === 0) return progress;
  const direct = safeAbsoluteRoundWins(observation);
  const rounds = [...map.roundHistory.rounds];
  let changed = false;
  let winnerSideConflict = false;
  for (const win of observation.roundWins) {
    const index = rounds.findIndex((round) => round.roundNumber === win.roundNumber);
    if (index < 0) {
      if (!direct) continue;
      rounds.push({
        roundNumber: win.roundNumber,
        winnerSide: win.winnerSide,
        winnerEntryId: null,
        winCondition: win.winCondition,
      });
      changed = true;
      continue;
    }
    const existing = rounds[index]!;
    if (
      existing.winnerSide !== 'unknown' &&
      win.winnerSide !== 'unknown' &&
      existing.winnerSide !== win.winnerSide
    ) {
      winnerSideConflict = true;
      continue;
    }
    if (existing.winCondition === 'unknown' && win.winCondition !== 'unknown') {
      rounds[index] = { ...existing, winCondition: win.winCondition };
      changed = true;
    }
  }
  let next = progress;
  if (changed) {
    next = {
      ...progress,
      maps: progress.maps.map((candidate) =>
        candidate.mapOrder === map.mapOrder ? withHistory(map, rounds) : candidate,
      ),
    };
  }
  if (winnerSideConflict) {
    return markHistoryPartial(
      next,
      map.mapOrder,
      observation.mapEpoch,
      'map_round_wins 与 round_ended 的 winner side 冲突，保留 primary transition 事实并标记 partial。',
    );
  }
  if (!direct && observation.roundWins.length > 0) {
    return markHistoryPartial(
      next,
      map.mapOrder,
      observation.mapEpoch,
      'map_round_wins 无法证明为整张图的绝对回合号，保留已有历史且不猜缺失回合。',
      'info',
    );
  }
  if (!changed) return progress;
  if (rounds.length > SERIES_ROUND_HISTORY_MAX) {
    next = addIssue(
      next,
      issue(
        'round_history_cap',
        'warning',
        `回合历史超过上限，已保留最近 ${SERIES_ROUND_HISTORY_MAX} 条。`,
        map.mapOrder,
        observation.mapEpoch,
      ),
    );
  }
  return next;
}

function reconcileRestoredState(
  progress: SeriesProgress,
  observation: SeriesMapObservation,
): SeriesProgress {
  const boundMap =
    progress.currentMapOrder === null
      ? undefined
      : progress.maps.find(
          (candidate) =>
            candidate.mapOrder === progress.currentMapOrder &&
            candidate.mapName ===
              (observation.mapName === null ? null : canonicalMapName(observation.mapName)),
        );
  const map = boundMap ?? mapForEpoch(progress, observation.mapEpoch);
  if (map === undefined || map.roundHistory.rounds.length === 0) return progress;

  const historyMaxRound = Math.max(...map.roundHistory.rounds.map((round) => round.roundNumber));
  const scoreTotal =
    observation.score.ct !== null && observation.score.t !== null
      ? observation.score.ct + observation.score.t
      : null;
  const snapshotMaxRound =
    observation.roundWins.length === 0
      ? null
      : Math.max(...observation.roundWins.map((round) => round.roundNumber));
  const conflicts: string[] = [];

  if (observation.roundNumber !== null && historyMaxRound > observation.roundNumber) {
    conflicts.push(
      `checkpoint history 到第 ${historyMaxRound} 回合，但恢复 observation 只到第 ${observation.roundNumber} 回合`,
    );
  }
  if (scoreTotal !== null && scoreTotal < map.roundHistory.rounds.length) {
    conflicts.push(
      `checkpoint history 有 ${map.roundHistory.rounds.length} 条回合，而恢复 score 只有 ${scoreTotal} 个已结束回合`,
    );
  }
  if (snapshotMaxRound !== null) {
    if (observation.roundNumber !== null && snapshotMaxRound > observation.roundNumber) {
      conflicts.push(
        `round_wins 到第 ${snapshotMaxRound} 回合，超过恢复 observation 的第 ${observation.roundNumber} 回合`,
      );
    }
    if (scoreTotal !== null && observation.roundWins.length !== scoreTotal) {
      conflicts.push(
        `round_wins 有 ${observation.roundWins.length} 条，但恢复 score 总和为 ${scoreTotal}`,
      );
    }
    if (snapshotMaxRound < historyMaxRound) {
      conflicts.push(
        `checkpoint history 到第 ${historyMaxRound} 回合，而恢复 round_wins 只到第 ${snapshotMaxRound} 回合`,
      );
    }
  }
  if (
    map.status === 'completed' &&
    map.finalScore !== null &&
    observation.score.ct !== null &&
    observation.score.t !== null &&
    map.finalScore.a + map.finalScore.b !== scoreTotal
  ) {
    conflicts.push('checkpoint final score 与恢复 observation score 不一致');
  }

  if (conflicts.length === 0) return progress;
  return markHistoryPartial(
    progress,
    map.mapOrder,
    observation.mapEpoch,
    `恢复 execution state 与 checkpoint history 不一致：${conflicts.join('；')}。保留 checkpoint primary history。`,
  );
}

function eventFromTransition(
  event: SeriesProgressEvent,
  observation: SeriesMapObservation | null,
): SeriesProgressEvent {
  if (event.kind !== 'round-ended' || observation === null) return event;
  const round = observation.roundWins.find(
    (candidate) => candidate.roundNumber === event.roundNumber,
  );
  return round === undefined || event.winCondition !== 'unknown'
    ? event
    : { ...event, winCondition: round.winCondition };
}

export function createSeriesProgress(context: MatchContext): SeriesProgress {
  const maps = initialMaps(context);
  const entrants = {
    a: {
      entryId: context.entrants.a.entryId,
      name: context.entrants.a.name,
      logoUrl: context.entrants.a.logoUrl,
    },
    b: {
      entryId: context.entrants.b.entryId,
      name: context.entrants.b.name,
      logoUrl: context.entrants.b.logoUrl,
    },
  } as const;
  const base: SeriesProgress = {
    matchId: context.matchId,
    format: context.format,
    requiredWins: requiredSeriesWins(context.format),
    entrants,
    score: { a: 0, b: 0 },
    maps,
    currentMapOrder: null,
    bindingState: 'unbound',
    issues: [],
  };
  return recomputeScore(base);
}

export function isSeriesProgressCheckpointCompatible(
  checkpoint: SeriesProgressCheckpoint,
  context: MatchContext,
): boolean {
  if (!isSeriesProgressCheckpoint(checkpoint)) return false;
  const identity = seriesCheckpointIdentity(context);
  return (
    checkpoint.checkpointVersion === SERIES_PROGRESS_CHECKPOINT_VERSION &&
    checkpoint.identity.matchId === identity.matchId &&
    checkpoint.identity.format === identity.format &&
    checkpoint.identity.entryAId === identity.entryAId &&
    checkpoint.identity.entryBId === identity.entryBId &&
    checkpoint.identity.mapPlanFingerprint === identity.mapPlanFingerprint
  );
}

export function makeSeriesProgressCheckpoint(progress: SeriesProgress): SeriesProgressCheckpoint {
  return {
    checkpointVersion: SERIES_PROGRESS_CHECKPOINT_VERSION,
    identity: {
      matchId: progress.matchId,
      format: progress.format,
      entryAId: progress.entrants.a.entryId,
      entryBId: progress.entrants.b.entryId,
      mapPlanFingerprint: seriesProgressMapPlanFingerprint(progress.maps),
    },
    progress,
  };
}

/** Refresh display metadata only within the already-bound series identity and plan. */
export function refreshSeriesProgressMetadata(
  progress: SeriesProgress,
  context: MatchContext,
): SeriesProgress {
  const before = makeSeriesProgressCheckpoint(progress).identity;
  const after = seriesCheckpointIdentity(context);
  if (
    before.matchId !== after.matchId ||
    before.format !== after.format ||
    before.entryAId !== after.entryAId ||
    before.entryBId !== after.entryBId ||
    before.mapPlanFingerprint !== after.mapPlanFingerprint
  )
    return progress;
  if (
    (['a', 'b'] as const).every((side) => {
      return (
        progress.entrants[side].name === context.entrants[side].name &&
        progress.entrants[side].logoUrl === context.entrants[side].logoUrl
      );
    })
  )
    return progress;
  return {
    ...progress,
    entrants: {
      a: {
        ...progress.entrants.a,
        name: context.entrants.a.name,
        logoUrl: context.entrants.a.logoUrl,
      },
      b: {
        ...progress.entrants.b,
        name: context.entrants.b.name,
        logoUrl: context.entrants.b.logoUrl,
      },
    },
  };
}

export function syncSeriesProgress(
  progress: SeriesProgress,
  input: SeriesProgressSyncInput,
): SeriesProgressReduceResult {
  let next = ensureBinding(progress, input.observation);
  if (input.restore && input.observation !== null) {
    next = reconcileRestoredState(next, input.observation);
  }
  for (const rawEvent of input.events) {
    const event = eventFromTransition(rawEvent, input.observation);
    switch (event.kind) {
      case 'map-execution-changed':
        next = applyMapExecutionChange(next, event);
        break;
      case 'round-ended':
        next = addRound(next, event, input.sideProof);
        break;
      case 'map-ended':
        // A gameover observation can contain the final round_wins without a
        // round-ended transition. Consume that evidence while the map is current.
        if (input.observation !== null) {
          next = reconcileRoundWins(next, input.observation);
        }
        next = endMap(next, event, input.sideProof);
        break;
      case 'operator-map-bind':
        next =
          input.observation !== null &&
          event.sourceGeneration === input.observation.sourceGeneration &&
          event.mapEpoch === input.observation.mapEpoch
            ? applyOperatorBind(next, event)
            : addIssue(
                next,
                issue(
                  'operator_bind_rejected',
                  'error',
                  'Operator map binding 必须针对当前 sourceGeneration + mapEpoch。',
                  event.mapOrder,
                  event.mapEpoch,
                ),
              );
        break;
    }
  }
  if (input.observation !== null) {
    next = reconcileRoundWins(next, input.observation);
    if (input.observation.mapEnded === true) {
      next = endMap(
        next,
        {
          kind: 'map-ended',
          sourceGeneration: input.observation.sourceGeneration,
          mapEpoch: input.observation.mapEpoch,
          finalScore: input.observation.score,
        },
        input.sideProof,
      );
    }
  }
  next = recomputeScore(next);
  return { progress: next, changed: JSON.stringify(progress) !== JSON.stringify(next) };
}

export function addSeriesProgressIssue(
  progress: SeriesProgress,
  nextIssue: SeriesProgressIssue,
): SeriesProgress {
  return addIssue(progress, nextIssue);
}
