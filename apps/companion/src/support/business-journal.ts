import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  openSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import type { MatchContextBinding } from '../match-context/index.js';
import type { ProjectionBundle } from '../projections/projection-coordinator.js';
import type { ReliableOutboxRecord } from '../output/reliable-outbox.js';

export const BUSINESS_LOG_BYTES = 64 * 1024;
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
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const pick = (value: unknown, allowed: readonly string[]) =>
  typeof value === 'string' && allowed.includes(value) ? value : null;
const number = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/** Reapply this boundary during export: local log files are untrusted input too. */
export function businessEvidence(value: unknown, salt = '') {
  const input = object(value);
  const ref = (value: unknown) =>
    typeof value === 'string' && /^[a-f0-9]{24}$/.test(value)
      ? salt
        ? createHash('sha256').update(salt).update(value).digest('hex').slice(0, 24)
        : value
      : null;
  return {
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
    reason: typeof input.reason === 'string' && codes.has(input.reason) ? input.reason : null,
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

/** Separate from request logs so HTTP polling cannot evict business evidence. */
export class BusinessJournal {
  private readonly session = randomUUID();
  private readonly salt = randomUUID();
  private previousRuntime = '';
  private readonly delivery = new Map<string, string>();
  private failed = false;
  constructor(
    private readonly directory: string,
    private readonly onFailure: () => void,
  ) {
    this.write('business_session', {});
  }
  private ref(value: string | null | undefined) {
    return value == null
      ? null
      : createHash('sha256').update(this.salt).update(value).digest('hex').slice(0, 24);
  }
  runtime(bundle: ProjectionBundle, binding: MatchContextBinding | undefined): void {
    const { operator, program } = bundle;
    const cursor = operator.cursor;
    const evidence = businessEvidence({
      matchRef: this.ref(binding?.context.matchId),
      contextRef: this.ref(binding?.manifest.revision),
      liveSessionRef: this.ref(cursor.liveSessionId),
      producerRef: this.ref(cursor.producerInstanceId),
      mapRef: this.ref(operator.runtime.mapName),
      mapName: operator.runtime.mapName,
      plannedMapRef: this.ref(
        operator.seriesProgress?.maps.find(
          (map) => map.mapOrder === operator.seriesProgress?.currentMapOrder,
        )?.mapName,
      ),
      scoreA: operator.seriesProgress?.score.a,
      scoreB: operator.seriesProgress?.score.b,
      scoreCT: program.map.score.ct,
      scoreT: program.map.score.t,
      mapEpoch: cursor.mapEpoch,
      sourceGeneration: cursor.programSourceGeneration,
      runtimeSeq: cursor.runtimeSeq,
      receiveSequence: cursor.programReceiveSequence,
      mapOrder: operator.seriesProgress?.currentMapOrder,
      context: operator.matchContext.freshness,
      identity: operator.identity.state,
      binding: program.series?.bindingState,
      telemetry: operator.runtime.telemetryFreshness,
      reason: operator.runtime.lastDisposition?.reason,
      issues: [...operator.identity.issues, ...(operator.seriesProgress?.issues ?? [])].map(
        (issue) => issue.code,
      ),
    });
    // Cursors describe the boundary but do not generate a write for each GSI frame.
    const signature = JSON.stringify({ ...evidence, runtimeSeq: null, receiveSequence: null });
    if (signature === this.previousRuntime) return;
    this.previousRuntime = signature;
    this.write('business_runtime', evidence);
  }
  reliable(record: ReliableOutboxRecord, reason: string): void {
    const { event } = record;
    const evidence = businessEvidence({
      matchRef: this.ref(event.matchId),
      contextRef: this.ref(event.contextRevision),
      eventRef: this.ref(event.idempotencyKey),
      eventKind: event.kind,
      mapRef: this.ref(event.mapName),
      mapName: event.mapName,
      liveSessionRef: this.ref(event.cursor.liveSessionId),
      producerRef: this.ref(event.cursor.producerInstanceId),
      mapEpoch: event.cursor.mapEpoch,
      sourceGeneration: event.cursor.programSourceGeneration,
      runtimeSeq: event.cursor.runtimeSeq,
      receiveSequence: event.cursor.programReceiveSequence,
      status: record.status,
      attempts: record.attempts,
      reason,
    });
    const key = evidence.eventRef!;
    const signature = JSON.stringify(evidence);
    if (this.delivery.get(key) === signature) return;
    this.delivery.delete(key);
    this.delivery.set(key, signature);
    if (this.delivery.size > 192) this.delivery.delete(this.delivery.keys().next().value!);
    this.write('business_delivery', evidence);
  }
  private write(stage: string, evidence: unknown): void {
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const path = join(this.directory, BUSINESS_LOG_FILES[0]!);
      const safe = businessEvidence(evidence);
      const failure =
        safe.status === 'rejected' ||
        safe.reason === 'send_guard_blocked' ||
        safe.identity === 'mismatch' ||
        safe.binding === 'needs_operator';
      const line = `${JSON.stringify({ event: 'business', stage, result: failure ? 'failure' : 'success', time: Date.now(), startupSessionId: this.session, evidence: safe })}\n`;
      let size = 0;
      try {
        const file = lstatSync(path);
        if (!file.isFile() || file.isSymbolicLink()) throw new Error('business_log_not_regular');
        size = file.size;
      } catch (error) {
        if (object(error).code !== 'ENOENT') throw error;
      }
      if (size + Buffer.byteLength(line) > BUSINESS_LOG_BYTES) {
        for (let index = BUSINESS_LOG_FILES.length - 1; index > 0; index--) {
          const target = join(this.directory, BUSINESS_LOG_FILES[index]!);
          if (index === BUSINESS_LOG_FILES.length - 1) {
            try {
              unlinkSync(target);
            } catch (error) {
              if (object(error).code !== 'ENOENT') throw error;
            }
          }
          try {
            renameSync(join(this.directory, BUSINESS_LOG_FILES[index - 1]!), target);
          } catch (error) {
            if (object(error).code !== 'ENOENT') throw error;
          }
        }
      }
      const handle = openSync(
        path,
        constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        appendFileSync(handle, line);
      } finally {
        closeSync(handle);
      }
      this.failed = false;
    } catch {
      if (!this.failed) {
        try {
          this.onFailure();
        } catch {
          /* Diagnostics are optional. */
        }
      }
      this.failed = true;
    }
  }
  getStatus(): 'available' | 'write_failed' {
    return this.failed ? 'write_failed' : 'available';
  }
}
