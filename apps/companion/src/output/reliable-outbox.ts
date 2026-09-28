import { readFile } from 'node:fs/promises';

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
  send(event: ReliableEventV1): Promise<ReliableDeliveryResult>;
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
    !['pending', 'accepted', 'rejected', 'expired', 'superseded'].includes(String(item.status)) ||
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

export class ReliableOutbox {
  private records: readonly ReliableOutboxRecord[] = [];
  private readonly queue = new SerialCommitQueue();
  private continuity: DeliveryContinuity | undefined;
  private requestedScope: string | undefined;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const text = await readFile(this.filePath, 'utf8');
      if (Buffer.byteLength(text) > 4_000_000) throw new Error('outbox_too_large');
      const raw: unknown = JSON.parse(text);
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        throw new Error('outbox_invalid');
      const value = raw as Record<string, unknown>;
      if (
        value.version !== RELIABLE_OUTBOX_VERSION ||
        !Array.isArray(value.records) ||
        value.records.length > RELIABLE_OUTBOX_MAX_RECORDS
      )
        throw new Error('outbox_invalid');
      this.records = value.records.map(parseRecord);
      if (value.continuity !== undefined) {
        const checkpoint = value.continuity as DeliveryContinuity;
        if (
          checkpoint === null ||
          typeof checkpoint !== 'object' ||
          Object.keys(checkpoint).sort().join(',') !==
            'contextRevision,cursor,mapName,matchId,savedAt'
        )
          throw new Error('outbox_continuity_invalid');
        // Validate the cursor and identity through the same strict event contract.
        const reference = this.records.at(-1)?.event;
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
        this.continuity = checkpoint;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
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
        try {
          outcome = await Promise.race([
            input.sink.send(record.event),
            new Promise<'retry'>((resolve) => {
              timeout = setTimeout(() => resolve('retry'), RELIABLE_SEND_TIMEOUT_MS);
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
    await replaceDurableJson(this.filePath, file);
    this.records = records;
    this.continuity = continuity;
  }
}
