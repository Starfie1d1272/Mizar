import type { GameEventPlayerRef } from '@mizar/core/game-events';
import type { SourceSide } from '@mizar/core/telemetry';

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function readProperty(record: Record<string, unknown>, key: string): unknown {
  try {
    return record[key];
  } catch {
    return undefined;
  }
}

function readNonEmptyString(record: Record<string, unknown>, key: string): string | undefined {
  const value = readProperty(record, key);
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function normalizeSide(value: unknown): SourceSide | undefined {
  if (typeof value === 'number') {
    if (value === 3) return 'CT';
    if (value === 2) return 'T';
  }
  if (typeof value === 'string') {
    const normalized = value.toUpperCase();
    if (normalized === 'CT') return 'CT';
    if (normalized === 'T') return 'T';
  }
  return undefined;
}

export function isSourceUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** Copy only the scalar player evidence needed by the Broadcast event contract. */
export function normalizeSourcePlayerRef(
  value: unknown,
  sourceUserId: unknown,
): GameEventPlayerRef | undefined {
  if (!isSourceUserId(sourceUserId)) return undefined;

  const record = asRecord(value);
  if (record === undefined) return { sourceUserId };

  const sourcePlayerId = readNonEmptyString(record, 'steamId');
  const displayName = readNonEmptyString(record, 'name');
  const side = normalizeSide(readProperty(record, 'teamNumber'));

  return {
    sourceUserId,
    ...(sourcePlayerId === undefined ? {} : { sourcePlayerId }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(side === undefined ? {} : { side }),
  };
}

export function readPropertyValue(record: Record<string, unknown>, key: string): unknown {
  return readProperty(record, key);
}
