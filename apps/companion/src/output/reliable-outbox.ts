import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { parseReliableEventV1, type ReliableEventV1 } from '@mizar/protocol/output';

import { replaceDurableJson } from '../match-context/durable-json.js';
import { SerialCommitQueue } from '../match-context/serial-commit.js';

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
  ): Promise<ReliableDeliveryResult>;
}

export interface ReliableOutboxRecord {
  readonly event: ReliableEventV1;
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
  readonly records: readonly {
    readonly kind: ReliableEventV1['kind'];
    readonly idempotencyKey: string;
    readonly status: ReliableDeliveryStatus;
    readonly needsAttention: boolean;
  }[];
}

export interface DeliveryContinuity {
  readonly matchId: string;
  readonly contextRevision: string;
  readonly cursor: ReliableEventV1['cursor'];
  readonly mapName: string | null;
  readonly savedAt: string;
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
  readonly planFingerprint: string;
  readonly authorityFingerprint: string;
  readonly expired?: true;
}

interface OutboxFile {
  readonly version: typeof RELIABLE_OUTBOX_VERSION;
  readonly records: readonly ReliableOutboxRecord[];
  readonly boundaryIntents?: readonly BoundaryIntent[];
  readonly boundaryGap?: true;
  readonly boundaryGaps?: readonly BoundaryScope[];
  readonly boundaryOverflowOwners?: readonly string[];
  readonly continuity?: DeliveryContinuity;
  readonly commit?: { readonly id: string; readonly sha256: string };
  readonly unconfirmedRecovery?: true;
}

function parseRecord(input: unknown): ReliableOutboxRecord {
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
  if (boundaryQualification && (!isContinuityBoundary(event) || event.evidence.contextFresh))
    throw new Error('boundary_qualification_invalid');
  if (item.lineupSteam64 !== undefined && event.kind !== 'map_started')
    throw new Error('outbox_lineup_invalid');
  return {
    event,
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
        boundaryIntents: value.boundaryIntents,
        boundaryGap: value.boundaryGap,
        boundaryGaps: value.boundaryGaps,
        boundaryOverflowOwners: value.boundaryOverflowOwners,
        continuity: value.continuity,
        unconfirmedRecovery: value.unconfirmedRecovery,
      }),
    )
    .digest('hex');
}

function parseCommit(value: unknown): NonNullable<OutboxFile['commit']> {
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

function parseOutbox(bytes: Buffer): OutboxFile {
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
    (raw): BoundaryIntent => {
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
      if (
        !isContinuityBoundary(event) ||
        event.evidence.contextFresh ||
        !event.cursor.liveSessionId
      )
        throw new Error('boundary_intent_invalid');
      return {
        event,
        planFingerprint: item.planFingerprint,
        authorityFingerprint: item.authorityFingerprint,
        ...(item.expired === true ? { expired: true as const } : {}),
      };
    },
  );

  let continuity: DeliveryContinuity | undefined;
  if (value.continuity !== undefined) {
    const checkpoint = value.continuity as DeliveryContinuity;
    if (
      checkpoint === null ||
      typeof checkpoint !== 'object' ||
      Object.keys(checkpoint).sort().join(',') !== 'contextRevision,cursor,mapName,matchId,savedAt'
    )
      throw new Error('outbox_continuity_invalid');
    const reference = records.at(-1)?.event ?? boundaryIntents?.at(-1)?.event;
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
    ...(boundaryIntents === undefined ? {} : { boundaryIntents }),
    ...(value.boundaryGap === true ? { boundaryGap: true } : {}),
    ...(boundaryGaps === undefined ? {} : { boundaryGaps }),
    ...(value.boundaryOverflowOwners === undefined
      ? {}
      : { boundaryOverflowOwners: value.boundaryOverflowOwners as string[] }),
    ...(continuity === undefined ? {} : { continuity }),
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
  private boundaryIntents: readonly BoundaryIntent[] = [];
  private boundaryGap: true | undefined;
  private boundaryGaps: readonly BoundaryScope[] = [];
  private boundaryOverflowOwners: readonly string[] = [];
  private boundaryCaptureFailed = false;
  private readonly queue = new SerialCommitQueue();
  private continuity: DeliveryContinuity | undefined;
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

  async load(): Promise<void> {
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
        this.boundaryIntents = file.boundaryIntents ?? [];
        this.boundaryGap = file.boundaryGap;
        this.boundaryGaps = file.boundaryGaps ?? [];
        this.boundaryOverflowOwners = file.boundaryOverflowOwners ?? [];
        this.continuity = file.continuity;
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
        await writeFile(`${path}.corrupt-${randomUUID()}`, contents, {
          flag: 'wx',
          mode: 0o600,
          flush: true,
        });
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
      await replaceDurableJson(mirrorPath, file);
      await replaceDurableJson(this.filePath, file);
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
    this.boundaryIntents = file.boundaryIntents ?? [];
    this.boundaryGap = file.boundaryGap;
    this.boundaryGaps = file.boundaryGaps ?? [];
    this.boundaryOverflowOwners = file.boundaryOverflowOwners ?? [];
    this.continuity = file.continuity;
    this.unconfirmedRecovery = file.unconfirmedRecovery;
    this.recovery = recoveryReport(file);
    this.onRecovery?.(this.recovery, cause ?? new Error('outbox_primary_missing'));
  }

  getRecords(): readonly ReliableOutboxRecord[] {
    return this.records;
  }

  getScopeDisposition(scope: ReliableDeliveryScope): ReliableScopeDisposition {
    const result = {
      pending: 0,
      accepted: 0,
      needsAttention: 0,
      rejected: 0,
      superseded: 0,
      expired: 0,
      records: [] as {
        kind: ReliableEventV1['kind'];
        idempotencyKey: string;
        status: ReliableDeliveryStatus;
        needsAttention: boolean;
      }[],
    };
    for (const record of this.records) {
      const c = record.event.cursor;
      if (
        record.event.matchId !== scope.matchId ||
        c.producerInstanceId !== scope.producerInstanceId ||
        c.liveSessionId !== scope.liveSessionId
      )
        continue;
      result[record.status]++;
      if (record.receiverOutcome === 'needs_attention') result.needsAttention++;
      result.records.push({
        kind: record.event.kind,
        idempotencyKey: record.event.idempotencyKey,
        status: record.status,
        needsAttention: record.receiverOutcome === 'needs_attention',
      });
    }
    return result;
  }

  hasUnconfirmedBoundary(event: ReliableEventV1): boolean {
    return this.records.some(
      (record) =>
        (record.status !== 'accepted' || record.receiverOutcome === 'needs_attention') &&
        isContinuityBoundary(record.event) &&
        dependsOnBoundary(event, record.event),
    );
  }

  /** Refusals remain authoritative for the original execution, even if context changes. */
  startRejections(event: ReliableEventV1): readonly ReliableOutboxRecord[] {
    const c = event.cursor;
    return this.records.filter((record) => {
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
      const record = this.records.find((item) => item.event.idempotencyKey === key);
      if (
        !record ||
        record.status !== 'rejected' ||
        record.event.kind !== 'map_started' ||
        !['context_stale', 'generation_fence', 'epoch_fence'].includes(
          record.rejection?.reason ?? '',
        ) ||
        record.recoveryState !== from
      )
        return false;
      await this.commit(
        this.records.map((item) =>
          item === record
            ? {
                ...item,
                recoveryState: to,
                ...(boundaryKey === undefined ? {} : { recoveryBoundaryKey: boundaryKey }),
                updatedAt: new Date().toISOString(),
              }
            : item,
        ),
      );
      return true;
    });
  }

  getBoundaryIntents(scope?: BoundaryScope): readonly BoundaryIntent[] {
    return scope
      ? this.boundaryIntents.filter((intent) =>
          this.matchesBoundaryScope(intent.event, intent.authorityFingerprint, scope),
        )
      : this.boundaryIntents;
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
  ): Promise<void> {
    return this.queue.run(async () => {
      try {
        if (this.boundaryCaptureFailed) throw new Error('boundary_capture_blocked');
        const at = now.toISOString();
        const added = events.map((event) =>
          parseRecord({ event, status: 'pending', attempts: 0, nextAttemptAt: at, updatedAt: at }),
        );
        if (added.some((record) => !isContinuityBoundary(record.event)))
          throw new Error('boundary_capture_invalid');
        const allIntents = [...this.boundaryIntents, ...intents];
        const overflow =
          allIntents.length > RELIABLE_OUTBOX_MAX_PENDING ||
          this.records.filter((r) => r.status === 'pending').length +
            added.length +
            allIntents.length >
            RELIABLE_OUTBOX_MAX_PENDING;
        const boundaries = intents.map((intent) => intent.event);
        const previous = this.records.map((record): ReliableOutboxRecord =>
          record.status === 'pending' &&
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
      if (
        this.boundaryCaptureFailed ||
        this.boundaryGap ||
        intent.expired ||
        !this.boundaryIntents.includes(intent)
      )
        return false;
      if (now.getTime() - Date.parse(intent.event.observedAt) >= RELIABLE_OUTBOX_RETENTION_MS) {
        return false;
      }
      const valid = parseReliableEventV1(event);
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
      if (this.records.some((record) => record.event.idempotencyKey === valid.idempotencyKey))
        throw new Error('boundary_duplicate');
      const at = now.toISOString();
      const next = parseRecord({
        event: valid,
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
    return this.queue.run(async () => {
      if (requested === this.requestedScope) return;
      if (
        this.records.length > 0 &&
        !this.hasBoundaryGap(scope) &&
        !this.getBoundaryIntents(scope).length
      ) {
        await this.commit(this.records, checkpoint);
        this.requestedScope = requested;
      }
    });
  }

  async enqueue(
    event: ReliableEventV1,
    now = new Date(),
    continuity?: DeliveryContinuity,
    lineupSteam64?: readonly string[],
    recoveryKey?: string,
    scope?: BoundaryScope,
  ): Promise<boolean> {
    return this.queue.run(async () => {
      const valid = parseReliableEventV1(event);
      if (this.records.some((record) => record.event.idempotencyKey === valid.idempotencyKey))
        return false;
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
          this.records.some(
            (record) =>
              isContinuityBoundary(record.event) &&
              (['rejected', 'expired', 'superseded'].includes(record.status) ||
                record.receiverOutcome === 'needs_attention') &&
              dependsOnBoundary(valid, record.event),
          ));
      const next = parseRecord({
        event: valid,
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
          rejected[0]?.event.idempotencyKey !== recoveryKey ||
          rejected[0].recoveryState !== 'awaiting_observation'
        )
          throw new Error('recovery_scope_invalid');
        existing = this.records.map((item) =>
          item === rejected[0]
            ? { ...item, recoveryState: 'proof_queued' as const, updatedAt: at }
            : item,
        );
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
    });
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
      const unconfirmedBoundaries = this.records.filter(
        (record) =>
          isContinuityBoundary(record.event) &&
          (record.status !== 'accepted' || record.receiverOutcome === 'needs_attention'),
      );
      const rejectedStarts = this.records
        .filter((record) => record.status === 'rejected' && record.event.kind === 'map_started')
        .map((record) => record.event);
      const next: ReliableOutboxRecord[] = [];
      let blockedByMapEnd = false;
      // Terminal failures remain fences: a later event cannot turn a rejected or
      // expired continuity transition into an implicit acknowledgement.
      const blockedBoundaries = this.records
        .filter(
          (record) =>
            isContinuityBoundary(record.event) &&
            (['rejected', 'expired', 'superseded'].includes(record.status) ||
              record.receiverOutcome === 'needs_attention'),
        )
        .map((record) => record.event);
      for (const record of this.records) {
        if (record.status !== 'pending') {
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
              ![...next, ...this.records].some((proof) => {
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
          blockedByMapEnd ||
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
          const parent = [...next, ...this.records].find(
            (r) => r.event.idempotencyKey === mapEndedKey,
          );
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
          else if (['map_ended', 'map_started'].includes(record.event.kind)) blockedByMapEnd = true;
          next.push(record);
          continue;
        }
        if (Date.parse(record.nextAttemptAt) > now.getTime()) {
          if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
          else if (['map_ended', 'map_started'].includes(record.event.kind)) blockedByMapEnd = true;
          next.push(record);
          continue;
        }
        let outcome: ReliableDeliveryResult;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        try {
          outcome = await Promise.race([
            record.lineupSteam64 === undefined
              ? input.sink.send(record.event, controller.signal)
              : input.sink.send(record.event, controller.signal, record.lineupSteam64),
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
          blockedByMapEnd = true;
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
      if (changed) await this.commit(this.trim(next));
      return invalidatedStarts;
    });
  }

  async sweep(
    isCurrent: (event: ReliableEventV1, lineupSteam64?: readonly string[]) => boolean,
    now = new Date(),
  ): Promise<void> {
    return this.queue.run(async () => {
      const next = this.records.map((record): ReliableOutboxRecord => {
        if (record.status !== 'pending') return record;
        const expired =
          now.getTime() - Date.parse(record.event.observedAt) >= RELIABLE_OUTBOX_RETENTION_MS;
        if (!expired && isCurrent(record.event, record.lineupSteam64)) return record;
        return {
          ...record,
          status: expired ? 'expired' : 'superseded',
          updatedAt: now.toISOString(),
        };
      });
      if (next.some((record, index) => record !== this.records[index]))
        await this.commit(this.trim(next));
    });
  }

  supersedeWhere(selected: (event: ReliableEventV1) => boolean, now = new Date()): Promise<void> {
    return this.queue.run(async () => {
      const records = this.records.map((record) =>
        record.status === 'pending' && selected(record.event)
          ? { ...record, status: 'superseded' as const, updatedAt: now.toISOString() }
          : record,
      );
      if (records.some((record, index) => record !== this.records[index]))
        await this.commit(records);
    });
  }

  async flushPending(): Promise<void> {
    await this.queue.flush();
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
    const file: OutboxFile = sealOutbox({
      version: RELIABLE_OUTBOX_VERSION,
      records,
      ...(boundaryIntents.length ? { boundaryIntents } : {}),
      ...(boundaryGap ? { boundaryGap } : {}),
      ...(boundaryGaps.length ? { boundaryGaps } : {}),
      ...(boundaryOverflowOwners.length ? { boundaryOverflowOwners } : {}),
      ...(continuity === undefined ? {} : { continuity }),
      ...(this.unconfirmedRecovery ? { unconfirmedRecovery: true } : {}),
    });
    // Persist a validated recovery copy before publishing the authoritative file.
    // A failed commit never advances the in-memory queue or reports success.
    await replaceDurableJson(`${this.filePath}.last-good`, file);
    await replaceDurableJson(this.filePath, file);
    const previous = this.records;
    this.records = records;
    this.boundaryIntents = boundaryIntents;
    this.boundaryGap = boundaryGap;
    this.boundaryGaps = boundaryGaps;
    this.boundaryOverflowOwners = boundaryOverflowOwners;
    this.continuity = continuity;
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
