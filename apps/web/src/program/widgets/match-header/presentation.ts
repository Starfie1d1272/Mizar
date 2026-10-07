import type { ProgramPayload } from '@mizar/protocol/program';

import {
  buildObjectiveCenterPresentation,
  type ObjectiveCenterPresentation,
} from './objective-presentation';

export type MatchHeaderEntrantKey = 'a' | 'b';
export type MatchHeaderSide = 'CT' | 'T';

export interface MatchHeaderTeamPresentation {
  readonly key: MatchHeaderEntrantKey;
  readonly entryId: string | null;
  readonly name: string;
  readonly logoUrl: string | null;
  readonly seriesScore: number | null;
  readonly winSlots: readonly boolean[];
  readonly side: MatchHeaderSide | null;
  readonly mapScore: number | null;
  readonly timeoutsRemaining: number | null;
}

export interface MatchHeaderTimeoutPresentation {
  readonly owner: MatchHeaderEntrantKey | null;
  readonly ownerName: string | null;
  readonly remaining: number | null;
  readonly clockText: string | null;
}

export interface MatchHeaderSeriesMapPresentation {
  readonly mapOrder: number;
  readonly mapName: string;
  readonly mapKey: string;
  readonly selectionText: string;
  readonly picker: MatchHeaderEntrantKey | null;
  readonly pickerName: string | null;
  readonly pickerLogoUrl: string | null;
  readonly pickerStartSide: MatchHeaderSide | null;
  readonly status: 'pending' | 'current' | 'completed' | 'not_played';
  readonly statusText: string;
  readonly finalScore: { readonly a: number; readonly b: number } | null;
  readonly winner: MatchHeaderEntrantKey | null;
  readonly pickOutcome: 'win' | 'loss' | null;
  readonly winnerName: string | null;
}

export interface MatchHeaderRoundPresentation {
  readonly roundNumber: number;
  readonly state: 'known' | 'missing';
  readonly winner: MatchHeaderEntrantKey | 'unknown';
  readonly winnerSide: MatchHeaderSide | 'unknown';
  readonly winCondition: 'elimination' | 'bomb' | 'defuse' | 'time' | 'unknown';
}

export interface MatchHeaderRoundHistoryPresentation {
  readonly completeness: 'complete' | 'partial';
  readonly rounds: readonly MatchHeaderRoundPresentation[];
}

export interface MatchHeaderPresentation {
  readonly objective: ObjectiveCenterPresentation;
  readonly hasCanonicalSeries: boolean;
  readonly currentSideMapping: 'resolved' | 'unavailable' | 'neutral';
  readonly teamA: MatchHeaderTeamPresentation;
  readonly teamB: MatchHeaderTeamPresentation;
  readonly currentMapName: string | null;
  readonly bestOfLabel: 'BO1' | 'BO3' | 'BO5' | null;
  readonly seriesScoreText: string | null;
  readonly competitionName: string | null;
  readonly stageName: string | null;
  readonly roundNumber: number | null;
  readonly roundLabel: string | null;
  readonly phaseLabel: string;
  readonly clockText: string | null;
  readonly clockTone: 'normal' | 'timeout' | 'paused' | 'objective' | 'unknown';
  readonly timeoutPanel: MatchHeaderTimeoutPresentation | null;
  readonly seriesMaps: readonly MatchHeaderSeriesMapPresentation[] | null;
  readonly roundHistory: MatchHeaderRoundHistoryPresentation | null;
}

const MAP_STATUS_LABELS = {
  pending: 'PENDING',
  current: 'PLAYING',
  completed: '',
  not_played: 'PENDING',
} as const;

function nullableNumber(value: number | null | undefined): number | null {
  return value ?? null;
}

function oppositeSide(side: MatchHeaderSide): MatchHeaderSide {
  return side === 'CT' ? 'T' : 'CT';
}

function displayMapName(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const name = value.trim().replace(/^de_/i, '').replaceAll('_', ' ');
  return name.length === 0 ? null : `${name.slice(0, 1).toUpperCase()}${name.slice(1)}`;
}

function radarMapKey(value: string): string {
  const name = value
    .trim()
    .toLowerCase()
    .replace(/^de_/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return name.length === 0 ? value : `de_${name}`;
}

function formatClock(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return null;
  const totalSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remaining = totalSeconds % 60;
  return `${minutes}:${String(remaining).padStart(2, '0')}`;
}

function resolveSideMapping(payload: ProgramPayload): {
  readonly state: 'resolved' | 'unavailable' | 'neutral';
  readonly a: MatchHeaderSide | null;
  readonly b: MatchHeaderSide | null;
} {
  const series = payload.series;
  if (series === null) return { state: 'neutral', a: null, b: null };

  const ctEntryId = payload.teams.ct.mode === 'canonical' ? payload.teams.ct.entryId : null;
  const tEntryId = payload.teams.t.mode === 'canonical' ? payload.teams.t.entryId : null;
  const entryIds = new Set([series.entrants.a.entryId, series.entrants.b.entryId]);
  if (
    ctEntryId === null ||
    tEntryId === null ||
    ctEntryId === tEntryId ||
    !entryIds.has(ctEntryId) ||
    !entryIds.has(tEntryId)
  ) {
    return { state: 'unavailable', a: null, b: null };
  }

  return {
    state: 'resolved',
    a: ctEntryId === series.entrants.a.entryId ? 'CT' : 'T',
    b: ctEntryId === series.entrants.b.entryId ? 'CT' : 'T',
  };
}

function sideScore(
  payload: ProgramPayload,
  side: MatchHeaderSide | null,
  field: 'score' | 'timeoutsRemaining',
): number | null {
  if (side === null) return null;
  return nullableNumber(payload.map[field][side === 'CT' ? 'ct' : 't']);
}

function buildTeam(
  key: MatchHeaderEntrantKey,
  payload: ProgramPayload,
  sideMapping: ReturnType<typeof resolveSideMapping>,
): MatchHeaderTeamPresentation {
  const series = payload.series;
  if (series === null) {
    const side: MatchHeaderSide = key === 'a' ? 'CT' : 'T';
    return {
      key,
      entryId: null,
      name: side,
      logoUrl: null,
      seriesScore: null,
      winSlots: [],
      side,
      mapScore: sideScore(payload, side, 'score'),
      timeoutsRemaining: sideScore(payload, side, 'timeoutsRemaining'),
    };
  }

  const entrant = series.entrants[key];
  const side = sideMapping[key];
  return {
    key,
    entryId: entrant.entryId,
    name: entrant.name,
    logoUrl: entrant.logoUrl,
    seriesScore: series.score[key],
    winSlots:
      series.requiredWins <= 1
        ? []
        : Array.from({ length: series.requiredWins }, (_, index) => index < series.score[key]),
    side,
    mapScore: sideScore(payload, side, 'score'),
    timeoutsRemaining: sideScore(payload, side, 'timeoutsRemaining'),
  };
}

function selectionText(
  selection: NonNullable<ProgramPayload['series']>['maps'][number]['selection'],
  entrants: NonNullable<ProgramPayload['series']>['entrants'],
): string {
  if (selection.kind === 'decider') return 'DECIDER';
  if (selection.kind === 'unknown') return '';
  if (selection.kind !== 'pick') return '';
  if (selection.entryId === entrants.a.entryId) return 'PICK';
  if (selection.entryId === entrants.b.entryId) return 'PICK';
  return '';
}

function buildSeriesMaps(
  series: NonNullable<ProgramPayload['series']>,
): readonly MatchHeaderSeriesMapPresentation[] {
  return series.maps.map((map) => {
    const winner =
      map.winnerEntryId === series.entrants.a.entryId
        ? 'a'
        : map.winnerEntryId === series.entrants.b.entryId
          ? 'b'
          : null;
    const picker =
      map.selection.kind === 'pick'
        ? map.selection.entryId === series.entrants.a.entryId
          ? 'a'
          : map.selection.entryId === series.entrants.b.entryId
            ? 'b'
            : null
        : null;
    const score =
      map.status === 'completed' && map.finalScore !== null && picker !== null
        ? picker === 'a'
          ? `${map.finalScore.a}–${map.finalScore.b}`
          : `${map.finalScore.b}–${map.finalScore.a}`
        : map.status === 'completed' && map.finalScore !== null
          ? `${map.finalScore.a}–${map.finalScore.b}`
          : MAP_STATUS_LABELS[map.status];
    return {
      mapOrder: map.mapOrder,
      mapName: displayMapName(map.mapName) ?? map.mapName,
      mapKey: radarMapKey(map.mapName),
      selectionText: selectionText(map.selection, series.entrants),
      picker,
      pickerName: picker === null ? null : series.entrants[picker].name,
      pickerLogoUrl: picker === null ? null : series.entrants[picker].logoUrl,
      pickerStartSide:
        picker === null || map.teamAStartSide === null
          ? null
          : picker === 'a'
            ? map.teamAStartSide
            : oppositeSide(map.teamAStartSide),
      status: map.status,
      statusText: score,
      finalScore: map.finalScore,
      winner,
      pickOutcome:
        map.status === 'completed' && picker !== null && winner !== null
          ? picker === winner
            ? 'win'
            : 'loss'
          : null,
      winnerName:
        map.status === 'completed' && map.finalScore !== null && winner !== null
          ? series.entrants[winner].name
          : null,
    };
  });
}

function buildRoundHistory(
  series: NonNullable<ProgramPayload['series']> | null,
  observed?: ProgramPayload['map']['roundHistory'],
): MatchHeaderRoundHistoryPresentation | null {
  const history = series?.roundHistory ?? observed;
  if (history === null || history === undefined || history.completeness === 'unavailable')
    return null;
  if (history.rounds.length === 0) return null;

  const byRound = new Map(history.rounds.map((round) => [round.roundNumber, round]));
  const maxRound = Math.max(...history.rounds.map((round) => round.roundNumber));
  const rounds: MatchHeaderRoundPresentation[] = [];
  for (let roundNumber = 1; roundNumber <= maxRound; roundNumber += 1) {
    const round = byRound.get(roundNumber);
    if (round === undefined) {
      rounds.push({
        roundNumber,
        state: 'missing',
        winner: 'unknown',
        winnerSide: 'unknown',
        winCondition: 'unknown',
      });
      continue;
    }
    rounds.push({
      roundNumber,
      state: 'known',
      winner:
        series && round.winnerEntryId === series.entrants.a.entryId
          ? 'a'
          : series && round.winnerEntryId === series.entrants.b.entryId
            ? 'b'
            : 'unknown',
      winnerSide:
        round.winnerSide === 'CT' || round.winnerSide === 'T' ? round.winnerSide : 'unknown',
      winCondition: round.winCondition,
    });
  }
  return { completeness: history.completeness, rounds };
}

function clockPresentation(
  payload: ProgramPayload,
  sideMapping: ReturnType<typeof resolveSideMapping>,
): Pick<MatchHeaderPresentation, 'phaseLabel' | 'clockText' | 'clockTone' | 'timeoutPanel'> {
  const phase = payload.clock?.phase ?? null;
  const clockText = formatClock(payload.clock?.endsInSeconds);
  const timeoutSide = phase === 'timeout_ct' ? 'CT' : phase === 'timeout_t' ? 'T' : null;
  const timeoutOwner =
    timeoutSide === null || sideMapping.state !== 'resolved'
      ? null
      : sideMapping.a === timeoutSide
        ? 'a'
        : sideMapping.b === timeoutSide
          ? 'b'
          : null;
  const timeoutRemaining =
    timeoutSide === null ? null : payload.map.timeoutsRemaining[timeoutSide === 'CT' ? 'ct' : 't'];
  const timeoutPanel: MatchHeaderTimeoutPresentation | null =
    timeoutSide === null
      ? null
      : {
          owner: timeoutOwner,
          ownerName:
            timeoutOwner === null ? null : (payload.series?.entrants[timeoutOwner].name ?? null),
          remaining: timeoutRemaining,
          clockText,
        };

  if (
    timeoutSide === null &&
    phase !== 'paused' &&
    (payload.round?.phase === 'over' ||
      payload.bomb?.state === 'defused' ||
      payload.bomb?.state === 'exploded')
  ) {
    return { phaseLabel: 'ROUND OVER', clockText: null, clockTone: 'normal', timeoutPanel: null };
  }

  switch (phase) {
    case 'warmup':
      return { phaseLabel: 'WARMUP', clockText, clockTone: 'normal', timeoutPanel };
    case 'freezetime':
      return { phaseLabel: 'FREEZETIME', clockText, clockTone: 'normal', timeoutPanel };
    case 'live':
      return { phaseLabel: 'LIVE', clockText, clockTone: 'normal', timeoutPanel };
    case 'timeout_ct':
    case 'timeout_t':
      return { phaseLabel: 'TACTICAL TIMEOUT', clockText, clockTone: 'timeout', timeoutPanel };
    case 'paused':
      return {
        phaseLabel: 'TECH PAUSE',
        clockText: null,
        clockTone: 'paused',
        timeoutPanel,
      };
    case 'bomb':
      return {
        phaseLabel: 'PLANTED',
        clockText: null,
        clockTone: 'objective',
        timeoutPanel,
      };
    case 'defuse':
      return {
        phaseLabel: 'DEFUSING',
        clockText: null,
        clockTone: 'objective',
        timeoutPanel,
      };
    case 'over':
      return {
        phaseLabel: 'ROUND OVER',
        clockText: null,
        clockTone: 'normal',
        timeoutPanel,
      };
    case 'unknown':
    case null:
      return {
        phaseLabel: 'UNKNOWN',
        clockText: null,
        clockTone: 'unknown',
        timeoutPanel,
      };
  }
}

/**
 * The only entrant-oriented join for the Match Header. Renderers consume this
 * model and must not re-bind side facts, map state, or round history.
 */
export function hasSeriesMapStrip(payload: ProgramPayload): boolean {
  return Boolean(
    payload.series?.veto.length ||
    payload.series?.maps.some(
      (map) => map.selection.kind === 'pick' || map.selection.kind === 'decider',
    ),
  );
}

/** GSI counts completed rounds between rounds; an active round is the next one. */
export function displayRoundNumber(payload: ProgramPayload): number | null {
  const count = payload.map.roundNumber;
  if (count === null || !Number.isInteger(count) || count < 0 || payload.map.phase === 'warmup')
    return null;
  if (payload.map.phase === 'gameover' || payload.round?.phase === 'over') {
    const { ct, t } = payload.map.score;
    const completed = ct !== null && t !== null ? ct + t : count;
    return completed > 0 ? completed : null;
  }
  return payload.round?.phase === 'live' || payload.round?.phase === 'freezetime'
    ? count + 1
    : null;
}

export function buildMatchHeaderPresentation(payload: ProgramPayload): MatchHeaderPresentation {
  const series = payload.series;
  const sideMapping = resolveSideMapping(payload);
  const teamA = buildTeam('a', payload, sideMapping);
  const teamB = buildTeam('b', payload, sideMapping);
  const currentMap =
    series?.currentMapOrder === null || series === null
      ? undefined
      : series.maps.find((map) => map.mapOrder === series.currentMapOrder);
  const clock = clockPresentation(payload, sideMapping);
  const roundNumber = displayRoundNumber(payload);

  return {
    objective: buildObjectiveCenterPresentation(payload, teamA, teamB),
    hasCanonicalSeries: series !== null,
    currentSideMapping: sideMapping.state,
    teamA,
    teamB,
    currentMapName: displayMapName(payload.map.name) ?? displayMapName(currentMap?.mapName) ?? null,
    bestOfLabel:
      series?.format === undefined ? null : (series.format.toUpperCase() as 'BO1' | 'BO3' | 'BO5'),
    seriesScoreText: series === null ? null : `${series.score.a}:${series.score.b}`,
    competitionName: payload.match?.competition.name ?? null,
    stageName: payload.match?.stage ?? null,
    roundNumber,
    roundLabel: roundNumber === null ? null : `ROUND ${roundNumber}`,
    ...clock,
    seriesMaps: series === null ? null : buildSeriesMaps(series),
    roundHistory: buildRoundHistory(series, payload.map.roundHistory),
  };
}

export function formatMatchHeaderScore(value: number | null): string {
  return value === null ? '—' : String(value);
}
