import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  businessEvidence,
  businessEvidenceHasFailure,
  businessId,
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
  'business_source_cleanup',
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
const failure = (e: Entry) => businessEvidenceHasFailure(e.evidence);

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

// Read-only compatibility adapter; new business evidence belongs to SessionJournal.
function canonicalBusiness(directory: string, archive: Archive) {
  let observed = 0;
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const name of readdirSync(directory).filter((name) =>
    /^(?:session|migrated)-[a-f0-9-]{36}\.ndjson$/.test(name),
  )) {
    let handle: number | undefined;
    try {
      const path = join(directory, name);
      const before = lstatSync(path);
      if (
        !before.isFile() ||
        before.isSymbolicLink() ||
        before.nlink !== 1 ||
        before.size > 2 * 1024 * 1024
      )
        continue;
      handle = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const actual = fstatSync(handle);
      if (actual.ino !== before.ino || actual.dev !== before.dev || actual.nlink !== 1) continue;
      for (const line of readFileSync(handle, 'utf8').split('\n')) {
        if (!line) continue;
        let event: Record<string, unknown>;
        try {
          event = obj(JSON.parse(line));
        } catch {
          continue;
        }
        if (event.kind !== 'business_evidence' && event.stage !== 'business_evidence') continue;
        if (typeof event.eventId === 'string') {
          if (seen.has(event.eventId)) continue;
          seen.add(event.eventId);
        }
        const body = obj(event.evidence),
          at = utc(body.recordedAt) ?? utc(event.recordedAt);
        if (!at || typeof body.stage !== 'string') continue;
        entries.push({
          stage: body.stage,
          recordedAt: at,
          lastRecordedAt: at,
          version: version(body.version),
          startupSessionId: typeof event.producerRunId === 'string' ? event.producerRunId : null,
          evidence: businessEvidence(body.evidence),
          occurrences: 1,
          lastObservedAt: utc(obj(body.evidence).originalObservedAt),
        });
      }
    } finally {
      if (handle !== undefined) closeSync(handle);
    }
  }
  entries.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const contexts = new Map<string, { runtime: ContextEntry | null; guard: ContextEntry | null }>();
  for (const entry of entries) {
    const key = groupKey(entry.evidence);
    let group = archive.groups.find(
      (group) => JSON.stringify([group.matchId, group.liveSessionId]) === key,
    );
    if (!group) {
      group = {
        matchId: entry.evidence.matchId,
        liveSessionId: entry.evidence.liveSessionId,
        firstRecordedAt: entry.recordedAt,
        lastRecordedAt: entry.recordedAt,
        rotatedEvents: 0,
        events: [],
      };
      archive.groups.push(group);
    }
    const context = contexts.get(key) ?? { runtime: null, guard: null };
    if (failure(entry)) entry.context = structuredClone(context);
    if (entry.stage === 'business_runtime')
      context.runtime = {
        recordedAt: entry.recordedAt,
        version: entry.version,
        evidence: entry.evidence,
      };
    if (entry.stage === 'business_guard')
      context.guard = {
        recordedAt: entry.recordedAt,
        version: entry.version,
        evidence: entry.evidence,
      };
    contexts.set(key, context);
    group.events.push(entry);
    group.lastRecordedAt = entry.recordedAt;
    observed++;
  }
  return observed;
}

export function readBusinessHistory(
  directory: string | undefined,
  maxBytes = BUSINESS_HISTORY_LIMITS.exportBytes,
) {
  const loaded = directory
    ? load(directory)
    : { status: 'not_configured', archive: empty(), corruptRecords: 0, corruptGroups: 0 };
  const { archive } = loaded;
  if (directory && canonicalBusiness(directory, archive) > 0) loaded.status = 'available';
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
