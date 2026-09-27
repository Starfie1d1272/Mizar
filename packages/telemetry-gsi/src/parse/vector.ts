import { DiagnosticCollector } from '../diagnostics/collector.js';
import type { ObservedVector3 } from '@mizar/core/telemetry';
import type { SourceRecord } from './record.js';

function vectorFromParts(parts: readonly unknown[]): ObservedVector3 | undefined {
  if (parts.length !== 3) return undefined;
  const [x, y, z] = parts;
  if (
    typeof x !== 'number' ||
    !Number.isFinite(x) ||
    typeof y !== 'number' ||
    !Number.isFinite(y) ||
    typeof z !== 'number' ||
    !Number.isFinite(z)
  ) {
    return undefined;
  }
  return { x, y, z };
}

function parseVector(value: unknown): ObservedVector3 | undefined {
  if (typeof value !== 'string') return undefined;
  const tokens = value.split(',').map((token) => token.trim());
  if (tokens.length !== 3 || tokens.some((token) => token.length === 0)) return undefined;
  const numbers = tokens.map((token) => Number(token));
  return vectorFromParts(numbers);
}

export function parseVectorValue(
  value: unknown,
  diagnostics: DiagnosticCollector,
  path: string,
): ObservedVector3 | undefined {
  const vector = parseVector(value);
  if (vector !== undefined) return vector;
  diagnostics.add('MALFORMED_VECTOR', 'error', path);
  return undefined;
}

export function optionalVector(
  record: SourceRecord,
  key: string,
  diagnostics: DiagnosticCollector,
  path: string,
): ObservedVector3 | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  return parseVectorValue(record[key], diagnostics, path);
}
