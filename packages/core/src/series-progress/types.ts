import { canonicalizeCs2MapName } from '../map-name.js';
import type { MatchContext, MatchFormat, MatchMapContext } from '../match-context/index.js';
import type { ObservedRoundWin, RoundWinCondition, SourceSide } from '../telemetry/index.js';

export const SERIES_ROUND_HISTORY_MAX = 256 as const;
export const SERIES_PROGRESS_CHECKPOINT_VERSION = 'mizar.series-progress.v2' as const;

export type SeriesBindingState = 'bound' | 'unbound' | 'needs_operator';
export type SeriesMapStatus = 'pending' | 'current' | 'completed' | 'not_played';
export type SeriesCompleteness = 'complete' | 'partial' | 'unavailable';

export type SeriesProgressIssueCode =
  | 'context_invalid'
  | 'map_unbound'
  | 'map_mismatch'
  | 'map_ambiguous'
  | 'map_order_exception'
  | 'side_mapping_unproven'
  | 'final_score_unavailable'
  | 'final_score_conflict'
  | 'round_number_unavailable'
  | 'round_history_partial'
  | 'round_history_cap'
  | 'checkpoint_incompatible'
  | 'checkpoint_invalid'
  | 'operator_bind_applied'
  | 'operator_bind_rejected'
  | 'context_result_conflict';

export interface SeriesProgressIssue {
  readonly code: SeriesProgressIssueCode;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly mapOrder: number | null;
  readonly mapEpoch: number | null;
}

export interface SeriesEntrant {
  readonly entryId: string;
  readonly name: string;
  readonly logoUrl: string | null;
}

export type SeriesMapSelection =
  | { readonly kind: 'pick'; readonly entryId: string }
  | { readonly kind: 'decider' }
  | { readonly kind: 'unknown' };

export interface SeriesRoundResult {
  readonly roundNumber: number;
  readonly winnerSide: SourceSide;
  readonly winnerEntryId: string | null;
  readonly winCondition: RoundWinCondition;
}

export interface SeriesRoundHistory {
  readonly completeness: SeriesCompleteness;
  readonly rounds: readonly SeriesRoundResult[];
}

export interface SeriesMapProgress {
  readonly mapId: string | null;
  readonly mapOrder: number;
  readonly mapName: string;
  readonly selection: SeriesMapSelection;
  readonly teamAStartSide: 'CT' | 'T' | null;
  readonly status: SeriesMapStatus;
  readonly executionMapEpoch: number | null;
  readonly finalScore: null | { readonly a: number; readonly b: number };
  readonly winnerEntryId: string | null;
  readonly roundHistory: SeriesRoundHistory;
}

export interface SeriesProgress {
  readonly matchId: string;
  readonly format: MatchFormat;
  readonly requiredWins: 1 | 2 | 3;
  /** Frozen source plan identity; observed slots never redefine it. */
  readonly sourcePlan: {
    readonly mode: 'planned' | 'unplanned';
    readonly fingerprint: string;
    readonly allowedMaps: readonly string[];
  };
  readonly entrants: {
    readonly a: SeriesEntrant;
    readonly b: SeriesEntrant;
  };
  readonly score: { readonly a: number; readonly b: number };
  readonly maps: readonly SeriesMapProgress[];
  readonly currentMapOrder: number | null;
  readonly bindingState: SeriesBindingState;
  readonly issues: readonly SeriesProgressIssue[];
}

export interface SeriesSideProof {
  readonly sourceGeneration: number;
  readonly mapEpoch: number;
  readonly a: SourceSide;
  readonly b: SourceSide;
}

export interface SeriesMapObservation {
  readonly sourceGeneration: number;
  readonly mapEpoch: number;
  readonly mapName: string | null;
  readonly mapEnded?: boolean;
  readonly roundNumber: number | null;
  readonly score: { readonly ct: number | null; readonly t: number | null };
  readonly roundWins: readonly ObservedRoundWin[];
}

export type SeriesProgressEvent =
  | {
      readonly kind: 'map-execution-changed';
      readonly sourceGeneration: number;
      readonly mapEpoch: number;
      readonly previousMapEpoch: number;
      readonly previousMapName: string | null;
      readonly mapName: string | null;
      readonly resetReason: 'same-map-restart' | 'restore' | 'operator-correction' | null;
    }
  | {
      readonly kind: 'round-ended';
      readonly sourceGeneration: number;
      readonly mapEpoch: number;
      readonly roundNumber: number | null;
      readonly winnerSide: SourceSide;
      readonly winCondition: RoundWinCondition;
    }
  | {
      readonly kind: 'map-ended';
      readonly sourceGeneration: number;
      readonly mapEpoch: number;
      readonly finalScore: { readonly ct: number | null; readonly t: number | null };
    }
  | {
      readonly kind: 'operator-map-bind';
      readonly sourceGeneration: number;
      readonly mapEpoch: number;
      readonly mapOrder: number;
      readonly mapName: string | null;
      readonly reason: string;
    };

export interface SeriesProgressSyncInput {
  /** Closed upstream execution cannot acquire new unplanned maps. Existing evidence is retained. */
  readonly allowMapCreation?: boolean;
  readonly events: readonly SeriesProgressEvent[];
  readonly observation: SeriesMapObservation | null;
  readonly sideProof: SeriesSideProof | null;
  /** True only for the first observation applied after a compatible checkpoint load. */
  readonly restore?: boolean;
}

export interface SeriesProgressReduceResult {
  readonly progress: SeriesProgress;
  readonly changed: boolean;
}

export interface SeriesProgressCheckpoint {
  readonly checkpointVersion: typeof SERIES_PROGRESS_CHECKPOINT_VERSION;
  readonly identity: {
    readonly matchId: string;
    readonly format: MatchFormat;
    readonly entryAId: string;
    readonly entryBId: string;
    readonly mapPlanFingerprint: string;
  };
  readonly progress: SeriesProgress;
}

export interface SeriesProgressCheckpointStore {
  load(): SeriesProgressCheckpoint | undefined;
  save(checkpoint: SeriesProgressCheckpoint): void | Promise<void>;
  flush(): Promise<void>;
}

export function isSeriesProgressCheckpoint(value: unknown): value is SeriesProgressCheckpoint {
  if (!isRecord(value)) return false;
  if (value.checkpointVersion !== SERIES_PROGRESS_CHECKPOINT_VERSION) return false;
  if (!isRecord(value.identity) || !isRecord(value.progress)) return false;

  const identity = value.identity;
  const progress = value.progress;
  const entrants = progress.entrants;
  const score = progress.score;
  const maps = progress.maps;
  const currentMapOrder = progress.currentMapOrder;
  return (
    isNonEmptyString(identity.matchId) &&
    isMatchFormat(identity.format) &&
    isNonEmptyString(identity.entryAId) &&
    isNonEmptyString(identity.entryBId) &&
    typeof identity.mapPlanFingerprint === 'string' &&
    isNonEmptyString(progress.matchId) &&
    progress.matchId === identity.matchId &&
    isMatchFormat(progress.format) &&
    progress.format === identity.format &&
    progress.requiredWins === requiredSeriesWins(progress.format) &&
    isSeriesEntrants(entrants) &&
    entrants.a.entryId === identity.entryAId &&
    entrants.b.entryId === identity.entryBId &&
    isSeriesScore(score) &&
    isSeriesBindingState(progress.bindingState) &&
    (currentMapOrder === null || isPositiveInteger(currentMapOrder)) &&
    Array.isArray(maps) &&
    isRecord(progress.sourcePlan) &&
    (progress.sourcePlan.mode === 'planned' || progress.sourcePlan.mode === 'unplanned') &&
    progress.sourcePlan.fingerprint === identity.mapPlanFingerprint &&
    Array.isArray(progress.sourcePlan.allowedMaps) &&
    progress.sourcePlan.allowedMaps.length <= 16 &&
    progress.sourcePlan.allowedMaps.every(isNonEmptyString) &&
    (progress.sourcePlan.mode === 'unplanned' || maps.length > 0) &&
    maps.length <= requiredSeriesWins(progress.format) * 2 - 1 &&
    (maps.length > 0 ||
      (currentMapOrder === null &&
        score.a === 0 &&
        score.b === 0 &&
        progress.bindingState !== 'bound')) &&
    maps.every(isSeriesMapProgress) &&
    new Set(maps.map((map) => map.mapOrder)).size === maps.length &&
    (currentMapOrder === null || maps.some((map) => map.mapOrder === currentMapOrder)) &&
    Array.isArray(progress.issues) &&
    progress.issues.length <= 64 &&
    progress.issues.every(isSeriesProgressIssue)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isMatchFormat(value: unknown): value is MatchFormat {
  return value === 'bo1' || value === 'bo3' || value === 'bo5';
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isSeriesEntrant(value: unknown): value is SeriesEntrant {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.entryId) &&
    typeof value.name === 'string' &&
    (value.logoUrl === null || typeof value.logoUrl === 'string')
  );
}

function isSeriesEntrants(value: unknown): value is SeriesProgress['entrants'] {
  return isRecord(value) && isSeriesEntrant(value.a) && isSeriesEntrant(value.b);
}

function isSeriesScore(value: unknown): value is SeriesProgress['score'] {
  return isRecord(value) && isNonNegativeInteger(value.a) && isNonNegativeInteger(value.b);
}

function isSeriesBindingState(value: unknown): value is SeriesBindingState {
  return value === 'bound' || value === 'unbound' || value === 'needs_operator';
}

function isSeriesSelection(value: unknown): value is SeriesMapSelection {
  if (!isRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'pick') return isNonEmptyString(value.entryId);
  return value.kind === 'decider' || value.kind === 'unknown';
}

function isSeriesRoundResult(value: unknown): value is SeriesRoundResult {
  if (!isRecord(value)) return false;
  return (
    isPositiveInteger(value.roundNumber) &&
    (value.winnerSide === 'CT' || value.winnerSide === 'T' || value.winnerSide === 'unknown') &&
    (value.winnerEntryId === null || typeof value.winnerEntryId === 'string') &&
    (value.winCondition === 'elimination' ||
      value.winCondition === 'bomb' ||
      value.winCondition === 'defuse' ||
      value.winCondition === 'time' ||
      value.winCondition === 'unknown')
  );
}

function isSeriesMapProgress(value: unknown): value is SeriesMapProgress {
  if (!isRecord(value) || !isSeriesSelection(value.selection)) return false;
  if (!isRecord(value.roundHistory) || !Array.isArray(value.roundHistory.rounds)) return false;
  return (
    (value.mapId === null || typeof value.mapId === 'string') &&
    isPositiveInteger(value.mapOrder) &&
    typeof value.mapName === 'string' &&
    (value.teamAStartSide === null ||
      value.teamAStartSide === 'CT' ||
      value.teamAStartSide === 'T') &&
    (value.status === 'pending' ||
      value.status === 'current' ||
      value.status === 'completed' ||
      value.status === 'not_played') &&
    (value.executionMapEpoch === null || isNonNegativeInteger(value.executionMapEpoch)) &&
    (value.finalScore === null ||
      (isRecord(value.finalScore) &&
        isNonNegativeInteger(value.finalScore.a) &&
        isNonNegativeInteger(value.finalScore.b))) &&
    (value.winnerEntryId === null || typeof value.winnerEntryId === 'string') &&
    (value.roundHistory.completeness === 'complete' ||
      value.roundHistory.completeness === 'partial' ||
      value.roundHistory.completeness === 'unavailable') &&
    value.roundHistory.rounds.length <= SERIES_ROUND_HISTORY_MAX &&
    value.roundHistory.rounds.every(isSeriesRoundResult)
  );
}

function isSeriesProgressIssue(value: unknown): value is SeriesProgressIssue {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === 'string' &&
    (value.severity === 'info' || value.severity === 'warning' || value.severity === 'error') &&
    typeof value.message === 'string' &&
    (value.mapOrder === null || isPositiveInteger(value.mapOrder)) &&
    (value.mapEpoch === null || isNonNegativeInteger(value.mapEpoch))
  );
}

export interface BindCurrentMapExecutionToSeriesMapCommand {
  readonly kind: 'bind-current-map-execution-to-series-map';
  readonly mapOrder: number;
  readonly reason: string;
}

export type OperatorCommand = BindCurrentMapExecutionToSeriesMapCommand;

export function requiredSeriesWins(format: MatchFormat): 1 | 2 | 3 {
  return format === 'bo1' ? 1 : format === 'bo3' ? 2 : 3;
}

function canonicalMapName(value: string): string {
  return canonicalizeCs2MapName(value) ?? value.trim().toLowerCase();
}

function mapPlanEntry(
  map: Pick<
    MatchMapContext,
    'mapId' | 'mapOrder' | 'mapName' | 'pickedByEntryId' | 'teamAStartSide'
  >,
  selection: SeriesMapSelection,
) {
  return {
    mapId: map.mapId,
    mapOrder: map.mapOrder,
    mapName: canonicalMapName(map.mapName),
    selection,
    teamAStartSide: map.teamAStartSide,
  };
}

function selectionForPlan(context: MatchContext, map: MatchMapContext): SeriesMapSelection {
  if (map.pickedByEntryId !== null) return { kind: 'pick', entryId: map.pickedByEntryId };
  const isDecider = context.veto.some(
    (step) =>
      step.actionType === 'decider' &&
      canonicalMapName(step.mapName) === canonicalMapName(map.mapName),
  );
  return isDecider ? { kind: 'decider' } : { kind: 'unknown' };
}

export function seriesMapPlanFingerprint(context: MatchContext): string {
  return JSON.stringify({
    mode: context.maps.length === 0 ? 'unplanned' : 'planned',
    allowedMaps: [...new Set((context.mapPool ?? []).map(canonicalMapName))].sort(),
    maps: context.maps
      .slice()
      .sort(
        (left, right) => left.mapOrder - right.mapOrder || left.mapId.localeCompare(right.mapId),
      )
      .map((map) => mapPlanEntry(map, selectionForPlan(context, map))),
  });
}

export function seriesCheckpointIdentity(
  context: MatchContext,
): SeriesProgressCheckpoint['identity'] {
  return {
    matchId: context.matchId,
    format: context.format,
    entryAId: context.entrants.a.entryId,
    entryBId: context.entrants.b.entryId,
    mapPlanFingerprint: seriesMapPlanFingerprint(context),
  };
}
