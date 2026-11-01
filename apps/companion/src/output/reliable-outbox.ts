import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseReliableEventV1, type ReliableEventV1 } from '@mizar/protocol/output';

import { durableJsonByteLength, replaceDurableJson } from '../match-context/durable-json.js';
import { SerialCommitQueue } from '../match-context/serial-commit.js';
import type { ExactSource } from '../match-context/rivalhub-source-state.js';

export const RELIABLE_OUTBOX_VERSION = 'mizar.reliable-outbox.v2' as const;
export const RELIABLE_OUTBOX_MAX_PENDING = 128;
export const RELIABLE_OUTBOX_MAX_RECORDS = 192;
export const RELIABLE_OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1000;
export const RELIABLE_SEND_TIMEOUT_MS = 5_000;

export type ReliableRejectionReason =
  | 'context_stale'
  | 'sequence_stale'
  | 'generation_fence'
  | 'epoch_fence'
  | 'authority_changed'
  | 'idempotency_conflict'
  | 'invalid_schema';
export interface ReliableRejection {
  readonly status: 'rejected';
  readonly reason: ReliableRejectionReason;
  readonly requestId?: string;
  readonly recovery: 'refresh_context' | 'reconcile' | 'none';
}
export interface ReliableAttention {
  readonly status: 'accepted';
  readonly outcome: 'needs_attention';
}
export type ReliableDeliveryResult =
  'accepted' | 'rejected' | 'retry' | ReliableRejection | ReliableAttention;

export function parseReliableRejection(input: unknown): ReliableRejection | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const recoveryByReason: Record<ReliableRejectionReason, ReliableRejection['recovery']> = {
    context_stale: 'refresh_context',
    sequence_stale: 'reconcile',
    generation_fence: 'reconcile',
    epoch_fence: 'reconcile',
    authority_changed: 'none',
    idempotency_conflict: 'none',
    invalid_schema: 'none',
  };
  if (
    typeof value.reason !== 'string' ||
    !Object.hasOwn(recoveryByReason, value.reason) ||
    (value.requestId !== undefined &&
      (typeof value.requestId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value.requestId,
        ))) ||
    value.recovery !== recoveryByReason[value.reason as ReliableRejectionReason]
  )
    return undefined;
  return {
    status: 'rejected',
    reason: value.reason as ReliableRejectionReason,
    ...(typeof value.requestId === 'string' ? { requestId: value.requestId } : {}),
    recovery: value.recovery as ReliableRejection['recovery'],
  };
}
export type ReliableDeliveryStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'superseded';

function isContinuityBoundary(event: ReliableEventV1): boolean {
  return event.kind === 'source_generation_changed' || event.kind === 'map_epoch_changed';
}

function dependsOnBoundary(event: ReliableEventV1, boundary: ReliableEventV1): boolean {
  const a = event.cursor;
  const b = boundary.cursor;
  return (
    event.idempotencyKey !== boundary.idempotencyKey &&
    event.matchId === boundary.matchId &&
    a.producerInstanceId === b.producerInstanceId &&
    a.liveSessionId !== null &&
    a.liveSessionId === b.liveSessionId &&
    a.runtimeSeq >= b.runtimeSeq &&
    a.programSourceGeneration >= b.programSourceGeneration &&
    a.mapEpoch >= b.mapEpoch
  );
}

export interface ReliableEventSink {
  send(
    event: ReliableEventV1,
    signal?: AbortSignal,
    lineupSteam64?: readonly string[],
    source?: ExactSource,
  ): Promise<ReliableDeliveryResult>;
}

export interface ReliableOutboxRecord {
  readonly event: ReliableEventV1;
  readonly source?: ExactSource;
  readonly awaitingSource?: true;
  readonly lineupSteam64?: readonly string[];
  readonly rejection?: ReliableRejection;
  readonly dispositionReason?: 'boundary_unconfirmed_result';
  readonly boundaryQualification?: {
    readonly planFingerprint: string;
    readonly authorityFingerprint: string;
  };
  readonly receiverOutcome?: 'needs_attention';
  readonly recoveryBoundaryKey?: string;
  readonly recoveryState?:
    'refreshing' | 'awaiting_boundary' | 'awaiting_observation' | 'blocked' | 'proof_queued';
  readonly status: ReliableDeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly updatedAt: string;
}

export interface ReliableDeliveryScope {
  readonly matchId: string;
  readonly producerInstanceId: string;
  readonly liveSessionId: string;
}

/** Persisted receipts only; an empty scope or a local queue flush is not an ACK. */
export interface ReliableScopeDisposition {
  readonly pending: number;
  readonly accepted: number;
  readonly needsAttention: number;
  readonly rejected: number;
  readonly superseded: number;
  readonly expired: number;
  readonly isolated: number;
  readonly isolatedIntents: number;
  readonly records: readonly {
    readonly kind: ReliableEventV1['kind'];
    readonly idempotencyKey: string;
    readonly status: ReliableDeliveryStatus;
    readonly needsAttention: boolean;
    readonly isolation?: 'revoked_unconfirmed';
  }[];
}

export interface DeliveryContinuity {
  readonly matchId: string;
  readonly contextRevision: string;
  readonly cursor: ReliableEventV1['cursor'];
  readonly mapName: string | null;
  readonly savedAt: string;
  readonly managedSourceId?: string;
}

export interface BoundaryScope {
  readonly matchId?: string;
  readonly producerInstanceId: string;
  readonly liveSessionId?: string;
  readonly ownerFingerprint?: string;
  readonly overflow?: true;
  readonly authorityFingerprint?: string;
  readonly runtimeSeq?: number;
  readonly programSourceGeneration?: number;
  readonly mapEpoch?: number;
}

export interface BoundaryIntent {
  readonly event: ReliableEventV1;
  readonly source?: ExactSource;
  readonly awaitingSource?: true;
  readonly planFingerprint: string;
  readonly authorityFingerprint: string;
  readonly expired?: true;
}

export interface OutboxFile {
  readonly version: typeof RELIABLE_OUTBOX_VERSION;
  readonly records: readonly ReliableOutboxRecord[];
  readonly archivedSources?: readonly ArchivedSource[];
  readonly boundaryIntents?: readonly BoundaryIntent[];
  readonly boundaryGap?: true;
  readonly boundaryGaps?: readonly BoundaryScope[];
  readonly boundaryOverflowOwners?: readonly string[];
  readonly continuity?: DeliveryContinuity;
  readonly continuityReference?: ReliableEventV1;
  readonly commit?: { readonly id: string; readonly sha256: string };
  readonly unconfirmedRecovery?: true;
}

export interface ArchivedSource {
  readonly identity: ExactSource;
  readonly records: readonly ReliableOutboxRecord[];
}

export interface RevokedSource {
  readonly disposition: 'revoked_unconfirmed';
  readonly identity: ExactSource;
  readonly records: readonly ReliableOutboxRecord[];
  readonly intents: readonly BoundaryIntent[];
}

export function parseSource(input: unknown): ExactSource {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('outbox_source_invalid');
  const value = input as Record<string, unknown>;
  const keys = [
    'baseUrl',
    'competitionId',
    'installationId',
    'matchId',
    'producerInstanceId',
    'liveSessionId',
  ];
  if (
    Object.keys(value).sort().join(',') !== [...keys, 'authorityRevision'].sort().join(',') ||
    keys.some(
      (key) =>
        typeof value[key] !== 'string' ||
        !(value[key] as string).length ||
        (value[key] as string).trim() !== value[key] ||
        (value[key] as string).length > (key === 'baseUrl' ? 2048 : 256),
    ) ||
    typeof value.authorityRevision !== 'number' ||
    !Number.isSafeInteger(value.authorityRevision) ||
    value.authorityRevision <= 0
  )
    throw new Error('outbox_source_invalid');
  try {
    const url = new URL(value.baseUrl as string);
    if (
      url.origin !== value.baseUrl ||
      url.username ||
      url.password ||
      !(
        url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      )
    )
      throw new Error('invalid origin');
  } catch {
    throw new Error('outbox_source_invalid');
  }
  return {
    baseUrl: value.baseUrl as string,
    competitionId: value.competitionId as string,
    installationId: value.installationId as string,
    matchId: value.matchId as string,
    producerInstanceId: value.producerInstanceId as string,
    liveSessionId: value.liveSessionId as string,
    authorityRevision: value.authorityRevision as number,
  };
}

export function sourceKey(source: ExactSource): string {
  return JSON.stringify([
    source.baseUrl,
    source.competitionId,
    source.installationId,
    source.matchId,
    source.producerInstanceId,
    source.liveSessionId,
    source.authorityRevision,
  ]);
}

export function scopeDigest(
  competitionId: string,
  matchId: string,
  producer: string,
  session: string | null,
): string {
  return createHash('sha256')
    .update(JSON.stringify([competitionId, matchId, producer, session]))
    .digest('hex');
}

export function archiveName(source: ExactSource): string {
  return `${scopeDigest(source.competitionId, source.matchId, source.producerInstanceId, source.liveSessionId)}-${createHash('sha256').update(sourceKey(source)).digest('hex')}.json`;
}

export function archiveDigest(archive: ArchivedSource): string {
  return createHash('sha256').update(JSON.stringify(archive)).digest('hex');
}

export function sourceMatchesEvent(source: ExactSource, event: ReliableEventV1): boolean {
  return (
    source.competitionId === event.competitionId &&
    source.matchId === event.matchId &&
    source.producerInstanceId === event.cursor.producerInstanceId &&
    source.liveSessionId === event.cursor.liveSessionId
  );
}

export function parseRecord(input: unknown): ReliableOutboxRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('outbox_record_invalid');
  const item = input as Record<string, unknown>;
  if (
    (item.lineupSteam64 !== undefined &&
      (!Array.isArray(item.lineupSteam64) ||
        item.lineupSteam64.length !== 10 ||
        item.lineupSteam64.some((v: unknown) => typeof v !== 'string' || !/^\d{17}$/.test(v)) ||
        new Set(item.lineupSteam64).size !== 10)) ||
    typeof item.status !== 'string' ||
    !['pending', 'accepted', 'rejected', 'expired', 'superseded'].includes(item.status) ||
    typeof item.attempts !== 'number' ||
    !Number.isSafeInteger(item.attempts) ||
    item.attempts < 0 ||
    typeof item.nextAttemptAt !== 'string' ||
    !Number.isFinite(Date.parse(item.nextAttemptAt)) ||
    typeof item.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(item.updatedAt))
  )
    throw new Error('outbox_record_invalid');
  if (
    item.dispositionReason !== undefined &&
    (item.dispositionReason !== 'boundary_unconfirmed_result' || item.status !== 'superseded')
  )
    throw new Error('outbox_disposition_invalid');
  if (
    item.receiverOutcome !== undefined &&
    (item.receiverOutcome !== 'needs_attention' || item.status !== 'accepted')
  )
    throw new Error('outbox_receiver_outcome_invalid');
  const rejection =
    item.rejection === undefined ? undefined : parseReliableRejection(item.rejection);
  if (item.rejection !== undefined && (rejection === undefined || item.status !== 'rejected'))
    throw new Error('outbox_rejection_invalid');
  if (
    item.recoveryState !== undefined &&
    (![
      'refreshing',
      'awaiting_boundary',
      'awaiting_observation',
      'blocked',
      'proof_queued',
    ].includes(String(item.recoveryState)) ||
      !['context_stale', 'generation_fence', 'epoch_fence'].includes(rejection?.reason ?? '') ||
      item.status !== 'rejected')
  )
    throw new Error('outbox_recovery_state_invalid');
  if (
    item.recoveryBoundaryKey !== undefined &&
    (typeof item.recoveryBoundaryKey !== 'string' ||
      !item.recoveryBoundaryKey ||
      item.recoveryBoundaryKey.length > 256 ||
      !['generation_fence', 'epoch_fence'].includes(rejection?.reason ?? ''))
  )
    throw new Error('outbox_recovery_boundary_invalid');
  let boundaryQualification: ReliableOutboxRecord['boundaryQualification'];
  if (item.boundaryQualification !== undefined) {
    if (
      !item.boundaryQualification ||
      typeof item.boundaryQualification !== 'object' ||
      Array.isArray(item.boundaryQualification)
    )
      throw new Error('boundary_qualification_invalid');
    const q = item.boundaryQualification as Record<string, unknown>;
    if (
      typeof q.planFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(q.planFingerprint) ||
      typeof q.authorityFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(q.authorityFingerprint)
    )
      throw new Error('boundary_qualification_invalid');
    boundaryQualification = {
      planFingerprint: q.planFingerprint,
      authorityFingerprint: q.authorityFingerprint,
    };
  }
  const event = parseReliableEventV1(item.event);
  const source = item.source === undefined ? undefined : parseSource(item.source);
  if (item.awaitingSource !== undefined && (item.awaitingSource !== true || source))
    throw new Error('outbox_source_invalid');
  if (source && !sourceMatchesEvent(source, event)) throw new Error('outbox_source_mismatch');
  if (boundaryQualification && (!isContinuityBoundary(event) || event.evidence.contextFresh))
    throw new Error('boundary_qualification_invalid');
  if (item.lineupSteam64 !== undefined && event.kind !== 'map_started')
    throw new Error('outbox_lineup_invalid');
  return {
    event,
    ...(source === undefined ? {} : { source }),
    ...(item.awaitingSource === true ? { awaitingSource: true as const } : {}),
    ...(boundaryQualification ? { boundaryQualification } : {}),
    ...(item.dispositionReason === 'boundary_unconfirmed_result'
      ? { dispositionReason: 'boundary_unconfirmed_result' as const }
      : {}),
    ...(rejection === undefined ? {} : { rejection }),
    ...(typeof item.recoveryBoundaryKey === 'string'
      ? { recoveryBoundaryKey: item.recoveryBoundaryKey }
      : {}),
    ...(item.receiverOutcome === 'needs_attention'
      ? { receiverOutcome: 'needs_attention' as const }
      : {}),
    ...(item.recoveryState === undefined
      ? {}
      : {
          recoveryState: item.recoveryState as NonNullable<ReliableOutboxRecord['recoveryState']>,
        }),
    ...(item.lineupSteam64 === undefined ? {} : { lineupSteam64: item.lineupSteam64 as string[] }),
    status: item.status as ReliableDeliveryStatus,
    attempts: item.attempts,
    nextAttemptAt: item.nextAttemptAt,
    updatedAt: item.updatedAt,
  };
}

export interface OutboxRecovery {
  readonly code: 'outbox_recovered' | 'outbox_preserved_without_records';
  readonly recoveredRecords: number;
  readonly message: string;
}

// Hash the complete stored payload, including terminal receipts and continuity.
// A UUID identifies a single commit; neither field is an event sequence or owner.
function payloadDigest(value: Record<string, unknown> | OutboxFile): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        records: value.records,
        archivedSources: value.archivedSources,
        boundaryIntents: value.boundaryIntents,
        boundaryGap: value.boundaryGap,
        boundaryGaps: value.boundaryGaps,
        boundaryOverflowOwners: value.boundaryOverflowOwners,
        continuity: value.continuity,
        continuityReference: value.continuityReference,
        unconfirmedRecovery: value.unconfirmedRecovery,
      }),
    )
    .digest('hex');
}

export function parseCommit(value: unknown): NonNullable<OutboxFile['commit']> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('outbox_commit_invalid');
  const commit = value as Record<string, unknown>;
  if (
    typeof commit.id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(commit.id) ||
    typeof commit.sha256 !== 'string' ||
    !/^[0-9a-f]{64}$/.test(commit.sha256)
  )
    throw new Error('outbox_commit_invalid');
  return { id: commit.id, sha256: commit.sha256 };
}

export function parseBoundaryIntent(raw: unknown): BoundaryIntent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('boundary_intent_invalid');
  const item = raw as Record<string, unknown>;
  if (
    (item.expired !== undefined && item.expired !== true) ||
    typeof item.planFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(item.planFingerprint) ||
    typeof item.authorityFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(item.authorityFingerprint)
  )
    throw new Error('boundary_intent_invalid');
  const event = parseReliableEventV1(item.event);
  const source = item.source === undefined ? undefined : parseSource(item.source);
  if (item.awaitingSource !== undefined && (item.awaitingSource !== true || source))
    throw new Error('outbox_source_invalid');
  if (source && !sourceMatchesEvent(source, event)) throw new Error('outbox_source_mismatch');
  if (!isContinuityBoundary(event) || event.evidence.contextFresh || !event.cursor.liveSessionId)
    throw new Error('boundary_intent_invalid');
  return {
    event,
    ...(source === undefined ? {} : { source }),
    ...(item.awaitingSource === true ? { awaitingSource: true as const } : {}),
    planFingerprint: item.planFingerprint,
    authorityFingerprint: item.authorityFingerprint,
    ...(item.expired === true ? { expired: true as const } : {}),
  };
}

export function parseOutbox(bytes: Buffer): OutboxFile {
  if (bytes.length > 4_000_000) throw new Error('outbox_too_large');
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('outbox_invalid');
  const value = raw as Record<string, unknown>;
  if (
    ![RELIABLE_OUTBOX_VERSION, 'mizar.reliable-outbox.v1'].includes(value.version as string) ||
    !Array.isArray(value.records) ||
    value.records.length > RELIABLE_OUTBOX_MAX_RECORDS ||
    (value.unconfirmedRecovery !== undefined && value.unconfirmedRecovery !== true) ||
    (value.boundaryGap !== undefined && value.boundaryGap !== true) ||
    (value.boundaryOverflowOwners !== undefined &&
      (!Array.isArray(value.boundaryOverflowOwners) ||
        value.boundaryOverflowOwners.length > RELIABLE_OUTBOX_MAX_RECORDS ||
        value.boundaryOverflowOwners.some(
          (owner: unknown) => typeof owner !== 'string' || !/^[a-f0-9]{64}$/.test(owner),
        ))) ||
    (value.boundaryGaps !== undefined &&
      (!Array.isArray(value.boundaryGaps) ||
        value.boundaryGaps.length > RELIABLE_OUTBOX_MAX_RECORDS)) ||
    (value.boundaryIntents !== undefined &&
      (!Array.isArray(value.boundaryIntents) ||
        value.boundaryIntents.length > RELIABLE_OUTBOX_MAX_PENDING))
  )
    throw new Error('outbox_invalid');
  if (
    value.version === 'mizar.reliable-outbox.v1' &&
    (value.commit !== undefined ||
      value.archivedSources !== undefined ||
      value.unconfirmedRecovery !== undefined ||
      value.boundaryIntents !== undefined ||
      value.boundaryGap !== undefined ||
      value.boundaryGaps !== undefined ||
      value.boundaryOverflowOwners !== undefined)
  )
    throw new Error('outbox_legacy_metadata_invalid');
  const commit = value.version === RELIABLE_OUTBOX_VERSION ? parseCommit(value.commit) : undefined;
  if (commit !== undefined && commit.sha256 !== payloadDigest(value))
    throw new Error('outbox_checksum_mismatch');
  const records = value.records.map(parseRecord);
  const archivedSources =
    value.archivedSources === undefined
      ? undefined
      : (() => {
          if (!Array.isArray(value.archivedSources)) throw new Error('outbox_archive_invalid');
          const archives: ArchivedSource[] = value.archivedSources.map((raw: unknown) => {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw))
              throw new Error('outbox_archive_invalid');
            const item = raw as Record<string, unknown>;
            if (!Array.isArray(item.records)) throw new Error('outbox_archive_invalid');
            const identity = parseSource(item.identity);
            const records = item.records.map(parseRecord);
            if (
              records.some(
                (record) =>
                  record.status === 'pending' ||
                  !record.source ||
                  sourceKey(record.source) !== sourceKey(identity),
              )
            )
              throw new Error('outbox_archive_invalid');
            return { identity, records };
          });
          if (new Set(archives.map((item) => sourceKey(item.identity))).size !== archives.length)
            throw new Error('outbox_archive_invalid');
          return archives;
        })();
  const boundaryGaps = (value.boundaryGaps as unknown[] | undefined)?.map((raw): BoundaryScope => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('boundary_gap_invalid');
    const item = raw as Record<string, unknown>;
    if (
      (item.matchId !== undefined &&
        (typeof item.matchId !== 'string' || !item.matchId || item.matchId.length > 256)) ||
      typeof item.producerInstanceId !== 'string' ||
      !item.producerInstanceId ||
      item.producerInstanceId.length > 256 ||
      (item.liveSessionId !== undefined &&
        (typeof item.liveSessionId !== 'string' ||
          !item.liveSessionId ||
          item.liveSessionId.length > 256)) ||
      (item.overflow !== undefined && item.overflow !== true) ||
      (item.ownerFingerprint !== undefined &&
        (typeof item.ownerFingerprint !== 'string' ||
          !/^[a-f0-9]{64}$/.test(item.ownerFingerprint))) ||
      (item.authorityFingerprint !== undefined &&
        (typeof item.authorityFingerprint !== 'string' ||
          !/^[a-f0-9]{64}$/.test(item.authorityFingerprint))) ||
      ['runtimeSeq', 'programSourceGeneration', 'mapEpoch'].some(
        (key) =>
          item[key] !== undefined &&
          (typeof item[key] !== 'number' ||
            !Number.isSafeInteger(item[key]) ||
            (item[key] as number) < 0),
      )
    )
      throw new Error('boundary_gap_invalid');
    return {
      ...(typeof item.matchId === 'string' ? { matchId: item.matchId } : {}),
      producerInstanceId: item.producerInstanceId,
      ...(typeof item.liveSessionId === 'string' ? { liveSessionId: item.liveSessionId } : {}),
      ...(typeof item.ownerFingerprint === 'string'
        ? { ownerFingerprint: item.ownerFingerprint }
        : {}),
      ...(item.overflow === true ? { overflow: true as const } : {}),
      ...(typeof item.runtimeSeq === 'number' ? { runtimeSeq: item.runtimeSeq } : {}),
      ...(typeof item.programSourceGeneration === 'number'
        ? { programSourceGeneration: item.programSourceGeneration }
        : {}),
      ...(typeof item.mapEpoch === 'number' ? { mapEpoch: item.mapEpoch } : {}),
      ...(typeof item.authorityFingerprint === 'string'
        ? { authorityFingerprint: item.authorityFingerprint }
        : {}),
    };
  });
  const boundaryIntents = (value.boundaryIntents as unknown[] | undefined)?.map(
    parseBoundaryIntent,
  );

  let continuity: DeliveryContinuity | undefined;
  if (value.continuity !== undefined) {
    const checkpoint = value.continuity as DeliveryContinuity;
    if (
      checkpoint === null ||
      typeof checkpoint !== 'object' ||
      ![
        'contextRevision,cursor,mapName,matchId,savedAt',
        'contextRevision,cursor,managedSourceId,mapName,matchId,savedAt',
      ].includes(Object.keys(checkpoint).sort().join(',')) ||
      (checkpoint.managedSourceId !== undefined &&
        (typeof checkpoint.managedSourceId !== 'string' ||
          !/^[0-9a-f-]{36}$/i.test(checkpoint.managedSourceId)))
    )
      throw new Error('outbox_continuity_invalid');
    const storedReference =
      value.continuityReference === undefined
        ? undefined
        : parseReliableEventV1(value.continuityReference);
    const reference =
      records.at(-1)?.event ??
      boundaryIntents?.at(-1)?.event ??
      archivedSources?.flatMap((archive) => archive.records).at(-1)?.event ??
      storedReference;
    if (reference === undefined || !Number.isFinite(Date.parse(checkpoint.savedAt)))
      throw new Error('outbox_continuity_invalid');
    parseReliableEventV1({
      ...reference,
      matchId: checkpoint.matchId,
      contextRevision: checkpoint.contextRevision,
      cursor: checkpoint.cursor,
      mapName: checkpoint.mapName,
      observedAt: checkpoint.savedAt,
    });
    continuity = checkpoint;
  }
  return {
    version: RELIABLE_OUTBOX_VERSION,
    records,
    ...(archivedSources === undefined ? {} : { archivedSources }),
    ...(boundaryIntents === undefined ? {} : { boundaryIntents }),
    ...(value.boundaryGap === true ? { boundaryGap: true } : {}),
    ...(boundaryGaps === undefined ? {} : { boundaryGaps }),
    ...(value.boundaryOverflowOwners === undefined
      ? {}
      : { boundaryOverflowOwners: value.boundaryOverflowOwners as string[] }),
    ...(continuity === undefined ? {} : { continuity }),
    ...(value.continuityReference === undefined
      ? {}
      : { continuityReference: parseReliableEventV1(value.continuityReference) }),
    ...(commit === undefined ? {} : { commit }),
    ...(value.unconfirmedRecovery === true ? { unconfirmedRecovery: true } : {}),
  };
}

function sealOutbox(file: OutboxFile): OutboxFile {
  return { ...file, commit: { id: randomUUID(), sha256: payloadDigest(file) } };
}

function recoveryReport(file: OutboxFile): OutboxRecovery {
  return {
    code: file.unconfirmedRecovery ? 'outbox_preserved_without_records' : 'outbox_recovered',
    recoveredRecords: file.unconfirmedRecovery ? 0 : file.records.length,
    message: file.unconfirmedRecovery
      ? '发送队列异常，原文件与已有恢复副本已另存隔离，无法确认完整提交与回执，旧事件暂停发送。Mizar 可继续使用；旧事件未确认送达，请核对接收端结果，在运行诊断导出诊断包反馈。'
      : `发送队列读取异常，已从同一提交的完整恢复副本恢复 ${file.records.length} 条记录（含已确认记录）；原文件已另存。发送仍需通过原有身份与时效检查。可在运行诊断导出诊断包反馈。`,
  };
}

async function readOptional(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Local-only evidence: never use this object as an HTTP response or support export. */
export function outboxLocalError(error: unknown, depth = 0): unknown {
  if (depth >= 6) return { message: 'cause depth exceeded' };
  if (!(error instanceof Error)) return { message: String(error) };
  const code = (error as NodeJS.ErrnoException).code;
  return {
    type: error.name,
    name: error.name,
    message: error.message,
    stack: error.stack,
    ...(code === undefined ? {} : { code }),
    ...(error.cause === undefined ? {} : { cause: outboxLocalError(error.cause, depth + 1) }),
    ...(error instanceof AggregateError
      ? {
          errors: error.errors
            .slice(0, 4)
            .map((item: unknown) => outboxLocalError(item, depth + 1)),
        }
      : {}),
  };
}

export class ReliableOutbox {
  private records: readonly ReliableOutboxRecord[] = [];
  private archivedSources: readonly ArchivedSource[] = [];
  private revokedSources: readonly RevokedSource[] = [];
  private legacyRecords: readonly ReliableOutboxRecord[] = [];
  private damagedArchiveScopes = new Set<string>();
  private boundaryIntents: readonly BoundaryIntent[] = [];
  private boundaryGap: true | undefined;
  private boundaryGaps: readonly BoundaryScope[] = [];
  private boundaryOverflowOwners: readonly string[] = [];
  private boundaryCaptureFailed = false;
  private readonly queue = new SerialCommitQueue();
  private readonly unconfirmedWrites = new Set<string>();
  private durabilityContext: string | undefined;
  private readonly continuityFailures = new Map<string, number>();
  private successfulDurableWrites = 0;
  private pendingReplay: Promise<void> | undefined;
  private readonly pendingEnqueues = new Map<
    string,
    { event: ReliableEventV1; retry: () => Promise<boolean> }
  >();

  private noteUnconfirmedWrite(key: string): void {
    if (
      this.unconfirmedWrites.has(key) ||
      this.unconfirmedWrites.size < RELIABLE_OUTBOX_MAX_RECORDS
    )
      this.unconfirmedWrites.add(key);
    else this.unconfirmedWrites.add('unconfirmed-write-overflow');
  }

  private async trackDurability<T>(key: string, write: () => Promise<T>): Promise<T> {
    const context = this.durabilityContext;
    const failureKey = context ?? key;
    try {
      const result = await write();
      this.successfulDurableWrites++;
      if (!context) this.unconfirmedWrites.delete(failureKey);
      return result;
    } catch (error) {
      this.noteUnconfirmedWrite(failureKey);
      throw error;
    }
  }

  private async durableOperation<T>(
    key: string,
    operation: () => Promise<T>,
    continuitySequence?: number,
  ): Promise<T> {
    const previous = this.durabilityContext;
    this.durabilityContext = key;
    const before = this.successfulDurableWrites;
    try {
      const result = await operation();
      const failedSequence = this.continuityFailures.get(key);
      // A duplicate/no-op or older checkpoint cannot prove the failed write won.
      if (
        result !== false &&
        this.successfulDurableWrites > before &&
        (failedSequence === undefined ||
          (continuitySequence !== undefined && continuitySequence >= failedSequence))
      ) {
        this.unconfirmedWrites.delete(key);
        this.continuityFailures.delete(key);
      }
      return result;
    } catch (error) {
      if (continuitySequence !== undefined && this.unconfirmedWrites.has(key))
        this.continuityFailures.set(
          key,
          Math.max(continuitySequence, this.continuityFailures.get(key) ?? 0),
        );
      throw error;
    } finally {
      this.durabilityContext = previous;
    }
  }

  private runDurable<T>(
    key: string,
    operation: () => Promise<T>,
    continuitySequence?: number,
  ): Promise<T> {
    return this.queue.run(() => this.durableOperation(key, operation, continuitySequence));
  }

  private persist(...args: Parameters<typeof replaceDurableJson>): Promise<boolean> {
    let identity = args[1];
    if (args[0] === this.filePath || args[0] === `${this.filePath}.last-good`) {
      const file = args[1] as OutboxFile;
      // Commit IDs and retry clocks change on a semantic retry. Preserve every
      // event, disposition and source in the identity, but not those clocks.
      identity = {
        ...file,
        commit: undefined,
        records: file.records.map((record) => ({
          ...record,
          updatedAt: undefined,
          nextAttemptAt: undefined,
        })),
        ...(file.continuity ? { continuity: { ...file.continuity, savedAt: undefined } } : {}),
      };
    }
    const key = createHash('sha256').update(args[0]).update(JSON.stringify(identity)).digest('hex');
    return this.trackDurability(`write:${key}`, () => replaceDurableJson(...args));
  }
  private continuity: DeliveryContinuity | undefined;
  private continuityReference: ReliableEventV1 | undefined;
  private requestedScope: string | undefined;

  private recovery: OutboxRecovery | undefined;
  private unconfirmedRecovery: true | undefined;

  constructor(
    private readonly filePath: string,
    private readonly onRecovery?: (report: OutboxRecovery | undefined, error: unknown) => void,
    private readonly onEvidence?: (record: ReliableOutboxRecord, reason: string) => void,
  ) {}

  getRecovery(): OutboxRecovery | undefined {
    return this.recovery;
  }

  private async loadRevokedSources(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(`${this.filePath}.revoked`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const bytes = await readFile(join(`${this.filePath}.revoked`, name));
        if (bytes.length > 4_000_000) throw new Error('outbox_revoked_too_large');
        const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        const identity = parseSource(value.identity);
        if (
          value.disposition !== 'revoked_unconfirmed' ||
          !Array.isArray(value.records) ||
          !Array.isArray(value.intents)
        )
          throw new Error('outbox_revoked_invalid');
        const records = value.records.map(parseRecord);
        const intents = value.intents.map(parseBoundaryIntent);
        const archive: RevokedSource = {
          disposition: 'revoked_unconfirmed',
          identity,
          records,
          intents,
        };
        const storedPayload = {
          disposition: value.disposition,
          identity: value.identity,
          records: value.records,
          intents: value.intents,
        };
        if (
          name !== archiveName(identity) ||
          value.sha256 !==
            createHash('sha256').update(JSON.stringify(storedPayload)).digest('hex') ||
          records.some(
            (record) => !record.source || sourceKey(record.source) !== sourceKey(identity),
          ) ||
          intents.some(
            (intent) => !intent.source || sourceKey(intent.source) !== sourceKey(identity),
          )
        )
          throw new Error('outbox_revoked_invalid');
        this.revokedSources = [...this.revokedSources, archive];
      } catch {
        this.damagedArchiveScopes.add(name.slice(0, 64));
      }
    }
  }

  private async loadArchives(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(`${this.filePath}.archives`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const name of names) {
      if (/^legacy-[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name)) {
        try {
          const bytes = await readFile(join(`${this.filePath}.archives`, name));
          if (bytes.length > 4_000_000) throw new Error('outbox_archive_too_large');
          const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
          const record = parseRecord(value.record);
          const scope = scopeDigest(
            record.event.competitionId,
            record.event.matchId,
            record.event.cursor.producerInstanceId,
            record.event.cursor.liveSessionId,
          );
          const key = createHash('sha256').update(record.event.idempotencyKey).digest('hex');
          if (
            name !== `legacy-${scope}-${key}.json` ||
            record.source ||
            record.awaitingSource ||
            record.status === 'pending' ||
            value.sha256 !== createHash('sha256').update(JSON.stringify(record)).digest('hex')
          )
            throw new Error('outbox_archive_invalid');
          this.legacyRecords = [...this.legacyRecords, record];
        } catch {
          this.damagedArchiveScopes.add(name.slice(7, 71));
        }
        continue;
      }
      if (!/^[a-f0-9]{64}-[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const bytes = await readFile(join(`${this.filePath}.archives`, name));
        if (bytes.length > 4_000_000) throw new Error('outbox_archive_too_large');
        const value = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
        const identity = parseSource(value.identity);
        if (!Array.isArray(value.records)) throw new Error('outbox_archive_invalid');
        const records = value.records.map(parseRecord);
        const archive = { identity, records };
        if (
          name !== archiveName(identity) ||
          value.sha256 !== archiveDigest(archive) ||
          records.some(
            (record) =>
              record.status === 'pending' ||
              !record.source ||
              sourceKey(record.source) !== sourceKey(identity),
          )
        )
          throw new Error('outbox_archive_invalid');
        this.archivedSources = [...this.archivedSources, archive];
      } catch {
        // Preserve damaged evidence and fence only the affected event scope.
        this.damagedArchiveScopes.add(name.slice(0, 64));
      }
    }
  }

  /** Preserve old terminal evidence without claiming which authority produced it. */
  private async archiveLegacyTerminals(): Promise<void> {
    const legacy = this.records.filter(
      (record) => !record.source && !record.awaitingSource && record.status !== 'pending',
    );
    if (!legacy.length) return;
    for (const record of legacy) {
      const scope = scopeDigest(
        record.event.competitionId,
        record.event.matchId,
        record.event.cursor.producerInstanceId,
        record.event.cursor.liveSessionId,
      );
      if (this.damagedArchiveScopes.has(scope)) continue;
      const prior = this.legacyRecords.find(
        (item) => item.event.idempotencyKey === record.event.idempotencyKey,
      );
      if (prior) continue;
      const key = createHash('sha256').update(record.event.idempotencyKey).digest('hex');
      try {
        await this.persist(join(`${this.filePath}.archives`, `legacy-${scope}-${key}.json`), {
          record,
          sha256: createHash('sha256').update(JSON.stringify(record)).digest('hex'),
        });
        this.legacyRecords = [...this.legacyRecords, record];
      } catch {
        // Keep this evidence active; independent scopes can still be archived.
        this.evidence(record, 'legacy_archive_failed');
      }
    }
    const remaining = this.records.filter(
      (record) =>
        !legacy.includes(record) ||
        !this.legacyRecords.some((saved) => JSON.stringify(saved) === JSON.stringify(record)),
    );
    if (remaining.length !== this.records.length) await this.commit(remaining);
  }

  private async migrateInlineArchives(archives: readonly ArchivedSource[]): Promise<void> {
    for (const archive of archives) {
      const existing = this.archivedSources.find(
        (item) => sourceKey(item.identity) === sourceKey(archive.identity),
      );
      if (existing) {
        if (archiveDigest(existing) !== archiveDigest(archive))
          throw new Error('outbox_archive_conflict');
        continue;
      }
      const scope = scopeDigest(
        archive.identity.competitionId,
        archive.identity.matchId,
        archive.identity.producerInstanceId,
        archive.identity.liveSessionId,
      );
      if (this.damagedArchiveScopes.has(scope)) throw new Error('outbox_archive_unreadable');
      await this.persist(join(`${this.filePath}.archives`, archiveName(archive.identity)), {
        ...archive,
        sha256: archiveDigest(archive),
      });
      this.archivedSources = [...this.archivedSources, archive];
    }
  }

  async load(): Promise<void> {
    await this.loadArchives();
    await this.loadRevokedSources();
    // I/O errors are not evidence of damaged contents and must stay actionable.
    let bytes: Buffer | undefined;
    try {
      bytes = await readOptional(this.filePath);
    } catch (error) {
      this.onRecovery?.(undefined, new Error('outbox_primary_read_failed', { cause: error }));
      throw Object.assign(
        new Error(
          '发送队列读取主文件失败。检查数据目录权限与磁盘空间后重试；保留原队列，不要删除。',
          { cause: error },
        ),
        { code: 'outbox_recovery_failed' },
      );
    }
    let file: OutboxFile | undefined;
    let cause: unknown;
    if (bytes !== undefined) {
      try {
        file = parseOutbox(bytes);
      } catch (error) {
        cause = error;
      }
      if (file !== undefined) {
        this.records = file.records;
        await this.migrateInlineArchives(file.archivedSources ?? []);
        this.boundaryIntents = file.boundaryIntents ?? [];
        this.boundaryGap = file.boundaryGap;
        this.boundaryGaps = file.boundaryGaps ?? [];
        this.boundaryOverflowOwners = file.boundaryOverflowOwners ?? [];
        this.continuity = file.continuity;
        this.continuityReference = file.continuityReference;
        this.unconfirmedRecovery = file.unconfirmedRecovery;
        if (file.unconfirmedRecovery) {
          this.recovery = recoveryReport(file);
          this.onRecovery?.(this.recovery, new Error('outbox_previous_recovery_unconfirmed'));
        }
        return;
      }
    }
    const mirrorPath = `${this.filePath}.last-good`;
    let recoveryPhase = '读取恢复副本';
    try {
      const mirror = await readOptional(mirrorPath);
      if (bytes === undefined && mirror === undefined) return;
      // Preserve exact bytes before replacing anything. Failure remains a startup error.
      const preserve = async (path: string, contents: Buffer): Promise<void> => {
        await this.trackDurability(`preserve:${path}`, () =>
          writeFile(`${path}.corrupt-${randomUUID()}`, contents, {
            flag: 'wx',
            mode: 0o600,
            flush: true,
          }),
        );
      };
      recoveryPhase = '另存原始文件';
      if (mirror !== undefined) await preserve(mirrorPath, mirror);
      if (bytes !== undefined) await preserve(this.filePath, bytes);
      // Never combine records from different snapshots. Even an intact mirror may
      // predate an ack or belong to an interrupted, unpublished commit.
      if (bytes !== undefined && bytes.length <= 4_000_000 && mirror !== undefined) {
        try {
          const primary = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
          const expected =
            primary.version === RELIABLE_OUTBOX_VERSION ? parseCommit(primary.commit) : undefined;
          const candidate = parseOutbox(mirror);
          if (
            expected !== undefined &&
            candidate.commit?.id === expected.id &&
            candidate.commit.sha256 === expected.sha256
          )
            file = candidate;
        } catch (error) {
          cause = new AggregateError(
            [cause, error].filter((value) => value !== undefined),
            'outbox_recovery_sources_unverified',
          );
        }
      }
      file ??= sealOutbox({
        version: RELIABLE_OUTBOX_VERSION,
        records: [],
        unconfirmedRecovery: true,
      });
      parseOutbox(Buffer.from(JSON.stringify(file)));
      recoveryPhase = '保存恢复队列';
      await this.persist(mirrorPath, file);
      await this.persist(this.filePath, file);
    } catch (error) {
      this.onRecovery?.(
        undefined,
        new AggregateError(
          [cause, error].filter((value) => value !== undefined),
          'outbox_recovery_failed',
        ),
      );
      throw Object.assign(
        new Error(
          `发送队列${recoveryPhase}失败。检查数据目录权限与磁盘空间后重试；保留原队列，不要删除。`,
          { cause: error },
        ),
        { code: 'outbox_recovery_failed' },
      );
    }
    if (file === undefined) throw new Error('outbox_recovery_missing');
    this.records = file.records;
    await this.migrateInlineArchives(file.archivedSources ?? []);
    this.boundaryIntents = file.boundaryIntents ?? [];
    this.boundaryGap = file.boundaryGap;
    this.boundaryGaps = file.boundaryGaps ?? [];
    this.boundaryOverflowOwners = file.boundaryOverflowOwners ?? [];
    this.continuity = file.continuity;
    this.continuityReference = file.continuityReference;
    this.unconfirmedRecovery = file.unconfirmedRecovery;
    this.recovery = recoveryReport(file);
    this.onRecovery?.(this.recovery, cause ?? new Error('outbox_primary_missing'));
  }

  getRecords(): readonly ReliableOutboxRecord[] {
    const keys = new Set(this.records.map((record) => record.event.idempotencyKey));
    return [
      ...this.revokedSources
        .flatMap((archive) => archive.records)
        .filter(
          (record) =>
            record.status === 'rejected' &&
            record.event.kind === 'map_started' &&
            !keys.has(record.event.idempotencyKey),
        ),
      ...this.legacyRecords.filter(
        (record) =>
          record.status === 'rejected' &&
          record.event.kind === 'map_started' &&
          !keys.has(record.event.idempotencyKey),
      ),
      ...this.records,
    ];
  }

  getScopeDisposition(scope: ReliableDeliveryScope): ReliableScopeDisposition {
    const result = {
      pending: 0,
      accepted: 0,
      needsAttention: 0,
      rejected: 0,
      superseded: 0,
      expired: 0,
      isolated: 0,
      isolatedIntents: 0,
      records: [] as {
        kind: ReliableEventV1['kind'];
        idempotencyKey: string;
        status: ReliableDeliveryStatus;
        needsAttention: boolean;
        isolation?: 'revoked_unconfirmed';
      }[],
    };
    const seen = new Set<string>();
    for (const record of [
      ...this.records,
      ...this.legacyRecords,
      ...this.archivedSources.flatMap((item) => item.records),
    ]) {
      const c = record.event.cursor;
      if (
        record.event.matchId !== scope.matchId ||
        c.producerInstanceId !== scope.producerInstanceId ||
        c.liveSessionId !== scope.liveSessionId
      )
        continue;
      if (seen.has(record.event.idempotencyKey)) continue;
      seen.add(record.event.idempotencyKey);
      result[record.status]++;
      if (record.receiverOutcome === 'needs_attention') result.needsAttention++;
      result.records.push({
        kind: record.event.kind,
        idempotencyKey: record.event.idempotencyKey,
        status: record.status,
        needsAttention: record.receiverOutcome === 'needs_attention',
      });
    }
    for (const archive of this.revokedSources) {
      if (
        archive.identity.matchId !== scope.matchId ||
        archive.identity.producerInstanceId !== scope.producerInstanceId ||
        archive.identity.liveSessionId !== scope.liveSessionId
      )
        continue;
      result.isolatedIntents += archive.intents.length;
      for (const record of archive.records) {
        if (seen.has(record.event.idempotencyKey)) {
          // A file-first commit can leave the active copy present after a crash.
          const item = result.records.find(
            (entry) => entry.idempotencyKey === record.event.idempotencyKey,
          );
          if (item) item.isolation = 'revoked_unconfirmed';
        } else {
          seen.add(record.event.idempotencyKey);
          result[record.status]++;
          if (record.receiverOutcome === 'needs_attention') result.needsAttention++;
          result.records.push({
            kind: record.event.kind,
            idempotencyKey: record.event.idempotencyKey,
            status: record.status,
            needsAttention: record.receiverOutcome === 'needs_attention',
            isolation: 'revoked_unconfirmed',
          });
        }
        result.isolated++;
      }
    }
    return result;
  }

  getRevokedIsolationSummary() {
    return {
      disposition: 'revoked_unconfirmed' as const,
      scopes: this.revokedSources.length,
      records: this.revokedSources.reduce((count, archive) => count + archive.records.length, 0),
      pending: this.revokedSources.reduce(
        (count, archive) =>
          count + archive.records.filter((record) => record.status === 'pending').length,
        0,
      ),
      intents: this.revokedSources.reduce((count, archive) => count + archive.intents.length, 0),
    };
  }

  getActiveSources(): readonly ExactSource[] {
    const sources = new Map<string, ExactSource>();
    for (const item of [...this.records, ...this.boundaryIntents]) {
      if (item.source) sources.set(sourceKey(item.source), item.source);
    }
    return [...sources.values()];
  }

  /** Called only after the release owner has confirmed this exact authority ended. */
  async archiveConfirmedSource(input: ExactSource): Promise<void> {
    await this.retryPendingEnqueues();
    if (this.hasPendingEnqueues(input)) throw new Error('outbox_source_unsettled');
    return this.runDurable(`archive:${sourceKey(parseSource(input))}`, async () => {
      const identity = parseSource(input);
      const key = sourceKey(identity);
      if (
        this.damagedArchiveScopes.has(
          scopeDigest(
            identity.competitionId,
            identity.matchId,
            identity.producerInstanceId,
            identity.liveSessionId,
          ),
        )
      )
        throw new Error('outbox_archive_unreadable');
      // Untagged legacy pending work is ambiguous and must not be treated as delivered.
      if (
        this.records.some(
          (record) =>
            record.status === 'pending' &&
            sourceMatchesEvent(identity, record.event) &&
            (!record.source || sourceKey(record.source) === key),
        ) ||
        this.boundaryIntents.some(
          (intent) =>
            sourceMatchesEvent(identity, intent.event) &&
            (!intent.source || sourceKey(intent.source) === key),
        )
      )
        throw new Error('outbox_source_unsettled');
      const archived = this.records.filter(
        (record) => record.source && sourceKey(record.source) === key,
      );
      const remaining = this.records.filter(
        (record) => !record.source || sourceKey(record.source) !== key,
      );
      let saved = this.archivedSources.find((archive) => sourceKey(archive.identity) === key);
      if (!saved) {
        saved = { identity, records: archived };
        const document = { ...saved, sha256: archiveDigest(saved) };
        if (durableJsonByteLength(document) > 4_000_000)
          throw new Error('outbox_archive_too_large');
        // Publish immutable evidence first. If the active commit fails, the archive
        // still fences this scope; a retry removes the duplicate active records.
        await this.persist(join(`${this.filePath}.archives`, archiveName(identity)), document);
        this.archivedSources = [...this.archivedSources, saved];
      }
      if (
        archived.some(
          (record) =>
            !saved!.records.some((item) => JSON.stringify(item) === JSON.stringify(record)),
        )
      )
        throw new Error('outbox_archive_conflict');
      await this.commit(
        remaining,
        this.continuity,
        this.boundaryIntents,
        this.boundaryGap,
        this.boundaryGaps,
        this.boundaryOverflowOwners,
      );
    });
  }

  /** Preserve every exact-source item without claiming remote closure or delivery. */
  async isolateRevokedSource(input: ExactSource): Promise<void> {
    await this.retryPendingEnqueues();
    if (this.hasPendingEnqueues(input)) throw new Error('outbox_source_unsettled');
    return this.runDurable(`revoke:${sourceKey(parseSource(input))}`, async () => {
      const identity = parseSource(input);
      const key = sourceKey(identity);
      const affected = this.records.filter(
        (record) => record.source && sourceKey(record.source) === key,
      );
      const intents = this.boundaryIntents.filter(
        (intent) => intent.source && sourceKey(intent.source) === key,
      );
      if (
        this.damagedArchiveScopes.has(
          scopeDigest(
            identity.competitionId,
            identity.matchId,
            identity.producerInstanceId,
            identity.liveSessionId,
          ),
        )
      )
        throw new Error('outbox_archive_unreadable');
      let saved = this.revokedSources.find((archive) => sourceKey(archive.identity) === key);
      if (!saved) {
        saved = { disposition: 'revoked_unconfirmed', identity, records: affected, intents };
        const document = {
          ...saved,
          sha256: createHash('sha256').update(JSON.stringify(saved)).digest('hex'),
        };
        if (durableJsonByteLength(document) > 4_000_000)
          throw new Error('outbox_revoked_too_large');
        // Publish the fence and its full evidence before releasing any active slot.
        await this.persist(join(`${this.filePath}.revoked`, archiveName(identity)), document);
        this.revokedSources = [...this.revokedSources, saved];
      }
      if (
        affected.some(
          (record) =>
            !saved!.records.some((item) => JSON.stringify(item) === JSON.stringify(record)),
        ) ||
        intents.some(
          (intent) =>
            !saved!.intents.some((item) => JSON.stringify(item) === JSON.stringify(intent)),
        )
      )
        throw new Error('outbox_revoked_conflict');
      await this.commit(
        this.records.filter((record) => !record.source || sourceKey(record.source) !== key),
        this.continuity,
        this.boundaryIntents.filter((intent) => !intent.source || sourceKey(intent.source) !== key),
      );
    });
  }

  private isRevokedEvent(event: ReliableEventV1, source?: ExactSource): boolean {
    return this.revokedSources.some((archive) =>
      source
        ? sourceKey(archive.identity) === sourceKey(source)
        : sourceMatchesEvent(archive.identity, event),
    );
  }

  private assertSourceOpen(event: ReliableEventV1, source?: ExactSource): void {
    if (
      this.damagedArchiveScopes.has(
        scopeDigest(
          event.competitionId,
          event.matchId,
          event.cursor.producerInstanceId,
          event.cursor.liveSessionId,
        ),
      )
    )
      throw new Error('outbox_archive_unreadable');
    if (source && !sourceMatchesEvent(source, event)) throw new Error('outbox_source_mismatch');
    if (this.isRevokedEvent(event, source)) throw new Error('outbox_source_revoked');
    if (
      this.archivedSources.some((archive) =>
        source
          ? sourceKey(archive.identity) === sourceKey(source)
          : sourceMatchesEvent(archive.identity, event),
      )
    )
      throw new Error('outbox_source_closed');
  }

  /** Pin unsent work to the current authority before any request can be issued. */
  bindUnsentSource(input: ExactSource): Promise<void> {
    return this.runDurable(`bind:${sourceKey(parseSource(input))}`, async () => {
      const source = parseSource(input);
      const records = this.records.map((record) => {
        if (
          record.status !== 'pending' ||
          record.attempts !== 0 ||
          !record.awaitingSource ||
          !sourceMatchesEvent(source, record.event)
        )
          return record;
        this.assertSourceOpen(record.event, source);
        const { awaitingSource, ...rest } = record;
        void awaitingSource;
        return { ...rest, source };
      });
      if (records.some((record, index) => record !== this.records[index]))
        await this.commit(records);
    });
  }

  hasUnconfirmedBoundary(event: ReliableEventV1): boolean {
    if (
      [...this.pendingEnqueues.values()].some(
        (item) => isContinuityBoundary(item.event) && dependsOnBoundary(event, item.event),
      )
    )
      return true;
    return [
      ...this.records,
      ...this.legacyRecords,
      ...this.revokedSources.flatMap((archive) => archive.records),
    ].some(
      (record) =>
        (record.status !== 'accepted' || record.receiverOutcome === 'needs_attention') &&
        isContinuityBoundary(record.event) &&
        dependsOnBoundary(event, record.event),
    );
  }

  /** Refusals remain authoritative for the original execution, even if context changes. */
  startRejections(event: ReliableEventV1): readonly ReliableOutboxRecord[] {
    const c = event.cursor;
    return this.getRecords().filter((record) => {
      const previous = record.event;
      const p = previous.cursor;
      return (
        record.status === 'rejected' &&
        previous.kind === 'map_started' &&
        previous.matchId === event.matchId &&
        previous.mapName === event.mapName &&
        p.producerInstanceId === c.producerInstanceId &&
        p.liveSessionId !== null &&
        p.liveSessionId === c.liveSessionId &&
        p.programSourceGeneration === c.programSourceGeneration &&
        p.mapEpoch === c.mapEpoch
      );
    });
  }

  async setStartRecovery(
    key: string,
    from: ReliableOutboxRecord['recoveryState'],
    to: NonNullable<ReliableOutboxRecord['recoveryState']>,
    boundaryKey?: string,
  ): Promise<boolean> {
    return this.queue.run(async () => {
      const record = this.getRecords().find((item) => item.event.idempotencyKey === key);
      if (
        !record ||
        this.isRevokedEvent(record.event, record.source) ||
        record.status !== 'rejected' ||
        record.event.kind !== 'map_started' ||
        !['context_stale', 'generation_fence', 'epoch_fence'].includes(
          record.rejection?.reason ?? '',
        ) ||
        record.recoveryState !== from
      )
        return false;
      const updated = {
        ...record,
        recoveryState: to,
        ...(boundaryKey === undefined ? {} : { recoveryBoundaryKey: boundaryKey }),
        updatedAt: new Date().toISOString(),
      };
      const active = this.records.includes(record);
      if (!active && this.records.length >= RELIABLE_OUTBOX_MAX_RECORDS)
        throw new Error('reliable_outbox_full');
      await this.commit(
        active
          ? this.records.map((item) => (item === record ? updated : item))
          : [...this.records, updated],
      );
      return true;
    });
  }

  getBoundaryIntents(scope?: BoundaryScope): readonly BoundaryIntent[] {
    if (!scope) return this.boundaryIntents;
    const seen = new Set<string>();
    return [
      ...this.boundaryIntents,
      ...this.revokedSources.flatMap((archive) => archive.intents),
    ].filter((intent) => {
      if (
        !this.matchesBoundaryScope(intent.event, intent.authorityFingerprint, scope) ||
        seen.has(intent.event.idempotencyKey)
      )
        return false;
      seen.add(intent.event.idempotencyKey);
      return true;
    });
  }

  private matchesBoundaryScope(
    event: ReliableEventV1,
    authority: string | undefined,
    scope: BoundaryScope,
  ): boolean {
    return (
      (!scope.matchId || event.matchId === scope.matchId) &&
      event.cursor.producerInstanceId === scope.producerInstanceId &&
      (!scope.liveSessionId || event.cursor.liveSessionId === scope.liveSessionId) &&
      (scope.runtimeSeq === undefined || event.cursor.runtimeSeq <= scope.runtimeSeq) &&
      (scope.programSourceGeneration === undefined ||
        event.cursor.programSourceGeneration <= scope.programSourceGeneration) &&
      (scope.mapEpoch === undefined || event.cursor.mapEpoch <= scope.mapEpoch) &&
      (!authority || !scope.authorityFingerprint || authority === scope.authorityFingerprint)
    );
  }

  hasBoundaryGap(scope?: BoundaryScope): boolean {
    return (
      this.boundaryCaptureFailed ||
      this.boundaryGap === true ||
      (scope
        ? scope.ownerFingerprint
          ? this.boundaryOverflowOwners.includes(scope.ownerFingerprint)
          : this.boundaryOverflowOwners.length > 0
        : this.boundaryOverflowOwners.length > 0) ||
      (scope
        ? this.boundaryGaps.some(
            (gap) =>
              (!gap.matchId || !scope.matchId || gap.matchId === scope.matchId) &&
              gap.producerInstanceId === scope.producerInstanceId &&
              (!gap.liveSessionId ||
                !scope.liveSessionId ||
                gap.liveSessionId === scope.liveSessionId) &&
              (!gap.ownerFingerprint ||
                !scope.ownerFingerprint ||
                gap.ownerFingerprint === scope.ownerFingerprint) &&
              (gap.runtimeSeq === undefined ||
                scope.runtimeSeq === undefined ||
                gap.runtimeSeq <= scope.runtimeSeq) &&
              (gap.programSourceGeneration === undefined ||
                scope.programSourceGeneration === undefined ||
                gap.programSourceGeneration <= scope.programSourceGeneration) &&
              (gap.mapEpoch === undefined ||
                scope.mapEpoch === undefined ||
                gap.mapEpoch <= scope.mapEpoch) &&
              (!gap.authorityFingerprint ||
                !scope.authorityFingerprint ||
                gap.authorityFingerprint === scope.authorityFingerprint),
          )
        : this.boundaryGaps.length > 0)
    );
  }

  hasBoundaryOverflow(scope: BoundaryScope | undefined): boolean {
    if (!scope)
      return (
        this.boundaryOverflowOwners.length > 0 || this.boundaryGaps.some((gap) => gap.overflow)
      );
    return Boolean(
      (scope.ownerFingerprint && this.boundaryOverflowOwners.includes(scope.ownerFingerprint)) ||
      this.boundaryGaps.some(
        (gap) =>
          gap.overflow &&
          gap.producerInstanceId === scope.producerInstanceId &&
          (!gap.ownerFingerprint ||
            !scope.ownerFingerprint ||
            gap.ownerFingerprint === scope.ownerFingerprint) &&
          (!gap.matchId || !scope.matchId || gap.matchId === scope.matchId) &&
          (!gap.liveSessionId || !scope.liveSessionId || gap.liveSessionId === scope.liveSessionId),
      ),
    );
  }

  /** Capture every boundary from one runtime mutation in the same durable commit as its cursor. */
  captureBoundaries(
    events: readonly ReliableEventV1[],
    intents: readonly BoundaryIntent[],
    continuity: DeliveryContinuity | undefined,
    missing: boolean,
    now = new Date(),
    scope?: BoundaryScope,
    source?: ExactSource | null,
  ): Promise<void> {
    return this.queue.run(async () => {
      await this.archiveLegacyTerminals();
      if (source) source = parseSource(source);
      for (const event of [...events, ...intents.map((intent) => intent.event)]) {
        if (source !== null) this.assertSourceOpen(event, source);
        if (
          this.legacyRecords.some(
            (record) => record.event.idempotencyKey === event.idempotencyKey,
          ) ||
          this.revokedSources.some((archive) =>
            archive.records.some((record) => record.event.idempotencyKey === event.idempotencyKey),
          ) ||
          this.revokedSources.some((archive) =>
            archive.intents.some((intent) => intent.event.idempotencyKey === event.idempotencyKey),
          ) ||
          this.archivedSources.some((archive) =>
            archive.records.some((record) => record.event.idempotencyKey === event.idempotencyKey),
          )
        )
          throw new Error('boundary_duplicate');
      }
      try {
        if (this.boundaryCaptureFailed) throw new Error('boundary_capture_blocked');
        const at = now.toISOString();
        const added = events.map((event) =>
          parseRecord({
            event,
            ...(source ? { source } : {}),
            ...(source === null ? { awaitingSource: true } : {}),
            status: 'pending',
            attempts: 0,
            nextAttemptAt: at,
            updatedAt: at,
          }),
        );
        if (added.some((record) => !isContinuityBoundary(record.event)))
          throw new Error('boundary_capture_invalid');
        const allIntents = [
          ...this.boundaryIntents,
          ...intents.map((intent) => ({
            event: intent.event,
            planFingerprint: intent.planFingerprint,
            authorityFingerprint: intent.authorityFingerprint,
            ...(intent.expired ? { expired: true as const } : {}),
            ...(source ? { source } : {}),
            ...(source === null ? { awaitingSource: true as const } : {}),
          })),
        ];
        const overflow =
          allIntents.length > RELIABLE_OUTBOX_MAX_PENDING ||
          this.records.filter((r) => r.status === 'pending').length +
            added.length +
            allIntents.length >
            RELIABLE_OUTBOX_MAX_PENDING;
        const boundaries = intents.map((intent) => intent.event);
        const previous = this.records.map((record): ReliableOutboxRecord =>
          record.status === 'pending' &&
          !this.isRevokedEvent(record.event, record.source) &&
          ['map_ended', 'map_player_snapshot', 'series_ended'].includes(record.event.kind) &&
          boundaries.some((boundary) => dependsOnBoundary(record.event, boundary))
            ? {
                ...record,
                status: 'superseded',
                dispositionReason: 'boundary_unconfirmed_result',
                updatedAt: at,
              }
            : record,
        );
        const records = this.trim([...previous, ...(overflow ? [] : added)]);
        const gap = missing || overflow || records.length > RELIABLE_OUTBOX_MAX_RECORDS;
        // Retain the old checkpoint if the boundary cannot be recorded.
        const gaps =
          gap && scope && this.boundaryGaps.length < RELIABLE_OUTBOX_MAX_RECORDS
            ? [
                ...this.boundaryGaps,
                ...(overflow || records.length > RELIABLE_OUTBOX_MAX_RECORDS
                  ? [{ ...scope, overflow: true as const }]
                  : [scope]),
              ]
            : this.boundaryGaps;
        let overflowOwners = this.boundaryOverflowOwners;
        if (gap && scope && gaps === this.boundaryGaps) {
          if (
            !scope.ownerFingerprint ||
            (overflowOwners.length >= RELIABLE_OUTBOX_MAX_RECORDS &&
              !overflowOwners.includes(scope.ownerFingerprint))
          )
            throw new Error('boundary_gap_capacity_exhausted');
          if (!overflowOwners.includes(scope.ownerFingerprint))
            overflowOwners = [...overflowOwners, scope.ownerFingerprint];
        }
        if (gap && !scope) throw new Error('boundary_gap_scope_unavailable');
        const frozen = gap || this.hasBoundaryGap(scope);
        await this.commit(
          overflow || records.length > RELIABLE_OUTBOX_MAX_RECORDS ? this.records : records,
          frozen ? this.continuity : continuity,
          overflow ? this.boundaryIntents : allIntents,
          this.boundaryGap,
          gaps,
          overflowOwners,
        );
      } catch (error) {
        this.boundaryCaptureFailed = true;
        throw error;
      }
    });
  }

  expireBoundaryIntents(now = new Date()): Promise<void> {
    return this.queue.run(async () => {
      const intents = this.boundaryIntents.map((intent) =>
        !intent.expired &&
        !this.isRevokedEvent(intent.event, intent.source) &&
        now.getTime() - Date.parse(intent.event.observedAt) >= RELIABLE_OUTBOX_RETENTION_MS
          ? { ...intent, expired: true as const }
          : intent,
      );
      if (intents.some((intent, index) => intent !== this.boundaryIntents[index]))
        await this.commit(this.records, this.continuity, intents);
    });
  }

  materializeBoundary(
    intent: BoundaryIntent,
    event: ReliableEventV1,
    now = new Date(),
  ): Promise<boolean> {
    return this.queue.run(async () => {
      await this.archiveLegacyTerminals();
      if (
        this.boundaryCaptureFailed ||
        this.boundaryGap ||
        intent.expired ||
        this.isRevokedEvent(intent.event, intent.source) ||
        !this.boundaryIntents.includes(intent)
      )
        return false;
      if (now.getTime() - Date.parse(intent.event.observedAt) >= RELIABLE_OUTBOX_RETENTION_MS) {
        return false;
      }
      const valid = parseReliableEventV1(event);
      if (!intent.awaitingSource) this.assertSourceOpen(valid, intent.source);
      const original = intent.event;
      if (
        !isContinuityBoundary(valid) ||
        valid.kind !== original.kind ||
        JSON.stringify(valid.cursor) !== JSON.stringify(original.cursor) ||
        JSON.stringify(valid.payload) !== JSON.stringify(original.payload) ||
        JSON.stringify(valid.evidence) !== JSON.stringify(original.evidence) ||
        valid.observedAt !== original.observedAt ||
        valid.mapName !== original.mapName ||
        valid.matchId !== original.matchId ||
        valid.competitionId !== original.competitionId ||
        valid.entryAId !== original.entryAId ||
        valid.entryBId !== original.entryBId ||
        valid.mapId !== original.mapId
      )
        throw new Error('boundary_materialization_invalid');
      if (
        [
          ...this.records,
          ...this.legacyRecords,
          ...this.revokedSources.flatMap((archive) => archive.records),
          ...this.archivedSources.flatMap((archive) => archive.records),
        ].some((record) => record.event.idempotencyKey === valid.idempotencyKey) ||
        this.revokedSources.some((archive) =>
          archive.intents.some((intent) => intent.event.idempotencyKey === valid.idempotencyKey),
        )
      )
        throw new Error('boundary_duplicate');
      const at = now.toISOString();
      const next = parseRecord({
        event: valid,
        ...(intent.source ? { source: intent.source } : {}),
        ...(intent.awaitingSource ? { awaitingSource: true } : {}),
        boundaryQualification: {
          planFingerprint: intent.planFingerprint,
          authorityFingerprint: intent.authorityFingerprint,
        },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        updatedAt: at,
      });
      const ordered = [...this.records];
      const position = ordered.findIndex(
        (item) => item.status === 'pending' && dependsOnBoundary(item.event, valid),
      );
      ordered.splice(position < 0 ? ordered.length : position, 0, next);
      const records = this.trim(ordered);
      if (records.length > RELIABLE_OUTBOX_MAX_RECORDS) throw new Error('reliable_outbox_full');
      await this.commit(
        records,
        this.continuity,
        this.boundaryIntents.filter((item) => item !== intent),
      );
      return true;
    });
  }

  getContinuity(): DeliveryContinuity | undefined {
    return this.continuity;
  }

  updateContinuity(checkpoint: DeliveryContinuity, scope?: BoundaryScope): Promise<void> {
    const { cursor } = checkpoint;
    const requested = JSON.stringify([
      checkpoint.matchId,
      checkpoint.contextRevision,
      cursor.producerInstanceId,
      cursor.liveSessionId,
      cursor.programSourceGeneration,
      cursor.mapEpoch,
      scope?.authorityFingerprint,
    ]);
    const operationKey = `continuity:${createHash('sha256')
      .update(
        JSON.stringify([
          requested,
          checkpoint.mapName,
          scope && { ...scope, runtimeSeq: undefined },
        ]),
      )
      .digest('hex')}`;
    return this.runDurable(
      operationKey,
      async () => {
        if (requested === this.requestedScope && !this.unconfirmedWrites.has(operationKey)) return;
        if (
          this.records.length > 0 &&
          !this.hasBoundaryGap(scope) &&
          !this.getBoundaryIntents(scope).length
        ) {
          await this.commit(this.records, checkpoint);
          this.requestedScope = requested;
        }
      },
      cursor.runtimeSeq,
    );
  }

  async enqueue(
    event: ReliableEventV1,
    now = new Date(),
    continuity?: DeliveryContinuity,
    lineupSteam64?: readonly string[],
    recoveryKey?: string,
    scope?: BoundaryScope,
    source?: ExactSource | null,
    replaying = false,
  ): Promise<boolean> {
    event = parseReliableEventV1(event);
    const operationKey = `enqueue:${createHash('sha256')
      .update(JSON.stringify([event, lineupSteam64, recoveryKey, source]))
      .digest('hex')}`;
    const retryArgs = structuredClone([
      event,
      now,
      continuity,
      lineupSteam64,
      recoveryKey,
      scope,
      source,
    ] as const);
    if (!replaying && this.pendingEnqueues.size) await this.retryPendingEnqueues();
    return this.runDurable(operationKey, async () => {
      // Do not replace a recovery mirror with unrelated work while an original write is missing.
      if (!replaying && this.pendingEnqueues.size) {
        this.noteUnconfirmedWrite(operationKey);
        throw new Error('outbox_preceding_write_unconfirmed');
      }
      await this.archiveLegacyTerminals();
      const valid = parseReliableEventV1(event);
      if (source) source = parseSource(source);
      if (source !== null) this.assertSourceOpen(valid, source);
      if (
        [
          ...this.records,
          ...this.legacyRecords,
          ...this.revokedSources.flatMap((archive) => archive.records),
          ...this.archivedSources.flatMap((archive) => archive.records),
        ].some((record) => record.event.idempotencyKey === valid.idempotencyKey) ||
        this.revokedSources.some((archive) =>
          archive.intents.some((intent) => intent.event.idempotencyKey === valid.idempotencyKey),
        )
      ) {
        if (this.unconfirmedWrites.has(operationKey)) {
          await this.commit(this.records, this.continuity);
          return true;
        }
        return false;
      }
      if (
        this.records.filter((record) => record.status === 'pending').length +
          this.boundaryIntents.length >=
        RELIABLE_OUTBOX_MAX_PENDING
      )
        throw new Error('reliable_outbox_full');
      const at = now.toISOString();
      const unsafeResult =
        ['map_ended', 'map_player_snapshot', 'series_ended'].includes(valid.kind) &&
        (this.hasBoundaryGap(scope) ||
          this.getBoundaryIntents(scope).some((intent) => dependsOnBoundary(valid, intent.event)) ||
          [
            ...this.records,
            ...this.legacyRecords,
            ...this.revokedSources.flatMap((archive) => archive.records),
          ].some(
            (record) =>
              isContinuityBoundary(record.event) &&
              (['rejected', 'expired', 'superseded'].includes(record.status) ||
                record.receiverOutcome === 'needs_attention') &&
              dependsOnBoundary(valid, record.event),
          ));
      const next = parseRecord({
        event: valid,
        ...(source ? { source } : {}),
        ...(source === null ? { awaitingSource: true } : {}),
        ...(lineupSteam64 === undefined ? {} : { lineupSteam64 }),
        ...(unsafeResult ? { dispositionReason: 'boundary_unconfirmed_result' } : {}),
        status: unsafeResult ? 'superseded' : 'pending',
        attempts: 0,
        nextAttemptAt: at,
        updatedAt: at,
      });
      let existing = this.records;
      if (recoveryKey !== undefined) {
        const rejected = this.startRejections(valid);
        if (
          valid.kind !== 'map_started' ||
          rejected.length !== 1 ||
          rejected[0] === undefined ||
          this.isRevokedEvent(rejected[0].event, rejected[0].source) ||
          rejected[0]?.event.idempotencyKey !== recoveryKey ||
          rejected[0].recoveryState !== 'awaiting_observation'
        )
          throw new Error('recovery_scope_invalid');
        const proofQueued = {
          ...rejected[0],
          recoveryState: 'proof_queued' as const,
          updatedAt: at,
        };
        existing = this.records.includes(rejected[0])
          ? this.records.map((item) => (item === rejected[0] ? proofQueued : item))
          : [...this.records, proofQueued];
      }
      const records = this.trim([...existing, next]);
      if (records.length > RELIABLE_OUTBOX_MAX_RECORDS) throw new Error('reliable_outbox_full');
      await this.commit(
        records,
        this.hasBoundaryGap(scope) || this.getBoundaryIntents(scope).length
          ? this.continuity
          : (continuity ?? {
              matchId: valid.matchId,
              contextRevision: valid.contextRevision,
              cursor: valid.cursor,
              mapName: valid.mapName,
              savedAt: at,
            }),
      );
      return true;
    }).then(
      (result) => {
        this.pendingEnqueues.delete(operationKey);
        return result;
      },
      (error: unknown) => {
        if (this.unconfirmedWrites.has(operationKey))
          this.pendingEnqueues.set(operationKey, {
            event: retryArgs[0],
            retry: () => this.enqueue(...retryArgs, true),
          });
        throw error;
      },
    );
  }

  hasPendingEnqueues(scope: ReliableDeliveryScope): boolean {
    return [...this.pendingEnqueues.values()].some(
      ({ event }) =>
        event.matchId === scope.matchId &&
        event.cursor.producerInstanceId === scope.producerInstanceId &&
        event.cursor.liveSessionId === scope.liveSessionId,
    );
  }

  hasPendingEnqueue(idempotencyKey: string): boolean {
    return [...this.pendingEnqueues.values()].some(
      (item) => item.event.idempotencyKey === idempotencyKey,
    );
  }

  async retryPendingEnqueues(): Promise<void> {
    if (this.pendingReplay) return this.pendingReplay;
    const replay = (async () => {
      for (const pending of [...this.pendingEnqueues.values()]) {
        try {
          await pending.retry();
        } catch {
          break;
        } // Keep every original request; retry storage later, not a newer replacement.
      }
    })();
    this.pendingReplay = replay;
    try {
      await replay;
    } finally {
      if (this.pendingReplay === replay) this.pendingReplay = undefined;
    }
  }

  async flush(input: {
    readonly sink: ReliableEventSink;
    readonly isCurrent: (event: ReliableEventV1, lineupSteam64?: readonly string[]) => boolean;
    readonly canSend?: (event: ReliableEventV1, lineupSteam64?: readonly string[]) => boolean;
    readonly now?: Date;
  }): Promise<readonly string[]> {
    return this.queue.run(async () => {
      if (this.boundaryCaptureFailed) throw new Error('boundary_capture_blocked');
      const now = input.now ?? new Date();
      let changed = false;
      const invalidatedStarts: string[] = [];
      const unconfirmedBoundaries = [
        ...this.records,
        ...this.legacyRecords,
        ...this.revokedSources.flatMap((archive) => archive.records),
      ].filter(
        (record) =>
          isContinuityBoundary(record.event) &&
          (record.status !== 'accepted' || record.receiverOutcome === 'needs_attention'),
      );
      const rejectedStarts = this.getRecords()
        .filter((record) => record.status === 'rejected' && record.event.kind === 'map_started')
        .map((record) => record.event);
      const next: ReliableOutboxRecord[] = [];
      const blockedByMapEnd = new Set<string>();
      const deliveryScope = (event: ReliableEventV1) =>
        JSON.stringify([
          event.matchId,
          event.cursor.producerInstanceId,
          event.cursor.liveSessionId,
        ]);
      // Terminal failures remain fences: a later event cannot turn a rejected or
      // expired continuity transition into an implicit acknowledgement.
      const blockedBoundaries = [
        ...this.records,
        ...this.legacyRecords,
        ...this.revokedSources.flatMap((archive) => archive.records),
      ]
        .filter(
          (record) =>
            isContinuityBoundary(record.event) &&
            (['rejected', 'expired', 'superseded'].includes(record.status) ||
              record.receiverOutcome === 'needs_attention'),
        )
        .map((record) => record.event);
      blockedBoundaries.push(
        ...this.revokedSources
          .flatMap((archive) => archive.records)
          .filter((record) => record.status === 'pending' && isContinuityBoundary(record.event))
          .map((record) => record.event),
      );
      for (const record of this.records) {
        if (record.status !== 'pending') {
          next.push(record);
          continue;
        }
        if (this.isRevokedEvent(record.event, record.source)) {
          if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
          next.push(record);
          continue;
        }
        if (
          this.damagedArchiveScopes.has(
            scopeDigest(
              record.event.competitionId,
              record.event.matchId,
              record.event.cursor.producerInstanceId,
              record.event.cursor.liveSessionId,
            ),
          )
        ) {
          if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
          next.push(record);
          continue;
        }
        // A refused start never authorizes replay of a result that was already
        // queued for that execution. Preserve the refusal and retire the result.
        if (
          ['map_ended', 'map_player_snapshot', 'series_ended'].includes(record.event.kind) &&
          rejectedStarts.some((start) => {
            const a = record.event.cursor;
            const b = start.cursor;
            return (
              record.event.matchId === start.matchId &&
              a.producerInstanceId === b.producerInstanceId &&
              a.liveSessionId !== null &&
              a.liveSessionId === b.liveSessionId &&
              a.programSourceGeneration === b.programSourceGeneration &&
              a.mapEpoch === b.mapEpoch &&
              a.runtimeSeq >= b.runtimeSeq &&
              ![
                ...next,
                ...this.records,
                ...this.legacyRecords,
                ...this.revokedSources.flatMap((archive) => archive.records),
              ].some((proof) => {
                const c = proof.event.cursor;
                return (
                  proof.status === 'accepted' &&
                  proof.receiverOutcome !== 'needs_attention' &&
                  proof.event.kind === 'map_started' &&
                  proof.event.matchId === start.matchId &&
                  c.producerInstanceId === b.producerInstanceId &&
                  c.liveSessionId === b.liveSessionId &&
                  c.programSourceGeneration === b.programSourceGeneration &&
                  c.mapEpoch === b.mapEpoch &&
                  c.runtimeSeq > b.runtimeSeq &&
                  c.runtimeSeq < a.runtimeSeq
                );
              })
            );
          })
        ) {
          next.push({ ...record, status: 'superseded', updatedAt: now.toISOString() });
          changed = true;
          continue;
        }
        // A start observed before a boundary ACK is not a post-ACK proof,
        // including starts left in a queue written by an older version.
        if (
          record.event.kind === 'map_started' &&
          unconfirmedBoundaries.some((boundary) => dependsOnBoundary(record.event, boundary.event))
        ) {
          invalidatedStarts.push(record.event.idempotencyKey);
          next.push({ ...record, status: 'superseded', updatedAt: now.toISOString() });
          changed = true;
          continue;
        }
        if (
          blockedByMapEnd.has(deliveryScope(record.event)) ||
          blockedBoundaries.some((boundary) => dependsOnBoundary(record.event, boundary))
        ) {
          if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
          next.push(record);
          continue;
        }
        const expired =
          now.getTime() - Date.parse(record.event.observedAt) >= RELIABLE_OUTBOX_RETENTION_MS;
        if (expired || !input.isCurrent(record.event, record.lineupSteam64)) {
          if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
          next.push({
            ...record,
            status: expired ? 'expired' : 'superseded',
            updatedAt: now.toISOString(),
          });
          changed = true;
          continue;
        }
        if (record.event.kind === 'map_player_snapshot') {
          const mapEndedKey = record.event.payload.mapEndedKey;
          const parent = [
            ...next,
            ...this.records,
            ...this.legacyRecords,
            ...this.revokedSources.flatMap((archive) => archive.records),
          ].find((r) => r.event.idempotencyKey === mapEndedKey);
          if (!parent || ['rejected', 'expired', 'superseded'].includes(parent.status)) {
            next.push({ ...record, status: 'superseded', updatedAt: now.toISOString() });
            changed = true;
            continue;
          }
          if (parent.status !== 'accepted') {
            next.push(record);
            continue;
          }
        }
        if (input.canSend !== undefined && !input.canSend(record.event, record.lineupSteam64)) {
          this.evidence(record, 'send_guard_blocked');
          if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
          else if (['map_ended', 'map_started'].includes(record.event.kind))
            blockedByMapEnd.add(deliveryScope(record.event));
          next.push(record);
          continue;
        }
        if (Date.parse(record.nextAttemptAt) > now.getTime()) {
          if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
          else if (['map_ended', 'map_started'].includes(record.event.kind))
            blockedByMapEnd.add(deliveryScope(record.event));
          next.push(record);
          continue;
        }
        let outcome: ReliableDeliveryResult;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        try {
          outcome = await Promise.race([
            input.sink.send(record.event, controller.signal, record.lineupSteam64, record.source),
            new Promise<'retry'>((resolve) => {
              timeout = setTimeout(() => {
                controller.abort(new DOMException('Reliable delivery timed out', 'TimeoutError'));
                resolve('retry');
              }, RELIABLE_SEND_TIMEOUT_MS);
              timeout.unref();
            }),
          ]);
        } catch {
          outcome = 'retry';
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
        const accepted =
          outcome === 'accepted' || (typeof outcome === 'object' && outcome.status === 'accepted');
        if (
          (!accepted || (typeof outcome === 'object' && outcome.status === 'accepted')) &&
          isContinuityBoundary(record.event)
        )
          blockedBoundaries.push(record.event);
        else if (
          (outcome === 'retry' ||
            (typeof outcome === 'object' &&
              outcome.status === 'rejected' &&
              ['generation_fence', 'epoch_fence'].includes(outcome.reason))) &&
          ['map_ended', 'map_started'].includes(record.event.kind)
        )
          blockedByMapEnd.add(deliveryScope(record.event));
        if (!accepted && outcome !== 'retry' && record.event.kind === 'map_started')
          rejectedStarts.push(record.event);
        const attempts = record.attempts + 1;
        const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6));
        next.push({
          ...record,
          status: outcome === 'retry' ? 'pending' : accepted ? 'accepted' : 'rejected',
          ...(typeof outcome === 'object' && outcome.status === 'rejected'
            ? { rejection: outcome }
            : {}),
          ...(typeof outcome === 'object' && outcome.status === 'accepted'
            ? { receiverOutcome: outcome.outcome }
            : {}),
          attempts,
          nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
          updatedAt: now.toISOString(),
        });
        changed = true;
      }
      if (changed) {
        const changedRecords = next.filter((record, index) => record !== this.records[index]);
        await this.commitStatusChanges(changedRecords, this.trim(next));
      }
      return invalidatedStarts;
    });
  }

  private deliveryIdentity(record: ReliableOutboxRecord): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          ...record,
          status: undefined,
          attempts: undefined,
          updatedAt: undefined,
          nextAttemptAt: undefined,
          receiverOutcome: undefined,
          rejection: undefined,
        }),
      )
      .digest('hex');
  }

  private statusWriteKey(record: ReliableOutboxRecord): string {
    if (
      record.status === 'pending' &&
      record.attempts > 0 &&
      record.receiverOutcome === undefined &&
      record.rejection === undefined
    )
      return `pending-retry:${this.deliveryIdentity(record)}:${record.attempts}`;
    return `status:${createHash('sha256')
      .update(JSON.stringify({ ...record, updatedAt: undefined, nextAttemptAt: undefined }))
      .digest('hex')}`;
  }

  private acknowledgeStatusWrite(record: ReliableOutboxRecord): void {
    this.unconfirmedWrites.delete(this.statusWriteKey(record));
    if (record.status !== 'accepted' && record.status !== 'rejected') return;
    const prefix = `pending-retry:${this.deliveryIdentity(record)}:`;
    for (const key of this.unconfirmedWrites) {
      if (key.startsWith(prefix) && Number(key.slice(prefix.length)) <= record.attempts)
        this.unconfirmedWrites.delete(key);
    }
  }

  private async commitStatusChanges(
    changed: readonly ReliableOutboxRecord[],
    records: readonly ReliableOutboxRecord[],
  ): Promise<void> {
    const batch = `status-batch:${randomUUID()}`;
    const previous = this.durabilityContext;
    this.durabilityContext = batch;
    try {
      await this.commit(records);
      for (const record of changed) {
        if (records.includes(record)) this.acknowledgeStatusWrite(record);
      }
    } catch (error) {
      if (this.unconfirmedWrites.delete(batch))
        for (const record of changed) this.noteUnconfirmedWrite(this.statusWriteKey(record));
      throw error;
    } finally {
      this.durabilityContext = previous;
    }
  }

  async sweep(
    isCurrent: (event: ReliableEventV1, lineupSteam64?: readonly string[]) => boolean,
    now = new Date(),
  ): Promise<void> {
    return this.queue.run(async () => {
      const next = this.records.map((record): ReliableOutboxRecord => {
        if (record.status !== 'pending' || this.isRevokedEvent(record.event, record.source))
          return record;
        const expired =
          now.getTime() - Date.parse(record.event.observedAt) >= RELIABLE_OUTBOX_RETENTION_MS;
        if (!expired && isCurrent(record.event, record.lineupSteam64)) return record;
        return {
          ...record,
          status: expired ? 'expired' : 'superseded',
          updatedAt: now.toISOString(),
        };
      });
      const changed = next.filter((record, index) => record !== this.records[index]);
      if (changed.length) await this.commitStatusChanges(changed, this.trim(next));
    });
  }

  supersedeWhere(selected: (event: ReliableEventV1) => boolean, now = new Date()): Promise<void> {
    return this.queue.run(async () => {
      const records = this.records.map((record) =>
        record.status === 'pending' &&
        !this.isRevokedEvent(record.event, record.source) &&
        selected(record.event)
          ? { ...record, status: 'superseded' as const, updatedAt: now.toISOString() }
          : record,
      );
      const changed = records.filter((record, index) => record !== this.records[index]);
      if (changed.length) await this.commitStatusChanges(changed, records);
    });
  }

  async flushPending(): Promise<void> {
    await this.queue.flush();
  }

  async flushForShutdown(): Promise<void> {
    await this.queue.flush();
    await this.retryPendingEnqueues();
    if (this.unconfirmedWrites.size || this.boundaryCaptureFailed || this.pendingEnqueues.size)
      throw new Error('outbox_durable_write_unconfirmed');
  }

  private trim(records: readonly ReliableOutboxRecord[]): readonly ReliableOutboxRecord[] {
    const pending = records.filter((record) => record.status === 'pending');
    // A failed boundary is a durable fence, even after ordinary receipt history
    // rotates. At capacity, reject new work rather than forget the missing ACK.
    const fences = records.filter(
      (record) =>
        (isContinuityBoundary(record.event) &&
          (['rejected', 'expired', 'superseded'].includes(record.status) ||
            record.receiverOutcome === 'needs_attention')) ||
        (record.event.kind === 'map_started' && record.status === 'rejected'),
    );
    const terminal = records.filter(
      (record) => record.status !== 'pending' && !fences.includes(record),
    );
    const room = Math.max(
      0,
      Math.min(64, RELIABLE_OUTBOX_MAX_RECORDS - pending.length - fences.length),
    );
    return [...fences, ...(room === 0 ? [] : terminal.slice(-room)), ...pending];
  }

  private async commit(
    records: readonly ReliableOutboxRecord[],
    continuity = this.continuity,
    boundaryIntents = this.boundaryIntents,
    boundaryGap = this.boundaryGap,
    boundaryGaps = this.boundaryGaps,
    boundaryOverflowOwners = this.boundaryOverflowOwners,
  ): Promise<void> {
    if (this.boundaryCaptureFailed) throw new Error('boundary_capture_blocked');
    const continuityReference =
      records.at(-1)?.event ??
      boundaryIntents.at(-1)?.event ??
      this.continuityReference ??
      this.archivedSources.flatMap((archive) => archive.records).at(-1)?.event ??
      this.revokedSources.flatMap((archive) => [...archive.records, ...archive.intents]).at(-1)
        ?.event ??
      this.legacyRecords.at(-1)?.event;
    const file: OutboxFile = sealOutbox({
      version: RELIABLE_OUTBOX_VERSION,
      records,
      ...(boundaryIntents.length ? { boundaryIntents } : {}),
      ...(boundaryGap ? { boundaryGap } : {}),
      ...(boundaryGaps.length ? { boundaryGaps } : {}),
      ...(boundaryOverflowOwners.length ? { boundaryOverflowOwners } : {}),
      ...(continuity === undefined ? {} : { continuity }),
      ...(continuity === undefined || continuityReference === undefined
        ? {}
        : { continuityReference }),
      ...(this.unconfirmedRecovery ? { unconfirmedRecovery: true } : {}),
    });
    // Persist a validated recovery copy before publishing the authoritative file.
    // A failed commit never advances the in-memory queue or reports success.
    if (durableJsonByteLength(file) > 4_000_000) {
      this.noteUnconfirmedWrite(this.durabilityContext ?? 'outbox_too_large');
      throw new Error('outbox_too_large');
    }
    await this.persist(`${this.filePath}.last-good`, file);
    await this.persist(this.filePath, file);
    const previous = this.records;
    this.records = records;
    this.boundaryIntents = boundaryIntents;
    this.boundaryGap = boundaryGap;
    this.boundaryGaps = boundaryGaps;
    this.boundaryOverflowOwners = boundaryOverflowOwners;
    this.continuity = continuity;
    this.continuityReference = continuityReference;
    for (const record of records) {
      if (previous.includes(record)) continue;
      this.evidence(
        record,
        {
          accepted: 'receiver_accepted',
          rejected: 'delivery_rejected_unknown',
          expired: 'retention_expired',
          superseded: record.dispositionReason ?? 'current_scope_failed',
          pending: record.attempts === 0 ? 'queued' : 'retry_unknown',
        }[record.status],
      );
    }
  }

  private evidence(record: ReliableOutboxRecord, reason: string): void {
    // Optional diagnostics cannot fail a durable queue commit or affect delivery.
    try {
      this.onEvidence?.(record, reason);
    } catch {
      /* Keep the queue authoritative. */
    }
  }
}
