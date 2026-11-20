import { performanceSegmentPattern } from './segments.js';
import { isDiagnosticEvent } from '@mizar/protocol';
import {
  DIAGNOSTIC_PERMIT_BYTES,
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
import { constants } from 'node:fs';
import { mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { setImmediate as yieldIO } from 'node:timers/promises';
import { join } from 'node:path';
import { safePath } from '../resource-store/files.js';
import { diagnosticSourceUtc } from './envelope.js';
import { diagnosticValue, type SessionJournal } from './session-journal.js';
import {
  DELIVERY_LIMITS,
  LEGACY_QUEUE_LIMITS,
  CONSENT,
  diagnosticKind,
  retryDelay,
  transportFailureReason,
  diagnosticsEndpoint,
  cloudRecord,
  decodeDiagnosticBatch,
  transportReceiptError,
  batchMetadata,
  credentialsSchema,
  stateSchema,
  initial,
  missing,
  checksum,
  responseJson,
  secureRead,
  recoverSealedBatch,
  orderedSources,
  mergedSourceLines,
  compress,
  decompress,
  type Batch,
  type Credentials,
  type Withdrawal,
  type State,
} from './delivery-encoding.js';

export { DELIVERY_LIMITS, diagnosticsEndpoint, decodeDiagnosticBatch };

/** One local outbox. Queue references and source cursors commit together, before upload. */
export class DiagnosticDelivery {
  private state = initial();
  private pending: { line: string; sessionId: string; cursorId: string; sequence: number }[] = [];
  private pendingBytes = 0;
  private recoveryNeeded = false;
  private serial = Promise.resolve();
  private pumping: Promise<void> | undefined;
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
  /** Drop legacy event/1 or already-acknowledged wire references from queue accounting. */
  private async isolateRetiredQueue() {
    const previous = this.state.queue;
    const current: Batch[] = [];
    let isolated = 0;
    for (const batch of previous) {
      if (batch.acknowledgedAt) {
        await unlink(join(this.queueDirectory, `${batch.id}.gz`)).catch((error) => {
          if (!missing(error)) throw error;
        });
        continue;
      }
      if (batch.index.eventSchemaVersion !== 2) {
        isolated++;
        continue;
      }
      current.push(batch);
    }
    if (current.length === previous.length) return;
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
      queuedBatches: this.state.queue.length,
      retainedAcknowledgedBatches: 0,
      blockedBatches: this.state.queue.filter((value) => value.serverExpired).length,
      queuedBytes: this.state.queue.reduce((n, v) => n + v.bytes, 0),
      pendingBytes: this.pendingBytes,
      omitted: this.state.omitted,
      omissionReasons: this.state.omissionReasons,
      acknowledged: this.state.acknowledged,
      deletionPending: this.state.withdrawals.length,
      retiredIdentityCount: 0,
      nextAttemptAt: this.state.nextAttemptAt,
      failures: this.state.failures,
      consecutiveFailures: this.state.consecutiveFailures,
      sendableBatches: this.state.queue.filter((value) => !value.serverExpired).length,
      manualOnlyBatches: this.state.queue.filter((value) => value.serverExpired).length,
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
        if (this.state.consent && !this.revocationFenced) {
          // A preceding baseline write can fail after consent itself was saved.
          // An explicit retry must capture it rather than silently returning success.
          await this.options.onConsent?.();
          return this.status();
        }
        if (this.state.withdrawals.length >= DELIVERY_LIMITS.tombstones)
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
      !diagnosticKind.test(value.stage)
    ) {
      this.omitted('invalid_source_cursor');
      return;
    }
    // Invalid records and new chat-only sources must not create producer cursors.
    // Existing cursors deduplicate old chat records before counting their exclusion.
    if (!this.state.sessions[cursorId] && /chat/i.test(value.stage)) {
      this.omitted('chat_not_collected');
      return;
    }
    // Cursor history shares the existing manifest byte budget with queue metadata.
    const cursor = (this.state.sessions[cursorId] ??= { from: 0, queued: 0 });
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
        if (await this.persist()) this.nextCollectionAt = this.now() + DELIVERY_LIMITS.collectMs;
      })
        .catch(() => {
          this.error = 'queue_write_unconfirmed';
        })
        .finally(() => {
          this.collectionScheduled = false;
        });
    }
  }
  private async canonicalSourceExists(sessionId: string | undefined): Promise<boolean> {
    if (!sessionId) return false;
    if (sessionId === this.journal.sessionId) return true;
    try {
      const names = await readdir(this.directory);
      if (names.some((name) => name.includes(sessionId))) return true;
      const perf = await readdir(join(this.directory, 'performance-pending')).catch(() => []);
      return perf.some((name) => name.includes(sessionId));
    } catch {
      return false;
    }
  }
  private nextUpload(): Batch | undefined {
    return this.state.queue.find(
      (batch) =>
        !batch.serverExpired && !batch.acknowledgedAt && batch.index.eventSchemaVersion === 2,
    );
  }
  private waitForTransportRecovery(): boolean {
    const failure = this.state.transportFailure;
    if (
      this.requestedPause ||
      !failure ||
      (failure.status !== null && failure.status < 500) ||
      !this.nextUpload()
    )
      return false;
    this.recoveryNeeded = true;
    // The next normal pump after a confirmed recovery collects the retained tail.
    this.nextCollectionAt = Math.min(this.nextCollectionAt, this.now());
    return true;
  }
  private async recover(flush = true) {
    if (!this.consentActive() || this.closed || this.waitForTransportRecovery()) return;
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
          if (admitted === false) {
            await this.persist();
            return;
          }
          if (++count % 32 === 0) await yieldIO();
          if (this.pendingBytes > DELIVERY_LIMITS.pendingBytes / 2 && !(await this.persist()))
            return;
          if (
            this.state.queue.filter((batch) => !batch.serverExpired && !batch.acknowledgedAt)
              .length >= DELIVERY_LIMITS.batches
          ) {
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
        if (!missing(error))
          this.error = error instanceof Error ? error.message : 'journal_unreadable';
        sourceUnavailable = true;
      }
    }
    // Performance bodies are final gzip evidence, not copies inside the ordinary journal.
    const performanceDirectory = join(this.directory, 'performance-pending');
    try {
      await safePath(performanceDirectory);
      const files = (await readdir(performanceDirectory)).filter((name) =>
        performanceSegmentPattern.test(name),
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
          const first = records[0];
          if (!first) continue;
          const run = String(first.producerRunId);
          const cursor = this.state.sessions[`performance:${run}`];
          if (
            cursor &&
            records.every(
              (event) =>
                isDiagnosticEvent(event) &&
                event.producerKind === 'companion' &&
                event.producerRunId === run &&
                diagnosticKind.test(event.kind) &&
                event.sequence <= cursor.queued,
            )
          )
            continue;
          ordered.push({ name, run, sequence: Number(first.sequence) });
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
    // recovery flag until the complete prefix is admitted. Background scans
    // keep it in the existing pending buffer until the normal collection time;
    // only persisted batches advance durable cursors.
    if ((flush && !(await this.persist())) || sourceUnavailable) return;
    // Keep producer cursors across restart; forgetting a recovered producer would
    // regenerate its already-queued immutable batches on the next scan.
    this.registerSession(0);
    await this.save();
    // A record may have its sequence allocated before this scan but commit
    // after the file snapshot. Observe durable notifications as well as new
    // allocations so that this tail is picked up on the next bounded scan.
    this.recoveryNeeded =
      this.sourceRevision !== startedRevision || this.journal.health().sequence !== startedSequence;
  }
  private async persist(): Promise<boolean> {
    if (!this.consentActive()) return false;
    if (!this.closed && this.waitForTransportRecovery()) return false;
    const epoch = this.epoch;
    // Freeze a contiguous carrier prefix. Group its events for transport, then
    // commit every resulting file and its source cursors in one manifest write.
    this.pending.sort((a, b) => a.cursorId.localeCompare(b.cursorId) || a.sequence - b.sequence);
    let remaining = this.pending.length;
    while (remaining > 0) {
      let count = Math.min(remaining, DELIVERY_LIMITS.events);
      let packets: { batch: Batch; compressed: Buffer }[];
      let skipped: number;
      for (;;) {
        packets = [];
        skipped = 0;
        const groups = new Map<string, typeof this.pending>();
        for (const item of this.pending.slice(0, count)) {
          const group = groups.get(item.sessionId) ?? [];
          group.push(item);
          groups.set(item.sessionId, group);
        }
        for (const [sessionId, group] of groups) {
          const projected = group.map((item) => cloudRecord(item.line, this.state.consentAt));
          let offset = 0;
          while (offset < projected.length) {
            let size = projected.length - offset;
            let raw: Buffer;
            let compressed: Buffer | null;
            let events: ReturnType<typeof cloudRecord>[];
            for (;;) {
              events = projected.slice(offset, offset + size);
              raw = Buffer.from(
                JSON.stringify({
                  schema: 'mizar-technical-diagnostics/1',
                  coverage: {
                    omitted: this.state.omitted,
                    reasons: this.state.omissionReasons,
                    scope:
                      'consented retained technical journal; not complete raw GSI or browser pixels',
                  },
                  events,
                }),
              );
              compressed =
                raw.length <= DELIVERY_LIMITS.expandedBytes
                  ? await compress(raw, { level: 3 })
                  : null;
              if (
                compressed &&
                compressed.length <= DELIVERY_LIMITS.compressedBytes - DIAGNOSTIC_PERMIT_BYTES
              )
                break;
              if (size === 1) break;
              size = Math.ceil(size / 2);
            }
            if (
              !compressed ||
              compressed.length > DELIVERY_LIMITS.compressedBytes - DIAGNOSTIC_PERMIT_BYTES
            ) {
              skipped++;
            } else {
              const stamped = Buffer.from(stampDiagnosticGzip(compressed, this.now()));
              packets.push({
                compressed: stamped,
                batch: {
                  id: checksum(stamped),
                  bytes: stamped.length,
                  index: {
                    schema: 'mizar-technical-diagnostics/1',
                    events: events.length,
                    expandedBytes: raw.length,
                    stages: [...new Set(events.map((v) => (v as { stage: string }).stage))].slice(
                      0,
                      32,
                    ),
                    ...batchMetadata(sessionId, events),
                  },
                },
              });
            }
            offset += size;
          }
        }
        const queue = [...this.state.queue, ...packets.map(({ batch }) => batch)];
        const active = queue.filter((batch) => !batch.serverExpired && !batch.acknowledgedAt);
        const capacity =
          active.length <= DELIVERY_LIMITS.batches &&
          active.reduce((n, v) => n + v.bytes + (v.sealed ? 0 : DIAGNOSTIC_PERMIT_BYTES), 0) <=
            DELIVERY_LIMITS.queueBytes &&
          queue.filter((batch) => !batch.acknowledgedAt).length <= LEGACY_QUEUE_LIMITS.batches &&
          queue.reduce((n, v) => n + v.bytes + (v.sealed ? 0 : DIAGNOSTIC_PERMIT_BYTES), 0) <=
            LEGACY_QUEUE_LIMITS.queueBytes;
        const manifest =
          Buffer.byteLength(JSON.stringify({ ...this.state, queue })) <=
          DELIVERY_LIMITS.manifestBytes;
        if (capacity && manifest) break;
        // Split only a prefix that exceeds the queue's hard capacity on its own.
        // Temporary occupancy must wait for sends, not create tiny packets per poll.
        const prefix = packets.map(({ batch }) => batch);
        const fitsEmptyQueue =
          prefix.length <= DELIVERY_LIMITS.batches &&
          prefix.reduce((n, v) => n + v.bytes + DIAGNOSTIC_PERMIT_BYTES, 0) <=
            DELIVERY_LIMITS.queueBytes &&
          Buffer.byteLength(JSON.stringify({ ...this.state, queue: prefix })) <=
            DELIVERY_LIMITS.manifestBytes;
        if (count === 1 || fitsEmptyQueue) {
          this.error = capacity
            ? 'manifest_budget_local_journal_retained'
            : 'queue_budget_local_journal_retained';
          return false;
        }
        count = Math.floor(count / 2);
      }
      if (!this.consentActive() || epoch !== this.epoch) return false;
      const created: string[] = [];
      let committed = false;
      try {
        for (const { batch, compressed } of packets) {
          const path = join(this.queueDirectory, `${batch.id}.gz`);
          await safePath(this.queueDirectory, `${batch.id}.gz`).catch((error) => {
            if (!missing(error)) throw error;
          });
          let file: Awaited<ReturnType<typeof open>> | undefined;
          try {
            file = await open(
              path,
              constants.O_CREAT |
                constants.O_EXCL |
                constants.O_WRONLY |
                (constants.O_NOFOLLOW ?? 0),
              0o600,
            );
            created.push(path);
            await file.writeFile(compressed);
            await file.sync();
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            if (
              checksum(
                await secureRead(
                  this.queueDirectory,
                  `${batch.id}.gz`,
                  DELIVERY_LIMITS.compressedBytes,
                ),
              ) !== batch.id
            )
              throw new Error('existing_batch_integrity', { cause: error });
          } finally {
            await file?.close();
          }
        }
        if (!this.consentActive() || epoch !== this.epoch) return false;
        const selected = this.pending.slice(0, count);
        const previous = {
          sessions: structuredClone(this.state.sessions),
          queue: this.state.queue,
          omitted: this.state.omitted,
          omissionReasons: { ...this.state.omissionReasons },
        };
        this.state.queue = [...this.state.queue, ...packets.map(({ batch }) => batch)];
        for (const item of selected) {
          const cursor = this.state.sessions[item.cursorId];
          if (cursor) {
            if (item.sequence > cursor.queued + 1)
              this.omitted('source_sequence_gap', item.sequence - cursor.queued - 1);
            cursor.queued = Math.max(cursor.queued, item.sequence);
          }
        }
        if (skipped) this.omitted('batch_size_budget', skipped);
        try {
          await this.save();
        } catch (error) {
          Object.assign(this.state, previous);
          if (error instanceof Error && error.message === 'manifest_budget') {
            this.error = 'manifest_budget_local_journal_retained';
            return false;
          }
          throw error;
        }
        committed = true;
        this.pending.splice(0, count);
        remaining -= count;
        this.pendingBytes -= selected.reduce((n, item) => n + Buffer.byteLength(item.line), 0);
      } finally {
        // Only files created by this uncommitted attempt are disposable. Existing
        // immutable batches and their identities are never rewritten or removed.
        if (!committed) for (const path of created) await unlink(path);
      }
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
  tick(forceCollection = true): Promise<void> {
    // Coalesce the whole round: slow source recovery must not let every timer
    // enqueue another scan ahead of the active upload's state transactions.
    return (this.pumping ??= (async () => {
      await this.transaction(async () => {
        await this.renewExpiredInstallation();
        if (this.waitForTransportRecovery()) return;
        const collecting = forceCollection || this.now() >= this.nextCollectionAt;
        if (collecting) {
          await this.recover();
          this.nextCollectionAt = this.now() + DELIVERY_LIMITS.collectMs;
        }
        if (!collecting && this.recoveryNeeded) await this.recover(false);
        // Recovery alone persists the admitted prefix; a second pass would
        // turn records arriving during gzip/fsync into a tiny extra batch.
      });
      if (!this.endpoint || this.closed) return;
      for (let count = 0; count < DELIVERY_LIMITS.sendPerTick; count++) {
        const acknowledged = this.state.acknowledged;
        await this.send();
        if (this.state.acknowledged === acknowledged) break;
      }
    })().finally(() => {
      this.pumping = undefined;
    }));
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
      const selectedBatch = this.nextUpload();
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
      if (
        [400, 413, 422].includes(response.status) ||
        (response.status === 409 && ack.error === 'batch_metadata_conflict')
      ) {
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
        const keepLocalCopy = !(await this.canonicalSourceExists(batch.index.sessionId));
        const previous = structuredClone(this.state);
        if (keepLocalCopy) {
          const retained = this.state.queue.find((value) => value.id === batch.id)!;
          retained.acknowledgedAt = new Date(this.now()).toISOString();
          retained.serverExpired = true;
          retained.unavailableReason = 'acknowledged_local_history';
        } else {
          this.state.queue = this.state.queue.filter((value) => value.id !== batch.id);
        }
        this.state.acknowledged++;
        this.state.lastConfirmedAt = new Date(this.now()).toISOString();
        this.state.consecutiveFailures = 0;
        this.state.nextAttemptAt = 0;
        this.error = null;
        this.state.transportFailure = null;
        try {
          await this.save();
        } catch (error) {
          this.state = previous;
          throw error;
        }
        if (!keepLocalCopy) {
          await unlink(join(this.queueDirectory, `${batch.id}.gz`)).catch((error) => {
            if (!missing(error)) throw error;
          });
        }
        this.recoveryNeeded = true;
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
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.abort?.abort();
    await this.pumping;
    await this.transaction(() => this.persist());
  }
}
