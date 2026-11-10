import { redactDiagnosticText } from '../updates/diagnostics.js';
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const pick = (value: unknown, allowed: readonly string[]) =>
  typeof value === 'string' && allowed.includes(value) ? value : null;
const number = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Reapply this boundary during export: local log files are untrusted input too. */
export function businessEvidence(value: unknown) {
  const input = object(value);
  const ref = (value: unknown) =>
    typeof value === 'string' && /^[a-f0-9]{24}$/.test(value) ? value : null;
  const roster = (value: unknown) =>
    Array.isArray(value)
      ? value.slice(0, 64).map((row) => {
          const item = object(row);
          return {
            steam64: steam64(item.steam64),
            entryId: businessId(item.entryId),
            playerId: businessId(item.playerId),
            side: pick(item.side, ['CT', 'T', 'unknown']),
            slot: number(item.slot),
            isStarter: typeof item.isStarter === 'boolean' ? item.isStarter : null,
          };
        })
      : [];
  return {
    schema: input.schema === 2 ? 2 : 1,
    repetitionId: businessId(input.repetitionId),
    occurrences: number(input.occurrences),
    totalOccurrences: number(input.totalOccurrences),
    firstObservedAt: utc(input.firstObservedAt),
    lastObservedAt: utc(input.lastObservedAt),
    matchId: businessId(input.matchId),
    competitionId: businessId(input.competitionId),
    installationId: businessId(input.installationId),
    contextRevision: businessId(input.contextRevision),
    eventId: businessId(input.eventId),
    idempotencyKey: businessId(input.idempotencyKey),
    receiptId: businessId(input.receiptId),
    liveSessionId: businessId(input.liveSessionId),
    producerInstanceId: businessId(input.producerInstanceId),
    mapId: businessId(input.mapId),
    entryAId: businessId(input.entryAId),
    entryBId: businessId(input.entryBId),
    coverage: Object.fromEntries(
      ['map', 'round', 'phaseCountdowns', 'allPlayers', 'player'].map((key) => [
        key,
        pick(object(input.coverage)[key], ['present', 'absent', 'degraded']),
      ]),
    ),
    mapPhase: pick(input.mapPhase, ['live', 'warmup', 'gameover', 'intermission', 'unknown']),
    roundNumber: number(input.roundNumber),
    lineupState: pick(input.lineupState, [
      'empty',
      'current',
      'retained',
      'degraded',
      'unavailable',
      'ready',
      'partial',
    ]),
    failureStage: pick(input.failureStage, ['fetch', 'read', 'parse', 'validate', 'cancel']),
    causeCode: pick(input.causeCode, [
      'ECONNREFUSED',
      'ECONNRESET',
      'ENOTFOUND',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ETIMEDOUT',
      'EPIPE',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_HEADERS_TIMEOUT',
      'UND_ERR_BODY_TIMEOUT',
      'UND_ERR_SOCKET',
    ]),
    sourceUnavailableReason: pick(input.sourceUnavailableReason, [
      'source_missing',
      'match_mismatch',
      'producer_mismatch',
      'session_mismatch',
    ]),
    authorityRevision: number(input.authorityRevision),
    originalObservedAt: utc(input.originalObservedAt),
    recordUpdatedAt: utc(input.recordUpdatedAt),
    nextAttemptAt: utc(input.nextAttemptAt),
    sentAt: utc(input.sentAt),
    acknowledgedAt: utc(input.acknowledgedAt),
    restoredAt: utc(input.restoredAt),
    generatedVersion: version(input.generatedVersion),
    restoredVersion: version(input.restoredVersion),
    expected: roster(input.expected),
    observed: roster(input.observed),
    missing: steamList(input.missing),
    extra: steamList(input.extra),
    duplicates: steamList(input.duplicates),
    rosterOmitted: number(input.rosterOmitted),
    telemetryFresh: typeof input.telemetryFresh === 'boolean' ? input.telemetryFresh : null,
    contextFresh: typeof input.contextFresh === 'boolean' ? input.contextFresh : null,
    lineupMismatchOnly:
      typeof input.lineupMismatchOnly === 'boolean' ? input.lineupMismatchOnly : null,
    source: pick(input.source, [
      'runtime-transition',
      'runtime-continuity',
      'series-progress',
      'identity',
    ]),
    httpStatus:
      typeof input.httpStatus === 'number' && input.httpStatus >= 100 && input.httpStatus <= 599
        ? input.httpStatus
        : null,
    blockers: Array.isArray(input.blockers) ? input.blockers.filter(isReason).slice(0, 24) : [],
    matchRef: ref(input.matchRef),
    contextRef: ref(input.contextRef),
    eventRef: ref(input.eventRef),
    liveSessionRef: ref(input.liveSessionRef),
    producerRef: ref(input.producerRef),
    mapRef: ref(input.mapRef),
    mapName:
      typeof input.mapName === 'string' && /^[a-zA-Z0-9_./-]{1,128}$/.test(input.mapName)
        ? input.mapName
        : null,
    plannedMapRef: ref(input.plannedMapRef),
    eventKind: pick(input.eventKind, [
      'match_started',
      'map_started',
      'map_ended',
      'map_player_snapshot',
      'series_ended',
      'source_generation_changed',
      'map_epoch_changed',
      'identity_mismatch',
      'lineup_mismatch',
    ]),
    mapEpoch: number(input.mapEpoch),
    sourceGeneration: number(input.sourceGeneration),
    runtimeSeq: number(input.runtimeSeq),
    receiveSequence: number(input.receiveSequence),
    mapOrder: number(input.mapOrder),
    attempts: number(input.attempts),
    scoreA: number(input.scoreA),
    scoreB: number(input.scoreB),
    scoreCT: number(input.scoreCT),
    scoreT: number(input.scoreT),
    context: pick(input.context, ['unbound', 'fresh', 'stale']),
    identity: pick(input.identity, ['unbound', 'resolving', 'matched', 'degraded', 'mismatch']),
    binding: pick(input.binding, ['bound', 'unbound', 'needs_operator']),
    telemetry: pick(input.telemetry, ['awaiting', 'fresh', 'stale']),
    status: pick(input.status, ['pending', 'accepted', 'rejected', 'expired', 'superseded']),
    receiverOutcome: pick(input.receiverOutcome, ['needs_attention']),
    recoveryState: pick(input.recoveryState, [
      'refreshing',
      'awaiting_boundary',
      'awaiting_observation',
      'blocked',
      'proof_queued',
    ]),
    dispositionReason: pick(input.dispositionReason, ['boundary_unconfirmed_result']),
    supersessionReason: pick(input.supersessionReason, [
      'rejected_start_result',
      'boundary_unconfirmed_start',
      'map_end_unavailable',
      'current_scope_failed',
      'scope_superseded',
    ]),
    rejectionReason: pick(input.rejectionReason, [
      'context_stale',
      'sequence_stale',
      'generation_fence',
      'epoch_fence',
      'authority_changed',
      'idempotency_conflict',
      'invalid_schema',
    ]),
    recovery: pick(input.recovery, ['refresh_context', 'reconcile', 'none']),
    requestId:
      typeof input.requestId === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input.requestId,
      )
        ? input.requestId
        : null,
    reason: isReason(input.reason) ? input.reason : null,
    issues: Array.isArray(input.issues)
      ? [...new Set(input.issues.filter((code): code is string => isReason(code)))]
          .sort()
          .slice(0, 32)
      : [],
  };
}

export const businessVersion = () => version(process.env.MIZAR_APP_VERSION) ?? 'unknown';
export const version = (value: unknown) =>
  typeof value === 'string' &&
  /^(?:unknown|[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-(?:alpha|beta|rc)\.[0-9]+)?)$/.test(value)
    ? value
    : null;
export const utc = (value: unknown) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
  Number.isFinite(Date.parse(value))
    ? value
    : null;
export const businessId = (value: unknown) =>
  typeof value === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value) &&
  redactDiagnosticText(value) === value
    ? value
    : null;
export const steam64 = (value: unknown) =>
  typeof value === 'string' && /^7656\d{13}$/.test(value) ? value : null;
const steamList = (value: unknown) =>
  Array.isArray(value)
    ? value.filter((v: unknown): v is string => steam64(v) !== null).slice(0, 64)
    : [];
const isReason = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);

/** One fault predicate for retained business history and diagnostic search indexes. */
export function businessEvidenceHasFailure(value: unknown): boolean {
  const evidence = object(value);
  return (
    evidence.status === 'rejected' ||
    evidence.identity === 'mismatch' ||
    evidence.binding === 'needs_operator' ||
    (Array.isArray(evidence.blockers) && evidence.blockers.length > 0) ||
    (typeof evidence.reason === 'string' &&
      ![
        'queued',
        'restored',
        'receiver_accepted',
        'claim_accepted',
        'release_attempt',
        'release_confirmed',
        'contiguous',
        'baseline',
        'request_started',
      ].includes(evidence.reason))
  );
}
