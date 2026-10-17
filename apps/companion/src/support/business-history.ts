import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync } from 'node:fs';
import { open, mkdir, lstat, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import {
  businessEvidence,
  businessId,
  businessVersion,
  utc,
  version,
} from './business-evidence.js';

export const BUSINESS_HISTORY_FILE = 'business-history.json';
export const BUSINESS_HISTORY_LIMITS = {
  groups: 16,
  groupBytes: 512 * 1024,
  totalBytes: 8 * 1024 * 1024,
  stagingBytes: 8 * 1024 * 1024,
  peakDiskBytes: 16 * 1024 * 1024,
  contextBytes: 128 * 1024,
  exportBytes: 512 * 1024,
  queuedEvents: 128,
  queuedBytes: 512 * 1024,
};
const stages = [
  'business_session',
  'business_runtime',
  'business_delivery',
  'business_claim',
  'business_live',
  'business_reliable',
  'business_guard',
];
type Evidence = ReturnType<typeof businessEvidence>;
type Entry = {
  stage: string;
  recordedAt: string;
  version: string | null;
  startupSessionId: string | null;
  evidence: Evidence;
  occurrences: number;
  lastObservedAt: string | null;
  lastRecordedAt: string;
  context?: { runtime: ContextEntry | null; guard: ContextEntry | null };
};
type ContextEntry = Pick<Entry, 'recordedAt' | 'version' | 'evidence'>;
type Group = {
  matchId: string | null;
  liveSessionId: string | null;
  firstRecordedAt: string | null;
  lastRecordedAt: string | null;
  rotatedEvents: number;
  events: Entry[];
};
type Archive = {
  schema: 2;
  evictedGroups: number;
  evictedEvents: number;
  writeFailures: number;
  abandonedStagingFiles: number;
  groups: Group[];
  coalescedEvents: number;
  droppedPendingEvents: number;
};
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const count = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const bytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v, null, 2));
const empty = (): Archive => ({
  schema: 2,
  evictedGroups: 0,
  evictedEvents: 0,
  writeFailures: 0,
  abandonedStagingFiles: 0,
  groups: [],
  coalescedEvents: 0,
  droppedPendingEvents: 0,
});
const failure = (e: Entry) =>
  e.evidence.status === 'rejected' ||
  e.evidence.identity === 'mismatch' ||
  e.evidence.binding === 'needs_operator' ||
  e.evidence.blockers.length > 0 ||
  (e.evidence.reason !== null &&
    ![
      'queued',
      'restored',
      'receiver_accepted',
      'claim_accepted',
      'contiguous',
      'baseline',
      'request_started',
    ].includes(e.evidence.reason));

/** Fixed path, bounded read, no traversal or configuration/remote payload copying. */
function load(directory: string): {
  status: string;
  archive: Archive;
  corruptRecords: number;
  corruptGroups: number;
} {
  let handle: number | undefined;
  try {
    const path = join(directory, BUSINESS_HISTORY_FILE);
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('invalid_history');
    handle = openSync(
      join(directory, BUSINESS_HISTORY_FILE),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = fstatSync(handle);
    if (
      !stat.isFile() ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.size > BUSINESS_HISTORY_LIMITS.totalBytes
    )
      throw new Error('invalid_history');
    const raw = obj(JSON.parse(readFileSync(handle, 'utf8')));
    if (
      raw.schema !== 2 ||
      !Array.isArray(raw.groups) ||
      raw.groups.length > BUSINESS_HISTORY_LIMITS.groups
    )
      throw new Error('invalid_history');
    const archive = empty();
    archive.evictedGroups = count(raw.evictedGroups);
    archive.evictedEvents = count(raw.evictedEvents);
    archive.writeFailures = count(raw.writeFailures);
    archive.abandonedStagingFiles = count(raw.abandonedStagingFiles);
    archive.coalescedEvents = count(raw.coalescedEvents);
    archive.droppedPendingEvents = count(raw.droppedPendingEvents);
    let corruptRecords = 0;
    let corruptGroups = 0;
    for (const value of raw.groups) {
      const g = obj(value);
      if (!Array.isArray(g.events) || bytes(g) > BUSINESS_HISTORY_LIMITS.groupBytes) {
        corruptGroups++;
        if (Array.isArray(g.events)) corruptRecords += g.events.length;
        continue;
      }
      const events: Entry[] = g.events.flatMap((value) => {
        const e = obj(value);
        if (!stages.includes(String(e.stage)) || !utc(e.recordedAt)) {
          corruptRecords++;
          return [];
        }
        return [
          {
            stage: String(e.stage),
            recordedAt: utc(e.recordedAt)!,
            version: version(e.version),
            startupSessionId: businessId(e.startupSessionId),
            evidence: businessEvidence(e.evidence),
            occurrences: Math.max(1, count(e.occurrences)),
            lastObservedAt: utc(e.lastObservedAt),
            lastRecordedAt: utc(e.lastRecordedAt) ?? utc(e.recordedAt)!,
            ...(e.context === undefined
              ? {}
              : {
                  context: {
                    runtime: projectContext(obj(e.context).runtime),
                    guard: projectContext(obj(e.context).guard),
                  },
                }),
          },
        ];
      });
      archive.groups.push({
        matchId: businessId(g.matchId),
        liveSessionId: businessId(g.liveSessionId),
        firstRecordedAt: utc(g.firstRecordedAt),
        lastRecordedAt: utc(g.lastRecordedAt),
        rotatedEvents: count(g.rotatedEvents),
        events,
      });
    }
    return {
      status: corruptRecords || corruptGroups ? 'partial_corrupt' : 'read',
      archive,
      corruptRecords,
      corruptGroups,
    };
  } catch (error) {
    return {
      status: obj(error).code === 'ENOENT' ? 'not_collected' : 'unreadable_or_corrupt',
      archive: empty(),
      corruptRecords: 0,
      corruptGroups: 0,
    };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

function projectContext(value: unknown): ContextEntry | null {
  const e = obj(value);
  return utc(e.recordedAt)
    ? {
        recordedAt: utc(e.recordedAt)!,
        version: version(e.version),
        evidence: businessEvidence(e.evidence),
      }
    : null;
}
const groupKey = (e: Evidence) => JSON.stringify([e.matchId, e.liveSessionId]);

export class BusinessHistory {
  private readonly session = randomUUID();
  private readonly archive: Archive;
  private failed = false;
  private readonly retained = new Set<Entry>();
  private readonly previous = new Map<string, { signature: string; entry: Entry }>();
  private readonly contexts = new Map<
    string,
    { runtime: ContextEntry | null; guard: ContextEntry | null }
  >();
  private readonly blocked: boolean;
  private pending: Entry[] = [];
  private queuedBytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> | undefined;
  private dirty = false;
  private closed = false;
  private committedFailures: number;
  private uncommittedEvents = 0;
  private committedWrites = 0;
  private uncommittedAggregates = 0;
  private readonly observed = new WeakMap<Entry, number>();
  constructor(
    private readonly directory: string,
    private readonly onFailure: () => void,
    private readonly sourceVersion = businessVersion(),
    private readonly onEvidence?: (entry: Entry) => void,
  ) {
    const loaded = load(directory);
    this.archive = loaded.archive;
    this.blocked = !['read', 'not_collected'].includes(loaded.status);
    this.committedFailures = this.archive.writeFailures;
    for (const group of this.archive.groups)
      for (const entry of group.events) this.updateContext(entry);
  }
  private updateContext(entry: Entry) {
    if (!['business_runtime', 'business_guard'].includes(entry.stage)) return;
    const key = groupKey(entry.evidence);
    const context = {
      ...(this.contexts.get(key) ?? { runtime: null, guard: null }),
      [entry.stage === 'business_runtime' ? 'runtime' : 'guard']: {
        recordedAt: entry.recordedAt,
        version: entry.version,
        evidence: entry.evidence,
      },
    };
    this.contexts.delete(key);
    this.contexts.set(key, context);
    if (this.contexts.size > BUSINESS_HISTORY_LIMITS.groups)
      this.contexts.delete(this.contexts.keys().next().value!);
  }
  private observe(entry: Entry): void {
    if (this.observed.get(entry) === entry.occurrences) return;
    try {
      this.onEvidence?.(entry);
      this.observed.set(entry, entry.occurrences);
    } catch {
      this.fail();
    }
  }
  append(stage: string, evidence: Evidence): void {
    if (this.closed) return;
    const key = JSON.stringify([stage, groupKey(evidence), evidence.idempotencyKey]);
    const at = new Date().toISOString();
    const entry: Entry = {
      stage,
      recordedAt: at,
      version: this.sourceVersion,
      startupSessionId: this.session,
      evidence,
      occurrences: 1,
      lastObservedAt: evidence.originalObservedAt,
      lastRecordedAt: at,
    };
    if (!stages.includes(stage)) {
      this.observe(entry);
      return;
    }
    if (this.blocked) {
      this.observe(entry);
      this.archive.droppedPendingEvents++;
      this.fail();
      return;
    }
    const context = this.contexts.get(groupKey(evidence));
    if (failure(entry) && context) entry.context = context;
    const signature = JSON.stringify({
      ...evidence,
      sentAt: null,
      acknowledgedAt: null,
      restoredAt: null,
      ...(stage === 'business_live'
        ? { originalObservedAt: null, runtimeSeq: null, receiveSequence: null }
        : {}),
      context: entry.context,
    });
    const previous = this.previous.get(key);
    if (previous?.signature === signature && this.retained.has(previous.entry)) {
      const queued = this.pending.includes(previous.entry);
      const priorBytes = queued ? bytes(previous.entry) : 0;
      previous.entry.occurrences++;
      this.uncommittedAggregates++;
      previous.entry.lastRecordedAt = at;
      const group = this.archive.groups.find(
        (g) => g.matchId === evidence.matchId && g.liveSessionId === evidence.liveSessionId,
      );
      if (group) group.lastRecordedAt = at;
      previous.entry.lastObservedAt = evidence.originalObservedAt;
      if (queued) {
        this.queuedBytes += bytes(previous.entry) - priorBytes;
        this.boundPending();
      }
      this.archive.coalescedEvents++;
      this.dirty = true;
      // Healthy identical LIVE frames never schedule a rewrite. After a disk
      // failure, new observations may request one bounded, delayed retry.
      if (this.failed && !this.writing && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.startWriter();
        }, 1000);
        this.timer.unref();
      }
      return;
    }
    if (previous) this.observe(previous.entry);
    this.observe(entry);
    this.updateContext(entry);
    // Ordinary state can be superseded while waiting for the writer. A fault has
    // already pinned its own immutable context, independent of this queue slot.
    const replace =
      stage === 'business_runtime' && !failure(entry)
        ? this.pending.findIndex(
            (e) => e.stage === stage && groupKey(e.evidence) === groupKey(evidence) && !failure(e),
          )
        : -1;
    if (replace >= 0) {
      this.queuedBytes -= bytes(this.pending[replace]);
      this.retained.delete(this.pending[replace]!);
      this.pending.splice(replace, 1);
      this.archive.coalescedEvents++;
    }
    this.pending.push(entry);
    this.retained.add(entry);
    this.queuedBytes += bytes(entry);
    this.boundPending();
    this.previous.delete(key);
    this.previous.set(key, { signature, entry });
    if (this.previous.size > 256) {
      const oldest = this.previous.keys().next().value!;
      this.observe(this.previous.get(oldest)!.entry);
      this.previous.delete(oldest);
    }
    this.dirty = true;
    if (!this.writing && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.startWriter();
      }, 25);
      this.timer.unref();
    }
  }
  private boundPending(): void {
    while (
      this.pending.length > BUSINESS_HISTORY_LIMITS.queuedEvents ||
      this.queuedBytes > BUSINESS_HISTORY_LIMITS.queuedBytes
    ) {
      const normal = this.pending.findIndex((e) => !failure(e));
      const removed = this.pending.splice(normal >= 0 ? normal : 0, 1)[0]!;
      this.observe(removed);
      this.retained.delete(removed);
      this.queuedBytes -= bytes(removed);
      this.archive.droppedPendingEvents++;
      // Do not keep an evicted queue entry as the live aggregation target.
      for (const [k, v] of this.previous) if (v.entry === removed) this.previous.delete(k);
    }
  }
  private apply(entry: Entry): void {
    const { evidence } = entry;
    let group = this.archive.groups.find(
      (g) => g.matchId === evidence.matchId && g.liveSessionId === evidence.liveSessionId,
    );
    if (!group) {
      group = {
        matchId: evidence.matchId,
        liveSessionId: evidence.liveSessionId,
        firstRecordedAt: entry.recordedAt,
        lastRecordedAt: entry.recordedAt,
        rotatedEvents: 0,
        events: [],
      };
      this.archive.groups.push(group);
    }
    if (entry.stage === 'business_delivery')
      evidence.generatedVersion =
        group.events.find(
          (e) =>
            e.evidence.idempotencyKey === evidence.idempotencyKey &&
            e.evidence.generatedVersion !== null,
        )?.evidence.generatedVersion ?? (evidence.reason === 'queued' ? this.sourceVersion : null);
    group.events.push(entry);
    group.lastRecordedAt = entry.recordedAt;
    const trim = (predicate: (event: Entry) => boolean, limit: number) => {
      while (bytes(group.events.filter(predicate)) > limit) {
        const index = group.events.findIndex(predicate);
        if (index < 0) break;
        this.observe(group.events[index]!);
        this.retained.delete(group.events[index]!);
        group.events.splice(index, 1);
        group.rotatedEvents++;
      }
    };
    trim((e) => !failure(e), BUSINESS_HISTORY_LIMITS.contextBytes);
    trim(failure, BUSINESS_HISTORY_LIMITS.groupBytes - BUSINESS_HISTORY_LIMITS.contextBytes - 4096);
    while (
      Buffer.byteLength(JSON.stringify({ businessHistory: { groups: [group] } }, null, 2)) >
      BUSINESS_HISTORY_LIMITS.groupBytes - 16 * 1024
    ) {
      this.observe(group.events[0]!);
      this.retained.delete(group.events[0]!);
      group.events.shift();
      group.rotatedEvents++;
    }
  }
  private fail(): void {
    this.archive.writeFailures++;
    this.dirty = true;
    if (!this.failed) {
      try {
        this.onFailure();
      } catch {
        /* Optional diagnostics. */
      }
    }
    this.failed = true;
  }
  private startWriter(): Promise<void> {
    if (this.writing) return this.writing;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.writing = this.writePending().finally(() => {
      this.writing = undefined;
      if (!this.closed && !this.failed && (this.pending.length || this.dirty) && !this.timer) {
        this.timer = setTimeout(() => {
          this.timer = undefined;
          void this.startWriter();
        }, 25);
        this.timer.unref();
      }
    });
    return this.writing;
  }
  private async writePending(): Promise<void> {
    if (this.blocked) return;
    if (this.pending.length || this.dirty) {
      const batch = this.pending;
      this.pending = [];
      this.queuedBytes = 0;
      for (const entry of batch) this.apply(entry);
      while (
        this.archive.groups.length > BUSINESS_HISTORY_LIMITS.groups ||
        bytes(this.archive) > BUSINESS_HISTORY_LIMITS.totalBytes
      ) {
        const oldest = [...this.archive.groups].sort((a, b) =>
          (a.lastRecordedAt ?? '').localeCompare(b.lastRecordedAt ?? ''),
        )[0]!;
        for (const entry of oldest.events) {
          this.observe(entry);
          this.retained.delete(entry);
        }
        this.archive.groups.splice(this.archive.groups.indexOf(oldest), 1);
        this.archive.evictedGroups++;
        this.archive.evictedEvents += oldest.events.length + oldest.rotatedEvents;
      }
      this.uncommittedEvents += batch.length;
      const events = this.uncommittedEvents;
      this.dirty = false;
      const temporary = join(this.directory, `${BUSINESS_HISTORY_FILE}.tmp`);
      let ownedTemporary = false;
      try {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        try {
          const stale = await lstat(temporary);
          if (!stale.isFile() || stale.isSymbolicLink()) throw new Error('invalid_staging_file');
          await unlink(temporary);
          this.archive.abandonedStagingFiles++;
        } catch (error) {
          if (obj(error).code !== 'ENOENT') throw error;
        }
        const failures = this.archive.writeFailures;
        // A bounded snapshot is serialized once per batch; no synchronous file
        // writes or fsync execute in the telemetry/claim/delivery callback.
        const aggregates = this.uncommittedAggregates;
        const contents = JSON.stringify(this.archive);
        const handle = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        ownedTemporary = true;
        try {
          await handle.writeFile(contents);
          await handle.sync();
        } finally {
          await handle.close();
        }
        await rename(temporary, join(this.directory, BUSINESS_HISTORY_FILE));
        ownedTemporary = false;
        this.uncommittedAggregates -= aggregates;
        this.committedFailures = failures;
        this.uncommittedEvents -= events;
        this.committedWrites++;
        this.failed = false;
      } catch {
        this.fail();
      } finally {
        if (ownedTemporary) await unlink(temporary).catch(() => undefined);
      }
    }
  }
  async flush(): Promise<void> {
    for (const value of this.previous.values()) this.observe(value.entry);
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // A failed attempt is reported, not retried indefinitely during export/exit.
    const active = this.writing;
    await this.startWriter();
    // At most the active commit plus one batch; live input need not go idle.
    // close() stops producers first, so this also drains all queued exit evidence.
    if (active && !this.failed && (this.pending.length || this.dirty)) await this.startWriter();
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
  getHealth() {
    return {
      writeFailures: this.archive.writeFailures,
      droppedPendingEvents: this.archive.droppedPendingEvents,
      coalescedEvents: this.archive.coalescedEvents,
      committedWriteFailures: this.committedFailures,
      uncommittedWriteFailures: this.archive.writeFailures - this.committedFailures,
      queuedEvents: this.pending.length,
      queuedBytes: this.queuedBytes,
      uncommittedEvents: this.uncommittedEvents + this.pending.length,
      uncommittedAggregates: this.uncommittedAggregates,
      uncommittedChanges: this.dirty || this.pending.length > 0 || this.uncommittedEvents > 0,
      committedWrites: this.committedWrites,
    };
  }
  getStatus(): 'available' | 'write_failed' {
    return this.failed ? 'write_failed' : 'available';
  }
}

export function readBusinessHistory(
  directory: string | undefined,
  maxBytes = BUSINESS_HISTORY_LIMITS.exportBytes,
) {
  const loaded = directory
    ? load(directory)
    : { status: 'not_configured', archive: empty(), corruptRecords: 0, corruptGroups: 0 };
  const { archive } = loaded;
  const groups = [...archive.groups].sort(
    (a, b) =>
      Number(a.matchId === null) - Number(b.matchId === null) ||
      (b.lastRecordedAt ?? '').localeCompare(a.lastRecordedAt ?? ''),
  );
  const selected: Group[] = [];
  const omitted: { matchId: string | null; liveSessionId: string | null; events: number }[] = [];
  for (const group of groups) {
    if (Buffer.byteLength(JSON.stringify([...selected, group], null, 2)) > maxBytes)
      omitted.push({
        matchId: group.matchId,
        liveSessionId: group.liveSessionId,
        events: group.events.length,
      });
    else selected.push(group);
  }
  const result = () => ({
    manifest: {
      status: loaded.status,
      corruptRecords: loaded.corruptGroups ? null : loaded.corruptRecords,
      knownCorruptRecords: loaded.corruptRecords,
      corruptGroups: loaded.corruptGroups,
      coalescedEvents: archive.coalescedEvents,
      droppedPendingEvents: archive.droppedPendingEvents,
      firstRecordedAt:
        groups
          .map((g) => g.firstRecordedAt)
          .filter((v): v is string => v !== null)
          .sort()[0] ?? null,
      lastRecordedAt:
        groups
          .map((g) => g.lastRecordedAt)
          .filter((v): v is string => v !== null)
          .sort()
          .at(-1) ?? null,
      sourceVersions: [...new Set(groups.flatMap((g) => g.events.map((e) => e.version)))],
      limits: BUSINESS_HISTORY_LIMITS,
      exportedGroups: selected.length,
      exportOmittedGroups: omitted,
      exportOmittedEvents: omitted.reduce((n, g) => n + g.events, 0),
      rotatedGroups: archive.evictedGroups,
      rotatedEvents: archive.evictedEvents + groups.reduce((n, g) => n + g.rotatedEvents, 0),
      writeFailures: archive.writeFailures,
      committedWriteFailures: archive.writeFailures,
      uncommittedWriteFailures: 0,
      evidenceSource: 'committed_disk',
      abandonedStagingFiles: archive.abandonedStagingFiles,
      completeness: 'bounded_observations_only',
      legacy: 'legacy_refs_are_irreversible; historical_missing_fields_were_not_collected',
      attemptsMeaning: 'outbox_sink_invocations_including_local_rejections; not_HTTP_requests',
      restoredMeaning: 'loaded_from_queue; not_sent_or_acknowledged',
    },
    groups: selected.map((group) => ({
      ...group,
      sourceVersions: [...new Set(group.events.map((e) => e.version))],
      exportedFrom: group.events[0]?.recordedAt ?? null,
      exportedTo: group.events.at(-1)?.recordedAt ?? null,
      originalObservedFrom:
        group.events
          .map((e) => e.evidence.originalObservedAt)
          .filter((v): v is string => v !== null)
          .sort()[0] ?? null,
    })),
  });
  let exported = result();
  while (
    selected.length &&
    Buffer.byteLength(JSON.stringify({ businessHistory: exported }, null, 2)) > maxBytes
  ) {
    const group = selected.pop()!;
    omitted.push({
      matchId: group.matchId,
      liveSessionId: group.liveSessionId,
      events: group.events.length,
    });
    exported = result();
  }
  return exported;
}
