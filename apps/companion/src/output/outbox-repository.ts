import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { ExactSource } from '../match-context/rivalhub-source-state.js';
import {
  archiveDigest,
  archiveName,
  parseBoundaryIntent,
  parseCommit,
  parseOutbox,
  parseRecord,
  parseSource,
  scopeDigest,
  sourceKey,
  type ArchivedSource,
  type BoundaryIntent,
  type OutboxFile,
  type ReliableOutboxRecord,
  type RevokedSource,
} from './reliable-outbox.js';

type HistoryKind = 'archived' | 'revoked' | 'legacy';
type HistoryItem =
  | { readonly kind: 'record'; readonly value: ReliableOutboxRecord }
  | { readonly kind: 'intent'; readonly value: BoundaryIntent };

export interface OutboxHistory {
  readonly disposition: HistoryKind;
  readonly source?: ExactSource;
  readonly items: readonly HistoryItem[];
}

export interface OutboxCommit {
  readonly active: OutboxFile;
  readonly history?: readonly OutboxHistory[];
  readonly damagedScopes?: readonly string[];
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function itemScope(item: HistoryItem): string {
  const e = item.value.event;
  return scopeDigest(
    e.competitionId,
    e.matchId,
    e.cursor.producerInstanceId,
    e.cursor.liveSessionId,
  );
}

async function optionalFile(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function optionalDirectory(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Imports without modifying the JSON files. A corrupt primary may use only its exact mirror. */
async function readLegacy(path: string): Promise<OutboxCommit> {
  const primary = await optionalFile(path);
  const mirror = await optionalFile(`${path}.last-good`);
  let active: OutboxFile | undefined;
  if (primary) {
    try {
      active = parseOutbox(primary);
    } catch (cause) {
      if (!mirror) throw new Error('outbox_import_primary_invalid', { cause });
      try {
        const raw = JSON.parse(primary.toString('utf8')) as Record<string, unknown>;
        const expected = parseCommit(raw.commit);
        const candidate = parseOutbox(mirror);
        if (candidate.commit?.id !== expected.id || candidate.commit.sha256 !== expected.sha256)
          throw new Error('outbox_import_mirror_mismatch');
        active = candidate;
      } catch (error) {
        throw new AggregateError([cause, error], 'outbox_import_unconfirmed');
      }
    }
  } else if (mirror) {
    // A mirror alone cannot prove whether its commit was published.
    throw new Error('outbox_import_primary_missing');
  }
  active ??= { version: 'mizar.reliable-outbox.v2', records: [] };

  const history: OutboxHistory[] = [];
  const damagedScopes = new Set<string>();
  const archives = new Map<string, ArchivedSource>();
  for (const archive of active.archivedSources ?? [])
    archives.set(sourceKey(archive.identity), archive);
  for (const name of await optionalDirectory(`${path}.archives`)) {
    const legacy = /^legacy-([a-f0-9]{64})-([a-f0-9]{64})\.json$/.exec(name);
    const archived = /^([a-f0-9]{64})-[a-f0-9]{64}\.json$/.exec(name);
    if (!legacy && !archived) continue;
    const bytes = await readFile(join(`${path}.archives`, name));
    try {
      if (bytes.length > 4_000_000) throw new Error('outbox_archive_too_large');
      const raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      if (legacy) {
        const record = parseRecord(raw.record);
        const item = { kind: 'record' as const, value: record };
        if (
          itemScope(item) !== legacy[1] ||
          createHash('sha256').update(record.event.idempotencyKey).digest('hex') !== legacy[2] ||
          record.source ||
          record.awaitingSource ||
          record.status === 'pending' ||
          raw.sha256 !== hash(record)
        )
          throw new Error('outbox_archive_invalid');
        history.push({ disposition: 'legacy', items: [item] });
      } else {
        const identity = parseSource(raw.identity);
        if (!Array.isArray(raw.records)) throw new Error('outbox_archive_invalid');
        const records = raw.records.map(parseRecord);
        const archive = { identity, records };
        if (
          name !== archiveName(identity) ||
          raw.sha256 !== archiveDigest(archive) ||
          records.some(
            (record) =>
              record.status === 'pending' ||
              !record.source ||
              sourceKey(record.source) !== sourceKey(identity),
          )
        )
          throw new Error('outbox_archive_invalid');
        const old = archives.get(sourceKey(identity));
        if (old && archiveDigest(old) !== archiveDigest(archive))
          throw new Error('outbox_archive_conflict');
        archives.set(sourceKey(identity), archive);
      }
    } catch {
      damagedScopes.add((legacy?.[1] ?? archived?.[1])!);
    }
  }
  for (const archive of archives.values())
    history.push({
      disposition: 'archived',
      source: archive.identity,
      items: archive.records.map((value) => ({ kind: 'record', value })),
    });
  for (const name of await optionalDirectory(`${path}.revoked`)) {
    const match = /^([a-f0-9]{64})-[a-f0-9]{64}\.json$/.exec(name);
    if (!match) continue;
    const bytes = await readFile(join(`${path}.revoked`, name));
    try {
      if (bytes.length > 4_000_000) throw new Error('outbox_revoked_too_large');
      const raw = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
      const identity = parseSource(raw.identity);
      if (
        raw.disposition !== 'revoked_unconfirmed' ||
        !Array.isArray(raw.records) ||
        !Array.isArray(raw.intents)
      )
        throw new Error('outbox_revoked_invalid');
      const records = raw.records.map(parseRecord);
      const intents = raw.intents.map(parseBoundaryIntent);
      const payload = {
        disposition: raw.disposition,
        identity: raw.identity,
        records: raw.records,
        intents: raw.intents,
      };
      if (
        name !== archiveName(identity) ||
        raw.sha256 !== hash(payload) ||
        [...records, ...intents].some(
          (item) => !item.source || sourceKey(item.source) !== sourceKey(identity),
        )
      )
        throw new Error('outbox_revoked_invalid');
      const archive: RevokedSource = {
        disposition: 'revoked_unconfirmed',
        identity,
        records,
        intents,
      };
      history.push({
        disposition: 'revoked',
        source: archive.identity,
        items: [
          ...archive.records.map((value) => ({ kind: 'record' as const, value })),
          ...archive.intents.map((value) => ({ kind: 'intent' as const, value })),
        ],
      });
    } catch {
      damagedScopes.add(match[1]!);
    }
  }
  const { archivedSources: _archives, ...snapshot } = active;
  return { active: snapshot, history, damagedScopes: [...damagedScopes] };
}

/** Companion-only transaction owner. Opening does not publish an incomplete import. */
export class OutboxRepository {
  private constructor(private readonly db: DatabaseSync) {}

  static async open(dbPath: string, legacyPath: string): Promise<OutboxRepository> {
    await mkdir(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    try {
      chmodSync(dbPath, 0o600);
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sources (source_key TEXT NOT NULL, scope TEXT NOT NULL, disposition TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(source_key, disposition));
        CREATE INDEX IF NOT EXISTS sources_scope ON sources(scope);
        CREATE TABLE IF NOT EXISTS history (disposition TEXT NOT NULL, source_key TEXT NOT NULL, scope TEXT NOT NULL, item_key TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(disposition, source_key, item_key, kind));
        CREATE INDEX IF NOT EXISTS history_scope ON history(scope);
        CREATE INDEX IF NOT EXISTS history_key ON history(item_key);
        CREATE TABLE IF NOT EXISTS damaged_scopes (scope TEXT PRIMARY KEY);`);
      const repository = new OutboxRepository(db);
      if (!db.prepare("SELECT value FROM metadata WHERE key = 'imported'").get()) {
        const imported = await readLegacy(legacyPath);
        repository.transaction(() => {
          repository.write(imported);
          db.prepare("INSERT INTO metadata VALUES ('imported', '1')").run();
        });
      }
      return repository;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  private transaction(operation: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      operation();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  commit(value: OutboxCommit): void {
    this.transaction(() => this.write(value));
  }

  private write(value: OutboxCommit): void {
    this.db
      .prepare(
        "INSERT INTO metadata VALUES ('active', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(value.active));
    const sourceInsert = this.db.prepare(
      'INSERT INTO sources VALUES (?, ?, ?, ?) ON CONFLICT(source_key, disposition) DO UPDATE SET payload=excluded.payload',
    );
    const itemInsert = this.db.prepare('INSERT OR IGNORE INTO history VALUES (?, ?, ?, ?, ?, ?)');
    const existingItem = this.db.prepare(
      'SELECT payload FROM history WHERE disposition = ? AND source_key = ? AND item_key = ? AND kind = ?',
    );
    for (const entry of value.history ?? []) {
      if ((entry.disposition === 'legacy') !== (entry.source === undefined))
        throw new Error('outbox_history_source_invalid');
      const key = entry.source ? sourceKey(entry.source) : '';
      if (entry.source) {
        const s = entry.source;
        sourceInsert.run(
          key,
          scopeDigest(s.competitionId, s.matchId, s.producerInstanceId, s.liveSessionId),
          entry.disposition,
          JSON.stringify(s),
        );
      }
      for (const item of entry.items) {
        const parsed =
          item.kind === 'record' ? parseRecord(item.value) : parseBoundaryIntent(item.value);
        if (entry.source && (!parsed.source || sourceKey(parsed.source) !== key))
          throw new Error('outbox_history_source_mismatch');
        if (
          entry.disposition === 'archived' &&
          (item.kind !== 'record' || (parsed as ReliableOutboxRecord).status === 'pending')
        )
          throw new Error('outbox_history_disposition_invalid');
        if (
          entry.disposition === 'legacy' &&
          (item.kind !== 'record' ||
            parsed.source ||
            (parsed as ReliableOutboxRecord).status === 'pending')
        )
          throw new Error('outbox_history_disposition_invalid');
        const payload = JSON.stringify(parsed);
        const prior = existingItem.get(
          entry.disposition,
          key,
          parsed.event.idempotencyKey,
          item.kind,
        ) as { payload: string } | undefined;
        if (prior && prior.payload !== payload) throw new Error('outbox_history_conflict');
        itemInsert.run(
          entry.disposition,
          key,
          itemScope({ kind: item.kind, value: parsed } as HistoryItem),
          parsed.event.idempotencyKey,
          item.kind,
          payload,
        );
      }
    }
    const damage = this.db.prepare('INSERT OR IGNORE INTO damaged_scopes VALUES (?)');
    for (const scope of value.damagedScopes ?? []) {
      if (!/^[a-f0-9]{64}$/.test(scope)) throw new Error('outbox_scope_invalid');
      damage.run(scope);
    }
  }

  active(): OutboxFile {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = 'active'").get() as {
      value: string;
    };
    return JSON.parse(row.value) as OutboxFile;
  }

  bySource(source: ExactSource): readonly { disposition: string; kind: string; value: unknown }[] {
    return this.history('source_key', sourceKey(source));
  }
  byScope(scope: string): readonly { disposition: string; kind: string; value: unknown }[] {
    return this.history('scope', scope);
  }
  byKey(key: string): readonly { disposition: string; kind: string; value: unknown }[] {
    return this.history('item_key', key);
  }
  private history(column: 'source_key' | 'scope' | 'item_key', value: string) {
    const rows = this.db
      .prepare(`SELECT disposition, kind, payload FROM history WHERE ${column} = ?`)
      .all(value) as { disposition: string; kind: string; payload: string }[];
    return rows.map((row) => ({
      disposition: row.disposition,
      kind: row.kind,
      value: JSON.parse(row.payload) as unknown,
    }));
  }
  sourcesByScope(scope: string): readonly { source: ExactSource; disposition: string }[] {
    const rows = this.db
      .prepare('SELECT disposition, payload FROM sources WHERE scope = ?')
      .all(scope) as { disposition: string; payload: string }[];
    return rows.map((row) => ({
      disposition: row.disposition,
      source: parseSource(JSON.parse(row.payload)),
    }));
  }
  sourceDisposition(source: ExactSource): readonly string[] {
    return (
      this.db
        .prepare('SELECT disposition FROM sources WHERE source_key = ?')
        .all(sourceKey(source)) as { disposition: string }[]
    ).map((row) => row.disposition);
  }
  isDamaged(scope: string): boolean {
    return !!this.db.prepare('SELECT scope FROM damaged_scopes WHERE scope = ?').get(scope);
  }
  close(): void {
    this.db.close();
  }
}
