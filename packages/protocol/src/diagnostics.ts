/** Shared evidence contract, deliberately independent of business state enumerations. */
export const DIAGNOSTIC_EVENT_SCHEMA = 'mizar-diagnostic-event/2' as const;
export type DiagnosticProducerKind = 'companion' | 'host' | 'document' | 'legacy-unknown';
export interface DiagnosticCoverage {
  durability: 'pending' | 'committed' | 'memory-only' | 'unknown';
  unknown: string[];
  excluded: string[];
  replayCount: number;
  occurrences: number;
}
export interface DiagnosticEvent {
  schema: typeof DIAGNOSTIC_EVENT_SCHEMA;
  eventId: string;
  producerKind: DiagnosticProducerKind;
  producerRunId: string;
  sequence: number;
  kind: string;
  phase: string | null;
  outcome: string | null;
  observedAt: string | null;
  recordedAt: string;
  monotonicMs: number | null;
  sourceInterval: { from: string | null; to: string | null } | null;
  taskId: string | null;
  operationId: string | null;
  parentOperationId: string | null;
  attemptId: string | null;
  scope: Record<string, unknown> | null;
  evidence: unknown;
  coverage: DiagnosticCoverage;
}
export interface DiagnosticWatermark {
  producerRunId: string;
  acceptedSequence: number;
  committedSequence: number;
  pendingRecords: number;
  asOf: string;
}
export function isDiagnosticEvent(value: unknown): value is DiagnosticEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as DiagnosticEvent;
  return (
    event.schema === DIAGNOSTIC_EVENT_SCHEMA &&
    typeof event.eventId === 'string' &&
    event.eventId.length > 0 &&
    event.eventId.length <= 256 &&
    ['companion', 'host', 'document', 'legacy-unknown'].includes(event.producerKind) &&
    typeof event.producerRunId === 'string' &&
    Number.isSafeInteger(event.sequence) &&
    event.sequence >= 1 &&
    typeof event.kind === 'string' &&
    typeof event.recordedAt === 'string'
  );
}

/** The HTTP document handoff uses the same event identity and body as the native IPC. */
export function isDocumentDiagnosticEvent(value: unknown): value is DiagnosticEvent {
  if (!isDiagnosticEvent(value)) return false;
  const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  const text = (value: unknown) =>
    value === null || (typeof value === 'string' && value.length <= 256);
  return (
    value.producerKind === 'document' &&
    uuid.test(value.producerRunId) &&
    value.eventId === `${value.producerRunId}:${value.sequence}` &&
    /^[a-z][a-z0-9_.-]{0,127}$/.test(value.kind) &&
    typeof value.observedAt === 'string' &&
    Number.isFinite(Date.parse(value.observedAt)) &&
    Number.isFinite(Date.parse(value.recordedAt)) &&
    [
      value.phase,
      value.outcome,
      value.taskId,
      value.operationId,
      value.parentOperationId,
      value.attemptId,
    ].every(text) &&
    value.sourceInterval === null &&
    (value.monotonicMs === null ||
      (typeof value.monotonicMs === 'number' && Number.isFinite(value.monotonicMs))) &&
    Boolean(value.coverage) &&
    Array.isArray(value.coverage.unknown) &&
    Array.isArray(value.coverage.excluded) &&
    value.coverage.unknown.every((item) => typeof item === 'string') &&
    value.coverage.excluded.every((item) => typeof item === 'string') &&
    Number.isSafeInteger(value.coverage.occurrences) &&
    value.coverage.occurrences > 0
  );
}
