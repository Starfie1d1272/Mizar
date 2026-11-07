/** Cloud is a deliberately narrower projection, never a redacted copy of local evidence. */
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const scalarFields = new Set([
  'name',
  'code',
  'reason',
  'stage',
  'phase',
  'result',
  'status',
  'state',
  'operation',
  'failureKind',
  'matchId',
  'competitionId',
  'mapId',
  'mapName',
  'mapEpoch',
  'liveSessionId',
  'producerInstanceId',
  'sourceGeneration',
  'runtimeSeq',
  'receiveSequence',
  'contextRevision',
  'httpStatus',
  'attempts',
  'durationMs',
  'elapsedMs',
  'latencyMs',
  'queueBytes',
  'pendingBytes',
  'pendingRecords',
  'dropped',
  'writeFailures',
  'occurrences',
  'count',
  'firstObservedAt',
  'lastObservedAt',
  'time',
  'observedAt',
  'recordedAt',
  'taskId',
  'operationId',
  'attemptId',
  'parentOperationId',
  'trigger',
  'connected',
  'available',
  'accepted',
  'confirmed',
  'acknowledged',
  'requested',
  'received',
  'sent',
  'bytes',
  'anomalyCount',
  'windowMs',
  'p50',
  'p95',
  'p99',
  'min',
  'max',
  'mean',
  'total',
  'omittedSamples',
  'droppedFrames',
  'sequence',
]);
const nestedFields = new Set([
  'error',
  'cause',
  'correlation',
  'coverage',
  'timing',
  'metrics',
  'frames',
  'longTasks',
]);
const differenceFields = new Set(['missing', 'extra', 'duplicates', 'issues']);
function fields(value: unknown, exclusions: Set<string>, depth = 0): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object(value))) {
    if (
      scalarFields.has(key) &&
      (item === null ||
        typeof item === 'boolean' ||
        (typeof item === 'number' && Number.isFinite(item)) ||
        (typeof item === 'string' && item.length <= 160 && /^[\w.:/+-]*$/.test(item)))
    ) {
      output[key] = item;
    } else if (differenceFields.has(key) && Array.isArray(item)) {
      output[key] = item
        .filter((value) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,96}$/.test(value))
        .slice(0, 64);
      if ((output[key] as unknown[]).length !== item.length)
        exclusions.add('difference-list-bounded');
    } else if (
      nestedFields.has(key) &&
      depth < 3 &&
      item &&
      typeof item === 'object' &&
      !Array.isArray(item)
    ) {
      output[key] = fields(item, exclusions, depth + 1);
    } else exclusions.add('unclassified-or-private-field');
  }
  return output;
}
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
  const excludedKind = /chat|roster|lineup_document|obs_native|attachment|support_bundle/i.test(
    kind,
  );
  if (excludedKind) exclusions.add('private-source-kind');
  const evidence = permitted && !excludedKind ? fields(input.evidence, exclusions) : {};
  // Business envelopes carry technical facts one level below their source metadata.
  // Apply the exact same narrow field policy, never copy the nested body wholesale.
  if (permitted && !excludedKind && kind === 'business_evidence') {
    const nestedEvidence = object(input.evidence).evidence;
    if (nestedEvidence != null) evidence.evidence = fields(nestedEvidence, exclusions);
  }
  const sourceCoverage = object(input.coverage);
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
    scope: permitted ? fields(input.scope, exclusions) : null,
    evidence,
    coverage: {
      durability: 'committed',
      occurrences:
        Number.isSafeInteger(sourceCoverage.occurrences) && Number(sourceCoverage.occurrences) > 0
          ? sourceCoverage.occurrences
          : 1,
      excluded: [...exclusions],
      unknown: ['local-detail-not-in-technical-projection'],
      replayCount: 0,
    },
    projection: { policyVersion: 2, consentAt, sourceEventId: eventId },
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
