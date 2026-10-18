import { redactDiagnosticText } from '../updates/diagnostics.js';
export const BUSINESS_LOG_FILES = [
  'business.ndjson',
  'business.ndjson.1',
  'business.ndjson.2',
  'business.ndjson.3',
];
const codes = new Set([
  'baseline',
  'contiguous',
  'gap-resync',
  'stale-recovery',
  'source-generation-advanced',
  'map-execution-reset',
  'duplicate',
  'out-of-order',
  'non-monotonic-time',
  'stale-generation',
  'generation-ahead',
  'invalid-generation-advance',
  'map-not-established',
  'context_unbound',
  'roster_evidence_pending',
  'allplayers_unavailable',
  'allplayers_degraded',
  'partial_roster_evidence',
  'source_generation_changed',
  'map_epoch_changed',
  'roster_incomplete',
  'missing_canonical_steam64',
  'missing_canonical_display_name',
  'duplicate_canonical_player_id',
  'duplicate_canonical_steam64',
  'bot_or_noncanonical_source_id',
  'unexpected_human_steam64',
  'duplicate_observed_identity',
  'unknown_observed_side',
  'ambiguous_side_mapping',
  'side_mapping_conflict',
  'lineup_differs_from_expected',
  'map_not_confirmed',
  'map_mismatch',
  'context_invalid',
  'map_unbound',
  'map_ambiguous',
  'map_order_exception',
  'side_mapping_unproven',
  'final_score_unavailable',
  'final_score_conflict',
  'result_pending_review',
  'round_number_unavailable',
  'round_history_partial',
  'round_history_cap',
  'checkpoint_incompatible',
  'checkpoint_invalid',
  'operator_bind_applied',
  'operator_bind_rejected',
  'context_result_conflict',
  'current_scope_failed',
  'send_guard_blocked',
  'receiver_accepted',
  'delivery_rejected_unknown',
  'retry_unknown',
  'retention_expired',
  'queued',
  'restored',
]);
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
    matchId: businessId(input.matchId),
    competitionId: businessId(input.competitionId),
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
    mapName: pick(input.mapName, [
      'de_ancient',
      'de_anubis',
      'de_dust2',
      'de_inferno',
      'de_mirage',
      'de_nuke',
      'de_overpass',
      'de_train',
      'de_vertigo',
    ]),
    plannedMapRef: ref(input.plannedMapRef),
    eventKind: pick(input.eventKind, [
      'match_started',
      'map_started',
      'map_ended',
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
    reason: isReason(input.reason) ? input.reason : null,
    issues: Array.isArray(input.issues)
      ? [
          ...new Set(
            input.issues.filter(
              (code): code is string => typeof code === 'string' && codes.has(code),
            ),
          ),
        ]
          .sort()
          .slice(0, 32)
      : [],
  };
}

export const businessVersion = () => version(process.env.MIZAR_APP_VERSION) ?? 'unknown';
export const version = (value: unknown) =>
  typeof value === 'string' &&
  /^(?:unknown|[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-rc\.[0-9]+)?)$/.test(value)
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
  typeof value === 'string' &&
  (codes.has(value) ||
    [
      'unknown',
      'claim_attempt',
      'claim_accepted',
      'claim_rejected',
      'network_failed',
      'timeout',
      'invalid_response',
      'response_read_failed',
      'response_cancel_failed',
      'response_too_large',
      'broadcast_unavailable',
      'unknown_rejection',
      'frame_expired',
      'contended',
      'delivery_dropped',
      'capacity',
      'source_unavailable',
      'producer_mismatch',
      'map_start_pending',
      'map_start_rejected',
      'quarantined',
      'bundle_unavailable',
      'context_not_fresh',
      'telemetry_not_fresh',
      'identity_not_matched',
      'scope_not_current',
      'final_evidence_not_current',
      'map_phase_not_gameover',
      'map_name_changed',
      'map_score_changed',
      'map_result_not_completed',
      'canonical_result_changed',
      'mismatch_no_longer_current',
      'claim_response_received',
      'request_started',
      'request_aborted',
    ].includes(value) ||
    /^http_[1-5]\d{2}$/.test(value));

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
        'contiguous',
        'baseline',
        'request_started',
      ].includes(evidence.reason))
  );
}
