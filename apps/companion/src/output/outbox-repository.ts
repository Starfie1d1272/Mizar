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

function migrateLegacyMapEnded(db: DatabaseSync): void {
  try {
    const migrated = db.prepare("SELECT value FROM metadata WHERE key = 'v2_migrated'").get();
    if (migrated) return;
    const active = db.prepare("SELECT value FROM metadata WHERE key = 'active'").get() as
      { value?: string } | undefined;
    if (!active?.value) return;
    const parsed = JSON.parse(active.value) as { records?: unknown[] };
    const records = Array.isArray(parsed.records) ? parsed.records : [];
    const playersByMapEndKey = new Map<string, unknown[]>();
    for (const r of records as Record<string, unknown>[]) {
      const ev = r?.event as Record<string, unknown> | undefined;
      const p = ev?.payload as Record<string, unknown> | undefined;
      if (
        ev?.kind === 'map_player_snapshot' &&
        typeof p?.mapEndedKey === 'string' &&
        Array.isArray(p.players)
      ) {
        playersByMapEndKey.set(p.mapEndedKey, p.players);
      }
    }
    const nowIso = new Date().toISOString();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO outbox_events_v2 (
        idempotency_key, match_id, kind, payload_json, status,
        attempts, next_attempt_at, created_at, updated_at, last_error
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL)`,
    );
    for (const r of records as Record<string, unknown>[]) {
      const ev = r?.event as Record<string, unknown> | undefined;
      if (r?.status !== 'pending' || ev?.kind !== 'map_ended') continue;
      try {
        const cursor = (ev.cursor ?? {}) as Record<string, unknown>;
        const src = (r.source ?? {}) as Record<string, unknown>;
        const p = (ev.payload ?? {}) as Record<string, unknown>;
        const players = playersByMapEndKey.get(String(ev.idempotencyKey));
        const v2 = parseReliableEventV2({
          schemaVersion: 'mizar.reliable-event.v2',
          idempotencyKey: ev.idempotencyKey,
          kind: 'map_ended',
          observedAt: ev.observedAt,
          matchId: ev.matchId,
          competitionId: ev.competitionId,
          entryAId: ev.entryAId,
          entryBId: ev.entryBId,
          mapId: ev.mapId ?? null,
          mapName: ev.mapName ?? null,
          session: {
            producerInstanceId: cursor.producerInstanceId,
            liveSessionId: cursor.liveSessionId,
            authorityRevision:
              typeof src.authorityRevision === 'number' ? src.authorityRevision : 1,
          },
          payload: {
            scoreA: p.scoreA,
            scoreB: p.scoreB,
            scoreCT: p.scoreCT,
            scoreT: p.scoreT,
            lineupSteam64: Array.isArray(r.lineupSteam64) ? r.lineupSteam64 : [],
            ...(players ? { players } : {}),
          },
        });
        insert.run(
          v2.idempotencyKey,
          v2.matchId,
          v2.kind,
          JSON.stringify(v2),
          nowIso,
          nowIso,
          nowIso,
        );
      } catch {
        // Ignore malformed legacy records so startup never fails.
      }
    }
    db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('v2_migrated', '1')").run();
  } catch {
    // Ignore when legacy metadata table does not exist or is unreadable.
  }
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
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    db.prepare(
      "DELETE FROM outbox_events_v2 WHERE status IN ('accepted', 'rejected', 'expired') AND updated_at < ?",
    ).run(thirtyDaysAgo);
    migrateLegacyMapEnded(db);
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
         SET status = 'expired', updated_at = ?, last_error = 'expired'
         WHERE idempotency_key = ?`,
      )
      .run(nowIso, idempotencyKey);
  }

  close(): void {
    this.db.close();
  }
}
