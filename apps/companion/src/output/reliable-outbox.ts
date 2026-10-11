import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

import { parseReliableEventV1, type ReliableEventV1 } from '@mizar/protocol/output';

import { replaceDurableJson } from '../match-context/durable-json.js';
import { SerialCommitQueue } from '../match-context/serial-commit.js';

export const RELIABLE_OUTBOX_VERSION = 'mizar.reliable-outbox.v1' as const;
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

interface ParsedOutbox {
  readonly file: OutboxFile;
  readonly damaged: boolean;
}

function parseOutbox(bytes: Buffer, salvage = false): ParsedOutbox {
  if (bytes.length > 4_000_000) throw new Error('outbox_too_large');
  const raw: unknown = JSON.parse(bytes.toString('utf8'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new Error('outbox_invalid');
  const value = raw as Record<string, unknown>;
  if (
    value.version !== RELIABLE_OUTBOX_VERSION ||
    !Array.isArray(value.records) ||
    value.records.length > RELIABLE_OUTBOX_MAX_RECORDS
  )
    throw new Error('outbox_invalid');
  const records: ReliableOutboxRecord[] = [];
  let damaged = false;
  for (const record of value.records) {
    try {
      records.push(parseRecord(record));
    } catch (error) {
      if (!salvage) throw error;
      damaged = true;
    }
  }
  let continuity: DeliveryContinuity | undefined;
  if (value.continuity !== undefined) {
    try {
      const checkpoint = value.continuity as DeliveryContinuity;
      if (
        checkpoint === null ||
        typeof checkpoint !== 'object' ||
        Object.keys(checkpoint).sort().join(',') !==
          'contextRevision,cursor,mapName,matchId,savedAt'
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
    } catch (error) {
      if (!salvage) throw error;
      damaged = true;
    }
  }
  return {
    file: {
      version: RELIABLE_OUTBOX_VERSION,
      records,
      ...(continuity === undefined ? {} : { continuity }),
    },
    damaged,
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
        file = parseOutbox(bytes).file;
      } catch (error) {
        cause = error;
      }
      if (file !== undefined) {
        this.records = file.records;
        this.continuity = file.continuity;
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
      if (bytes !== undefined) {
        await preserve(this.filePath, bytes);
        try {
          file = parseOutbox(bytes, true).file;
        } catch {
          /* No byte guessing. */
        }
      }
      if (file === undefined || file.records.length === 0) {
        if (mirror !== undefined) {
          try {
            file = parseOutbox(mirror).file;
          } catch (error) {
            cause = new AggregateError(
              [cause, error].filter((value) => value !== undefined),
              'outbox_recovery_sources_invalid',
            );
            try {
              file = parseOutbox(mirror, true).file;
            } catch {
              /* Preserve only. */
            }
          }
        }
      }
      file ??= { version: RELIABLE_OUTBOX_VERSION, records: [] };
      // The strict contract is checked again; partial state never escapes a failed load.
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
    this.recovery = {
      code: file.records.length > 0 ? 'outbox_recovered' : 'outbox_preserved_without_records',
      recoveredRecords: file.records.length,
      message:
        file.records.length > 0
          ? `发送队列读取异常，已从有效内容恢复 ${file.records.length} 条记录；原文件已另存。发送仍需通过原有身份与时效检查。可在运行诊断导出诊断包反馈。`
          : '发送队列损坏，原文件已另存，但未找到可恢复记录。Mizar 可继续使用；旧事件未确认送达，请核对接收端结果，在运行诊断导出诊断包反馈。',
    };
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
    const file: OutboxFile = {
      version: RELIABLE_OUTBOX_VERSION,
      records,
      ...(continuity === undefined ? {} : { continuity }),
    };
    // Persist a validated recovery copy before publishing the authoritative file.
    // A failed commit never advances the in-memory queue or reports success.
    await replaceDurableJson(`${this.filePath}.last-good`, file);
    await replaceDurableJson(this.filePath, file);
    this.records = records;
    this.continuity = continuity;
  }
}
