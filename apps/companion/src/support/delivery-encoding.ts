import { diagnosticSegmentNames } from './segments.js';
import { technicalProjection } from './technical-projection.js';
import {
  DIAGNOSTIC_PERMIT_BYTES,
  DIAGNOSTIC_RECEIVER_STAGES,
  type DiagnosticReceiverStage,
} from '@mizar/protocol/diagnostics-upload';
import { diagnosticEnvelope } from './envelope.js';
import { DIAGNOSTIC_CONSENT_REVISION } from '@mizar/protocol/version';
import { z } from 'zod';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { safePath } from '../resource-store/files.js';

export const compress = promisify(gzip);
export const decompress = promisify(gunzip);
export const LEGACY_QUEUE_LIMITS = {
  queueBytes: 64 * 1024 * 1024,
  batches: 2048,
};
export const DELIVERY_LIMITS = {
  expandedBytes: 4 * 1024 * 1024,
  compressedBytes: 512 * 1024,
  queueBytes: 8 * 1024 * 1024,
  batches: 16,
  manifestBytes: 2 * 1024 * 1024,
  pendingBytes: 8 * 1024 * 1024,
  events: 4096,
  tombstones: 8,
  collectMs: 20 * 60_000,
  pollMs: 5000,
  sendPerTick: 4,
};
export const CONSENT = DIAGNOSTIC_CONSENT_REVISION;
export const sendableBatch = (batch: Batch) =>
  !batch.serverExpired && !batch.acknowledgedAt && batch.index.eventSchemaVersion === 2;

export function queuedWireBytes(batch: Batch) {
  return batch.bytes + (batch.sealed ? 0 : DIAGNOSTIC_PERMIT_BYTES);
}

/** Reclaim terminal metadata first. The manual exporter reads the wire files independently. */
export function queueWithHistoryBudget(state: State, queue: Batch[]): Batch[] {
  let bytes = queue.reduce((total, batch) => total + queuedWireBytes(batch), 0);
  let count = queue.length;
  let manifest = Buffer.byteLength(JSON.stringify({ ...state, queue }));
  return queue.filter((batch) => {
    if (
      sendableBatch(batch) ||
      (count <= LEGACY_QUEUE_LIMITS.batches &&
        bytes <= LEGACY_QUEUE_LIMITS.queueBytes &&
        manifest <= DELIVERY_LIMITS.manifestBytes)
    )
      return true;
    bytes -= queuedWireBytes(batch);
    manifest -= Buffer.byteLength(JSON.stringify(batch)) + (count > 1 ? 1 : 0);
    count--;
    return false;
  });
}
export const diagnosticKind = /^[a-z][a-z0-9_.-]{0,63}$/;
export const retryDelay = (failures: number) =>
  Math.ceil(
    Math.min(
      15 * 60_000,
      Math.max(
        30_000,
        30_000 * 2 ** Math.min(failures - 1, 10) * (0.8 + (randomBytes(1)[0]! / 255) * 0.4),
      ),
    ),
  );
export const transportReasons = [
  'receiver_upgrade_required',
  'receipt_invalid',
  'batch_retention_expired',
  'automatic_window_expired',
  'payload_clock_future',
  'payload_creation_time_missing',
  'permit_budget',
  'daily_batch_budget',
  'daily_byte_budget',
  'installation_byte_budget',
  'intake_paused',
  'installation_revoked',
  'unauthorized',
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
export function transportFailureReason(error: unknown): (typeof transportReasons)[number] {
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
export interface Credentials {
  installationId: string;
  enrollmentSecret: string;
  enrollmentAttempted?: boolean;
  token?: string;
  expiresAt?: number;
}
export interface Withdrawal extends Credentials {
  nextAttemptAt?: number;
  consecutiveFailures?: number;
  serverRetryAt?: number;
}
export interface Batch {
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
export interface State {
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
export const credentialsSchema = z
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
export const stateSchema = z
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
      .refine(
        (queue) =>
          queue.filter((batch) => !batch.acknowledgedAt).length <= LEGACY_QUEUE_LIMITS.batches,
      ),
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
      v.withdrawals.length +
        v.retiredIdentities.length +
        (v.credentials && (v.credentials.enrollmentAttempted || v.credentials.token) ? 1 : 0) <=
        DELIVERY_LIMITS.tombstones &&
      v.queue.reduce((n, b) => n + b.bytes, 0) <=
        LEGACY_QUEUE_LIMITS.queueBytes + LEGACY_QUEUE_LIMITS.batches * DIAGNOSTIC_PERMIT_BYTES &&
      (!v.consent || v.credentials !== null),
  );
export async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
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
export const initial = (): State => ({
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
export const checksum = (value: Uint8Array | string) =>
  createHash('sha256').update(value).digest('hex');
export const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';
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
export function cloudRecord(line: string, consentAt: string | null): unknown {
  const value = JSON.parse(line) as Record<string, unknown>;
  if (value.schema !== 'mizar-diagnostic-event/2') throw new Error('current_event_required');
  return technicalProjection(value, consentAt);
}
export async function secureRead(directory: string, name: string, maximum: number) {
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
export async function recoverSealedBatch(directory: string, name: string, expected: Buffer) {
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
export async function* sourceLines(directory: string, name: string): AsyncGenerator<string> {
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
export async function orderedSources(directory: string) {
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
export async function* mergedSourceLines(directory: string, sources: JournalSource[]) {
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
export function transportReceiptError(operation: string, status: number, receipt: unknown) {
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
export function batchMetadata(sessionId: string, events: unknown[]) {
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
