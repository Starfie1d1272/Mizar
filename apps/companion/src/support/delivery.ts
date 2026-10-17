import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, unlink, writeFile } from 'node:fs/promises';
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
  expandedBytes: 512 * 1024,
  compressedBytes: 128 * 1024,
  queueBytes: 32 * 1024 * 1024,
  batches: 256,
  manifestBytes: 256 * 1024,
  pendingBytes: 2 * 1024 * 1024,
  events: 512,
  sessions: 128,
  tombstones: 8,
};
const CONSENT = 'technical-diagnostics-v1';
interface Credentials {
  installationId: string;
  enrollmentSecret: string;
  token?: string;
  expiresAt?: number;
}
interface Batch {
  id: string;
  bytes: number;
  index: { schema: string; events: number; expandedBytes: number; stages: string[] };
}
interface State {
  version: 1;
  consent: boolean;
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
const initial = (): State => ({
  version: 1,
  consent: false,
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
const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
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
  private error: string | null = null;
  private readonly endpoint: string | undefined;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly queueDirectory: string;
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
    this.queueDirectory = join(directory, 'diagnostic-outbox');
  }
  async initialize(startTimer = true) {
    await mkdir(this.queueDirectory, { recursive: true, mode: 0o700 });
    await safePath(this.queueDirectory);
    try {
      const value = JSON.parse(
        (
          await secureRead(this.queueDirectory, 'state.json', DELIVERY_LIMITS.manifestBytes)
        ).toString(),
      ) as State;
      if (
        value.version !== 1 ||
        typeof value.consent !== 'boolean' ||
        !Array.isArray(value.queue) ||
        !Array.isArray(value.withdrawals) ||
        !value.sessions ||
        value.queue.length > DELIVERY_LIMITS.batches ||
        value.withdrawals.length > DELIVERY_LIMITS.tombstones ||
        Object.keys(value.sessions).length > DELIVERY_LIMITS.sessions ||
        !value.queue.every(
          (v) =>
            validId(v.id) &&
            Number.isSafeInteger(v.bytes) &&
            v.bytes > 0 &&
            v.bytes <= DELIVERY_LIMITS.compressedBytes,
        ) ||
        value.queue.reduce((n, v) => n + v.bytes, 0) > DELIVERY_LIMITS.queueBytes
      )
        throw new Error('invalid_delivery_state');
      this.state = value;
    } catch (error) {
      if (!missing(error)) {
        this.error = 'state_unreadable';
        throw error;
      }
    }
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
      this.registerSession(0);
      await this.save();
      await this.recover();
    }
    if (startTimer) {
      this.timer = setInterval(() => {
        void this.tick().catch(() => {
          this.error = 'delivery_failed';
        });
      }, 60_000);
      this.timer.unref();
    }
    return this;
  }
  private registerSession(from: number) {
    if (
      !this.state.sessions[this.journal.sessionId] &&
      Object.keys(this.state.sessions).length >= DELIVERY_LIMITS.sessions
    )
      throw new Error('session_budget');
    this.state.sessions[this.journal.sessionId] ??= { from, queued: from };
  }
  status() {
    return {
      configured: Boolean(this.endpoint),
      consent: this.state.consent,
      consentAt: this.state.consentAt,
      queuedBatches: this.state.queue.length,
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
  async consent(enabled: boolean) {
    // Revocation takes effect before any await, including while network I/O is in flight.
    const prior = this.state.credentials;
    if (!enabled) {
      this.epoch++;
      this.abort?.abort();
      this.state.consent = false;
      this.pending = [];
      this.pendingBytes = 0;
    }
    return this.transaction(async () => {
      if (enabled) {
        if (this.state.consent) return this.status();
        if (this.state.withdrawals.length >= DELIVERY_LIMITS.tombstones)
          throw new Error('withdrawal_sync_required');
        this.state.consent = true;
        this.state.consentAt = new Date(this.now()).toISOString();
        this.state.credentials = {
          installationId: randomUUID(),
          enrollmentSecret: randomBytes(32).toString('hex'),
        };
        this.state.sessions = {};
        this.registerSession(this.journal.health().sequence);
      } else {
        if (prior && !this.state.withdrawals.some((v) => v.installationId === prior.installationId))
          this.state.withdrawals.push(prior);
        this.state.credentials = null;
        this.state.sessions = {};
      }
      const removed = enabled ? [] : this.state.queue.splice(0);
      this.state.nextAttemptAt = 0;
      this.state.failures = 0;
      await this.save();
      for (const batch of removed)
        await unlink(join(this.queueDirectory, `${batch.id}.gz`)).catch((error) => {
          if (!missing(error)) throw error;
        });
      this.journal.record('diagnostic_consent', {
        enabled,
        revision: CONSENT,
        result: 'persisted',
        deletionPending: this.state.withdrawals.length,
      });
      return this.status();
    });
  }
  private omitted(reason: string, count = 1) {
    this.state.omitted += count;
    this.state.omissionReasons[reason] = (this.state.omissionReasons[reason] ?? 0) + count;
  }
  private observe(line: string, recovering = false) {
    if (!this.state.consent || this.closed || (this.recoveryNeeded && !recovering)) return;
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
    this.recoveryNeeded = this.journal.health().sequence !== startedSequence;
  }
  private async persist() {
    if (!this.state.consent) return;
    while (this.pending.length) {
      const selected: typeof this.pending = [];
      let bytes = 128;
      for (const item of this.pending) {
        const length = Buffer.byteLength(item.line);
        if (
          selected.length &&
          (bytes + length > DELIVERY_LIMITS.expandedBytes ||
            selected.length >= DELIVERY_LIMITS.events)
        )
          break;
        selected.push(item);
        bytes += length;
      }
      let events = selected.map((v) => cloudValue(diagnosticValue(JSON.parse(v.line))));
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
        (compressed.length > DELIVERY_LIMITS.compressedBytes ||
          raw.length > DELIVERY_LIMITS.expandedBytes)
      ) {
        selected.splice(Math.ceil(selected.length / 2));
        events = selected.map((v) => cloudValue(diagnosticValue(JSON.parse(v.line))));
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
      if (!this.state.consent) return;
      if (
        compressed.length > DELIVERY_LIMITS.compressedBytes ||
        raw.length > DELIVERY_LIMITS.expandedBytes
      ) {
        this.omitted('batch_size_budget', selected.length);
        this.pending.splice(0, selected.length);
        this.pendingBytes -= selected.reduce((n, v) => n + Buffer.byteLength(v.line), 0);
        continue;
      }
      if (
        this.state.queue.length >= DELIVERY_LIMITS.batches ||
        this.state.queue.reduce((n, v) => n + v.bytes, 0) + compressed.length >
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
      await writeFile(path, compressed, { flag: 'wx', mode: 0o600 }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        await file.sync();
      } finally {
        await file.close();
      }
      const batch: Batch = {
        id,
        bytes: compressed.length,
        index: {
          schema: 'mizar-technical-diagnostics/1',
          events: events.length,
          expandedBytes: raw.length,
          stages: [...new Set(events.map((v) => (v as { stage: string }).stage))].slice(0, 32),
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
      this.pendingBytes -= selected.reduce((n, v) => n + Buffer.byteLength(v.line), 0);
      await yieldIO();
    }
  }
  private async credentials(value: Credentials, signal: AbortSignal) {
    if (value.token && (value.expiresAt ?? 0) > this.now() + 60_000) return value.token;
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
    if (!response.ok) throw new Error(`enrollment_http_${response.status}`);
    const data = (await response.json()) as {
      installationId: string;
      token: string;
      expiresAt: number;
    };
    if (
      data.installationId !== value.installationId ||
      typeof data.token !== 'string' ||
      data.token.length > 2048 ||
      !Number.isSafeInteger(data.expiresAt)
    )
      throw new Error('invalid_enrollment_ack');
    value.token = data.token;
    value.expiresAt = data.expiresAt;
    return data.token;
  }
  async tick() {
    await this.transaction(async () => {
      await this.persist();
      if (this.recoveryNeeded) await this.recover();
      await this.persist();
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
        const ack = (await response.json()) as {
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
          this.state.withdrawals = this.state.withdrawals.filter(
            (v) => v.installationId !== item.installationId,
          );
          await this.save();
        });
      }
      if (!this.state.consent || !this.state.credentials || epoch !== this.epoch) return;
      const identity = this.state.credentials;
      const bearer = await this.credentials(identity, signal);
      await this.transaction(() => this.save());
      const batch = this.state.queue[0];
      if (!batch) return;
      const bytes = await secureRead(
        this.queueDirectory,
        `${batch.id}.gz`,
        DELIVERY_LIMITS.compressedBytes,
      );
      if (checksum(bytes) !== batch.id) throw new Error('batch_integrity_failed');
      if (!this.state.consent || epoch !== this.epoch) return;
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
      const ack = (await response.json()) as { batchId: string; sha256: string; accepted: boolean };
      if (
        !response.ok ||
        ack.batchId !== batch.id ||
        ack.sha256 !== batch.id ||
        ack.accepted !== true
      )
        throw new Error(`upload_unconfirmed_${response.status}`);
      await this.transaction(async () => {
        if (epoch !== this.epoch || !this.state.consent) return;
        this.state.queue = this.state.queue.filter((v) => v.id !== batch.id);
        this.state.acknowledged++;
        this.state.failures = 0;
        this.state.nextAttemptAt = 0;
        this.error = null;
        await this.save();
        await unlink(join(this.queueDirectory, `${batch.id}.gz`));
      });
    } catch (error) {
      if (epoch !== this.epoch) return;
      await this.transaction(async () => {
        this.state.failures++;
        this.state.nextAttemptAt =
          this.now() +
          Math.min(6 * 3600_000, 30_000 * 2 ** Math.min(this.state.failures - 1, 10)) *
            (0.8 + (randomBytes(1)[0]! / 255) * 0.4);
        this.error = error instanceof Error ? error.message : 'delivery_failed';
        await this.save();
      });
    } finally {
      this.abort = undefined;
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.abort?.abort();
    await this.sending;
    await this.transaction(() => this.persist());
  }
}
