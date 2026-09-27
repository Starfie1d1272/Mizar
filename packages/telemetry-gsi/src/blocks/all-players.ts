import type { ObservedPlayer } from '@mizar/core/telemetry';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import { asSourceRecord, compareSourceKeys } from '../parse/record.js';
import { parsePlayer } from './player.js';
import { finishBlock, type ParsedBlock } from './types.js';

export function parseAllPlayers(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ParsedBlock<readonly ObservedPlayer[]> {
  const start = diagnostics.totalCount;
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('UNEXPECTED_BLOCK_SHAPE', 'error', path);
    return finishBlock<readonly ObservedPlayer[]>(diagnostics, start, undefined);
  }

  const players: ObservedPlayer[] = [];
  for (const [sourcePlayerId, playerValue] of Object.entries(record).sort(([left], [right]) =>
    compareSourceKeys(left, right),
  )) {
    if (sourcePlayerId.length === 0 || asSourceRecord(playerValue) === undefined) {
      diagnostics.add('INVALID_ALLPLAYERS_ENTRY', 'error', `${path}.${sourcePlayerId}`);
      continue;
    }
    const player = parsePlayer(
      playerValue,
      diagnostics,
      `${path}.${sourcePlayerId}`,
      sourcePlayerId,
    );
    if (player.value !== undefined) players.push(player.value);
  }

  return finishBlock(diagnostics, start, players);
}
