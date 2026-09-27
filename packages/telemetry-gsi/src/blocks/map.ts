import type {
  MapPhase,
  ObservedMap,
  ObservedMapSide,
  ObservedRoundWin,
  RoundWinCondition,
  SourceSide,
} from '@mizar/core/telemetry';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import { optionalEnum } from '../parse/enum.js';
import { asSourceRecord } from '../parse/record.js';
import { optionalInteger, optionalNumber, optionalString } from '../parse/scalar.js';
import { finishBlock, type ParsedBlock } from './types.js';

function normalizeMapPhase(value: string): MapPhase | undefined {
  switch (value.toLowerCase()) {
    case 'warmup':
      return 'warmup';
    case 'live':
      return 'live';
    case 'intermission':
      return 'intermission';
    case 'gameover':
      return 'gameover';
    default:
      return undefined;
  }
}

function parseMapSide(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ObservedMapSide | undefined {
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('UNEXPECTED_BLOCK_SHAPE', 'error', path);
    return undefined;
  }

  const name = optionalString(record, 'name', diagnostics, `${path}.name`);
  const score = optionalInteger(record, 'score', diagnostics, `${path}.score`);
  const timeoutsRemaining = optionalInteger(
    record,
    'timeouts_remaining',
    diagnostics,
    `${path}.timeouts_remaining`,
  );
  const consecutiveRoundLosses = parseConsecutiveRoundLosses(record, diagnostics, path);

  return {
    ...(name === undefined ? {} : { name }),
    ...(score === undefined ? {} : { score }),
    ...(timeoutsRemaining === undefined ? {} : { timeoutsRemaining }),
    ...(consecutiveRoundLosses === undefined ? {} : { consecutiveRoundLosses }),
  };
}

function parseConsecutiveRoundLosses(
  record: Record<string, unknown>,
  diagnostics: DiagnosticCollector,
  path: string,
): number | undefined {
  const value = optionalNumber(
    record,
    'consecutive_round_losses',
    diagnostics,
    `${path}.consecutive_round_losses`,
  );
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) {
    diagnostics.add('INVALID_FIELD', 'error', `${path}.consecutive_round_losses`, String(value));
    return undefined;
  }
  return value;
}

function normalizeRoundWin(value: string): {
  readonly winnerSide: SourceSide;
  readonly winCondition: RoundWinCondition;
} {
  const match = /^(ct|t)_win_(elimination|bomb|defuse|time)$/i.exec(value.trim());
  if (match === null) return { winnerSide: 'unknown', winCondition: 'unknown' };
  return {
    winnerSide: match[1]!.toUpperCase() as 'CT' | 'T',
    winCondition: match[2]!.toLowerCase() as Exclude<RoundWinCondition, 'unknown'>,
  };
}

function parseRoundWins(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): readonly ObservedRoundWin[] | undefined {
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('INVALID_FIELD', 'error', path);
    return undefined;
  }

  const wins: ObservedRoundWin[] = [];
  for (const [rawRoundNumber, rawReason] of Object.entries(record)) {
    const roundNumber = /^\d+$/.test(rawRoundNumber) ? Number(rawRoundNumber) : Number.NaN;
    if (!Number.isSafeInteger(roundNumber) || roundNumber <= 0 || typeof rawReason !== 'string') {
      diagnostics.add('INVALID_FIELD', 'warning', `${path}.${rawRoundNumber}`);
      continue;
    }
    const normalized = normalizeRoundWin(rawReason);
    if (normalized.winnerSide === 'unknown' || normalized.winCondition === 'unknown') {
      diagnostics.add('UNKNOWN_GSI_ENUM', 'warning', `${path}.${rawRoundNumber}`, rawReason);
    }
    wins.push({ roundNumber, ...normalized });
  }
  return wins.sort((left, right) => left.roundNumber - right.roundNumber);
}

export function parseMap(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ParsedBlock<ObservedMap> {
  const start = diagnostics.totalCount;
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('UNEXPECTED_BLOCK_SHAPE', 'error', path);
    return finishBlock<ObservedMap>(diagnostics, start, undefined);
  }

  const name = optionalString(record, 'name', diagnostics, `${path}.name`);
  const mode = optionalString(record, 'mode', diagnostics, `${path}.mode`);
  const phase = optionalEnum(
    record,
    'phase',
    normalizeMapPhase,
    'unknown',
    diagnostics,
    `${path}.phase`,
  );
  const roundNumber = optionalInteger(record, 'round', diagnostics, `${path}.round`);
  const roundWins = Object.hasOwn(record, 'round_wins')
    ? parseRoundWins(record.round_wins, diagnostics, `${path}.round_wins`)
    : undefined;

  const sideValues: { ct?: ObservedMapSide; t?: ObservedMapSide } = {};
  if (Object.hasOwn(record, 'team_ct')) {
    const ct = parseMapSide(record.team_ct, diagnostics, `${path}.team_ct`);
    if (ct !== undefined) sideValues.ct = ct;
  }
  if (Object.hasOwn(record, 'team_t')) {
    const t = parseMapSide(record.team_t, diagnostics, `${path}.team_t`);
    if (t !== undefined) sideValues.t = t;
  }

  const hasSides = sideValues.ct !== undefined || sideValues.t !== undefined;
  return finishBlock(diagnostics, start, {
    ...(name === undefined ? {} : { name }),
    ...(mode === undefined ? {} : { mode }),
    ...(phase === undefined ? {} : { phase }),
    ...(roundNumber === undefined ? {} : { roundNumber }),
    ...(roundWins === undefined ? {} : { roundWins }),
    ...(hasSides ? { sides: sideValues } : {}),
  });
}
