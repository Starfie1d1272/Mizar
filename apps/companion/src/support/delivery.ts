import { hostDeliveryParticipant } from './host-delivery-pin.js';
import { type IncidentParticipant, type PinReceipt } from './retention.js';
import { diagnosticSegmentNames } from './segments.js';
import { technicalProjection, sourceCoversProjection } from './technical-projection.js';
import {
  DIAGNOSTIC_PERMIT_BYTES,
  DIAGNOSTIC_RECEIVER_STAGES,
  type DiagnosticReceiverStage,
  DIAGNOSTIC_AUTOMATIC_LIFETIME_MS,
  diagnosticInstallationId,
  diagnosticInstallationCreatedAt,
  diagnosticGzipCreatedAt,
  diagnosticAutomaticTimeReason,
  stampDiagnosticGzip,
  diagnosticPermit,
  sealDiagnosticGzip,
  readDiagnosticGzipPermit,
} from '@mizar/protocol/diagnostics-upload';
import { diagnosticEnvelope, diagnosticSourceUtc } from './envelope.js';
import { DIAGNOSTIC_CONSENT_REVISION } from '@mizar/protocol/version';
import { z } from 'zod';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { safePath } from '../resource-store/files.js';
import { diagnosticValue, type SessionJournal } from './session-journal.js';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
export const DELIVERY_LIMITS = {
  expandedBytes: 4 * 1024 * 1024,
  compressedBytes: 512 * 1024,
  queueBytes: 64 * 1024 * 1024,
  batches: 2048,
  manifestBytes: 2 * 1024 * 1024,
  pendingBytes: 8 * 1024 * 1024,
  events: 4096,
  sessions: 128,
  tombstones: 8,
  collectMs: 20 * 60_000,
  pollMs: 5000,
};
const CONSENT = DIAGNOSTIC_CONSENT_REVISION;
const retryDelay = (failures: number) =>
  Math.ceil(
    Math.min(
      15 * 60_000,
      Math.max(
        30_000,
        30_000 * 2 ** Math.min(failures - 1, 10) * (0.8 + (randomBytes(1)[0]! / 255) * 0.4),
      ),
    ),
  );
const transportReasons = [
  'receiver_upgrade_required',
  'receipt_invalid',
  'batch_retention_expired',
  'automatic_window_expired',
  'payload_clock_future',
  'payload_creation_time_missing',
  'permit_budget',
  'registration_budget',
  'installation_capacity',
  'capacity_or_concurrent_reservation',
  'index_allocation_budget',
  'rate_limited',
  'connection_timeout',
  'connection_failed',
  'request_timeout',
  'unconfirmed',
] as const;
function transportFailureReason(error: unknown): (typeof transportReasons)[number] {
  const seen = new Set<unknown>();
  for (
    let depth = 0;
    error && typeof error === 'object' && depth < 8 && !seen.has(error);
    depth++
  ) {
    seen.add(error);
    const detail = error as { reason?: unknown; code?: unknown; name?: unknown; cause?: unknown };
    if (transportReasons.includes(detail.reason as (typeof transportReasons)[number]))
      return detail.reason as (typeof transportReasons)[number];
    if (detail.code === 'UND_ERR_CONNECT_TIMEOUT') return 'connection_timeout';
    if (
      ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH'].includes(
        String(detail.code),
      )
    )
      return 'connection_failed';
    if (detail.name === 'TimeoutError') return 'request_timeout';
    error = detail.cause;
  }
  return 'unconfirmed';
}
interface Credentials {
  installationId: string;
  enrollmentSecret: string;
  enrollmentAttempted?: boolean;
  token?: string;
  expiresAt?: number;
}
interface Withdrawal extends Credentials {
  nextAttemptAt?: number;
  consecutiveFailures?: number;
  serverRetryAt?: number;
}
interface Batch {
  id: string;
  bytes: number;
  serverExpired?: boolean;
  acknowledgedAt?: string;
  unavailableReason?: string;
  sealed?: boolean;
  index: {
    schema: string;
    eventSchemaVersion?: 2;
    producerKind?: string;
    uniqueEvents?: number;
    aggregatedOccurrences?: number;
    events: number;
    expandedBytes: number;
    stages: string[];
    sessionId?: string;
    from?: string | null;
    to?: string | null;
    version?: string | null;
    failures?: number;
    failureKinds?: string[];
    sourceTimeUnknownRecords?: number;
  };
}
type TransportFailure = {
  phase: 'enrollment' | 'permit' | 'upload' | 'withdrawal';
  status: number | null;
  reason: string;
  receiverStage?: DiagnosticReceiverStage;
  attemptId?: string;
};
interface State {
  version: 1;
  consentPolicy: 1 | 2 | 3;
  consent: boolean;
  paused: boolean;
  consentAt: string | null;
  closedReason: 'policy_changed' | 'user' | null;
  lastAttemptAt: string | null;
  lastConfirmedAt: string | null;
  transportFailure: TransportFailure | null;
  credentials: Credentials | null;
  withdrawals: Withdrawal[];
  retiredIdentities: Credentials[];
  sessions: Record<string, { from: number; queued: number }>;
  queue: Batch[];
  omitted: number;
  omissionReasons: Record<string, number>;
  acknowledged: number;
  nextAttemptAt: number;
  failures: number;
  consecutiveFailures: number;
  serverRetryAt: number;
}
const identifier = z.string().uuid();
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const credentialsSchema = z
  .object({
    installationId: identifier,
    enrollmentSecret: z.string().regex(/^[a-f0-9]{64}$/),
    enrollmentAttempted: z.boolean().optional(),
    token: z
      .string()
      .max(2048)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
    expiresAt: counter.optional(),
  })
  .passthrough();
const stateSchema = z
  .object({
    version: z.literal(1),
    consentPolicy: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(1),
    consent: z.boolean(),
    paused: z.boolean().default(false),
    consentAt: z.iso.datetime().nullable(),
    closedReason: z.enum(['policy_changed', 'user']).nullable().default(null),
    lastAttemptAt: z.iso.datetime().nullable().default(null),
    lastConfirmedAt: z.iso.datetime().nullable().default(null),
    transportFailure: z
      .object({
        phase: z.enum(['enrollment', 'permit', 'upload', 'withdrawal']),
        status: z.number().int().min(400).max(599).nullable(),
        reason: z.enum(transportReasons),
        receiverStage: z.enum(DIAGNOSTIC_RECEIVER_STAGES).optional(),
        attemptId: z.uuid().optional(),
      })
      .nullable()
      .default(null),
    credentials: credentialsSchema.nullable(),
    withdrawals: z
      .array(
        credentialsSchema.extend({
          nextAttemptAt: counter.optional(),
          consecutiveFailures: counter.optional(),
          serverRetryAt: counter.optional(),
        }),
      )
      .max(DELIVERY_LIMITS.tombstones),
    retiredIdentities: z.array(credentialsSchema).max(DELIVERY_LIMITS.tombstones).default([]),
    sessions: z.record(
      z.string().regex(/^(?:performance:)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i),
      z.object({ from: counter, queued: counter }).refine((v) => v.queued >= v.from),
    ),
    queue: z
      .array(
        z.object({
          id: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().min(1).max(DELIVERY_LIMITS.compressedBytes),
          serverExpired: z.boolean().optional(),
          acknowledgedAt: z.iso.datetime().optional(),
          unavailableReason: z
            .enum([
              'acknowledged_local_history',
              'permanent_rejection',
              'installation_lease_closed',
              'consent_policy_changed',
              'server_retention_expired',
              'batch_retention_expired',
              'automatic_window_expired',
              'payload_clock_future',
              'payload_creation_time_missing',
              'sealed_batch_conflict',
            ])
            .optional(),
          sealed: z.boolean().optional(),
          index: z.object({
            schema: z.literal('mizar-technical-diagnostics/1'),
            eventSchemaVersion: z.literal(2).optional(),
            producerKind: z.enum(['companion', 'host', 'document', 'legacy-unknown']).optional(),
            uniqueEvents: counter.optional(),
            aggregatedOccurrences: counter.optional(),
            events: z.number().int().min(1).max(DELIVERY_LIMITS.events),
            expandedBytes: z.number().int().min(1).max(DELIVERY_LIMITS.expandedBytes),
            stages: z.array(z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/)).max(32),
            sessionId: identifier.optional(),
            from: z.iso.datetime().nullable().optional(),
            to: z.iso.datetime().nullable().optional(),
            version: z
              .string()
              .regex(/^[a-zA-Z0-9.+_-]{1,64}$/)
              .nullable()
              .optional(),
            failures: counter.optional(),
            failureKinds: z
              .array(z.string().regex(/^[a-z_]{1,32}$/))
              .max(16)
              .optional(),
            sourceTimeUnknownRecords: counter.optional(),
          }),
        }),
      )
      .max(DELIVERY_LIMITS.batches),
    omitted: counter,
    omissionReasons: z.record(z.string().max(96), counter),
    acknowledged: counter,
    nextAttemptAt: z.number().min(0).max(Number.MAX_SAFE_INTEGER),
    failures: counter,
    consecutiveFailures: counter.default(0),
    serverRetryAt: counter.default(0),
  })
  .passthrough()
  .refine(
    (v) =>
      Object.keys(v.sessions).length <= DELIVERY_LIMITS.sessions &&
      v.withdrawals.length +
        v.retiredIdentities.length +
        (v.credentials && (v.credentials.enrollmentAttempted || v.credentials.token) ? 1 : 0) <=
        DELIVERY_LIMITS.tombstones &&
      v.queue.reduce((n, b) => n + b.bytes, 0) <=
        DELIVERY_LIMITS.queueBytes + DELIVERY_LIMITS.batches * DIAGNOSTIC_PERMIT_BYTES &&
      (!v.consent || v.credentials !== null),
  );
async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const limit = 8192;
  if (Number(response.headers.get('content-length')) > limit || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw Object.assign(new Error('receipt_size_or_body'), {
      reason: 'receipt_invalid',
      status: response.status,
    });
  }
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      let aborted: () => void = () => {};
      const item = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          aborted = () => reject(new Error('receipt_timeout'));
          if (signal.aborted) aborted();
          else signal.addEventListener('abort', aborted, { once: true });
        }),
      ]).finally(() => signal.removeEventListener('abort', aborted));
      if (item.done) break;
      bytes += item.value.length;
      if (bytes > limit) throw new Error('receipt_size_budget');
      chunks.push(item.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('receipt_invalid');
    return value;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw Object.assign(error instanceof Error ? error : new Error('receipt_invalid'), {
      status: response.status,
      reason: signal.aborted
        ? 'request_timeout'
        : transportFailureReason(error) === 'unconfirmed'
          ? 'receipt_invalid'
          : transportFailureReason(error),
    });
  }
}
const initial = (): State => ({
  version: 1,
  consentPolicy: 3,
  consent: false,
  paused: false,
  consentAt: null,
  closedReason: null,
  lastAttemptAt: null,
  lastConfirmedAt: null,
  transportFailure: null,
  credentials: null,
  withdrawals: [],
  retiredIdentities: [],
  sessions: {},
  queue: [],
  omitted: 0,
  omissionReasons: {},
  acknowledged: 0,
  nextAttemptAt: 0,
  failures: 0,
  consecutiveFailures: 0,
  serverRetryAt: 0,
});
const checksum = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
export function diagnosticsEndpoint(value: string | undefined, test = false): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    (url.protocol !== 'https:' &&
      !(test && url.protocol === 'http:' && url.hostname === '127.0.0.1'))
  )
    throw new Error('invalid_diagnostics_endpoint');
  return url.origin;
}
function cloudRecord(line: string, consentAt: string | null): unknown {
  const value = JSON.parse(line) as Record<string, unknown>;
  if (value.schema !== 'mizar-diagnostic-event/2') throw new Error('current_event_required');
  return technicalProjection(value, consentAt);
}
async function secureRead(directory: string, name: string, maximum: number) {
  await safePath(directory, name);
  const path = join(directory, name);
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum)
    throw new Error('unsafe_diagnostics_file');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.nlink !== 1 ||
      stat.size > maximum
    )
      throw new Error('diagnostics_file_changed');
    return await file.readFile();
  } finally {
    await file.close();
  }
}
async function recoverSealedBatch(directory: string, name: string, expected: Buffer) {
  const path = await safePath(directory, name);
  const before = await lstat(path);
  const file = await open(
    path,
    constants.O_RDWR | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.ino !== before.ino ||
      stat.dev !== before.dev ||
      stat.nlink !== 1 ||
      stat.size > DELIVERY_LIMITS.compressedBytes
    )
      throw new Error('diagnostics_file_changed');
    const actual = await file.readFile();
    if (actual.length !== stat.size || (await file.stat()).size !== stat.size)
      throw new Error('diagnostics_file_changed');
    if (actual.length > expected.length || !expected.subarray(0, actual.length).equals(actual))
      throw new Error('sealed_batch_conflict');
    // A write interrupted before fsync can leave an empty file or exact prefix.
    // The same verified handle appends only the missing suffix; existing bytes
    // are never truncated or replaced, including when this repair is interrupted.
    if (actual.length < expected.length) await file.writeFile(expected.subarray(actual.length));
    await file.sync();
    const verified = Buffer.alloc(expected.length);
    let offset = 0;
    while (offset < verified.length) {
      const { bytesRead } = await file.read(verified, offset, verified.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const final = await file.stat();
    if (offset !== expected.length || final.size !== expected.length || !verified.equals(expected))
      throw new Error('sealed_batch_conflict');
    const current = await lstat(path);
    if (
      final.nlink !== 1 ||
      !current.isFile() ||
      current.ino !== stat.ino ||
      current.dev !== stat.dev ||
      current.nlink !== 1 ||
      current.size !== expected.length
    )
      throw new Error('diagnostics_file_changed');
  } finally {
    await file.close();
  }
}
/** Fixed-length safe traversal of current producer segments; no full log buffer. */
async function* sourceLines(directory: string, name: string): AsyncGenerator<string> {
  const path = await safePath(directory, name);
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > 100 * 1024 * 1024
  )
    throw new Error('unsafe_diagnostic_source');
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await file.stat();
    if (actual.ino !== before.ino || actual.dev !== before.dev || actual.nlink !== 1)
      throw new Error('diagnostic_source_changed');
    let offset = 0;
    let tail = Buffer.alloc(0);
    const chunk = Buffer.alloc(64 * 1024);
    while (offset < before.size) {
      const { bytesRead } = await file.read(
        chunk,
        0,
        Math.min(chunk.length, before.size - offset),
        offset,
      );
      if (!bytesRead) throw new Error('diagnostic_source_truncated');
      offset += bytesRead;
      tail = Buffer.concat([tail, chunk.subarray(0, bytesRead)]);
      let newline: number;
      while ((newline = tail.indexOf(10)) >= 0) {
        if (newline > DELIVERY_LIMITS.expandedBytes / 2)
          throw new Error('diagnostic_source_line_budget');
        yield tail.subarray(0, newline).toString('utf8');
        tail = tail.subarray(newline + 1);
      }
      if (tail.length > DELIVERY_LIMITS.expandedBytes / 2)
        throw new Error('diagnostic_source_line_budget');
    }
    if (tail.length) throw new Error('diagnostic_source_uncommitted_tail');
  } finally {
    await file.close();
  }
}
type JournalSource = { name: string; run: string; sequence: number; order: number };
async function orderedSources(directory: string) {
  const names = await diagnosticSegmentNames(directory);
  const records: JournalSource[] = [];
  let unavailable: unknown = null;
  for (const [order, name] of names.entries()) {
    let run = '';
    let sequence = 0;
    if (name.startsWith('session-')) {
      try {
        for await (const line of sourceLines(directory, name)) {
          const event = JSON.parse(line) as {
            producerKind?: string;
            producerRunId?: string;
            sequence?: number;
            journal?: { producerRunId?: string; sequence?: number };
          };
          // A session segment may start with a document event. Its durable owner
          // is the journal carrier, not that event's browser producer.
          run =
            event.journal?.producerRunId ??
            (event.producerKind === 'companion' ? (event.producerRunId ?? '') : '');
          sequence = event.journal?.sequence ?? event.sequence ?? 0;
          if (!run || !Number.isSafeInteger(sequence) || sequence <= 0)
            throw new Error('journal_source_sequence_invalid');
          break;
        }
      } catch (error) {
        if (missing(error)) continue;
        unavailable = error;
        continue;
      }
      // Empty active files have no committed records. A later commit triggers
      // another scan; do not read them again without a known carrier boundary.
      if (!run) continue;
    }
    records.push({ name, run, sequence, order });
  }
  // A run may now have two interleaved physical streams. Keep runs in
  // first-seen order, but merge their carrier sequences rather than whole files.
  const groups: JournalSource[][] = [];
  const runs = new Map<string, JournalSource[]>();
  for (const record of records) {
    if (!record.run) {
      groups.push([record]);
      continue;
    }
    let group = runs.get(record.run);
    if (!group) {
      group = [];
      runs.set(record.run, group);
      groups.push(group);
    }
    group.push(record);
  }
  for (const group of groups) group.sort((a, b) => a.sequence - b.sequence);
  return { groups, unavailable };
}
/** At most two overlapping streams per journal run. Legacy segments do not
 * overlap. Open successors only when their first sequence can precede a head;
 * neither the entire run nor an unbounded set of file handles is retained. */
async function* mergedSourceLines(directory: string, sources: JournalSource[]) {
  if (!sources[0]?.run) {
    yield* sourceLines(directory, sources[0]!.name);
    return;
  }
  const run = sources[0].run;
  const heads: { reader: AsyncGenerator<string>; line: string; sequence: number }[] = [];
  let next = 0;
  let emitted = 0;
  const sequenceOf = (line: string) => {
    const event = JSON.parse(line) as {
      producerRunId?: string;
      sequence?: number;
      journal?: { producerRunId?: string; sequence?: number };
    };
    const sequence = event.journal?.sequence ?? event.sequence;
    if (
      (event.journal?.producerRunId ?? event.producerRunId) !== run ||
      !Number.isSafeInteger(sequence) ||
      sequence! <= 0
    )
      throw new Error('journal_source_sequence_invalid');
    return sequence!;
  };
  try {
    while (next < sources.length || heads.length) {
      heads.sort((a, b) => a.sequence - b.sequence);
      if (
        next < sources.length &&
        (!heads.length || sources[next]!.sequence <= heads[0]!.sequence)
      ) {
        if (heads.length >= 2) throw new Error('journal_source_overlap_budget');
        const source = sources[next++]!;
        const reader = sourceLines(directory, source.name);
        try {
          const first = await reader.next();
          if (first.done) throw new Error('journal_source_changed');
          const sequence = sequenceOf(first.value);
          if (sequence !== source.sequence) throw new Error('journal_source_changed');
          heads.push({ reader, line: first.value, sequence });
        } catch (error) {
          await reader.return(undefined);
          throw error;
        }
        continue;
      }
      const head = heads[0]!;
      if (head.sequence <= emitted) throw new Error('journal_source_sequence_order');
      emitted = head.sequence;
      yield head.line;
      const value = await head.reader.next();
      if (value.done) heads.shift();
      else {
        head.line = value.value;
        head.sequence = sequenceOf(value.value);
      }
    }
  } finally {
    await Promise.all(heads.map((head) => head.reader.return(undefined)));
  }
}
/** Raw batches are never inflated without a bound, including malicious cloud archives. */
export async function decodeDiagnosticBatch(bytes: Buffer) {
  if (bytes.length > DELIVERY_LIMITS.compressedBytes) throw new Error('compressed_budget');
  const raw = await decompress(bytes, { maxOutputLength: DELIVERY_LIMITS.expandedBytes });
  const value = JSON.parse(raw.toString('utf8')) as { schema?: string; events?: unknown[] };
  if (
    value.schema !== 'mizar-technical-diagnostics/1' ||
    !Array.isArray(value.events) ||
    value.events.length > DELIVERY_LIMITS.events
  )
    throw new Error('invalid_diagnostics_batch');
  return value;
}
function transportReceiptError(operation: string, status: number, receipt: unknown) {
  const detail =
    receipt && typeof receipt === 'object'
      ? (receipt as { error?: unknown; stage?: unknown })
      : null;
  const code = detail?.error;
  const receiverStage = DIAGNOSTIC_RECEIVER_STAGES.find((stage) => stage === detail?.stage);
  const reason =
    typeof code === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(code) ? code : 'receipt_invalid';
  return Object.assign(
    new Error(`${operation}_unconfirmed_${status}`, { cause: new Error(reason) }),
    { status, reason, receiverStage },
  );
}
function batchMetadata(sessionId: string, events: unknown[]) {
  const records = events as {
    time?: unknown;
    appVersion?: unknown;
    stage?: string;
    evidence?: { sourceRecord?: { time?: unknown } };
  }[];
  const envelopes = records.map(diagnosticEnvelope);
  const times = envelopes.flatMap((value) => value.times).sort();
  const version = records.find(
    (value) =>
      typeof value.appVersion === 'string' && /^[a-zA-Z0-9.+_-]{1,64}$/.test(value.appVersion),
  )?.appVersion;
  const canonical = events as Record<string, unknown>[];
  const v2 = canonical.every((event) => event.schema === 'mizar-diagnostic-event/2');
  return {
    ...(v2
      ? {
          eventSchemaVersion: 2 as const,
          producerKind: String(canonical[0]!.producerKind),
          uniqueEvents: new Set(canonical.map((event) => event.eventId)).size,
          aggregatedOccurrences: canonical.reduce(
            (n, event) =>
              n + Number((event.coverage as { occurrences?: number })?.occurrences ?? 1),
            0,
          ),
        }
      : {}),
    sessionId,
    from: times[0] ?? null,
    to: times.at(-1) ?? null,
    version: typeof version === 'string' ? version : null,
    failures: envelopes.filter((value) => value.failureKinds.length > 0).length,
    failureKinds: [...new Set(envelopes.flatMap((value) => value.failureKinds))].sort(),
    sourceTimeUnknownRecords: envelopes.filter((value) => value.sourceTimeUnknown).length,
  };
}

/** One local outbox. Queue references and source cursors commit together, before upload. */
export class DiagnosticDelivery {
  private state = initial();
  private pending: { line: string; sessionId: string; cursorId: string; sequence: number }[] = [];
  private pendingBytes = 0;
  private recoveryNeeded = false;
  private serial = Promise.resolve();
  private sending: Promise<void> | undefined;
  private cleaningAcknowledged: Promise<void> | undefined;
  private acknowledgedScanNext: string | undefined;
  private abort: AbortController | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private epoch = 0;
  private requestedConsent = false;
  private requestedPause = false;
  private pauseEpoch = 0;
  private revocationFenced = false;
  private readonly fences = new Map<string, Promise<void>>();
  private error: string | null = null;
  private transportPhase: 'enrollment' | 'permit' | 'upload' | 'withdrawal' | null = null;
  private transportAttempt: { attemptId: string; started: number } | null = null;
  private readonly endpoint: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly queueDirectory: string;
  private nextCollectionAt: number;
  private collectionScheduled = false;
  private sourceRevision = 0;
  private readonly cleanupAbort = new AbortController();
  private readonly pendingPinReleases = new Map<
    string,
    {
      pinId: string;
      participant: IncidentParticipant;
      reported: boolean;
    }
  >();
  constructor(
    private readonly directory: string,
    private readonly journal: SessionJournal,
    private readonly options: {
      endpoint?: string;
      endpointSource?: 'product_default' | 'environment_override';
      fetch?: typeof fetch;
      now?: () => number;
      allowTestEndpoint?: boolean;
      onConsent?: () => Promise<void>;
      participants?: () => IncidentParticipant[];
    } = {},
  ) {
    this.endpoint = diagnosticsEndpoint(options.endpoint, options.allowTestEndpoint);
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.nextCollectionAt = this.now() + DELIVERY_LIMITS.collectMs;
    this.queueDirectory = join(directory, 'diagnostic-outbox');
  }
  async initialize(startTimer = true) {
    await mkdir(this.queueDirectory, { recursive: true, mode: 0o700 });
    await safePath(this.queueDirectory);
    try {
      this.state = stateSchema.parse(
        JSON.parse(
          (
            await secureRead(this.queueDirectory, 'state.json', DELIVERY_LIMITS.manifestBytes)
          ).toString(),
        ),
      ) as State;
    } catch (error) {
      if (!missing(error)) {
        this.error = 'state_unreadable';
        throw error;
      }
    }
    await this.isolateRetiredQueue();
    if (this.state.transportFailure?.phase === 'withdrawal') {
      // Older manifests assigned deletion failures to the upload's retry slot.
      // Preserve that deadline on its old identity, not on a later consent.
      const withdrawal = this.state.withdrawals[0];
      if (withdrawal) {
        withdrawal.nextAttemptAt = Math.ceil(
          Math.max(
            withdrawal.nextAttemptAt ?? 0,
            this.state.nextAttemptAt,
            this.state.serverRetryAt,
          ),
        );
        withdrawal.serverRetryAt = Math.max(
          withdrawal.serverRetryAt ?? 0,
          this.state.serverRetryAt,
        );
        withdrawal.consecutiveFailures = Math.max(
          withdrawal.consecutiveFailures ?? 0,
          this.state.consecutiveFailures,
        );
      }
      this.state.transportFailure = null;
      this.state.nextAttemptAt = 0;
      this.state.serverRetryAt = 0;
      this.state.consecutiveFailures = 0;
      await this.save();
    }
    const entries = await readdir(this.queueDirectory, { withFileTypes: true });
    for (const entry of entries)
      if (/^consent-(?:policy-)?revoked-[a-f0-9-]{36}\.flag$/.test(entry.name)) {
        await secureRead(this.queueDirectory, entry.name, 16);
        if (this.fences.size >= 64) throw new Error('revocation_marker_budget');
        this.fences.set(entry.name, Promise.resolve());
      }
    // Finite automatic delivery and rotating identities require the current
    // explicit disclosure. Earlier policies never silently migrate consent.
    if (
      this.state.consent &&
      (this.state.consentPolicy !== 3 ||
        diagnosticInstallationCreatedAt(this.state.credentials?.installationId ?? '') === null)
    ) {
      const name = `consent-policy-revoked-${randomUUID()}.flag`;
      await this.createFence(name);
      this.fences.set(name, Promise.resolve());
      this.error = 'consent_policy_changed';
    }
    if (this.fences.size) {
      this.revocationFenced = true;
      const preserveCopies = ![...this.fences.keys()].some((name) =>
        name.startsWith('consent-revoked-'),
      );
      if (preserveCopies) this.error = 'consent_policy_changed';
      for (const retired of this.state.retiredIdentities)
        if (
          !this.state.withdrawals.some((value) => value.installationId === retired.installationId)
        )
          this.state.withdrawals.push(retired);
      this.state.retiredIdentities = [];
      if (
        this.state.credentials &&
        (this.state.credentials.enrollmentAttempted || this.state.credentials.token) &&
        !this.state.withdrawals.some(
          (v) => v.installationId === this.state.credentials!.installationId,
        )
      )
        this.state.withdrawals.push(this.state.credentials);
      this.state.consent = false;
      this.state.closedReason = preserveCopies ? 'policy_changed' : 'user';
      this.state.credentials = null;
      this.state.sessions = {};
      if (preserveCopies) {
        for (const batch of this.state.queue) {
          if (!batch.serverExpired) this.omitted('consent_policy_changed', batch.index.events);
          batch.serverExpired = true;
          batch.unavailableReason = 'consent_policy_changed';
        }
      } else this.state.queue = [];
      this.state.consecutiveFailures = 0;
      this.state.nextAttemptAt = 0;
      await this.save();
    }
    if (
      this.state.transportFailure?.status === null &&
      this.state.transportFailure.reason !== 'receiver_upgrade_required' &&
      this.state.serverRetryAt <= this.now()
    ) {
      this.state.nextAttemptAt = Math.max(
        this.now(),
        (Date.parse(this.state.lastAttemptAt ?? '') || 0) + 30_000,
      );
      await this.save();
    }
    this.requestedConsent = this.state.consent;
    this.requestedPause = this.state.paused;
    // Unreferenced wire files may contain unique evidence. Initialization never
    // deletes them; export classifies them without converting their bodies.
    this.unsubscribe = this.journal.subscribe((line) => {
      this.sourceRevision++;
      this.observe(line);
    });
    if (this.state.consent) {
      await this.recover();
      this.registerSession(0);
      await this.save();
      await this.recover();
    }
    if (startTimer) {
      this.timer = setInterval(() => {
        void this.tick(false).catch(() => {
          this.error = 'delivery_failed';
        });
      }, DELIVERY_LIMITS.pollMs);
      this.timer.unref();
    }
    return this;
  }
  /** Remove only proven retired-format references from current queue accounting.
   * Bodies stay in place. Missing, invalid or mixed bodies remain protected. */
  private async isolateRetiredQueue() {
    const previous = this.state.queue;
    const current: Batch[] = [];
    let isolated = 0;
    let changed = false;
    for (const batch of previous) {
      if (batch.index.eventSchemaVersion === 2) {
        current.push(batch);
        continue;
      }
      try {
        const bytes = await secureRead(
          this.queueDirectory,
          `${batch.id}.gz`,
          DELIVERY_LIMITS.compressedBytes,
        );
        if (checksum(bytes) !== batch.id) throw new Error('queue_source_digest_changed');
        const decoded = await decodeDiagnosticBatch(bytes);
        const events = decoded.events!.map((value) =>
          value && typeof value === 'object' ? (value as Record<string, unknown>) : {},
        );
        if (events.length && events.every((event) => event.schema === 'mizar-diagnostic-event/2')) {
          current.push({ ...batch, index: { ...batch.index, eventSchemaVersion: 2 } });
          changed = true;
        } else if (
          events.length &&
          events.every(
            (event) =>
              event.schema === 'mizar-diagnostic-event/1' ||
              (event.schema === undefined &&
                typeof event.startupSessionId === 'string' &&
                Number.isSafeInteger(event.sequence) &&
                typeof event.stage === 'string'),
          )
        ) {
          isolated++;
          changed = true;
        } else {
          current.push(batch);
          this.error = 'queue_format_unconfirmed';
        }
      } catch {
        current.push(batch);
        this.error = 'queue_format_unconfirmed';
      }
    }
    if (!changed) return;
    this.state.queue = current;
    try {
      await this.save();
    } catch (error) {
      this.state.queue = previous;
      throw error;
    }
    if (isolated)
      this.journal.record('diagnostic_retired_queue_isolated', {
        batches: isolated,
        bodies: 'retained in place; excluded from current queue accounting',
      });
  }
  private registerSession(from: number) {
    if (
      !this.state.sessions[this.journal.sessionId] &&
      Object.keys(this.state.sessions).length >= DELIVERY_LIMITS.sessions
    ) {
      this.error = 'session_budget_waiting_for_capacity';
      this.recoveryNeeded = true;
      return;
    }
    this.state.sessions[this.journal.sessionId] ??= { from, queued: from };
  }
  status() {
    return {
      configured: Boolean(this.endpoint),
      consent: this.consentActive(),
      paused: this.requestedPause,
      consentAt: this.state.consentAt,
      closedReason: this.state.closedReason,
      lastAttemptAt: this.state.lastAttemptAt,
      lastConfirmedAt: this.state.lastConfirmedAt,
      transportFailure: this.state.transportFailure,
      queuedBatches: this.state.queue.filter((value) => !value.acknowledgedAt).length,
      retainedAcknowledgedBatches: this.state.queue.filter((value) => value.acknowledgedAt).length,
      blockedBatches: this.state.queue.filter(
        (value) => value.serverExpired && !value.acknowledgedAt,
      ).length,
      queuedBytes: this.state.queue.reduce((n, v) => n + v.bytes, 0),
      pendingBytes: this.pendingBytes,
      omitted: this.state.omitted,
      omissionReasons: this.state.omissionReasons,
      acknowledged: this.state.acknowledged,
      deletionPending: this.state.withdrawals.length,
      retiredIdentityCount: this.state.retiredIdentities.length,
      nextAttemptAt: this.state.nextAttemptAt,
      failures: this.state.failures,
      consecutiveFailures: this.state.consecutiveFailures,
      sendableBatches: this.state.queue.filter((value) => !value.serverExpired).length,
      manualOnlyBatches: this.state.queue.filter(
        (value) => value.serverExpired && !value.acknowledgedAt,
      ).length,
      error: [...this.pendingPinReleases.values()].some((pin) => pin.reported)
        ? 'ack_pin_release_pending'
        : this.error,
      scope:
        'technical diagnostics; not anonymous; cloud completeness is bounded by explicitly reported local and server budgets',
    };
  }
  private transaction<T>(work: () => Promise<T>): Promise<T> {
    const task = this.serial.then(work);
    this.serial = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
  private async save() {
    await safePath(this.queueDirectory);
    const temporary = join(this.queueDirectory, 'state.json.tmp');
    await unlink(temporary).catch((error) => {
      if (!missing(error)) throw error;
    });
    const fd = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      const text = JSON.stringify(this.state);
      if (Buffer.byteLength(text) > DELIVERY_LIMITS.manifestBytes)
        throw new Error('manifest_budget');
      await fd.writeFile(text);
      await fd.sync();
    } finally {
      await fd.close();
    }
    await safePath(this.queueDirectory, 'state.json').catch((error) => {
      if (!missing(error)) throw error;
    });
    await rename(temporary, join(this.queueDirectory, 'state.json'));
  }
  private consentActive() {
    return this.state.consent && this.requestedConsent && !this.revocationFenced;
  }
  private async createFence(name: string) {
    try {
      await safePath(this.queueDirectory);
      const file = await open(
        join(this.queueDirectory, name),
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        await file.writeFile('revoked');
        await file.sync();
      } finally {
        await file.close();
      }
    } catch (error) {
      // If even a tiny fence cannot be made durable, removing the old consent
      // manifest is the last fail-closed option. Never report success here.
      await unlink(join(this.queueDirectory, 'state.json')).catch(() => undefined);
      throw error;
    }
  }
  async consent(enabled: boolean) {
    const epoch = ++this.epoch;
    this.requestedConsent = enabled;
    this.abort?.abort();
    const olderFences = [...this.fences.entries()];
    let fence = Promise.resolve();
    if (!enabled) {
      this.revocationFenced = true;
      const name = `consent-revoked-${randomUUID()}.flag`;
      fence = this.createFence(name);
      this.fences.set(
        name,
        fence.catch(() => undefined),
      );
    }
    return this.transaction(async () => {
      if (enabled && epoch !== this.epoch) return this.status();
      if (enabled) {
        if (this.state.consent && !this.revocationFenced) {
          // A preceding baseline write can fail after consent itself was saved.
          // An explicit retry must capture it rather than silently returning success.
          await this.options.onConsent?.();
          return this.status();
        }
        if (
          this.state.withdrawals.length + this.state.retiredIdentities.length >=
          DELIVERY_LIMITS.tombstones
        )
          throw new Error('withdrawal_sync_required');
        const previous = structuredClone(this.state);
        this.state.consent = true;
        this.state.consentPolicy = 3;
        this.state.closedReason = null;
        this.state.transportFailure = null;
        this.state.consentAt = new Date(this.now()).toISOString();
        this.state.credentials = {
          installationId: diagnosticInstallationId(this.now(), randomBytes(16)),
          enrollmentSecret: randomBytes(32).toString('hex'),
        };
        this.state.sessions = {};
        this.registerSession(this.journal.health().sequence);
        try {
          await this.save();
        } catch (error) {
          this.state = previous;
          if (epoch === this.epoch) this.requestedConsent = false;
          throw error;
        }
        if (this.error === 'consent_policy_changed') this.error = null;
        // Remove only fences already present at THIS enable request. A later
        // revocation has a distinct name, so an older enable cannot erase it.
        for (const [name, created] of olderFences) {
          await created;
          await unlink(join(this.queueDirectory, name)).catch((error) => {
            if (!missing(error)) throw error;
          });
          this.fences.delete(name);
        }
        if (epoch === this.epoch) this.revocationFenced = this.fences.size > 0;
        // Capture current state after the durable consent boundary, never replay
        // the pre-consent startup snapshot. Journal ingress does not await this transaction.
        if (epoch === this.epoch && this.consentActive()) await this.options.onConsent?.();
      } else {
        await fence;
        const prior = this.state.credentials;
        for (const retired of this.state.retiredIdentities)
          if (
            !this.state.withdrawals.some((value) => value.installationId === retired.installationId)
          )
            this.state.withdrawals.push(retired);
        this.state.retiredIdentities = [];
        this.state.consent = false;
        this.state.closedReason = 'user';
        this.state.transportFailure = null;
        if (
          prior &&
          (prior.enrollmentAttempted || prior.token) &&
          !this.state.withdrawals.some((v) => v.installationId === prior.installationId)
        )
          this.state.withdrawals.push(prior);
        this.state.credentials = null;
        this.state.sessions = {};
        this.pending = [];
        this.pendingBytes = 0;
        this.state.queue.splice(0);
        this.state.nextAttemptAt = 0;
        this.state.consecutiveFailures = 0;
        await this.save();
        // The manifest now durably says off. Keep this request's fence and
        // remove only older markers; a later request must retain its own fence.
        for (const [name, created] of olderFences) {
          await created;
          await unlink(join(this.queueDirectory, name)).catch((error) => {
            if (!missing(error)) throw error;
          });
          this.fences.delete(name);
        }
        // Revocation removes sending authority, not independent local evidence.
        // Unacknowledged current wire evidence remains available to manual export.
      }
      this.journal.record('diagnostic_consent', {
        enabled: this.consentActive(),
        requested: enabled,
        revision: CONSENT,
        result: 'persisted',
        deletionPending: this.state.withdrawals.length,
      });
      return this.status();
    });
  }
  async pause(paused: boolean) {
    const epoch = ++this.pauseEpoch;
    // Stopping is immediate. Resuming waits for its durable setting commit.
    if (paused) {
      this.requestedPause = true;
      this.abort?.abort();
    }
    return this.transaction(async () => {
      const previous = this.state.paused;
      this.state.paused = paused;
      this.state.nextAttemptAt = Math.max(
        this.now(),
        this.state.serverRetryAt,
        (Date.parse(this.state.lastAttemptAt ?? '') || 0) + 30_000,
      );
      try {
        await this.save();
      } catch (error) {
        this.state.paused = previous;
        if (epoch === this.pauseEpoch) this.requestedPause = previous;
        throw error;
      }
      if (epoch === this.pauseEpoch) this.requestedPause = paused;
      this.journal.record('diagnostic_transport', { paused, trigger: 'user', queue: 'retained' });
      return this.status();
    });
  }
  private omitted(reason: string, count = 1) {
    this.state.omitted += count;
    this.state.omissionReasons[reason] = (this.state.omissionReasons[reason] ?? 0) + count;
  }
  private observe(line: string, recovering = false, namespace = '') {
    if (!this.consentActive() || this.closed || (this.recoveryNeeded && !recovering)) return;
    // Journal supplies an immutable, already-redacted durable record.
    const value = JSON.parse(line) as {
      startupSessionId: string;
      producerRunId?: string;
      producerKind?: string;
      journal?: { producerRunId?: string; sequence?: number };
      schema?: string;
      observedAt?: string;
      recordedAt?: string;
      kind?: string;
      sequence: number;
      stage: string;
    };
    if (value.schema !== 'mizar-diagnostic-event/2') return;
    // HTTP document records share the Companion writer's durable stream. Use
    // its carrier watermark so delayed browser sequence values are not skipped.
    // The event's original producer tuple remains unchanged in the wire body.
    const carrier = value.producerKind === 'document' ? value.journal : undefined;
    const journalCursor =
      typeof carrier?.producerRunId === 'string' &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(carrier.producerRunId) &&
      Number.isSafeInteger(carrier.sequence) &&
      Number(carrier.sequence) > 0;
    const cursorId =
      namespace +
      (journalCursor ? carrier.producerRunId : (value.producerRunId ?? value.startupSessionId));
    const sequence = journalCursor ? Number(carrier.sequence) : value.sequence;
    if (value.schema === 'mizar-diagnostic-event/2') {
      value.startupSessionId = value.producerRunId ?? '';
      value.stage = value.kind ?? '';
      const time = diagnosticSourceUtc(value.observedAt);
      if (!time || !this.state.consentAt || time < this.state.consentAt) return;
    }
    if (
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.startupSessionId) ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 1 ||
      typeof value.stage !== 'string' ||
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(value.stage)
    ) {
      this.omitted('invalid_source_cursor');
      return;
    }
    // Invalid records and new chat-only sources must not consume producer slots.
    // Existing cursors deduplicate old chat records before counting their exclusion.
    if (!this.state.sessions[cursorId] && /chat/i.test(value.stage)) {
      this.omitted('chat_not_collected');
      return;
    }
    if (
      !this.state.sessions[cursorId] &&
      Object.keys(this.state.sessions).length < DELIVERY_LIMITS.sessions
    )
      this.state.sessions[cursorId] = { from: 0, queued: 0 };
    const cursor = this.state.sessions[cursorId];
    if (!cursor) {
      // Never treat a producer rejected by the cursor budget as a completed scan.
      this.error = 'session_budget_waiting_for_capacity';
      this.recoveryNeeded = true;
      return 'cursor-capacity' as const;
    }
    if (
      sequence <= cursor.queued ||
      this.pending.some((v) => v.cursorId === cursorId && v.sequence === sequence)
    )
      return;
    if (/chat/i.test(value.stage)) {
      this.omitted('chat_not_collected');
      return;
    }
    const bytes = Buffer.byteLength(line);
    if (bytes > DELIVERY_LIMITS.expandedBytes / 2) {
      this.omitted('event_size_budget');
      return;
    }
    if (this.pendingBytes + bytes > DELIVERY_LIMITS.pendingBytes) {
      this.omitted('memory_budget_recoverable_from_local_journal');
      this.recoveryNeeded = true;
      return false;
    }
    this.pending.push({
      line,
      sessionId: value.startupSessionId,
      cursorId,
      sequence,
    });
    this.pendingBytes += bytes;
    if (value.stage === 'problem_report')
      this.nextCollectionAt = Math.min(this.nextCollectionAt, this.now() + 15_000);
    if (
      !recovering &&
      !this.collectionScheduled &&
      this.pendingBytes >= DELIVERY_LIMITS.pendingBytes * 0.75
    ) {
      this.collectionScheduled = true;
      void this.transaction(async () => {
        await this.persist();
        this.nextCollectionAt = this.now() + DELIVERY_LIMITS.collectMs;
      })
        .catch(() => {
          this.error = 'queue_write_unconfirmed';
        })
        .finally(() => {
          this.collectionScheduled = false;
        });
    }
  }
  private async recover() {
    if (!this.consentActive() || this.closed) return;
    // A live commit must not overtake an older record in the disk snapshot.
    // Keep live notifications behind recovery until a complete scan is stable.
    this.recoveryNeeded = true;
    const startedRevision = this.sourceRevision;
    const sourceHealth = this.journal.health();
    const startedSequence = sourceHealth.sequence;
    // Separate file snapshots must not admit a newer commit from one stream
    // while the other snapshot still omits an earlier committed record.
    const committedCutoff = sourceHealth.committedSequence;
    let sourceUnavailable = false;
    // Fixed Mizar log names only; source rotation remains governed by SessionJournal.
    const indexed = await orderedSources(this.directory);
    if (indexed.unavailable) {
      sourceUnavailable = true;
      this.error =
        indexed.unavailable instanceof Error ? indexed.unavailable.message : 'journal_unreadable';
    }
    for (const sources of indexed.groups) {
      // An unidentified journal source could contain an earlier carrier from
      // any run. Other producers remain readable, but no journal cursor may
      // overtake it until its boundary can be established.
      if (indexed.unavailable && sources[0]?.run) continue;
      let count = 0;
      try {
        for await (const line of mergedSourceLines(this.directory, sources)) {
          if (!line) continue;
          if (sources[0]?.run === sourceHealth.sessionId) {
            const event = JSON.parse(line) as { sequence: number; journal?: { sequence: number } };
            if ((event.journal?.sequence ?? event.sequence) > committedCutoff) break;
          }
          let admitted: ReturnType<DiagnosticDelivery['observe']> = undefined;
          try {
            admitted = this.observe(line + '\n', true);
          } catch {
            this.omitted('unreadable_journal_record');
          }
          if (admitted === 'cursor-capacity') sourceUnavailable = true;
          if (admitted === false) {
            await this.persist();
            return;
          }
          if (++count % 32 === 0) await yieldIO();
          if (this.pendingBytes > DELIVERY_LIMITS.pendingBytes / 2 && !(await this.persist()))
            return;
          if (this.state.queue.length >= DELIVERY_LIMITS.batches) {
            this.error = 'queue_budget_local_journal_retained';
            // Capacity may stop recovery before reaching the unqueued tail in a
            // later segment. Keep scanning eligible source records after ACKs
            // release space, including when this process has just restarted.
            this.recoveryNeeded = true;
            return;
          }
        }
      } catch (error) {
        // A source removed after indexing interrupts the entire merged run,
        // not just that file. Re-enumerate before admitting later live commits.
        this.error = missing(error)
          ? 'journal_source_changed_during_recovery'
          : error instanceof Error
            ? error.message
            : 'journal_unreadable';
        sourceUnavailable = true;
      }
    }
    // Performance bodies are final gzip evidence, not copies inside the ordinary journal.
    const performanceDirectory = join(this.directory, 'performance-pending');
    try {
      await safePath(performanceDirectory);
      const files = (await readdir(performanceDirectory)).filter((name) =>
        /^[a-f0-9-]{36}\.[a-f0-9]{4}\.gz$/.test(name),
      );
      const ordered: { name: string; run: string; sequence: number }[] = [];
      const read = async (name: string) => {
        const bytes = await secureRead(performanceDirectory, name, 1536 * 1024);
        const raw = await decompress(bytes, { maxOutputLength: 1024 * 1024 });
        const records = JSON.parse(raw.toString('utf8')) as Record<string, unknown>[];
        if (
          !Array.isArray(records) ||
          records.length > DELIVERY_LIMITS.events ||
          records.some((event) => event.schema !== 'mizar-diagnostic-event/2')
        )
          throw new Error('performance_source_format');
        return records;
      };
      for (const name of files) {
        try {
          const records = await read(name);
          if (records[0])
            ordered.push({
              name,
              run: String(records[0].producerRunId),
              sequence: Number(records[0].sequence),
            });
        } catch {
          this.omitted('performance_source_unreadable');
          sourceUnavailable = true;
        }
      }
      ordered.sort((a, b) => a.run.localeCompare(b.run) || a.sequence - b.sequence);
      for (const source of ordered) {
        try {
          for (const event of await read(source.name)) {
            const admitted = this.observe(JSON.stringify(event) + '\n', true, 'performance:');
            if (admitted === 'cursor-capacity') sourceUnavailable = true;
            if (admitted === false) {
              await this.persist();
              return;
            }
          }
          if (this.pendingBytes > DELIVERY_LIMITS.pendingBytes / 2 && !(await this.persist()))
            return;
        } catch {
          this.omitted('performance_source_unreadable');
          sourceUnavailable = true;
        }
      }
    } catch (error) {
      if (!missing(error)) {
        this.omitted('performance_source_unavailable');
        sourceUnavailable = true;
      }
    }
    // A stable source clock does not mean the scan completed. Capacity or
    // unreadable source can leave an unadmitted tail; keep its cursors and the
    // recovery flag until both scanning and prefix persistence succeed.
    if (!(await this.persist()) || sourceUnavailable) return;
    // Keep producer cursors across restart; forgetting a recovered producer would
    // regenerate its already-queued immutable batches on the next scan.
    this.registerSession(0);
    await this.save();
    if (!this.state.sessions[this.journal.sessionId]) return;
    if (this.error === 'session_budget_waiting_for_capacity') this.error = null;
    // A record may have its sequence allocated before this scan but commit
    // after the file snapshot. Observe durable notifications as well as new
    // allocations so that this tail is picked up on the next bounded scan.
    this.recoveryNeeded =
      this.sourceRevision !== startedRevision || this.journal.health().sequence !== startedSequence;
  }
  private async persist(): Promise<boolean> {
    if (!this.consentActive()) return false;
    const epoch = this.epoch;
    // Bound this collection to its admitted prefix. New committed records may
    // arrive during compression/fsync; keep them for the next scheduled batch.
    this.pending.sort((a, b) => a.cursorId.localeCompare(b.cursorId) || a.sequence - b.sequence);
    let remaining = this.pending.length;
    while (remaining > 0) {
      const selected: typeof this.pending = [];
      let bytes = 128;
      for (const item of this.pending.slice(0, remaining)) {
        const length = Buffer.byteLength(item.line);
        if (
          selected.length &&
          (item.sessionId !== selected[0]!.sessionId ||
            bytes + length > DELIVERY_LIMITS.expandedBytes ||
            selected.length >= DELIVERY_LIMITS.events)
        )
          break;
        selected.push(item);
        bytes += length;
      }
      let events = selected.map((v) => cloudRecord(v.line, this.state.consentAt));
      let raw = Buffer.from(
        JSON.stringify({
          schema: 'mizar-technical-diagnostics/1',
          coverage: {
            omitted: this.state.omitted,
            reasons: this.state.omissionReasons,
            scope: 'consented retained technical journal; not complete raw GSI or browser pixels',
          },
          events,
        }),
      );
      let compressed = Buffer.from(stampDiagnosticGzip(await compress(raw), this.now()));
      while (
        selected.length > 1 &&
        (compressed.length > DELIVERY_LIMITS.compressedBytes - DIAGNOSTIC_PERMIT_BYTES ||
          raw.length > DELIVERY_LIMITS.expandedBytes)
      ) {
        selected.splice(Math.ceil(selected.length / 2));
        events = selected.map((v) => cloudRecord(v.line, this.state.consentAt));
        raw = Buffer.from(
          JSON.stringify({
            schema: 'mizar-technical-diagnostics/1',
            coverage: {
              omitted: this.state.omitted,
              reasons: this.state.omissionReasons,
              scope: 'consented retained technical journal; not complete raw GSI or browser pixels',
            },
            events,
          }),
        );
        compressed = Buffer.from(stampDiagnosticGzip(await compress(raw), this.now()));
      }
      if (!this.consentActive() || epoch !== this.epoch) return false;
      if (
        compressed.length > DELIVERY_LIMITS.compressedBytes - DIAGNOSTIC_PERMIT_BYTES ||
        raw.length > DELIVERY_LIMITS.expandedBytes
      ) {
        this.omitted('batch_size_budget', selected.length);
        this.pending.splice(0, selected.length);
        remaining -= selected.length;
        this.pendingBytes -= selected.reduce((n, v) => n + Buffer.byteLength(v.line), 0);
        continue;
      }
      if (
        this.state.queue.length >= DELIVERY_LIMITS.batches ||
        this.state.queue.reduce(
          (n, v) => n + v.bytes + (v.sealed ? 0 : DIAGNOSTIC_PERMIT_BYTES),
          0,
        ) +
          compressed.length +
          DIAGNOSTIC_PERMIT_BYTES >
          DELIVERY_LIMITS.queueBytes
      ) {
        this.error = 'queue_budget_local_journal_retained';
        return false;
      }
      const id = checksum(compressed);
      const path = join(this.queueDirectory, `${id}.gz`);
      await safePath(this.queueDirectory, `${id}.gz`).catch((error) => {
        if (!missing(error)) throw error;
      });
      let file: Awaited<ReturnType<typeof open>> | undefined;
      try {
        file = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        await file.writeFile(compressed);
        await file.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (
          checksum(
            await secureRead(this.queueDirectory, `${id}.gz`, DELIVERY_LIMITS.compressedBytes),
          ) !== id
        )
          throw new Error('existing_batch_integrity', { cause: error });
      } finally {
        await file?.close();
      }
      if (!this.consentActive() || epoch !== this.epoch) {
        await unlink(path).catch(() => undefined);
        return false;
      }
      const batch: Batch = {
        id,
        bytes: compressed.length,
        index: {
          schema: 'mizar-technical-diagnostics/1',
          events: events.length,
          expandedBytes: raw.length,
          stages: [...new Set(events.map((v) => (v as { stage: string }).stage))].slice(0, 32),
          ...batchMetadata(selected[0]!.sessionId, events),
        },
      };
      const oldCursors = structuredClone(this.state.sessions);
      const oldQueue = [...this.state.queue];
      this.state.queue.push(batch);
      for (const item of selected) {
        const cursor = this.state.sessions[item.cursorId];
        if (cursor) {
          if (item.sequence > cursor.queued + 1)
            this.omitted('source_sequence_gap', item.sequence - cursor.queued - 1);
          cursor.queued = Math.max(cursor.queued, item.sequence);
        }
      }
      try {
        await this.save();
      } catch (error) {
        this.state.sessions = oldCursors;
        this.state.queue = oldQueue;
        if (!oldQueue.some((v) => v.id === id)) await unlink(path).catch(() => undefined);
        if (error instanceof Error && error.message === 'manifest_budget') {
          this.error = 'manifest_budget_local_journal_retained';
          return false;
        }
        throw error;
      }
      this.pending.splice(0, selected.length);
      remaining -= selected.length;
      this.pendingBytes -= selected.reduce((n, v) => n + Buffer.byteLength(v.line), 0);
      await yieldIO();
    }
    return true;
  }
  private async transportFetch(input: string, init: RequestInit, withdrawal?: Withdrawal) {
    const phase = input.includes('/enroll')
      ? 'enrollment'
      : input.includes('/permits/')
        ? 'permit'
        : input.includes('/batches/')
          ? 'upload'
          : 'withdrawal';
    let request: Promise<Response> | undefined;
    await this.transaction(async () => {
      this.transportPhase = null;
      this.transportAttempt = null;
      if (init.signal?.aborted) throw new Error('transport_aborted');
      this.transportPhase = phase;
      this.transportAttempt = { attemptId: randomUUID(), started: performance.now() };
      const endpoint = new URL(this.endpoint!);
      // Do not journal successful permit/upload attempts: their own delivery
      // would otherwise generate the next batch even without new activity.
      if (phase === 'enrollment')
        this.journal.record('diagnostic_transport_attempt', {
          phase,
          attemptId: this.transportAttempt.attemptId,
          request: {
            method: init.method,
            endpoint: {
              protocol: endpoint.protocol,
              hostname: endpoint.hostname,
              port: endpoint.port,
            },
            endpointSource: this.options.endpointSource ?? 'provided',
            nodeVersion: process.versions.node,
            fetchImplementation: this.options.fetch ? 'provided' : 'node',
            proxyConfigured: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some(
              (key) => Boolean(process.env[key]),
            ),
            envProxyRequested:
              process.env.NODE_USE_ENV_PROXY === '1' ||
              process.execArgv.includes('--use-env-proxy') ||
              /(?:^|\s)--use-env-proxy(?:\s|$)/.test(process.env.NODE_OPTIONS ?? ''),
            noProxyConfigured: Boolean(process.env.NO_PROXY || process.env.no_proxy),
            route: 'unverified',
          },
        });
      request = this.fetcher(input, init);
      // Attach a rejection handler immediately while the timestamp is committed.
      void request.catch(() => undefined);
      const previous = this.state.lastAttemptAt;
      this.state.lastAttemptAt = new Date(this.now()).toISOString();
      try {
        await this.save();
      } catch (error) {
        this.state.lastAttemptAt = previous;
        this.abort?.abort();
        throw error;
      }
    });
    let response: Response;
    try {
      response = await request!;
    } catch (error) {
      if (phase === 'enrollment')
        this.journal.record('diagnostic_transport_request_failed', {
          phase,
          ...this.transportTiming(),
          reason: transportFailureReason(error),
          aborted: init.signal?.aborted ?? false,
        });
      throw error;
    }
    if (phase === 'enrollment')
      this.journal.record('diagnostic_transport_response', {
        phase,
        ...this.transportTiming(),
        status: response.status,
        result: 'response_received_not_acknowledged',
        aborted: init.signal?.aborted ?? false,
      });
    if (response.status === 429 || response.status === 503) {
      const header = response.headers.get('retry-after');
      const delay =
        header && /^\d+$/.test(header)
          ? this.now() + Number(header) * 1000
          : header
            ? Date.parse(header)
            : NaN;
      const retryAt = Number.isFinite(delay)
        ? Math.max(this.now() + 30_000, delay)
        : this.now() + 15 * 60_000;
      if (withdrawal) withdrawal.serverRetryAt = retryAt;
      else this.state.serverRetryAt = retryAt;
    }
    return response;
  }
  private transportTiming() {
    return this.transportAttempt
      ? {
          attemptId: this.transportAttempt.attemptId,
          elapsedMs: Math.max(0, performance.now() - this.transportAttempt.started),
        }
      : {};
  }
  private async credentials(value: Credentials, signal: AbortSignal, deletion = false) {
    if (value.token && (value.expiresAt ?? 0) > this.now() + 60_000) return value.token;
    value.enrollmentAttempted = true;
    await this.transaction(() => this.save());
    if (signal.aborted) throw new Error('enrollment_aborted');
    const response = await this.transportFetch(
      `${this.endpoint}/v1/diagnostics/enroll`,
      {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          consent: CONSENT,
          enrollmentId: value.installationId,
          enrollmentSecret: value.enrollmentSecret,
          deletion,
        }),
      },
      deletion ? value : undefined,
    );
    const responseData = await responseJson(response, signal);
    if (!response.ok) throw transportReceiptError('enrollment', response.status, responseData);
    const closed = responseData as {
      installationId?: unknown;
      closed?: unknown;
      revoked?: unknown;
      deletion?: unknown;
    };
    if (
      deletion &&
      closed.installationId === value.installationId &&
      closed.closed === true &&
      closed.revoked === true &&
      closed.deletion === 'complete'
    )
      return null;
    const data = responseData as {
      installationId: string;
      token: string;
      expiresAt: number;
    };
    if (
      data.installationId !== value.installationId ||
      !credentialsSchema.safeParse({ ...value, token: data.token, expiresAt: data.expiresAt })
        .success ||
      typeof data.token !== 'string' ||
      !Number.isSafeInteger(data.expiresAt) ||
      data.expiresAt <= this.now()
    )
      throw transportReceiptError('enrollment', response.status, null);
    value.token = data.token;
    value.expiresAt = data.expiresAt;
    return data.token;
  }
  private async renewExpiredInstallation() {
    // Keep deletion ownership for the old identity's remaining ninety-day index.
    // Past its maximum index age, ask the server to confirm closure; do not infer
    // completion from local time when a crashed writer might still be pending.
    const aged = this.state.retiredIdentities.filter((value) => {
      const created = diagnosticInstallationCreatedAt(value.installationId);
      return created !== null && created + 2 * DIAGNOSTIC_AUTOMATIC_LIFETIME_MS <= this.now();
    });
    if (aged.length) {
      const previous = structuredClone(this.state);
      for (const identity of aged)
        if (
          !this.state.withdrawals.some((value) => value.installationId === identity.installationId)
        )
          this.state.withdrawals.push(identity);
      this.state.retiredIdentities = this.state.retiredIdentities.filter(
        (value) => !aged.includes(value),
      );
      try {
        await this.save();
      } catch (error) {
        this.state = previous;
        throw error;
      }
    }
    const identity = this.state.credentials;
    if (!this.consentActive() || !identity) return;
    const birth = diagnosticInstallationCreatedAt(identity.installationId);
    if (birth !== null && birth + DIAGNOSTIC_AUTOMATIC_LIFETIME_MS > this.now()) return;
    if (
      this.state.retiredIdentities.length + this.state.withdrawals.length >=
      DELIVERY_LIMITS.tombstones - 1
    ) {
      this.error = 'retired_identity_sync_required';
      return;
    }
    const previous = structuredClone(this.state);
    if (identity.enrollmentAttempted || identity.token) this.state.retiredIdentities.push(identity);
    let retained = 0;
    for (const batch of this.state.queue)
      if (!batch.serverExpired) {
        batch.serverExpired = true;
        batch.unavailableReason = 'installation_lease_closed';
        this.omitted('installation_lease_closed', batch.index.events);
        retained++;
      }
    this.state.credentials = {
      installationId: diagnosticInstallationId(this.now(), randomBytes(16)),
      enrollmentSecret: randomBytes(32).toString('hex'),
    };
    this.state.nextAttemptAt = 0;
    this.state.consecutiveFailures = 0;
    try {
      await this.save();
    } catch (error) {
      this.state = previous;
      throw error;
    }
    this.journal.record('diagnostic_installation_renewed', {
      previousInstallationId: identity.installationId,
      installationId: this.state.credentials.installationId,
      retainedBatches: retained,
      reason: 'installation_lease_closed',
      oldCopies: 'retained locally for manual export; not acknowledged or re-signed',
    });
  }
  /** A wire is a transport projection. Release only the exact acknowledged batch whose
   * stable identities and retained canonical facts still cover every transmitted event. */
  private async releaseAcknowledged(batches: readonly Batch[]): Promise<Set<string>> {
    const released = new Set<string>();
    await this.releaseAcknowledgedPins();
    // Retry cleanup before acquiring anything else: failed release cannot accumulate
    // indefinitely many live pins or requests in this process.
    if (this.pendingPinReleases.size || this.closed) return released;
    const pinId = randomUUID();
    const receipts: PinReceipt[] = [];
    const eligible = new Map<string, { batch: Batch; bytes: Buffer | null; remaining: number }>();
    const pending = new Map<string, { batchId: string; event: Record<string, unknown> }[]>();
    try {
      for (const batch of batches) {
        if (batch.index.eventSchemaVersion !== 2) continue;
        try {
          const bytes = await secureRead(
            this.queueDirectory,
            `${batch.id}.gz`,
            DELIVERY_LIMITS.compressedBytes,
          ).catch((error: unknown) => {
            if (missing(error)) return null;
            throw error;
          });
          // Durable ACK + missing wire can finish a previous interrupted unlink.
          if (!bytes) {
            eligible.set(batch.id, { batch, bytes, remaining: 0 });
            continue;
          }
          if (checksum(bytes) !== batch.id) throw new Error('acknowledged_batch_integrity');
          const decoded = await decodeDiagnosticBatch(bytes);
          const events = decoded.events as Record<string, unknown>[];
          if (
            events.some(
              (event) =>
                event.schema !== 'mizar-diagnostic-event/2' || typeof event.eventId !== 'string',
            )
          )
            continue;
          eligible.set(batch.id, { batch, bytes, remaining: events.length });
          for (const event of events) {
            const id = String(event.eventId);
            pending.set(id, [...(pending.get(id) ?? []), { batchId: batch.id, event }]);
          }
        } catch {
          // One corrupt/unreadable batch must not starve later acknowledged entries.
        }
      }
      const cover = (value: unknown) => {
        if (!value || typeof value !== 'object') return;
        const source = value as Record<string, unknown>;
        const id = String(source.eventId);
        const variants = pending.get(id);
        if (!variants) return;
        const remaining = variants.filter(({ batchId, event }) => {
          if (!sourceCoversProjection(source, event)) return true;
          eligible.get(batchId)!.remaining--;
          return false;
        });
        if (remaining.length) pending.set(id, remaining);
        else pending.delete(id);
      };
      const participants = pending.size
        ? [
            ...(this.options.participants?.() ?? [this.journal.deliveryParticipant()]),
            ...([...pending.values()].some((events) =>
              events.some(({ event }) => ['host', 'document'].includes(String(event.producerKind))),
            )
              ? [hostDeliveryParticipant(this.directory, this.cleanupAbort.signal)]
              : []),
          ]
        : [];
      for (const participant of participants) {
        if (!pending.size || this.closed) break;
        // One pin vector and one canonical pass for this entire (at most four) batch
        // round. No repeated prepare/hash/Host handshake per acknowledged wire.
        this.pendingPinReleases.set(`${pinId}:${participant.producerId}`, {
          pinId,
          participant,
          reported: false,
        });
        let receipt: PinReceipt;
        try {
          const prepared = await participant.prepare(pinId);
          receipt = await participant.commit(pinId);
          if (
            receipt.pinId !== pinId ||
            receipt.producerId !== participant.producerId ||
            receipt.kind !== 'delivery' ||
            receipt.status !== 'committed' ||
            receipt.expiresAt === null ||
            receipt.expiresAt <= Date.now() ||
            JSON.stringify(receipt.segments) !== JSON.stringify(prepared.segments)
          )
            throw new Error('ack_pin_receipt_invalid');
          receipts.push(receipt);
        } catch (error) {
          this.journal.record('diagnostic_delivery_pin_failed', {
            pinId,
            producerId: participant.producerId,
            error: diagnosticValue(error),
          });
          continue;
        }
        for (const segment of receipt.segments) {
          if (!pending.size || this.closed) break;
          try {
            // Only bytes covered by the original producer's committed pin prove
            // anything. Verify the same immutable bytes that are decoded.
            const raw = await secureRead(this.directory, segment.name, 2 * 1024 * 1024);
            if (raw.length !== segment.bytes || checksum(raw) !== segment.sha256) continue;
            if (segment.name.startsWith('performance-pending/')) {
              const expanded = await decompress(raw, { maxOutputLength: 1024 * 1024 });
              const values: unknown = JSON.parse(expanded.toString('utf8'));
              if (Array.isArray(values)) for (const value of values) cover(value);
            } else {
              for (const line of raw.toString('utf8').split('\n'))
                if (line) cover(JSON.parse(line));
            }
          } catch {
            /* An unreadable/changed source cannot prove coverage. */
          }
          await yieldIO();
        }
      }
      for (const { batch, bytes, remaining } of eligible.values()) {
        if (remaining || this.closed) continue;
        try {
          await this.transaction(async () => {
            if (this.closed || receipts.some((receipt) => receipt.expiresAt! <= Date.now()))
              throw new Error('ack_cleanup_expired');
            const current = this.state.queue.find((value) => value.id === batch.id);
            if (!current?.acknowledgedAt || current.index.eventSchemaVersion !== 2)
              throw new Error('acknowledged_batch_changed');
            if (bytes) {
              const actual = await secureRead(
                this.queueDirectory,
                `${batch.id}.gz`,
                DELIVERY_LIMITS.compressedBytes,
              );
              if (checksum(actual) !== batch.id) throw new Error('acknowledged_batch_integrity');
              await unlink(await safePath(this.queueDirectory, `${batch.id}.gz`));
            }
            const previous = this.state.queue;
            this.state.queue = previous.filter((value) => value.id !== batch.id);
            try {
              await this.save();
            } catch (error) {
              this.state.queue = previous;
              throw error;
            }
            this.recoveryNeeded = true;
          });
          released.add(batch.id);
        } catch {
          /* Keep the queue reference for retry, including an interrupted unlink. */
        }
      }
      return released;
    } finally {
      // Keep every hold until all unlinks/state transactions settle, not just until
      // the read finishes. An elapsed deadline during unlink does not revoke it.
      await this.releaseAcknowledgedPins();
    }
  }
  private async releaseAcknowledgedPins() {
    for (const [key, pending] of this.pendingPinReleases) {
      try {
        await pending.participant.release(pending.pinId);
        this.pendingPinReleases.delete(key);
      } catch (error) {
        this.error = 'ack_pin_release_pending';
        if (!pending.reported)
          this.journal.record('diagnostic_delivery_pin_release_failed', {
            pinId: pending.pinId,
            producerId: pending.participant.producerId,
            error: diagnosticValue(error),
          });
        pending.reported = true;
      }
    }
    if (!this.pendingPinReleases.size && this.error === 'ack_pin_release_pending')
      this.error = null;
  }

  private collectAcknowledged() {
    this.cleaningAcknowledged ??= (async () => {
      const candidates = this.state.queue.filter(
        (value) => value.acknowledgedAt && value.index.eventSchemaVersion === 2,
      );
      const next = candidates.findIndex((batch) => batch.id === this.acknowledgedScanNext);
      // A retained batch must not starve later reclaimable entries. Capture the
      // next position before release mutates the queue, with at most four attempts.
      const start = next < 0 ? 0 : next;
      const selected: Batch[] = [];
      for (let i = 0; i < Math.min(4, candidates.length); i++) {
        selected.push(candidates[(start + i) % candidates.length]!);
        this.acknowledgedScanNext = candidates[(start + i + 1) % candidates.length]!.id;
      }
      try {
        const released = await this.releaseAcknowledged(selected);
        if (this.pendingPinReleases.size) this.error = 'ack_pin_release_pending';
        else if (released.size < selected.length) this.error = 'ack_history_release_pending';
        else if (
          this.error === 'ack_history_release_pending' ||
          this.error === 'queue_budget_local_journal_retained'
        )
          this.error = null;
      } catch {
        this.error = this.pendingPinReleases.size
          ? 'ack_pin_release_pending'
          : 'ack_history_release_pending';
      }
    })().finally(() => {
      this.cleaningAcknowledged = undefined;
    });
    return this.cleaningAcknowledged;
  }
  async tick(forceCollection = true) {
    await this.collectAcknowledged();
    await this.transaction(async () => {
      await this.renewExpiredInstallation();
      const collecting = forceCollection || this.now() >= this.nextCollectionAt;
      if (collecting) {
        await this.recover();
        this.nextCollectionAt = this.now() + DELIVERY_LIMITS.collectMs;
      }
      if (!collecting && this.recoveryNeeded) await this.recover();
      // persist() freezes the admitted prefix; a second pass here would turn
      // records arriving during gzip/fsync into an immediate tiny extra batch.
      // recover() already persists its own recovered prefix when needed.
    });
    if (!this.endpoint || this.closed) return;
    this.sending ??= this.send().finally(() => {
      this.sending = undefined;
    });
    await this.sending;
    await this.collectAcknowledged();
  }
  private async syncWithdrawal(cancellation: AbortSignal) {
    // One due identity per pump. A stalled old deletion has its own durable
    // backoff and cannot consume the new consent's request timeout or retry slot.
    const item = this.state.withdrawals.find((value) => (value.nextAttemptAt ?? 0) <= this.now());
    if (!item) return;
    const signal = AbortSignal.any([cancellation, AbortSignal.timeout(15_000)]);
    try {
      const bearer = await this.credentials(item, signal, true);
      if (bearer !== null) {
        const response = await this.transportFetch(
          `${this.endpoint}/v1/diagnostics/installation`,
          {
            method: 'DELETE',
            redirect: 'error',
            signal,
            headers: { authorization: `Bearer ${bearer}` },
          },
          item,
        );
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw transportReceiptError('withdrawal', response.status, null);
        }
        const ack = (await responseJson(response, signal)) as {
          installationId: string;
          revoked: boolean;
          deletion: string;
        };
        if (
          ack.installationId !== item.installationId ||
          ack.revoked !== true ||
          ack.deletion !== 'complete'
        )
          throw new Error('withdrawal_pending');
      }
      await this.transaction(async () => {
        const previous = structuredClone(this.state);
        this.state.withdrawals = this.state.withdrawals.filter(
          (value) => value.installationId !== item.installationId,
        );
        try {
          await this.save();
        } catch (error) {
          this.state = previous;
          throw error;
        }
      });
    } catch (error) {
      if (cancellation.aborted) {
        if (this.transportAttempt)
          this.journal.record('diagnostic_transport_interrupted', {
            phase: this.transportPhase,
            ...this.transportTiming(),
            reason: 'withdrawal_cancelled',
          });
        return;
      }
      await this.transaction(async () => {
        const retained = this.state.withdrawals.find(
          (value) => value.installationId === item.installationId,
        );
        if (!retained) return;
        const previous = structuredClone(this.state);
        retained.consecutiveFailures = (retained.consecutiveFailures ?? 0) + 1;
        retained.nextAttemptAt = Math.max(
          retained.serverRetryAt ?? 0,
          this.now() + retryDelay(retained.consecutiveFailures),
        );
        try {
          await this.save();
        } catch (failure) {
          this.state = previous;
          throw failure;
        }
        this.journal.record('diagnostic_withdrawal_failure', {
          installationId: retained.installationId,
          phase: this.transportPhase,
          ...this.transportTiming(),
          error: diagnosticValue(error, '', new Set(), [
            retained.enrollmentSecret,
            retained.token ?? '',
          ]),
          nextAttemptAt: retained.nextAttemptAt,
          deletion: 'pending; no complete deletion acknowledgment',
        });
      });
    }
  }
  private async send(): Promise<void> {
    this.transportPhase = null;
    this.transportAttempt = null;
    const epoch = this.epoch;
    const abort = new AbortController();
    this.abort = abort;
    try {
      await this.syncWithdrawal(abort.signal);
      this.transportPhase = null;
      this.transportAttempt = null;
      if (
        !this.consentActive() ||
        this.requestedPause ||
        !this.state.credentials ||
        epoch !== this.epoch ||
        this.now() < this.state.nextAttemptAt
      )
        return;
      const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]);
      const identity = this.state.credentials;
      const bearer = await this.credentials(identity, signal);
      if (bearer === null) throw new Error('unexpected_closed_enrollment');
      await this.transaction(async () => {
        // Enrollment recovery is independent of whether there is a batch to send.
        // It must not clear a prior permit/upload failure or claim a batch ACK.
        const previous = structuredClone(this.state);
        const recovered =
          epoch === this.epoch &&
          this.consentActive() &&
          this.state.transportFailure?.phase === 'enrollment';
        if (recovered) {
          this.state.transportFailure = null;
          this.state.consecutiveFailures = 0;
          this.state.nextAttemptAt = 0;
        }
        try {
          await this.save();
        } catch (error) {
          this.state = previous;
          throw error;
        }
        if (recovered && !this.error?.includes('budget')) this.error = null;
      });
      const selectedBatch = this.state.queue.find(
        (value) =>
          !value.serverExpired && !value.acknowledgedAt && value.index.eventSchemaVersion === 2,
      );
      if (!selectedBatch) return;
      let batch: Batch = selectedBatch;
      let bytes = await secureRead(
        this.queueDirectory,
        `${batch.id}.gz`,
        DELIVERY_LIMITS.compressedBytes,
      );
      if (checksum(bytes) !== batch.id) throw new Error('batch_integrity_failed');
      const creationTime = diagnosticGzipCreatedAt(bytes);
      const localReason = diagnosticAutomaticTimeReason(creationTime, this.now());
      const sealedPermit = batch.sealed ? readDiagnosticGzipPermit(bytes)?.permit : null;
      if (localReason || (sealedPermit && sealedPermit.expiresAt <= this.now())) {
        await this.retainExpiredBatch(batch, epoch, localReason ?? 'batch_retention_expired');
        // Move past expired local work in the same pump, without an HTTP attempt.
        if (epoch === this.epoch && !this.requestedPause) return this.send();
        return;
      }
      if (!batch.sealed) {
        const response = await this.transportFetch(
          `${this.endpoint}/v1/diagnostics/permits/${batch.id}`,
          {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: {
              authorization: `Bearer ${bearer}`,
              'x-diagnostics-created-at': String(creationTime),
            },
          },
        );
        const receipt = await responseJson(response, signal);
        const permit = diagnosticPermit(receipt);
        if (
          response.status === 410 &&
          [
            'batch_retention_expired',
            'automatic_window_expired',
            'payload_clock_future',
            'payload_creation_time_missing',
          ].includes((receipt as { error?: string }).error ?? '')
        ) {
          await this.retainExpiredBatch(batch, epoch, (receipt as { error: string }).error);
          return;
        }
        if ([400, 413, 422].includes(response.status)) {
          await this.retainExpiredBatch(batch, epoch, 'permanent_rejection');
          return;
        }
        if (!response.ok) throw transportReceiptError('permit', response.status, receipt);
        if (
          batch.index.eventSchemaVersion === 2 &&
          response.headers.get('x-diagnostics-event-version') !== '2'
        )
          throw Object.assign(new Error('receiver_upgrade_required'), {
            reason: 'receiver_upgrade_required',
          });
        if (
          !permit ||
          permit.installationId !== identity.installationId ||
          permit.payloadSha256 !== batch.id
        )
          throw transportReceiptError('permit', response.status, null);
        const sealed = Buffer.from(sealDiagnosticGzip(bytes, permit));
        const oldBatch = batch;
        const newBatch = { ...batch, id: checksum(sealed), bytes: sealed.length, sealed: true };
        try {
          await this.transaction(async () => {
            if (!this.consentActive() || this.requestedPause || epoch !== this.epoch) return;
            const name = `${newBatch.id}.gz`;
            await safePath(this.queueDirectory, name).catch((error) => {
              if (!missing(error)) throw error;
            });
            let file: Awaited<ReturnType<typeof open>> | undefined;
            try {
              file = await open(
                join(this.queueDirectory, name),
                constants.O_CREAT |
                  constants.O_EXCL |
                  constants.O_WRONLY |
                  (constants.O_NOFOLLOW ?? 0),
                0o600,
              );
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              await recoverSealedBatch(this.queueDirectory, name, sealed);
            }
            try {
              if (file) {
                await file.writeFile(sealed);
                await file.sync();
              }
            } catch (error) {
              await file?.close();
              await unlink(join(this.queueDirectory, name)).catch(() => undefined);
              throw error;
            } finally {
              await file?.close();
            }
            const previous = this.state.queue;
            this.state.queue = previous.map((item) => (item.id === oldBatch.id ? newBatch : item));
            try {
              await this.save();
            } catch (error) {
              this.state.queue = previous;
              // An adopted orphan was already durable before this attempt.
              if (file) await unlink(join(this.queueDirectory, name)).catch(() => undefined);
              throw error;
            }
            batch = newBatch;
            bytes = sealed;
            await unlink(join(this.queueDirectory, `${oldBatch.id}.gz`));
          });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== 'sealed_batch_conflict') throw error;
          await this.retainExpiredBatch(oldBatch, epoch, 'sealed_batch_conflict');
          return;
        }
      }

      if (!this.consentActive() || this.requestedPause || epoch !== this.epoch) return;
      const response = await this.transportFetch(
        `${this.endpoint}/v1/diagnostics/batches/${batch.id}`,
        {
          method: 'PUT',
          redirect: 'error',
          signal,
          headers: {
            authorization: `Bearer ${bearer}`,
            'content-type': 'application/gzip',
            'x-content-sha256': batch.id,
            'x-diagnostics-index': JSON.stringify(batch.index),
          },
          body: new Uint8Array(bytes),
        },
      );
      const ack = (await responseJson(response, signal)) as {
        batchId: string;
        sha256: string;
        accepted: boolean;
        error?: unknown;
      };
      if ([400, 413, 422].includes(response.status)) {
        await this.retainExpiredBatch(batch, epoch, 'permanent_rejection');
        return;
      }
      if (response.status === 410 && ack.error === 'batch_retention_expired') {
        await this.retainExpiredBatch(batch, epoch);
        return;
      }

      if (
        !response.ok ||
        ack.batchId !== batch.id ||
        ack.sha256 !== batch.id ||
        ack.accepted !== true
      )
        throw transportReceiptError('upload', response.status, ack);
      await this.transaction(async () => {
        if (epoch !== this.epoch || !this.consentActive()) return;
        const previous = structuredClone(this.state);
        const retained = this.state.queue.find((value) => value.id === batch.id)!;
        retained.acknowledgedAt = new Date(this.now()).toISOString();
        retained.serverExpired = true;
        retained.unavailableReason = 'acknowledged_local_history';
        this.state.acknowledged++;
        this.state.lastConfirmedAt = new Date(this.now()).toISOString();
        this.state.consecutiveFailures = 0;
        this.state.nextAttemptAt = 0;
        if (this.error !== 'session_budget_waiting_for_capacity') this.error = null;
        this.state.transportFailure = null;
        try {
          await this.save();
        } catch (error) {
          this.state = previous;
          throw error;
        }
        // ACK is durable. Cleanup separately verifies retained canonical coverage; it never creates another body.
      });
    } catch (error) {
      if (epoch !== this.epoch || this.requestedPause) {
        if (this.transportAttempt)
          this.journal.record('diagnostic_transport_interrupted', {
            phase: this.transportPhase,
            ...this.transportTiming(),
            reason: this.requestedPause ? 'paused' : 'consent_changed',
          });
        return;
      }
      await this.transaction(async () => {
        this.state.failures++;
        this.state.consecutiveFailures++;
        const detail = error as { status?: unknown; receiverStage?: DiagnosticReceiverStage };
        this.state.transportFailure = this.transportPhase
          ? {
              phase: this.transportPhase,
              status:
                typeof detail?.status === 'number' && detail.status >= 400 && detail.status <= 599
                  ? detail.status
                  : null,
              reason: transportFailureReason(error),
              ...(detail?.receiverStage ? { receiverStage: detail.receiverStage } : {}),
              ...(this.transportAttempt ? { attemptId: this.transportAttempt.attemptId } : {}),
            }
          : null;
        this.state.nextAttemptAt = Math.max(
          this.state.serverRetryAt,
          this.now() + retryDelay(this.state.consecutiveFailures),
        );
        this.error = error instanceof Error ? error.message : 'delivery_failed';
        this.journal.record('diagnostic_transport_failure', {
          transportFailure: this.state.transportFailure,
          ...this.transportTiming(),
          error: diagnosticValue(error, '', new Set(), [
            this.state.credentials?.enrollmentSecret ?? '',
            this.state.credentials?.token ?? '',
            ...[...this.state.withdrawals, ...this.state.retiredIdentities].flatMap((value) => [
              value.enrollmentSecret,
              value.token ?? '',
            ]),
          ]),
          failures: this.state.failures,
          nextAttemptAt: this.state.nextAttemptAt,
          queue: 'retained; no server acknowledgment',
        });
        await this.save();
      });
    } finally {
      if (this.abort === abort) this.abort = undefined;
    }
  }
  private async retainExpiredBatch(
    batch: Batch,
    epoch: number,
    reason = 'server_retention_expired',
  ) {
    await this.transaction(async () => {
      if (epoch !== this.epoch || !this.consentActive()) return;
      const previous = structuredClone(this.state);
      const retained = this.state.queue.find((value) => value.id === batch.id);
      if (!retained || retained.serverExpired) return;
      retained.serverExpired = true;
      retained.unavailableReason = reason;
      this.omitted(reason, batch.index.events);
      try {
        await this.save();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      this.error =
        reason === 'server_retention_expired'
          ? 'server_retention_expired_local_copy_retained'
          : `${reason}_local_copy_retained`;
      this.journal.record('diagnostic_cloud_expired', {
        batchId: batch.id,
        events: batch.index.events,
        reason,
        localCopy: 'retained; not acknowledged or evicted',
      });
    });
  }
  async close() {
    this.closed = true;
    this.cleanupAbort.abort();
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.abort?.abort();
    await this.sending;
    await this.cleaningAcknowledged;
    await this.releaseAcknowledgedPins();
    await this.transaction(() => this.persist());
    if (this.pendingPinReleases.size) throw new Error('ack_pin_release_pending');
  }
}
