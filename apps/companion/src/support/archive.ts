import { setImmediate as yieldIO } from 'node:timers/promises';
import { safePath } from '../resource-store/files.js';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, resolve, parse } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { diagnosticValue, SESSION_LIMITS } from './session-journal.js';
import { PerformanceSpool } from './performance-spool.js';
import { decodeDiagnosticBatch, type RetainedDiagnosticBatch } from './delivery.js';
import { diagnosticConsoleEvidence, diagnosticSourceUtc } from './envelope.js';
const compress = promisify(gzip);
const VOLUME_BYTES = 1024 * 1024;
const FILE_BYTES = 25 * 1024 * 1024;
export interface ArchivedLogFile {
  name: string;
  status: string;
  sourceBytes: number;
  readBytes: number;
  durability?: 'durable-pending' | 'durable-outbox' | 'memory-only';
  scope?: string;
  automaticDelivery?: RetainedDiagnosticBatch['automaticDelivery'];
  error?: unknown;
  snapshotAt?: string;
  sha256?: string;
  volumes: { index: number; bytes: number; sha256: string; gzipBase64: string }[];
}
export async function encodeLogVolumes(bytes: Buffer) {
  const volumes: ArchivedLogFile['volumes'] = [];
  for (let start = 0; start < bytes.length; start += VOLUME_BYTES) {
    const part = bytes.subarray(start, start + VOLUME_BYTES);
    volumes.push({
      index: volumes.length,
      bytes: part.length,
      sha256: createHash('sha256').update(part).digest('hex'),
      gzipBase64: (await compress(part)).toString('base64'),
    });
  }
  return { sha256: createHash('sha256').update(bytes).digest('hex'), volumes };
}

const names = [
  ...[1, 2, 3].map((index) => `desktop.ndjson.${index}`),
  'session-retention.json',
  'business-history.json',
  'business.ndjson',
  'business.ndjson.1',
  'business.ndjson.2',
  'business.ndjson.3',
  ...Array.from({ length: SESSION_LIMITS.segments }, (_, i) =>
    i ? `session.ndjson.${i}` : 'session.ndjson',
  ),
  ...['desktop.ndjson', 'supervisor.ndjson', 'companion.log', 'companion.stderr.log'].flatMap(
    (name) => [
      name,
      ...[1, 2, 3].map((i) => (name === 'desktop.ndjson' ? `desktop.${i}.ndjson` : `${name}.${i}`)),
    ],
  ),
];

/** Fixed product logs only, full retained bytes, compressed into independently verifiable volumes. */
export async function fullLogArchive(
  directory: string | undefined,
  range: { from?: string; to?: string; focusSessionId?: string } = {},
  memoryPerformance: readonly unknown[] = [],
  extra: { journalMemory?: readonly string[]; outbox?: readonly RetainedDiagnosticBatch[] } = {},
) {
  const fragments = new Map<string, { id: string; expected: number; parts: Set<number> }>();
  const sessions = new Map<
    string,
    {
      sessionId: string;
      hostStartupSessionId: string | null;
      first: string | null;
      last: string | null;
      events: number;
      sequence: number[];
      ended: boolean;
    }
  >();
  const files: ArchivedLogFile[] = [];
  const include = (time: unknown) => {
    const utc = diagnosticSourceUtc(time);
    return !utc || ((!range.from || utc >= range.from) && (!range.to || utc <= range.to));
  };
  const sourceTime = (event: {
    time?: unknown;
    evidence?: { sourceRecord?: { time?: unknown } };
  }) => event.evidence?.sourceRecord?.time ?? event.time;
  const includeRecord = (input: unknown): boolean => {
    if (!input || typeof input !== 'object') return true;
    const event = input as {
      stage?: string;
      time?: unknown;
      evidence?: {
        sourceRecord?: { time?: unknown };
        entries?: { entry?: Record<string, unknown> }[];
      };
    };
    // NativeSource groups by bytes, not by stage or source time. A console
    // interval cannot stand in for an ordinary Host operation in the same group.
    // Keep the full context if any original entry matches or has unknown time.
    if (event.stage === 'native_host_records') {
      const entries = event.evidence?.entries;
      return (
        !Array.isArray(entries) ||
        !entries.length ||
        entries.some((copied) => includeRecord(copied?.entry))
      );
    }
    const consoles = event.stage === 'cs2_console_records' ? [input] : [];
    if (consoles.length) {
      for (const console of consoles) {
        const detail = diagnosticConsoleEvidence(console);
        if (!detail || !Array.isArray(detail.records) || !detail.records.length) return true;
        for (const value of detail.records as Record<string, unknown>[]) {
          const after = diagnosticSourceUtc(value.sourceAfterUtc);
          const captured = diagnosticSourceUtc(value.capturedAt);
          if (!after || !captured || after > captured) return true;
          if ((!range.from || captured >= range.from) && (!range.to || after <= range.to))
            return true;
        }
      }
      return false;
    }
    return include(sourceTime(event));
  };
  const indexRecord = (
    event: Record<string, unknown>,
    time: unknown,
    name: string,
    id = event.startupSessionId,
  ) => {
    if (typeof id === 'string') {
      const session = sessions.get(id) ?? {
        sessionId: id,
        hostStartupSessionId:
          typeof event.hostStartupSessionId === 'string'
            ? event.hostStartupSessionId
            : /^(?:desktop|supervisor|companion)/.test(name)
              ? id
              : null,
        first: null,
        last: null,
        events: 0,
        sequence: [],
        ended: false,
      };
      if (typeof time === 'string') {
        session.first = session.first === null || time < session.first ? time : session.first;
        session.last = session.last === null || time > session.last ? time : session.last;
      }
      session.events++;
      if (typeof event.sequence === 'number') session.sequence.push(event.sequence);
      if (event.stage === 'session_end') session.ended = true;
      sessions.set(id, session);
    }
  };
  const appendVolatileAndRetained = async () => {
    if (extra.journalMemory?.length) {
      const records = extra.journalMemory.map((line) => JSON.parse(line) as { time?: unknown });
      const bytes = Buffer.from(
        records
          .filter(includeRecord)
          .map((event) => {
            indexRecord(event, sourceTime(event), 'retained-copy');
            return JSON.stringify(diagnosticValue(event)) + '\n';
          })
          .join(''),
      );
      files.push({
        name: 'session-memory.ndjson',
        status: 'read',
        durability: 'memory-only',
        scope: 'accepted SessionJournal records not confirmed on disk at the export snapshot',
        sourceBytes: 0,
        readBytes: 0,
        ...(await encodeLogVolumes(bytes)),
      });
    }
    for (const retained of extra.outbox ?? []) {
      const file: ArchivedLogFile = {
        name: retained.id ? `diagnostic-outbox/${retained.id}.ndjson` : 'diagnostic-outbox',
        status: 'unreadable',
        durability: 'durable-outbox',
        automaticDelivery: retained.automaticDelivery,
        scope:
          'retained consented technical copy; original local journal can have broader scope; no credential manifest',
        sourceBytes: retained.sourceBytes,
        readBytes: 0,
        volumes: [],
      };
      files.push(file);
      try {
        if (!retained.gzip) {
          file.error = retained.error ?? 'retained_body_unavailable';
          continue;
        }
        const body = await decodeDiagnosticBatch(retained.gzip);
        const bytes = Buffer.from(
          (body.events ?? [])
            .filter(includeRecord)
            .map((event) => {
              indexRecord(
                event as Record<string, unknown>,
                sourceTime(event as { time?: unknown }),
                'retained-copy',
              );
              return JSON.stringify(diagnosticValue(event)) + '\n';
            })
            .join(''),
        );
        Object.assign(file, await encodeLogVolumes(bytes), {
          status: 'read',
          readBytes: retained.sourceBytes,
        });
      } catch (error) {
        file.error = diagnosticValue(error);
      }
      await yieldIO();
    }
    if (memoryPerformance.length) {
      const values = memoryPerformance.filter((event) =>
        include((event as { time?: unknown } | null)?.time),
      );
      const bytes = Buffer.from(
        values.map((event) => JSON.stringify(diagnosticValue(event)) + '\n').join(''),
      );
      files.push({
        name: 'performance-memory.ndjson',
        status: 'read',
        durability: 'memory-only',
        sourceBytes: 0,
        readBytes: 0,
        ...(await encodeLogVolumes(bytes)),
      });
    }
  };
  if (!directory) {
    await appendVolatileAndRetained();
    return { status: 'not_configured', files };
  }
  try {
    await lstat(directory);
  } catch (error) {
    await appendVolatileAndRetained();
    return {
      status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable',
      files,
    };
  }
  // Reject links in every ancestor, including state root. Never traverse arbitrary user files.
  let ancestor = resolve(directory);
  while (ancestor !== parse(ancestor).root) {
    if ((await lstat(ancestor)).isSymbolicLink()) throw new Error('support_log_link');
    ancestor = resolve(ancestor, '..');
  }
  const snapshots: {
    file: ArchivedLogFile;
    fd?: Awaited<ReturnType<typeof open>>;
    stat?: Stats;
  }[] = [];
  // Open fixed producer files before processing any large body. Their initial
  // bytes stay readable when another process rotates/unlinks the named files.
  for (const name of names) {
    const file: ArchivedLogFile = {
      name,
      status: 'missing',
      sourceBytes: 0,
      readBytes: 0,
      volumes: [],
    };
    files.push(file);
    const snapshot: (typeof snapshots)[number] = { file };
    snapshots.push(snapshot);
    try {
      const path = join(directory, name);
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        file.status = 'unsafe_file';
        continue;
      }
      await safePath(directory, name);
      const fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      snapshot.fd = fd;
      const stat = await fd.stat();
      if (stat.ino !== before.ino || stat.dev !== before.dev || stat.nlink > 1) {
        file.status = 'file_changed';
        continue;
      }
      file.sourceBytes = stat.size;
      if (stat.size > FILE_BYTES) {
        file.status = 'source_exceeds_producer_budget';
        continue;
      }
      snapshot.stat = stat;
      file.snapshotAt = new Date().toISOString();
    } catch (error) {
      file.status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
      if (file.status !== 'missing') file.error = diagnosticValue(error);
    } finally {
      if (!snapshot.stat) {
        await snapshot.fd?.close();
        delete snapshot.fd;
      }
    }
  }
  try {
    await appendVolatileAndRetained();
    for (const { file, fd, stat } of snapshots) {
      if (!fd || !stat) continue;
      const name = file.name;
      try {
        const source = Buffer.alloc(stat.size);
        while (file.readBytes < stat.size) {
          const { bytesRead } = await fd.read(
            source,
            file.readBytes,
            stat.size - file.readBytes,
            file.readBytes,
          );
          if (!bytesRead) break;
          file.readBytes += bytesRead;
        }
        const after = await fd.stat();
        const changed =
          after.ino !== stat.ino ||
          after.dev !== stat.dev ||
          file.readBytes !== stat.size ||
          after.size < stat.size ||
          (after.size === stat.size && after.mtimeMs !== stat.mtimeMs);
        if (changed)
          file.error = {
            reason: 'source_changed_during_snapshot',
            expectedBytes: stat.size,
            availableBytes: file.readBytes,
            finalBytes: after.size,
          };
        // Parse structured records before redaction to preserve valid NDJSON and replace whole credential values.
        let currentSession: unknown;
        const lines = source.subarray(0, file.readBytes).toString('utf8').split('\n');
        const processLine = (line: string) => {
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            const source = (event.evidence as { sourceRecord?: { time?: unknown } } | undefined)
              ?.sourceRecord;
            const stamp = source?.time ?? event.time ?? event.timestamp;
            const time =
              typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0 && stamp < 1e14
                ? new Date(stamp).toISOString()
                : stamp;
            if (typeof event.startupSessionId === 'string') currentSession = event.startupSessionId;
            const id = event.startupSessionId ?? currentSession;
            if (!includeRecord({ ...event, time })) return '';
            const rawDetail = event.error ?? event.detail;
            if (typeof rawDetail === 'string') {
              try {
                const detail = JSON.parse(rawDetail) as {
                  detailId?: unknown;
                  part?: unknown;
                  parts?: unknown;
                };
                if (
                  typeof detail.detailId === 'string' &&
                  typeof detail.part === 'number' &&
                  typeof detail.parts === 'number'
                ) {
                  const group = fragments.get(detail.detailId) ?? {
                    id: detail.detailId,
                    expected: detail.parts,
                    parts: new Set<number>(),
                  };
                  group.parts.add(detail.part);
                  fragments.set(group.id, group);
                }
              } catch {
                /* Ordinary native details need no fragment index. */
              }
            }
            indexRecord(event, time, name, id);
            return JSON.stringify(diagnosticValue(event));
          } catch {
            return diagnosticValue(line) as string;
          }
        };
        const processed: string[] = [];
        for (let index = 0; index < lines.length; index++) {
          processed.push(processLine(lines[index]!));
          if (index % 128 === 0) await yieldIO();
        }
        const text = processed.join('\n');
        const bytes = Buffer.from(text);
        Object.assign(file, await encodeLogVolumes(bytes));
        file.status = changed
          ? 'incomplete_snapshot'
          : name !== 'business-history.json' &&
              name !== 'session-retention.json' &&
              text.length > 0 &&
              !text.endsWith('\n')
            ? 'incomplete_last_line'
            : 'read';
      } catch (error) {
        file.status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
        file.error = diagnosticValue(error);
      }
    }
  } finally {
    await Promise.all(
      snapshots.map(async (snapshot) => {
        await snapshot.fd?.close();
      }),
    );
  }
  try {
    for await (const pending of new PerformanceSpool(directory).export()) {
      if (pending.status === 'unreadable') {
        files.push({
          name: pending.name,
          status: 'unreadable',
          sourceBytes: pending.sourceBytes,
          readBytes: 0,
          volumes: [],
        });
        continue;
      }
      const lines = pending.bytes
        .toString('utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { time?: unknown });
      const bytes = Buffer.from(
        lines
          .filter((event) => include(event.time))
          .map((event) => JSON.stringify(diagnosticValue(event)) + '\n')
          .join(''),
      );
      files.push({
        name: pending.name,
        status: 'read',
        durability: 'durable-pending',
        sourceBytes: pending.sourceBytes,
        readBytes: pending.sourceBytes,
        ...(await encodeLogVolumes(bytes)),
      });
    }
  } catch {
    files.push({
      name: 'performance-pending',
      status: 'unreadable',
      sourceBytes: 0,
      readBytes: 0,
      volumes: [],
    });
  }
  return {
    status: 'available',
    range,
    focus: {
      requestedSessionId: range.focusSessionId ?? null,
      componentSessions: [...sessions.values()]
        .filter(
          (session) =>
            session.sessionId === range.focusSessionId ||
            session.hostStartupSessionId === range.focusSessionId,
        )
        .map((session) => session.sessionId),
      policy:
        'focus is an index only; retained cross-process sources are not discarded, including borrowed runtimes',
    },
    rangePolicy:
      'Timestamped records are filtered; console write intervals use conservative overlap and unknown bounds remain attached; business/retention snapshots and unscoped legacy text remain attached.',
    fragmentedDetails: [...fragments.values()].map((group) => ({
      id: group.id,
      expected: group.expected,
      included: group.parts.size,
      complete:
        group.parts.size === group.expected &&
        [...group.parts].sort((a, b) => a - b).every((part, index) => part === index + 1),
    })),
    sessions: [...sessions.values()].map(({ sequence, ...session }) => {
      const ordered = [...new Set(sequence)].sort((a, b) => a - b);
      const first = ordered[0] ?? null;
      const last = ordered.at(-1) ?? null;
      return {
        ...session,
        firstSequence: first,
        lastSequence: last,
        missingSequences:
          first === null || last === null ? null : last - first + 1 - ordered.length,
        missingStart: first !== null && first !== 1,
        terminalRecorded: session.ended,
        completeness: !session.ended
          ? 'open-or-interrupted'
          : first !== 1 || last === null || last - first + 1 !== ordered.length
            ? 'partial'
            : 'retained-range',
      };
    }),
    encoding: 'concatenate gunzip(base64(volume)) in index order; UTF-8 NDJSON',
    scope: 'all retained Mizar product logs; summary is an index only',
    completeness:
      'Retention/rotation may remove earlier records; unclosed sessions or sequence gaps are incomplete. Power loss may lose pending/OS-buffered records. Legacy versions did not collect all controls.',
    files,
  };
}

/** Stream the archive a volume at a time; large exports must yield to live ingress. */
export async function* encodeSupportBundle(bundle: {
  fullLogs: Awaited<ReturnType<typeof fullLogArchive>>;
  [key: string]: unknown;
}): AsyncGenerator<string> {
  const { fullLogs, ...header } = bundle;
  yield JSON.stringify(header).slice(0, -1) + ',"fullLogs":';
  const { files, ...metadata } = fullLogs;
  yield JSON.stringify(metadata).slice(0, -1) + ',"files":[';
  for (let index = 0; index < files.length; index++) {
    const { volumes, ...file } = files[index]!;
    yield (index ? ',' : '') + JSON.stringify(file).slice(0, -1) + ',"volumes":[';
    for (let part = 0; part < volumes.length; part++) {
      yield (part ? ',' : '') + JSON.stringify(volumes[part]);
      await yieldIO();
    }
    yield ']}';
    await yieldIO();
  }
  yield ']}}';
}
