import { setImmediate as yieldIO } from 'node:timers/promises';
import { safePath } from '../resource-store/files.js';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, resolve, parse } from 'node:path';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { diagnosticValue, SESSION_LIMITS } from './session-journal.js';
const compress = promisify(gzip);
const VOLUME_BYTES = 1024 * 1024;
const FILE_BYTES = 25 * 1024 * 1024;
export interface ArchivedLogFile {
  name: string;
  status: string;
  sourceBytes: number;
  readBytes: number;
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
  if (!directory) return { status: 'not_configured', files };
  try {
    await lstat(directory);
  } catch (error) {
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
  for (const name of names) {
    const file: ArchivedLogFile = {
      name,
      status: 'missing',
      sourceBytes: 0,
      readBytes: 0,
      volumes: [],
    };
    files.push(file);
    let fd: Awaited<ReturnType<typeof open>> | undefined;
    try {
      const path = join(directory, name);
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        file.status = 'unsafe_file';
        continue;
      }
      await safePath(directory, name);
      fd = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await fd.stat();
      if (stat.ino !== before.ino || stat.dev !== before.dev) {
        file.status = 'file_changed';
        continue;
      }
      file.sourceBytes = stat.size;
      if (stat.size > FILE_BYTES) {
        file.status = 'source_exceeds_producer_budget';
        continue;
      }
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
      const after = await lstat(await safePath(directory, name));
      if (
        after.ino !== stat.ino ||
        after.dev !== stat.dev ||
        file.readBytes !== stat.size ||
        (after.size <= stat.size && after.mtimeMs !== stat.mtimeMs)
      ) {
        file.status = 'file_changed';
        continue;
      }
      // Parse structured records before redaction to preserve valid NDJSON and replace whole credential values.
      let currentSession: unknown;
      const lines = source.subarray(0, file.readBytes).toString('utf8').split('\n');
      const processLine = (line: string) => {
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          const stamp = event.time ?? event.timestamp;
          const time =
            typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0 && stamp < 1e14
              ? new Date(stamp).toISOString()
              : stamp;
          if (typeof event.startupSessionId === 'string') currentSession = event.startupSessionId;
          const id = event.startupSessionId ?? currentSession;
          if (
            typeof time === 'string' &&
            ((range.from && time < range.from) || (range.to && time > range.to))
          )
            return '';
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
      file.status =
        name !== 'business-history.json' &&
        name !== 'session-retention.json' &&
        text.length > 0 &&
        !text.endsWith('\n')
          ? 'incomplete_last_line'
          : 'read';
    } catch (error) {
      file.status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
    } finally {
      await fd?.close();
    }
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
      'Timestamped records are filtered; business/retention snapshots and unscoped legacy text remain attached.',
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
