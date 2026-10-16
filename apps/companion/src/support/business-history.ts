import { randomUUID } from 'node:crypto';
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  fsyncSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs';
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
};
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
function load(directory: string): { status: string; archive: Archive; corruptRecords: number } {
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
    let corruptRecords = 0;
    for (const value of raw.groups) {
      const g = obj(value);
      if (!Array.isArray(g.events) || bytes(g) > BUSINESS_HISTORY_LIMITS.groupBytes)
        throw new Error('invalid_group');
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
    return { status: corruptRecords ? 'partial_corrupt' : 'read', archive, corruptRecords };
  } catch (error) {
    return {
      status: obj(error).code === 'ENOENT' ? 'not_collected' : 'unreadable_or_corrupt',
      archive: empty(),
      corruptRecords: 0,
    };
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

export class BusinessHistory {
  private readonly session = randomUUID();
  private readonly archive: Archive;
  private failed = false;
  private readonly previous = new Map<string, string>();
  private readonly blocked: boolean;
  constructor(
    private readonly directory: string,
    private readonly onFailure: () => void,
    private readonly sourceVersion = businessVersion(),
  ) {
    const loaded = load(directory);
    this.archive = loaded.archive;
    // Preserve damaged/unsupported evidence. Never silently replace it with an empty history.
    this.blocked = !['read', 'not_collected'].includes(loaded.status);
  }
  append(stage: string, evidence: Evidence) {
    if (!stages.includes(stage)) return;
    try {
      if (this.blocked) throw new Error('history_unreadable');
      const key = JSON.stringify([
        stage,
        evidence.matchId,
        evidence.liveSessionId,
        evidence.idempotencyKey,
      ]);
      const signature = JSON.stringify({
        ...evidence,
        sentAt: null,
        acknowledgedAt: null,
        restoredAt: null,
      });
      if (this.previous.get(key) === signature && !this.failed) return;
      // Remember only after a successful write, so failure remains retryable.
      const at = new Date().toISOString();
      let group = this.archive.groups.find(
        (g) => g.matchId === evidence.matchId && g.liveSessionId === evidence.liveSessionId,
      );
      if (!group) {
        group = {
          matchId: evidence.matchId,
          liveSessionId: evidence.liveSessionId,
          firstRecordedAt: at,
          lastRecordedAt: at,
          rotatedEvents: 0,
          events: [],
        };
        this.archive.groups.push(group);
      }
      if (stage === 'business_delivery') {
        evidence.generatedVersion =
          group.events.find(
            (e) =>
              e.evidence.idempotencyKey === evidence.idempotencyKey &&
              e.evidence.generatedVersion !== null,
          )?.evidence.generatedVersion ??
          (evidence.reason === 'queued' ? this.sourceVersion : null);
      }
      const e: Entry = {
        stage,
        recordedAt: at,
        version: this.sourceVersion,
        startupSessionId: this.session,
        evidence,
      };
      group.events.push(e);
      group.lastRecordedAt = at;
      const trim = (predicate: (event: Entry) => boolean, limit: number) => {
        while (bytes(group.events.filter(predicate)) > limit) {
          const index = group.events.findIndex(predicate);
          if (index < 0) break;
          group.events.splice(index, 1);
          group.rotatedEvents++;
        }
      };
      trim((e) => !failure(e), BUSINESS_HISTORY_LIMITS.contextBytes);
      trim(
        failure,
        BUSINESS_HISTORY_LIMITS.groupBytes - BUSINESS_HISTORY_LIMITS.contextBytes - 4096,
      );
      while (
        Buffer.byteLength(JSON.stringify({ businessHistory: { groups: [group] } }, null, 2)) >
        BUSINESS_HISTORY_LIMITS.groupBytes - 16 * 1024
      ) {
        group.events.shift();
        group.rotatedEvents++;
      }
      while (
        this.archive.groups.length > BUSINESS_HISTORY_LIMITS.groups ||
        bytes(this.archive) > BUSINESS_HISTORY_LIMITS.totalBytes
      ) {
        const oldest = [...this.archive.groups].sort((a, b) =>
          (a.lastRecordedAt ?? '').localeCompare(b.lastRecordedAt ?? ''),
        )[0]!;
        this.archive.groups.splice(this.archive.groups.indexOf(oldest), 1);
        this.archive.evictedGroups++;
        this.archive.evictedEvents += oldest.events.length + oldest.rotatedEvents;
      }
      mkdirSync(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `${BUSINESS_HISTORY_FILE}.tmp`);
      try {
        try {
          const stale = lstatSync(temporary);
          if (!stale.isFile() || stale.isSymbolicLink()) throw new Error('invalid_staging_file');
          // One fixed staging slot bounds crash residue. Never import uncommitted bytes.
          unlinkSync(temporary);
          this.archive.abandonedStagingFiles++;
        } catch (error) {
          if (obj(error).code !== 'ENOENT') throw error;
        }
        const handle = openSync(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          writeFileSync(handle, JSON.stringify(this.archive));
          fsyncSync(handle);
        } finally {
          closeSync(handle);
        }
        renameSync(temporary, join(this.directory, BUSINESS_HISTORY_FILE));
      } finally {
        try {
          unlinkSync(temporary);
        } catch {
          /* Rename normally consumed it. */
        }
      }
      this.previous.delete(key);
      this.previous.set(key, signature);
      if (this.previous.size > 256) this.previous.delete(this.previous.keys().next().value!);
      this.failed = false;
    } catch {
      this.archive.writeFailures++;
      if (!this.failed) {
        try {
          this.onFailure();
        } catch {
          /* Optional diagnostic callback. */
        }
      }
      this.failed = true;
    }
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
    : { status: 'not_configured', archive: empty(), corruptRecords: 0 };
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
      corruptRecords: loaded.corruptRecords,
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
