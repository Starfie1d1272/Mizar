import { diagnosticEvidence } from './diagnostic-value.js';

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export function technicalProjection(input: Record<string, unknown>, consentAt: string | null) {
  const exclusions = new Set<string>();
  const token = (value: unknown, limit = 160) =>
    typeof value === 'string' && value.length <= limit && /^[a-zA-Z0-9_.:/+-]+$/.test(value)
      ? value
      : null;
  const timestamp = (value: unknown) =>
    typeof value === 'string' && Number.isFinite(Date.parse(value))
      ? new Date(value).toISOString()
      : null;
  const eventId = token(input.eventId, 256);

  const observedAt = timestamp(input.observedAt);
  const sourceTime = observedAt === null ? NaN : Date.parse(observedAt);
  const consentTime = consentAt === null ? NaN : Date.parse(consentAt);
  const interval = object(input.sourceInterval);
  const intervalFrom = typeof interval.from === 'string' ? Date.parse(interval.from) : NaN;
  const permitted =
    Number.isFinite(sourceTime) &&
    Number.isFinite(consentTime) &&
    sourceTime >= consentTime &&
    (input.sourceInterval == null ||
      (Number.isFinite(intervalFrom) && intervalFrom >= consentTime));
  if (!permitted) exclusions.add('source-before-consent-or-unknown-time');
  const kind = typeof input.kind === 'string' ? input.kind : 'diagnostic_source_excluded';
  // Export and upload share the same evidence policy; consent gates transport only.
  const safe = object(diagnosticEvidence(input));
  const evidence = permitted ? (safe.evidence ?? null) : null;
  const sourceCoverage = object(safe.coverage);
  return {
    schema: 'mizar-diagnostic-event/2',
    eventId,
    producerKind: ['companion', 'host', 'document', 'legacy-unknown'].includes(
      String(input.producerKind),
    )
      ? String(input.producerKind)
      : 'legacy-unknown',
    producerRunId: input.producerRunId,
    sequence: input.sequence,
    kind,
    phase: token(input.phase),
    outcome: token(input.outcome),
    observedAt,
    recordedAt: timestamp(input.recordedAt),
    monotonicMs:
      typeof input.monotonicMs === 'number' && Number.isFinite(input.monotonicMs)
        ? input.monotonicMs
        : null,
    sourceInterval:
      input.sourceInterval == null
        ? null
        : {
            from:
              typeof interval.from === 'string' && Number.isFinite(Date.parse(interval.from))
                ? new Date(interval.from).toISOString()
                : null,
            to:
              typeof interval.to === 'string' && Number.isFinite(Date.parse(interval.to))
                ? new Date(interval.to).toISOString()
                : null,
          },
    taskId: token(input.taskId, 96),
    operationId: token(input.operationId, 96),
    parentOperationId: token(input.parentOperationId, 96),
    attemptId: token(input.attemptId, 96),
    scope: permitted ? (safe.scope ?? null) : null,
    evidence,
    coverage: {
      ...object(safe.coverage),
      durability: 'committed',
      occurrences:
        Number.isSafeInteger(sourceCoverage.occurrences) && Number(sourceCoverage.occurrences) > 0
          ? sourceCoverage.occurrences
          : 1,
      excluded: [
        ...new Set([
          ...exclusions,
          ...(Array.isArray(object(safe.coverage).excluded)
            ? (object(safe.coverage).excluded as string[])
            : []),
        ]),
      ],
      unknown: Array.isArray(sourceCoverage.unknown) ? sourceCoverage.unknown : [],
      replayCount: sourceCoverage.replayCount ?? 0,
    },
    projection: { policyVersion: 3, consentAt, sourceEventId: eventId },
    // Wire /1 index compatibility aliases, not a second evidence body.
    time: observedAt,
    stage: kind,
    startupSessionId: input.producerRunId,
    appVersion:
      typeof input.appVersion === 'string' &&
      /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(input.appVersion)
        ? input.appVersion
        : null,
  };
}
