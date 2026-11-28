import { chmodSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseReliableEventV2, type ReliableEventV2 } from '@mizar/protocol/output';
import type { ReliableDeliveryStatus, ReliableOutboxRecord } from './outbox-codec.js';

interface OutboxRow {
  idempotency_key: string;
  match_id: string;
  kind: string;
  payload_json: string;
  status: ReliableDeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

function toRecord(row: OutboxRow): ReliableOutboxRecord {
  return {
    event: parseReliableEventV2(JSON.parse(row.payload_json) as unknown),
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  };
}

export class OutboxRepository {
  private constructor(private readonly db: DatabaseSync) {}

  static async open(dbPath: string): Promise<OutboxRepository> {
    await mkdir(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      chmodSync(dbPath, 0o600);
    } catch {
      // Ignore chmod failures on unsupported filesystems.
    }
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS outbox_events_v2 (
        idempotency_key TEXT PRIMARY KEY,
        match_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_v2_pending
        ON outbox_events_v2(status, next_attempt_at, created_at);
    `);
    return new OutboxRepository(db);
  }

  insert(event: ReliableEventV2, nowIso: string): boolean {
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO outbox_events_v2 (
          idempotency_key, match_id, kind, payload_json, status,
          attempts, next_attempt_at, created_at, updated_at, last_error
        ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL)`,
      )
      .run(
        event.idempotencyKey,
        event.matchId,
        event.kind,
        JSON.stringify(event),
        nowIso,
        nowIso,
        nowIso,
      );
    return Number(result.changes) > 0;
  }

  listDuePending(nowIso: string, limit = 64): ReliableOutboxRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_events_v2
         WHERE status = 'pending' AND next_attempt_at <= ?
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(nowIso, limit) as unknown as OutboxRow[];
    return rows.map(toRecord);
  }

  listRecent(limit = 100): ReliableOutboxRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM outbox_events_v2 ORDER BY created_at DESC LIMIT ?')
      .all(limit) as unknown as OutboxRow[];
    return rows.map(toRecord);
  }

  markAccepted(idempotencyKey: string, nowIso: string, warning?: string): void {
    this.db
      .prepare(
        `UPDATE outbox_events_v2
         SET status = 'accepted', attempts = attempts + 1, updated_at = ?, last_error = ?
         WHERE idempotency_key = ?`,
      )
      .run(nowIso, warning ?? null, idempotencyKey);
  }

  markRetry(
    idempotencyKey: string,
    attempts: number,
    nextAttemptAt: string,
    nowIso: string,
    error?: string,
  ): void {
    this.db
      .prepare(
        `UPDATE outbox_events_v2
         SET attempts = ?, next_attempt_at = ?, updated_at = ?, last_error = ?
         WHERE idempotency_key = ?`,
      )
      .run(attempts, nextAttemptAt, nowIso, error ?? null, idempotencyKey);
  }

  markRejected(idempotencyKey: string, nowIso: string, error: string): void {
    this.db
      .prepare(
        `UPDATE outbox_events_v2
         SET status = 'rejected', attempts = attempts + 1, updated_at = ?, last_error = ?
         WHERE idempotency_key = ?`,
      )
      .run(nowIso, error, idempotencyKey);
  }

  markExpired(idempotencyKey: string, nowIso: string): void {
    this.db
      .prepare(
        `UPDATE outbox_events_v2
         SET status = 'expired', updated_at = ?, last_error = 'expired_24h'
         WHERE idempotency_key = ?`,
      )
      .run(nowIso, idempotencyKey);
  }

  close(): void {
    this.db.close();
  }
}
