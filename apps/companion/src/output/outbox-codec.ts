import { createHash, randomUUID } from 'node:crypto';

import { parseReliableEventV1, type ReliableEventV1 } from '@mizar/protocol/output';

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

export function isContinuityBoundary(event: ReliableEventV1): boolean {
  return event.kind === 'source_generation_changed' || event.kind === 'map_epoch_changed';
}

export function dependsOnBoundary(event: ReliableEventV1, boundary: ReliableEventV1): boolean {
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
export function payloadDigest(value: Record<string, unknown> | OutboxFile): string {
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

export function sealOutbox(file: OutboxFile): OutboxFile {
  return { ...file, commit: { id: randomUUID(), sha256: payloadDigest(file) } };
}

export function recoveryReport(file: OutboxFile): OutboxRecovery {
  return {
    code: file.unconfirmedRecovery ? 'outbox_preserved_without_records' : 'outbox_recovered',
    recoveredRecords: file.unconfirmedRecovery ? 0 : file.records.length,
    message: file.unconfirmedRecovery
      ? '发送队列异常，原文件与已有恢复副本已另存隔离，无法确认完整提交与回执，旧事件暂停发送。Mizar 可继续使用；旧事件未确认送达，请核对接收端结果，在运行诊断导出诊断包反馈。'
      : `发送队列读取异常，已从同一提交的完整恢复副本恢复 ${file.records.length} 条记录（含已确认记录）；原文件已另存。发送仍需通过原有身份与时效检查。可在运行诊断导出诊断包反馈。`,
  };
}

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
