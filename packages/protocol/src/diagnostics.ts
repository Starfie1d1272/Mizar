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
