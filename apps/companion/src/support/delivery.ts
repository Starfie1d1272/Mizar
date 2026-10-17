import {
  DIAGNOSTIC_PERMIT_BYTES,
  diagnosticPermit,
  sealDiagnosticGzip,
} from '@mizar/protocol/diagnostics-upload';
import { diagnosticConsoleEvidence, diagnosticEnvelope, diagnosticSourceUtc } from './envelope.js';
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
import { diagnosticValue, SESSION_LIMITS, type SessionJournal } from './session-journal.js';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
export const DELIVERY_LIMITS = {
  expandedBytes: 2 * 1024 * 1024,
  compressedBytes: 256 * 1024,
  queueBytes: 64 * 1024 * 1024,
  batches: 2048,
  manifestBytes: 2 * 1024 * 1024,
  pendingBytes: 2 * 1024 * 1024,
  events: 4096,
  sessions: 128,
  tombstones: 8,
  collectMs: 10 * 60_000,
  pollMs: 5000,
};
const CONSENT = DIAGNOSTIC_CONSENT_REVISION;
interface Credentials {
  installationId: string;
  enrollmentSecret: string;
  enrollmentAttempted?: boolean;
  token?: string;
  expiresAt?: number;
}
interface Batch {
  id: string;
  bytes: number;
  serverExpired?: boolean;
  sealed?: boolean;
  index: {
    schema: string;
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
export interface RetainedDiagnosticBatch {
  id: string | null;
  sourceBytes: number;
  gzip?: Buffer;
  error?: unknown;
}
interface State {
  version: 1;
  consentPolicy: 1 | 2;
  consent: boolean;
  paused: boolean;
  consentAt: string | null;
  credentials: Credentials | null;
  withdrawals: Credentials[];
  sessions: Record<string, { from: number; queued: number }>;
  queue: Batch[];
  omitted: number;
  omissionReasons: Record<string, number>;
  acknowledged: number;
  nextAttemptAt: number;
  failures: number;
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
    consentPolicy: z.union([z.literal(1), z.literal(2)]).default(1),
    consent: z.boolean(),
    paused: z.boolean().default(false),
    consentAt: z.iso.datetime().nullable(),
    credentials: credentialsSchema.nullable(),
    withdrawals: z.array(credentialsSchema).max(DELIVERY_LIMITS.tombstones),
    sessions: z.record(
      identifier,
      z.object({ from: counter, queued: counter }).refine((v) => v.queued >= v.from),
    ),
    queue: z
      .array(
        z.object({
          id: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().min(1).max(DELIVERY_LIMITS.compressedBytes),
          serverExpired: z.boolean().optional(),
          sealed: z.boolean().optional(),
          index: z.object({
            schema: z.literal('mizar-technical-diagnostics/1'),
            events: z.number().int().min(1).max(DELIVERY_LIMITS.events),
            expandedBytes: z.number().int().min(1).max(DELIVERY_LIMITS.expandedBytes),
            stages: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(32),
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
  })
  .passthrough()
  .refine(
    (v) =>
      Object.keys(v.sessions).length <= DELIVERY_LIMITS.sessions &&
      v.queue.reduce((n, b) => n + b.bytes, 0) <=
        DELIVERY_LIMITS.queueBytes + DELIVERY_LIMITS.batches * DIAGNOSTIC_PERMIT_BYTES &&
      (!v.consent || v.credentials !== null),
  );
async function responseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const limit = 8192;
  if (Number(response.headers.get('content-length')) > limit || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new Error('receipt_size_or_body');
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
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
}
const initial = (): State => ({
  version: 1,
  consentPolicy: 2,
  consent: false,
  paused: false,
  consentAt: null,
  credentials: null,
  withdrawals: [],
  sessions: {},
  queue: [],
  omitted: 0,
  omissionReasons: {},
  acknowledged: 0,
  nextAttemptAt: 0,
  failures: 0,
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
function cloudValue(value: unknown, key = ''): unknown {
  if (/^(?:chat|chatText|teamChat|privateChat|messageBody|rawPayload|audio|imageData)$/i.test(key))
    return '[not-collected]';
  if (Array.isArray(value)) return value.map((v) => cloudValue(v));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cloudValue(v, k)]));
  return value;
}
function cloudBrowserPerformance(
  value: unknown,
  observedAt: unknown,
  consentAt: string | null,
): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const evidence = { ...(value as Record<string, unknown>) };
  const anomalies = Array.isArray(evidence.anomalies) ? evidence.anomalies : [];
  const kept = anomalies.filter((item) => {
    const time = diagnosticSourceUtc((item as { time?: unknown } | null)?.time);
    return time && consentAt && time >= consentAt;
  });
  const source = diagnosticSourceUtc(observedAt);
  const span = evidence.windowMs;
  const crossing =
    !source ||
    !consentAt ||
    typeof span !== 'number' ||
    !Number.isFinite(span) ||
    span < 0 ||
    Date.parse(source) - span < Date.parse(consentAt) ||
    kept.length !== anomalies.length;
  evidence.anomalies = kept;
  if (crossing) {
    for (const field of ['frames', 'longTasks', 'channels']) delete evidence[field];
    evidence.anomalyCount = kept.length;
    evidence.omittedAnomalySamples = null;
  }
  evidence.cloudCoverage = {
    excludedPreConsentOrUnknownTimeAnomalies: anomalies.length - kept.length,
    aggregateWindowExcluded: crossing,
    scope: crossing
      ? 'known post-consent anomaly records and current surfaces only; original aggregate/omitted sample times unavailable, local evidence retained'
      : 'source window and anomaly UTC after consent',
  };
  return evidence;
}
function cloudRecord(line: string, consentAt: string | null): unknown {
  const value = JSON.parse(line) as {
    stage?: string;
    evidence?: {
      samples?: { time?: string }[];
      entries?: { entry?: { time?: string; stage?: string; detail?: unknown } }[];
      sourceRecord?: { time?: string };
      [key: string]: unknown;
    };
  };
  if (value.stage?.startsWith('performance_anomaly_') && value.evidence?.sourceRecord) {
    const sourceTime = diagnosticSourceUtc(value.evidence.sourceRecord.time);
    if (!sourceTime || !consentAt || sourceTime < consentAt) {
      value.stage = 'diagnostic_source_excluded';
      value.evidence = { reason: 'recovered_source_before_consent_or_unknown_time' };
    }
  }
  if (value.stage === 'browser_control' && value.evidence?.operation === 'browser_performance')
    value.evidence.evidence = cloudBrowserPerformance(
      value.evidence.evidence,
      value.evidence.time,
      consentAt,
    );
  if (['browser_control', 'business_evidence', 'update_stage'].includes(value.stage ?? '')) {
    const source = diagnosticEnvelope(value).times;
    if (!consentAt || !source.length || source.some((time) => time < consentAt)) {
      value.stage = 'diagnostic_source_excluded';
      value.evidence = { reason: 'deferred_source_before_consent_or_unknown_time' };
    }
  }
  if (value.stage?.startsWith('performance_anomaly_') && value.evidence?.correlation) {
    const correlation = value.evidence.correlation as Record<string, unknown>;
    if (correlation.operation === 'browser_performance')
      correlation.originalEvidence = cloudBrowserPerformance(
        correlation.originalEvidence,
        correlation.observedAt,
        consentAt,
      );
    if (typeof correlation.operation === 'string' && correlation.operation.startsWith('browser_')) {
      const source = diagnosticSourceUtc(correlation.observedAt);
      if (!source || !consentAt || source < consentAt)
        value.evidence.correlation = {
          sourceEvidenceExcluded: true,
          reason: 'browser_source_before_consent_or_unknown_time',
        };
    }
  }
  if (value.stage === 'performance_anomaly_samples' && Array.isArray(value.evidence?.samples)) {
    const original = value.evidence.samples;
    const since = consentAt ? Date.parse(consentAt) : NaN;
    value.evidence.samples = original.filter((sample) => {
      if (!sample || typeof sample !== 'object') return false;
      const source = diagnosticSourceUtc(sample.time);
      const time = source ? Date.parse(source) : NaN;
      return Number.isFinite(since) && Number.isFinite(time) && time >= since;
    });
    value.evidence.cloudCoverage = {
      consentAt,
      excludedPreConsentOrUnknownTimeSamples: original.length - value.evidence.samples.length,
      scope: 'only source samples since consent; local window metadata describes original scope',
    };
  }
  if (value.stage === 'native_host_records' && Array.isArray(value.evidence?.entries)) {
    const original = value.evidence.entries;
    const since = consentAt ? Date.parse(consentAt) : NaN;
    const filteredConsole = original.map((record) => {
      const entry = record?.entry;
      if (entry?.stage !== 'cs2_console_records') return record;
      const detail = diagnosticConsoleEvidence(entry);
      const records = Array.isArray(detail?.records) ? detail.records : [];
      const kept = records.filter((value: unknown) => {
        if (!value || typeof value !== 'object') return false;
        const item = value as Record<string, unknown>;
        const after = diagnosticSourceUtc(item.sourceAfterUtc);
        const captured = diagnosticSourceUtc(item.capturedAt);
        const host = diagnosticSourceUtc(entry.time);
        return (
          Number.isFinite(since) &&
          after !== null &&
          captured !== null &&
          host !== null &&
          Date.parse(after) >= since &&
          after <= captured &&
          captured <= host
        );
      });
      return {
        ...record,
        entry: {
          ...entry,
          detail: JSON.stringify({
            ...(detail ?? { source: 'owned-cs2-technical-console', rawFileIncluded: false }),
            records: kept,
            cloudCoverage: {
              excludedPreConsentUnknownOrInvalidSourceRecords: records.length - kept.length,
              sourceEnvelopeValid: detail !== null,
              scope:
                'source write interval, never Host poll time, controls console consent; full local source retained',
            },
          }),
        },
      };
    });
    value.evidence.entries = filteredConsole.filter((record) => {
      const entry = record?.entry;
      if (!entry || typeof entry !== 'object' || typeof entry.time !== 'string') return false;
      const source = diagnosticSourceUtc(entry.time);
      const time = source ? Date.parse(source) : NaN;
      return (
        Number.isFinite(since) &&
        Number.isFinite(time) &&
        time >= since &&
        typeof entry.stage === 'string' &&
        !/chat/i.test(entry.stage)
      );
    });
    value.evidence.cloudCoverage = {
      consentAt,
      excludedPreConsentUnknownTimeOrChatRecords: original.length - value.evidence.entries.length,
      scope:
        'original Host source time controls consent; delayed copying cannot authorize historical upload',
    };
  }
  return cloudValue(diagnosticValue(value));
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
  const code =
    receipt && typeof receipt === 'object' ? (receipt as { error?: unknown }).error : undefined;
  const reason =
    typeof code === 'string' && /^[a-z][a-z0-9_]{0,95}$/.test(code) ? code : 'receipt_invalid';
  return Object.assign(
    new Error(`${operation}_unconfirmed_${status}`, { cause: new Error(reason) }),
    { status, reason },
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
  return {
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
  private pending: { line: string; sessionId: string; sequence: number }[] = [];
  private pendingBytes = 0;
  private recoveryNeeded = false;
  private serial = Promise.resolve();
  private sending: Promise<void> | undefined;
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
  private readonly endpoint: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly queueDirectory: string;
  private nextCollectionAt: number;
  private collectionScheduled = false;
  constructor(
    private readonly directory: string,
    private readonly journal: SessionJournal,
    private readonly options: {
      endpoint?: string;
      fetch?: typeof fetch;
      now?: () => number;
      allowTestEndpoint?: boolean;
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
    const entries = await readdir(this.queueDirectory, { withFileTypes: true });
    for (const entry of entries)
      if (/^consent-revoked-[a-f0-9-]{36}\.flag$/.test(entry.name)) {
        await secureRead(this.queueDirectory, entry.name, 16);
        if (this.fences.size >= 64) throw new Error('revocation_marker_budget');
        this.fences.set(entry.name, Promise.resolve());
      }
    // The ninety-day identifiable index needs fresh consent, not an implicit
    // extension of the earlier seven-day-body-only disclosure.
    if (this.state.consent && this.state.consentPolicy !== 2) {
      const name = `consent-revoked-${randomUUID()}.flag`;
      await this.createFence(name);
      this.fences.set(name, Promise.resolve());
      this.error = 'consent_policy_changed';
    }
    if (this.fences.size) {
      this.revocationFenced = true;
      if (
        this.state.credentials &&
        (this.state.credentials.enrollmentAttempted || this.state.credentials.token) &&
        !this.state.withdrawals.some(
          (v) => v.installationId === this.state.credentials!.installationId,
        )
      )
        this.state.withdrawals.push(this.state.credentials);
      this.state.consent = false;
      this.state.credentials = null;
      this.state.sessions = {};
      this.state.queue = [];
      this.state.failures = 0;
      this.state.nextAttemptAt = 0;
      await this.save();
    }
    this.requestedConsent = this.state.consent;
    this.requestedPause = this.state.paused;
    // Bytes not referenced by the atomic manifest were never eligible for upload.
    for (const entry of await readdir(this.queueDirectory, { withFileTypes: true }))
      if (
        entry.isFile() &&
        /^[a-f0-9]{64}\.gz$/.test(entry.name) &&
        !this.state.queue.some((v) => `${v.id}.gz` === entry.name)
      )
        await unlink(join(this.queueDirectory, entry.name));
    this.unsubscribe = this.journal.subscribe((line) => this.observe(line));
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
      queuedBatches: this.state.queue.length,
      blockedBatches: this.state.queue.filter((value) => value.serverExpired).length,
      queuedBytes: this.state.queue.reduce((n, v) => n + v.bytes, 0),
      pendingBytes: this.pendingBytes,
      omitted: this.state.omitted,
      omissionReasons: this.state.omissionReasons,
      acknowledged: this.state.acknowledged,
      deletionPending: this.state.withdrawals.length,
      nextAttemptAt: this.state.nextAttemptAt,
      failures: this.state.failures,
      error: this.error,
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
        if (this.state.consent && !this.revocationFenced) return this.status();
        if (this.state.withdrawals.length >= DELIVERY_LIMITS.tombstones)
          throw new Error('withdrawal_sync_required');
        const previous = structuredClone(this.state);
        this.state.consent = true;
        this.state.consentPolicy = 2;
        this.state.consentAt = new Date(this.now()).toISOString();
        this.state.credentials = {
          installationId: randomUUID(),
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
      } else {
        await fence;
        const prior = this.state.credentials;
        this.state.consent = false;
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
        const removed = this.state.queue.splice(0);
        this.state.nextAttemptAt = 0;
        this.state.failures = 0;
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
        for (const batch of removed)
          await unlink(join(this.queueDirectory, `${batch.id}.gz`)).catch((error) => {
            if (!missing(error)) throw error;
          });
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
      this.state.nextAttemptAt = 0;
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
  private observe(line: string, recovering = false) {
    if (!this.consentActive() || this.closed || (this.recoveryNeeded && !recovering)) return;
    // Journal supplies an immutable, already-redacted durable record.
    const value = JSON.parse(line) as { startupSessionId: string; sequence: number; stage: string };
    if (
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.startupSessionId) ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 1 ||
      typeof value.stage !== 'string' ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(value.stage)
    ) {
      this.omitted('invalid_source_cursor');
      return;
    }
    const cursor = this.state.sessions[value.startupSessionId];
    if (
      !cursor ||
      value.sequence <= cursor.queued ||
      this.pending.some(
        (v) => v.sessionId === value.startupSessionId && v.sequence === value.sequence,
      )
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
      return;
    }
    this.pending.push({ line, sessionId: value.startupSessionId, sequence: value.sequence });
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
    const startedSequence = this.journal.health().sequence;
    // Fixed Mizar log names only; source rotation remains governed by SessionJournal.
    for (let i = SESSION_LIMITS.segments - 1; i >= 0; i--) {
      const name = i ? `session.ndjson.${i}` : 'session.ndjson';
      let bytes: Buffer;
      try {
        bytes = await secureRead(
          this.directory,
          name,
          SESSION_LIMITS.segmentBytes + SESSION_LIMITS.pendingBytes,
        );
      } catch (error) {
        if (missing(error)) continue;
        this.error = 'journal_unreadable';
        continue;
      }
      let count = 0;
      for (const line of bytes.toString('utf8').split('\n')) {
        if (!line) continue;
        try {
          this.observe(line + '\n', true);
        } catch {
          this.omitted('unreadable_journal_record');
        }
        if (++count % 32 === 0) await yieldIO();
        if (this.pendingBytes > DELIVERY_LIMITS.pendingBytes / 2) await this.persist();
        if (
          this.state.queue.reduce((n, v) => n + v.bytes, 0) >
          DELIVERY_LIMITS.queueBytes - DELIVERY_LIMITS.compressedBytes
        )
          return;
      }
    }
    await this.persist();
    for (const id of Object.keys(this.state.sessions)) {
      if (id === this.journal.sessionId || this.pending.some((v) => v.sessionId === id)) continue;
      delete this.state.sessions[id];
    }
    this.registerSession(0);
    await this.save();
    this.recoveryNeeded = this.journal.health().sequence !== startedSequence;
  }
  private async persist() {
    if (!this.consentActive()) return;
    const epoch = this.epoch;
    // Bound this collection to its admitted prefix. New committed records may
    // arrive during compression/fsync; keep them for the next scheduled batch.
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
      let compressed = await compress(raw);
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
        compressed = await compress(raw);
      }
      if (!this.consentActive() || epoch !== this.epoch) return;
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
        return;
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
        return;
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
        const cursor = this.state.sessions[item.sessionId];
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
        throw error;
      }
      this.pending.splice(0, selected.length);
      remaining -= selected.length;
      this.pendingBytes -= selected.reduce((n, v) => n + Buffer.byteLength(v.line), 0);
      await yieldIO();
    }
  }
  private async credentials(value: Credentials, signal: AbortSignal) {
    if (value.token && (value.expiresAt ?? 0) > this.now() + 60_000) return value.token;
    value.enrollmentAttempted = true;
    await this.transaction(() => this.save());
    if (signal.aborted) throw new Error('enrollment_aborted');
    const response = await this.fetcher(`${this.endpoint}/v1/diagnostics/enroll`, {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        consent: CONSENT,
        enrollmentId: value.installationId,
        enrollmentSecret: value.enrollmentSecret,
      }),
    });
    const responseData = await responseJson(response, signal);
    if (!response.ok) throw transportReceiptError('enrollment', response.status, responseData);
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
      throw new Error('invalid_enrollment_ack');
    value.token = data.token;
    value.expiresAt = data.expiresAt;
    return data.token;
  }
  async tick(forceCollection = true) {
    await this.transaction(async () => {
      const collecting = forceCollection || this.now() >= this.nextCollectionAt;
      if (collecting) {
        await this.persist();
        this.nextCollectionAt = this.now() + DELIVERY_LIMITS.collectMs;
      }
      if (this.recoveryNeeded) await this.recover();
      if (collecting) await this.persist();
    });
    if (!this.endpoint || this.closed || this.now() < this.state.nextAttemptAt) return;
    this.sending ??= this.send().finally(() => {
      this.sending = undefined;
    });
    await this.sending;
  }
  private async send() {
    const epoch = this.epoch;
    this.abort = new AbortController();
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]);
    try {
      for (const item of [...this.state.withdrawals]) {
        const bearer = await this.credentials(item, signal);
        const response = await this.fetcher(`${this.endpoint}/v1/diagnostics/installation`, {
          method: 'DELETE',
          redirect: 'error',
          signal,
          headers: { authorization: `Bearer ${bearer}` },
        });
        const ack = (await responseJson(response, signal)) as {
          installationId: string;
          revoked: boolean;
          deletion: string;
        };
        if (
          !response.ok ||
          ack.installationId !== item.installationId ||
          ack.revoked !== true ||
          ack.deletion !== 'complete'
        )
          throw new Error('withdrawal_pending');
        await this.transaction(async () => {
          const previous = this.state.withdrawals;
          this.state.withdrawals = previous.filter((v) => v.installationId !== item.installationId);
          try {
            await this.save();
          } catch (error) {
            this.state.withdrawals = previous;
            throw error;
          }
        });
      }
      if (
        !this.consentActive() ||
        this.requestedPause ||
        !this.state.credentials ||
        epoch !== this.epoch
      )
        return;
      const identity = this.state.credentials;
      const bearer = await this.credentials(identity, signal);
      await this.transaction(() => this.save());
      const selectedBatch = this.state.queue.find((value) => !value.serverExpired);
      if (!selectedBatch) return;
      let batch: Batch = selectedBatch;
      let bytes = await secureRead(
        this.queueDirectory,
        `${batch.id}.gz`,
        DELIVERY_LIMITS.compressedBytes,
      );
      if (checksum(bytes) !== batch.id) throw new Error('batch_integrity_failed');
      if (!batch.sealed) {
        const response = await this.fetcher(`${this.endpoint}/v1/diagnostics/permits/${batch.id}`, {
          method: 'POST',
          redirect: 'error',
          signal,
          headers: { authorization: `Bearer ${bearer}` },
        });
        const receipt = await responseJson(response, signal);
        const permit = diagnosticPermit(receipt);
        if (
          response.status === 410 &&
          (receipt as { error?: string }).error === 'batch_retention_expired'
        ) {
          await this.retainExpiredBatch(batch, epoch);
          return;
        }
        if (!response.ok) throw transportReceiptError('permit', response.status, receipt);
        if (
          !permit ||
          permit.installationId !== identity.installationId ||
          permit.payloadSha256 !== batch.id
        )
          throw new Error('invalid_batch_permit');
        const sealed = Buffer.from(sealDiagnosticGzip(bytes, permit));
        const oldBatch = batch;
        const newBatch = { ...batch, id: checksum(sealed), bytes: sealed.length, sealed: true };
        await this.transaction(async () => {
          if (!this.consentActive() || this.requestedPause || epoch !== this.epoch) return;
          const name = `${newBatch.id}.gz`;
          await safePath(this.queueDirectory, name).catch((error) => {
            if (!missing(error)) throw error;
          });
          const file = await open(
            join(this.queueDirectory, name),
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
            0o600,
          );
          try {
            await file.writeFile(sealed);
            await file.sync();
          } catch (error) {
            await file.close();
            await unlink(join(this.queueDirectory, name)).catch(() => undefined);
            throw error;
          } finally {
            await file.close();
          }
          const previous = this.state.queue;
          this.state.queue = previous.map((item) => (item.id === oldBatch.id ? newBatch : item));
          try {
            await this.save();
          } catch (error) {
            this.state.queue = previous;
            await unlink(join(this.queueDirectory, name)).catch(() => undefined);
            throw error;
          }
          batch = newBatch;
          bytes = sealed;
          await unlink(join(this.queueDirectory, `${oldBatch.id}.gz`));
        });
      }

      if (!this.consentActive() || this.requestedPause || epoch !== this.epoch) return;
      const response = await this.fetcher(`${this.endpoint}/v1/diagnostics/batches/${batch.id}`, {
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
      });
      const ack = (await responseJson(response, signal)) as {
        batchId: string;
        sha256: string;
        accepted: boolean;
        error?: unknown;
      };
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
        this.state.queue = this.state.queue.filter((v) => v.id !== batch.id);
        this.state.acknowledged++;
        this.state.failures = 0;
        this.state.nextAttemptAt = 0;
        this.error = null;
        try {
          await this.save();
        } catch (error) {
          this.state = previous;
          throw error;
        }
        await unlink(join(this.queueDirectory, `${batch.id}.gz`));
      });
    } catch (error) {
      if (epoch !== this.epoch || this.requestedPause) return;
      await this.transaction(async () => {
        this.state.failures++;
        this.state.nextAttemptAt =
          this.now() +
          Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(this.state.failures - 1, 10)) *
            (0.8 + (randomBytes(1)[0]! / 255) * 0.4);
        this.error = error instanceof Error ? error.message : 'delivery_failed';
        this.journal.record('diagnostic_transport_failure', {
          error: diagnosticValue(error, '', new Set(), [
            this.state.credentials?.enrollmentSecret ?? '',
            this.state.credentials?.token ?? '',
            ...this.state.withdrawals.flatMap((value) => [
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
      this.abort = undefined;
    }
  }
  private async retainExpiredBatch(batch: Batch, epoch: number) {
    await this.transaction(async () => {
      if (epoch !== this.epoch || !this.consentActive()) return;
      const previous = structuredClone(this.state);
      const retained = this.state.queue.find((value) => value.id === batch.id);
      if (!retained || retained.serverExpired) return;
      retained.serverExpired = true;
      this.omitted('server_retention_expired', batch.index.events);
      try {
        await this.save();
      } catch (error) {
        this.state = previous;
        throw error;
      }
      this.error = 'server_retention_expired_local_copy_retained';
      this.journal.record('diagnostic_cloud_expired', {
        batchId: batch.id,
        events: batch.index.events,
        reason: 'server_retention_expired',
        localCopy: 'retained; not acknowledged or evicted',
      });
    });
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.abort?.abort();
    await this.sending;
    await this.transaction(() => this.persist());
  }
  /** Explicit manual export only. Copies immutable bodies while ACK/deletion is
   * serialized; never exports the credential manifest. At most queueBytes of gzip. */
  retainedBatches(): Promise<RetainedDiagnosticBatch[]> {
    return this.transaction(async () => {
      const snapshots: RetainedDiagnosticBatch[] = [];
      try {
        await this.persist();
      } catch (error) {
        snapshots.push({ id: null, sourceBytes: 0, error: diagnosticValue(error) });
      }
      for (const batch of this.state.queue) {
        try {
          const gzip = await secureRead(
            this.queueDirectory,
            `${batch.id}.gz`,
            DELIVERY_LIMITS.compressedBytes,
          );
          if (checksum(gzip) !== batch.id) throw new Error('batch_integrity_failed');
          snapshots.push({ id: batch.id, sourceBytes: gzip.length, gzip });
        } catch (error) {
          snapshots.push({ id: batch.id, sourceBytes: batch.bytes, error: diagnosticValue(error) });
        }
        await yieldIO();
      }
      return snapshots;
    });
  }
}
