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

export type ReliableDeliveryResult = 'accepted' | 'rejected' | 'retry';
export type ReliableDeliveryStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'superseded';

export interface ReliableEventSink {
  send(event: ReliableEventV1, signal?: AbortSignal): Promise<ReliableDeliveryResult>;
}

export interface ReliableOutboxRecord {
  readonly event: ReliableEventV1;
  readonly status: ReliableDeliveryStatus;
  readonly attempts: number;
  readonly nextAttemptAt: string;
  readonly updatedAt: string;
}

export interface DeliveryContinuity {
  readonly matchId: string;
  readonly contextRevision: string;
  readonly cursor: ReliableEventV1['cursor'];
  readonly mapName: string | null;
  readonly savedAt: string;
}

interface OutboxFile {
  readonly version: typeof RELIABLE_OUTBOX_VERSION;
  readonly records: readonly ReliableOutboxRecord[];
  readonly continuity?: DeliveryContinuity;
  readonly commit?: { readonly id: string; readonly sha256: string };
  readonly unconfirmedRecovery?: true;
}

function parseRecord(input: unknown): ReliableOutboxRecord {
  if (typeof input !== 'object' || input === null || Array.isArray(input))
    throw new Error('outbox_record_invalid');
  const item = input as Record<string, unknown>;
  if (
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
  return {
    event: parseReliableEventV1(item.event),
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
    (value.unconfirmedRecovery !== undefined && value.unconfirmedRecovery !== true)
  )
    throw new Error('outbox_invalid');
  if (
    value.version === 'mizar.reliable-outbox.v1' &&
    (value.commit !== undefined || value.unconfirmedRecovery !== undefined)
  )
    throw new Error('outbox_legacy_metadata_invalid');
  const commit = value.version === RELIABLE_OUTBOX_VERSION ? parseCommit(value.commit) : undefined;
  if (commit !== undefined && commit.sha256 !== payloadDigest(value))
    throw new Error('outbox_checksum_mismatch');
  const records = value.records.map(parseRecord);
  let continuity: DeliveryContinuity | undefined;
  if (value.continuity !== undefined) {
    const checkpoint = value.continuity as DeliveryContinuity;
    if (
      checkpoint === null ||
      typeof checkpoint !== 'object' ||
      Object.keys(checkpoint).sort().join(',') !== 'contextRevision,cursor,mapName,matchId,savedAt'
    )
      throw new Error('outbox_continuity_invalid');
    const reference = records.at(-1)?.event;
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
  private readonly queue = new SerialCommitQueue();
  private continuity: DeliveryContinuity | undefined;
  private requestedScope: string | undefined;

  private recovery: OutboxRecovery | undefined;
  private unconfirmedRecovery: true | undefined;

  constructor(
    private readonly filePath: string,
    private readonly onRecovery?: (report: OutboxRecovery | undefined, error: unknown) => void,
  ) {}

  getRecovery(): OutboxRecovery | undefined {
    return this.recovery;
  }

  async load(): Promise<void> {
    // I/O errors are not evidence of damaged contents and must stay actionable.
    const bytes = await readOptional(this.filePath);
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
    this.continuity = file.continuity;
    this.unconfirmedRecovery = file.unconfirmedRecovery;
    this.recovery = recoveryReport(file);
    this.onRecovery?.(this.recovery, cause ?? new Error('outbox_primary_missing'));
  }

  getRecords(): readonly ReliableOutboxRecord[] {
    return this.records;
  }

  getContinuity(): DeliveryContinuity | undefined {
    return this.continuity;
  }

  updateContinuity(checkpoint: DeliveryContinuity): Promise<void> {
    const { cursor } = checkpoint;
    const scope = JSON.stringify([
      checkpoint.matchId,
      checkpoint.contextRevision,
      cursor.liveSessionId,
      cursor.programSourceGeneration,
      cursor.mapEpoch,
    ]);
    if (scope === this.requestedScope) return Promise.resolve();
    this.requestedScope = scope;
    return this.queue.run(async () => {
      if (this.records.length > 0) await this.commit(this.records, checkpoint);
    });
  }

  async enqueue(
    event: ReliableEventV1,
    now = new Date(),
    continuity?: DeliveryContinuity,
  ): Promise<boolean> {
    return this.queue.run(async () => {
      const valid = parseReliableEventV1(event);
      if (this.records.some((record) => record.event.idempotencyKey === valid.idempotencyKey))
        return false;
      if (
        this.records.filter((record) => record.status === 'pending').length >=
        RELIABLE_OUTBOX_MAX_PENDING
      )
        throw new Error('reliable_outbox_full');
      const at = now.toISOString();
      const next: ReliableOutboxRecord = {
        event: valid,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        updatedAt: at,
      };
      await this.commit(
        this.trim([...this.records, next]),
        continuity ?? {
          matchId: valid.matchId,
          contextRevision: valid.contextRevision,
          cursor: valid.cursor,
          mapName: valid.mapName,
          savedAt: at,
        },
      );
      return true;
    });
  }

  async flush(input: {
    readonly sink: ReliableEventSink;
    readonly isCurrent: (event: ReliableEventV1) => boolean;
    readonly canSend?: (event: ReliableEventV1) => boolean;
    readonly now?: Date;
  }): Promise<void> {
    return this.queue.run(async () => {
      const now = input.now ?? new Date();
      let changed = false;
      const next: ReliableOutboxRecord[] = [];
      for (const record of this.records) {
        if (record.status !== 'pending') {
          next.push(record);
          continue;
        }
        const expired =
          now.getTime() - Date.parse(record.event.observedAt) >= RELIABLE_OUTBOX_RETENTION_MS;
        if (expired || !input.isCurrent(record.event)) {
          next.push({
            ...record,
            status: expired ? 'expired' : 'superseded',
            updatedAt: now.toISOString(),
          });
          changed = true;
          continue;
        }
        if (input.canSend !== undefined && !input.canSend(record.event)) {
          next.push(record);
          continue;
        }
        if (Date.parse(record.nextAttemptAt) > now.getTime()) {
          next.push(record);
          continue;
        }
        let outcome: ReliableDeliveryResult;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        try {
          outcome = await Promise.race([
            input.sink.send(record.event, controller.signal),
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
        const attempts = record.attempts + 1;
        const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6));
        next.push({
          ...record,
          status: outcome === 'retry' ? 'pending' : outcome,
          attempts,
          nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
          updatedAt: now.toISOString(),
        });
        changed = true;
      }
      if (changed) await this.commit(this.trim(next));
    });
  }

  async sweep(isCurrent: (event: ReliableEventV1) => boolean, now = new Date()): Promise<void> {
    return this.queue.run(async () => {
      const next = this.records.map((record): ReliableOutboxRecord => {
        if (record.status !== 'pending') return record;
        const expired =
          now.getTime() - Date.parse(record.event.observedAt) >= RELIABLE_OUTBOX_RETENTION_MS;
        if (!expired && isCurrent(record.event)) return record;
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

  async flushPending(): Promise<void> {
    await this.queue.flush();
  }

  private trim(records: readonly ReliableOutboxRecord[]): readonly ReliableOutboxRecord[] {
    const pending = records.filter((record) => record.status === 'pending');
    const terminal = records.filter((record) => record.status !== 'pending').slice(-64);
    return [...terminal, ...pending].slice(-RELIABLE_OUTBOX_MAX_RECORDS);
  }

  private async commit(
    records: readonly ReliableOutboxRecord[],
    continuity = this.continuity,
  ): Promise<void> {
    const file: OutboxFile = sealOutbox({
      version: RELIABLE_OUTBOX_VERSION,
      records,
      ...(continuity === undefined ? {} : { continuity }),
      ...(this.unconfirmedRecovery ? { unconfirmedRecovery: true } : {}),
    });
    // Persist a validated recovery copy before publishing the authoritative file.
    // A failed commit never advances the in-memory queue or reports success.
    await replaceDurableJson(`${this.filePath}.last-good`, file);
    await replaceDurableJson(this.filePath, file);
    this.records = records;
    this.continuity = continuity;
  }
}
