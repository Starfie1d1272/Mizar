import type { CountdownPhase, ObservedPhaseCountdown } from '@mizar/core/telemetry';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import { optionalEnum } from '../parse/enum.js';
import { asSourceRecord } from '../parse/record.js';
import { optionalDecimalString } from '../parse/scalar.js';
import { finishBlock, type ParsedBlock } from './types.js';

function normalizeCountdownPhase(value: string): CountdownPhase | undefined {
  switch (value.toLowerCase()) {
    case 'paused':
      return 'paused';
    case 'timeout_ct':
      return 'timeout_ct';
    case 'timeout_t':
      return 'timeout_t';
    case 'warmup':
      return 'warmup';
    case 'freezetime':
      return 'freezetime';
    case 'live':
      return 'live';
    case 'bomb':
      return 'bomb';
    case 'defuse':
      return 'defuse';
    case 'over':
      return 'over';
    case 'unknown':
      return 'unknown';
    default:
      return undefined;
  }
}

export function parsePhaseCountdown(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ParsedBlock<ObservedPhaseCountdown> {
  const start = diagnostics.totalCount;
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('UNEXPECTED_BLOCK_SHAPE', 'error', path);
    return finishBlock<ObservedPhaseCountdown>(diagnostics, start, undefined);
  }

  const phase = optionalEnum(
    record,
    'phase',
    normalizeCountdownPhase,
    'unknown',
    diagnostics,
    `${path}.phase`,
  );
  const endsInSeconds = optionalDecimalString(
    record,
    'phase_ends_in',
    diagnostics,
    `${path}.phase_ends_in`,
  );

  return finishBlock(diagnostics, start, {
    ...(phase === undefined ? {} : { phase }),
    ...(endsInSeconds === undefined ? {} : { endsInSeconds }),
  });
}
