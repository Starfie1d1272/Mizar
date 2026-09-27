import type { ObservedGrenade, ObservedGrenadeFlame } from '@mizar/core/telemetry';
import type { DiagnosticCollector } from '../diagnostics/collector.js';
import { asSourceRecord, compareSourceKeys, type SourceRecord } from '../parse/record.js';
import { optionalDecimalString, optionalString } from '../parse/scalar.js';
import { optionalVector, parseVectorValue } from '../parse/vector.js';
import { finishBlock, type ParsedBlock } from './types.js';

function readOwnerSourceId(
  record: SourceRecord,
  diagnostics: DiagnosticCollector,
  path: string,
): string | undefined {
  if (!Object.hasOwn(record, 'owner')) return undefined;
  const value = record.owner;
  if (typeof value === 'string') return value;
  diagnostics.add('INVALID_FIELD', 'error', `${path}.owner`);
  return undefined;
}

function parseFlame(
  sourceFlameId: string,
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ObservedGrenadeFlame | undefined {
  const position = parseVectorValue(value, diagnostics, path);
  return position === undefined ? undefined : { sourceFlameId, position };
}

function parseFlames(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): readonly ObservedGrenadeFlame[] | undefined {
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('UNEXPECTED_BLOCK_SHAPE', 'error', path);
    return undefined;
  }
  const flames: ObservedGrenadeFlame[] = [];
  for (const [sourceFlameId, flameValue] of Object.entries(record).sort(([left], [right]) =>
    compareSourceKeys(left, right),
  )) {
    const flame = parseFlame(sourceFlameId, flameValue, diagnostics, `${path}.${sourceFlameId}`);
    if (flame !== undefined) flames.push(flame);
  }
  return flames;
}

function parseGrenade(
  sourceEntityId: string,
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ObservedGrenade | undefined {
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('INVALID_GRENADE_ENTRY', 'error', path);
    return undefined;
  }

  const kind = optionalString(record, 'type', diagnostics, `${path}.type`);
  const ownerSourceId = readOwnerSourceId(record, diagnostics, path);
  const position = optionalVector(record, 'position', diagnostics, `${path}.position`);
  const velocity = optionalVector(record, 'velocity', diagnostics, `${path}.velocity`);
  const lifetimeSeconds = optionalDecimalString(
    record,
    'lifetime',
    diagnostics,
    `${path}.lifetime`,
  );
  const effectTimeSeconds = optionalDecimalString(
    record,
    'effecttime',
    diagnostics,
    `${path}.effecttime`,
  );
  const flames = Object.hasOwn(record, 'flames')
    ? parseFlames(record.flames, diagnostics, `${path}.flames`)
    : undefined;

  return {
    sourceEntityId,
    ...(kind === undefined ? {} : { kind }),
    ...(ownerSourceId === undefined ? {} : { ownerSourceId }),
    ...(position === undefined ? {} : { position }),
    ...(velocity === undefined ? {} : { velocity }),
    ...(lifetimeSeconds === undefined ? {} : { lifetimeSeconds }),
    ...(effectTimeSeconds === undefined ? {} : { effectTimeSeconds }),
    ...(flames === undefined ? {} : { flames }),
  };
}

export function parseGrenades(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ParsedBlock<readonly ObservedGrenade[]> {
  const start = diagnostics.totalCount;
  const record = asSourceRecord(value);
  if (record === undefined) {
    diagnostics.add('UNEXPECTED_BLOCK_SHAPE', 'error', path);
    return finishBlock<readonly ObservedGrenade[]>(diagnostics, start, undefined);
  }

  const grenades: ObservedGrenade[] = [];
  for (const [sourceEntityId, grenadeValue] of Object.entries(record).sort(([left], [right]) =>
    compareSourceKeys(left, right),
  )) {
    if (sourceEntityId.length === 0) {
      diagnostics.add('INVALID_GRENADE_ENTRY', 'error', `${path}.${sourceEntityId}`);
      continue;
    }
    const grenade = parseGrenade(
      sourceEntityId,
      grenadeValue,
      diagnostics,
      `${path}.${sourceEntityId}`,
    );
    if (grenade !== undefined) grenades.push(grenade);
  }

  return finishBlock(diagnostics, start, grenades);
}
