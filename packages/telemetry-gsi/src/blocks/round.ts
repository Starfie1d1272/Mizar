import type {
  ObservedRound,
  ObservedRoundBomb,
  RoundBombState,
  RoundPhase,
} from '@mizar/core/telemetry';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import { optionalEnum } from '../parse/enum.js';
import { asSourceRecord, type SourceRecord } from '../parse/record.js';
import { finishBlock, type ParsedBlock } from './types.js';

function normalizeRoundPhase(value: string): RoundPhase | undefined {
  switch (value.toLowerCase()) {
    case 'freezetime':
      return 'freezetime';
    case 'live':
      return 'live';
    case 'over':
      return 'over';
    case 'unknown':
      return 'unknown';
    default:
      return undefined;
  }
}

function normalizeRoundBombState(value: string): RoundBombState | undefined {
  switch (value.toLowerCase()) {
    case 'planted':
      return 'planted';
    case 'exploded':
      return 'exploded';
    case 'defused':
      return 'defused';
    case 'unknown':
      return 'unknown';
    default:
      return undefined;
  }
}

function normalizeSide(value: string): 'CT' | 'T' | 'unknown' | undefined {
  switch (value.toUpperCase()) {
    case 'CT':
      return 'CT';
    case 'T':
      return 'T';
    case 'UNKNOWN':
      return 'unknown';
    default:
      return undefined;
  }
}

function parseRoundBomb(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ObservedRoundBomb | undefined {
  if (typeof value !== 'string') {
    diagnostics.add('INVALID_FIELD', 'error', path);
    return undefined;
  }

  const state = normalizeRoundBombState(value);
  if (state !== undefined) return { state };
  diagnostics.add('UNKNOWN_GSI_ENUM', 'warning', path, value);
  return { state: 'unknown' };
}

function parseRoundBombField(
  record: SourceRecord,
  diagnostics: DiagnosticCollector,
  path: string,
): ObservedRoundBomb | undefined {
  return Object.hasOwn(record, 'bomb')
    ? parseRoundBomb(record.bomb, diagnostics, `${path}.bomb`)
    : undefined;
}

export function parseRound(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ParsedBlock<ObservedRound> {
  const start = diagnostics.totalCount;
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('UNEXPECTED_BLOCK_SHAPE', 'error', path);
    return finishBlock<ObservedRound>(diagnostics, start, undefined);
  }

  const phase = optionalEnum(
    record,
    'phase',
    normalizeRoundPhase,
    'unknown',
    diagnostics,
    `${path}.phase`,
  );
  const winnerSide = optionalEnum(
    record,
    'win_team',
    normalizeSide,
    'unknown',
    diagnostics,
    `${path}.win_team`,
  );
  const bomb = parseRoundBombField(record, diagnostics, path);

  return finishBlock(diagnostics, start, {
    ...(phase === undefined ? {} : { phase }),
    ...(winnerSide === undefined ? {} : { winnerSide }),
    ...(bomb === undefined ? {} : { bomb }),
  });
}
