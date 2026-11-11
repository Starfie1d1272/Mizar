import { performance } from 'node:perf_hooks';
import {
  parseCaptureReference,
  type CaptureReference,
  type CaptureTicket,
} from './capture-interval.js';
export { parseCaptureReference, type CaptureReference } from './capture-interval.js';
import { createHash, randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import {
  BoundaryCaptureError,
  parseBoundaryCapture,
  type BoundaryCaptureOperation,
} from './boundary-capture.js';
import { parseReliableEventV1, type ReliableEventV1 } from '@mizar/protocol/output';
import type { ExactSource } from '../match-context/rivalhub-source-state.js';
import { durableJsonByteLength } from '../match-context/durable-json.js';
import { SerialCommitQueue } from '../match-context/serial-commit.js';
import { OutboxRepository, type OutboxHistory } from './outbox-repository.js';
export * from './outbox-codec.js';
export * from './reliable-delivery.js';
import {
  RELIABLE_SEND_TIMEOUT_MS,
  type ReliableDeliveryResult,
  type ReliableEventSink,
} from './reliable-delivery.js';
import {
  RELIABLE_OUTBOX_VERSION,
  RELIABLE_OUTBOX_MAX_PENDING,
  RELIABLE_OUTBOX_MAX_RECORDS,
  RELIABLE_OUTBOX_RETENTION_MS,
  type ReliableDeliveryStatus,
  isContinuityBoundary,
  dependsOnBoundary,
  type ReliableOutboxRecord,
  type ReliableDeliveryScope,
  type ReliableScopeDisposition,
  type DeliveryContinuity,
  type BoundaryScope,
  type BoundaryIntent,
  type OutboxFile,
  parseSource,
  sourceKey,
  scopeDigest,
  sourceMatchesEvent,
  parseRecord,
  type OutboxRecovery,
  sealOutbox,
  recoveryReport,
} from './outbox-codec.js';

export class ReliableOutbox {
  private readonly captures = new Map<
    string,
    {
      reference: CaptureReference;
      source: ExactSource;
      nextSequence: number;
      sealing: boolean;
      endCursor?: ReliableEventV1['cursor'];
      activationCursor?: ReliableEventV1['cursor'];
    }
  >();
  private readonly sealRequests = new Set<string>();
  private readonly unknownCaptures = new Map<string, 'legacy' | 'unclean' | 'mismatch'>();
  private readonly captureTickets = new Map<string, CaptureTicket>();
  private readonly captureOrder = new Map<string, number>();
  private nextCaptureOrder = 0;
  private activeOrdinaryCapture: CaptureTicket | undefined;
  private orderedReplay: Promise<void> | undefined;

  createCaptureReference(cursor: ReliableEventV1['cursor']): CaptureReference {
    return parseCaptureReference({
      id: randomUUID(),
      storeId: this.repository().captureStoreId(),
      startCursor: cursor,
    });
  }

  armCapture(source: ExactSource, reference: CaptureReference): Promise<void> {
    source = parseSource(source);
    reference = parseCaptureReference(reference);
    return this.queue.run(async () => {
      const key = sourceKey(source);
      const current = this.captures.get(key);
      if (
        current &&
        !current.sealing &&
        !this.sealRequests.has(key) &&
        !this.unknownCaptures.has(key) &&
        !this.repository().captureUnknownReason(source) &&
        JSON.stringify(current.reference) === JSON.stringify(reference)
      )
        return;
      if (
        this.sealRequests.has(key) ||
        this.unknownCaptures.has(key) ||
        this.repository().captureUnknownReason(source) ||
        current ||
        reference.storeId !== this.repository().captureStoreId() ||
        this.repository().captureIntervalForSource(source)
      )
        throw new Error('capture_interval_not_reopenable');
      this.repository().createCaptureInterval({
        reference,
        source,
        state: 'armed',
        committedSequence: 0,
      });
      this.captures.set(key, { reference, source, nextSequence: 0, sealing: false });
    });
  }

  /** Publish activation only after arm committed, at the caller's synchronous source-publication cut. */
  activateCapture(source: ExactSource, actualCursor: ReliableEventV1['cursor']): void {
    source = parseSource(source);
    const key = sourceKey(source);
    const current = this.captures.get(key);
    if (
      !current ||
      current.sealing ||
      this.sealRequests.has(key) ||
      this.unknownCaptures.has(key) ||
      this.repository().captureUnknownReason(source)
    )
      throw new Error('capture_interval_not_activatable');
    const cursor = parseCaptureReference({
      ...current.reference,
      startCursor: actualCursor,
    }).startCursor;
    if (
      cursor.producerInstanceId !== source.producerInstanceId ||
      cursor.liveSessionId !== source.liveSessionId
    )
      throw new Error('capture_activation_source_mismatch');
    // An idempotent claim must not slide an already active interval's start.
    current.activationCursor ??= cursor;
  }

  restoreCaptureReference(
    source: ExactSource,
    reference: CaptureReference | undefined,
  ): Promise<void> {
    source = parseSource(source);
    if (reference) reference = parseCaptureReference(reference);
    return this.queue.run(async () => {
      const key = sourceKey(source);
      const interval = this.repository().captureIntervalForSource(source);
      if (
        !reference ||
        reference.storeId !== this.repository().captureStoreId() ||
        (interval && JSON.stringify(interval.reference) !== JSON.stringify(reference))
      ) {
        this.unknownCaptures.set(key, reference ? 'mismatch' : 'legacy');
        this.repository().recordUnknownCapture(source, reference ? 'mismatch' : 'legacy');
        return;
      }
      if (!interval) {
        if (this.repository().captureInterval(reference.id)) {
          this.unknownCaptures.set(key, 'mismatch');
          this.repository().recordUnknownCapture(source, 'mismatch');
          return;
        }
        // JSON intent is persisted before arm. Absence in this exact store proves no activation.
        this.repository().createCaptureInterval({
          reference,
          source,
          state: 'sealed',
          committedSequence: 0,
          endCursor: reference.startCursor,
        });
      } else if (interval.state !== 'sealed' && !this.captures.has(key)) {
        this.unknownCaptures.set(key, 'unclean');
        this.repository().recordUnknownCapture(source, 'unclean');
      }
    });
  }

  canCapture(source: ExactSource): boolean {
    const current = this.captures.get(sourceKey(source));
    return (
      !!current?.activationCursor &&
      !current.sealing &&
      !this.sealRequests.has(sourceKey(source)) &&
      !this.unknownCaptures.has(sourceKey(source))
    );
  }

  captureCoverage(source: ExactSource): {
    state: 'armed' | 'sealed' | 'unknown';
    reason?: 'legacy' | 'unclean' | 'mismatch';
    intervalId?: string;
    committedSequence?: number;
    activationCursor?: ReliableEventV1['cursor'];
  } {
    const key = sourceKey(source);
    const interval = this.repository().captureIntervalForSource(source);
    const reason =
      this.unknownCaptures.get(key) ??
      this.repository().captureUnknownReason(source) ??
      (!interval
        ? 'legacy'
        : interval.state !== 'sealed' && !this.captures.has(key)
          ? 'unclean'
          : undefined);
    return {
      state: reason ? 'unknown' : interval!.state,
      ...(reason ? { reason } : {}),
      ...(interval?.activationCursor
        ? { activationCursor: interval.activationCursor }
        : this.captures.get(key)?.activationCursor
          ? { activationCursor: this.captures.get(key)!.activationCursor! }
          : {}),
      ...(interval
        ? { intervalId: interval.reference.id, committedSequence: interval.committedSequence }
        : {}),
    };
  }

  sealCapture(
    source: ExactSource,
    endCursor: ReliableEventV1['cursor'],
    complete = true,
  ): Promise<boolean> {
    source = parseSource(source);
    const key = sourceKey(source);
    this.sealRequests.add(key);
    if (!complete) this.unknownCaptures.set(key, 'unclean');
    const current = this.captures.get(key);
    if (current) {
      current.endCursor ??= structuredClone(endCursor);
      current.sealing = true; // Fence before the first await, including all boundary kinds.
    }
    const end = current?.endCursor ?? structuredClone(endCursor);
    return (async () => {
      if (!complete) {
        await this.queue.run(async () => this.repository().recordUnknownCapture(source, 'unclean'));
        return false;
      }
      await this.queue.flush();
      if (this.captureCoverage(source).state === 'sealed') return true;
      if (!current || this.captureCoverage(source).state === 'unknown') return false;
      try {
        await this.retryPendingCaptures(true);
        return await this.queue.run(async () => {
          const scope = {
            source,
            matchId: source.matchId,
            producerInstanceId: source.producerInstanceId,
            liveSessionId: source.liveSessionId,
          };
          if (
            this.boundaryCaptureLost ||
            this.hasUnconfirmedWrites() ||
            this.hasStoredBoundaryGap(scope) ||
            this.getBoundaryIntents(scope).length
          )
            return false;
          this.repository().sealCaptureInterval(
            current.reference.id,
            current.nextSequence,
            end,
            current.activationCursor,
          );
          return true;
        });
      } catch (error) {
        this.reportCaptureFailure(error);
        return false;
      }
    })();
  }

  private reportCaptureFailure(error: unknown): void {
    try {
      this.onRecovery?.(this.recovery, error);
    } catch {
      // Optional diagnostics must not reject a detached write or change seal results.
    }
  }

  private markCaptureUnknown(source: ExactSource): void {
    const key = sourceKey(source);
    this.unknownCaptures.set(key, 'unclean');
    this.sealRequests.add(key);
    const current = this.captures.get(key);
    if (current) current.sealing = true;
    // Even if this write fails or the process dies first, the already armed
    // interval remains durable evidence that an empty queue cannot prove clean.
    void this.queue
      .run(async () => this.repository().recordUnknownCapture(source, 'unclean'))
      .catch((error: unknown) => this.reportCaptureFailure(error));
  }

  private reserveCapture(key: string, source?: ExactSource | null): CaptureTicket | undefined {
    const existing = this.captureTickets.get(key);
    if (existing) return existing;
    if (source && !this.canCapture(source)) throw new Error('capture_interval_not_armed');
    if (!this.captureOrder.has(key)) this.captureOrder.set(key, ++this.nextCaptureOrder);
    if (!source) return undefined;
    const current = this.captures.get(sourceKey(source))!;
    const ticket = {
      activationCursor: current.activationCursor!,
      requestId: key,
      intervalId: current.reference.id,
      sequence: ++current.nextSequence,
    };
    this.captureTickets.set(key, ticket);
    return ticket;
  }

  private records: readonly ReliableOutboxRecord[] = [];
  private database: OutboxRepository | undefined;
  private repository(): OutboxRepository {
    if (!this.database) throw new Error('outbox_not_loaded');
    return this.database;
  }
  private currentEvents(): ReliableEventV1[] {
    return [
      ...this.records.map((item) => item.event),
      ...this.boundaryIntents.map((item) => item.event),
      ...(this.continuityReference ? [this.continuityReference] : []),
    ];
  }
  private history(events = this.currentEvents()) {
    const scopes = new Map(
      events.map((event) => [
        JSON.stringify([
          event.matchId,
          event.cursor.producerInstanceId,
          event.cursor.liveSessionId,
        ]),
        event,
      ]),
    );
    return [...scopes.values()].flatMap((event) =>
      this.repository().forDelivery({
        matchId: event.matchId,
        producerInstanceId: event.cursor.producerInstanceId,
        ...(event.cursor.liveSessionId ? { liveSessionId: event.cursor.liveSessionId } : {}),
      }),
    );
  }
  private get legacyRecords(): readonly ReliableOutboxRecord[] {
    return this.history()
      .filter((item) => item.disposition === 'legacy' && item.kind === 'record')
      .map((item) => item.value as ReliableOutboxRecord);
  }
  private sourceHistory() {
    const scopes = new Set(
      this.currentEvents().map((event) =>
        scopeDigest(
          event.competitionId,
          event.matchId,
          event.cursor.producerInstanceId,
          event.cursor.liveSessionId,
        ),
      ),
    );
    return [...scopes]
      .flatMap((scope) => this.repository().sourcesByScope(scope))
      .filter((item) => item.disposition === 'revoked')
      .map((item) => {
        const history = this.repository()
          .bySource(item.source)
          .filter((row) => row.disposition === 'revoked');
        return {
          identity: item.source,
          disposition: 'revoked_unconfirmed' as const,
          records: history
            .filter((row) => row.kind === 'record')
            .map((row) => row.value as ReliableOutboxRecord),
          intents: history
            .filter((row) => row.kind === 'intent')
            .map((row) => row.value as BoundaryIntent),
        };
      });
  }
  private get revokedSources() {
    return this.sourceHistory();
  }
  private boundaryIntents: readonly BoundaryIntent[] = [];
  private boundaryGap: true | undefined;
  private boundaryGaps: readonly BoundaryScope[] = [];
  private boundaryOverflowOwners: readonly string[] = [];
  private boundaryCaptureLost = false;
  private readonly pendingBoundaryCaptures = new Map<string, BoundaryCaptureOperation>();
  private readonly durableBoundaryCaptures = new Set<string>();
  private activeBoundaryCapture: BoundaryCaptureOperation | undefined;
  private get boundaryCaptureFailed(): boolean {
    return (
      this.boundaryCaptureLost ||
      [...this.pendingBoundaryCaptures.keys()].some((id) =>
        this.unconfirmedWrites.has(`boundary:${id}`),
      )
    );
  }

  getBoundaryCaptureRecovery(): { pending: number; durable: number; lost: boolean } {
    return {
      pending: this.pendingBoundaryCaptures.size,
      durable: this.durableBoundaryCaptures.size,
      lost: this.boundaryCaptureLost,
    };
  }
  private readonly queue = new SerialCommitQueue();
  private readonly unconfirmedWrites = new Set<string>();
  private durabilityContext: string | undefined;
  private readonly continuityFailures = new Map<string, number>();
  private readonly pendingContinuities = new Map<
    string,
    { bytes: number; retry: () => Promise<void> }
  >();
  private activeContinuity: string | undefined;
  private successfulDurableWrites = 0;
  private pendingFlush: Promise<readonly string[]> | undefined;
  private closing = false;
  private closeTask: Promise<void> | undefined;
  private readonly revoking = new Map<string, { source: ExactSource; count: number }>();
  private readonly pendingEnqueues = new Map<
    string,
    {
      event: ReliableEventV1;
      source?: ExactSource | null;
      bytes: number;
      retry: () => Promise<boolean>;
    }
  >();

  private noteUnconfirmedWrite(key: string): void {
    if (
      this.unconfirmedWrites.has(key) ||
      this.unconfirmedWrites.size < RELIABLE_OUTBOX_MAX_RECORDS
    )
      this.unconfirmedWrites.add(key);
    else this.unconfirmedWrites.add('unconfirmed-write-overflow');
  }

  private async trackDurability<T>(key: string, write: () => Promise<T>): Promise<T> {
    const context = this.durabilityContext;
    const failureKey = context ?? key;
    try {
      const result = await write();
      this.successfulDurableWrites++;
      if (!context) this.unconfirmedWrites.delete(failureKey);
      return result;
    } catch (error) {
      this.noteUnconfirmedWrite(failureKey);
      throw error;
    }
  }

  private async durableOperation<T>(
    key: string,
    operation: () => Promise<T>,
    continuitySequence?: number,
  ): Promise<T> {
    const previous = this.durabilityContext;
    this.durabilityContext = key;
    const before = this.successfulDurableWrites;
    try {
      const result = await operation();
      const failedSequence = this.continuityFailures.get(key);
      // A duplicate/no-op or older checkpoint cannot prove the failed write won.
      if (
        result !== false &&
        this.successfulDurableWrites > before &&
        (failedSequence === undefined ||
          (continuitySequence !== undefined && continuitySequence >= failedSequence))
      ) {
        this.unconfirmedWrites.delete(key);
        this.continuityFailures.delete(key);
      }
      return result;
    } catch (error) {
      if (continuitySequence !== undefined && this.unconfirmedWrites.has(key))
        this.continuityFailures.set(
          key,
          Math.max(continuitySequence, this.continuityFailures.get(key) ?? 0),
        );
      throw error;
    } finally {
      this.durabilityContext = previous;
    }
  }

  private runDurable<T>(
    key: string,
    operation: () => Promise<T>,
    continuitySequence?: number,
  ): Promise<T> {
    return this.queue.run(() => this.durableOperation(key, operation, continuitySequence));
  }

  private continuity: DeliveryContinuity | undefined;
  private continuityReference: ReliableEventV1 | undefined;
  private requestedScope: string | undefined;

  private recovery: OutboxRecovery | undefined;
  private unconfirmedRecovery: true | undefined;

  private preparationTiming = { count: 0, totalMs: 0, maxMs: 0 };

  takePersistenceTiming() {
    const preparation = this.preparationTiming;
    this.preparationTiming = { count: 0, totalMs: 0, maxMs: 0 };
    return { preparation, sqlite: this.database?.takeTransactionTiming() ?? null };
  }

  constructor(
    private readonly filePath: string,
    private readonly onRecovery?: (report: OutboxRecovery | undefined, error: unknown) => void,
    private readonly onEvidence?: (record: ReliableOutboxRecord, reason: string) => void,
  ) {}

  getRecovery(): OutboxRecovery | undefined {
    return this.recovery;
  }

  /** One-time JSON import lives in the repository; normal operation never writes legacy files. */
  async load(): Promise<void> {
    if (this.database) return;
    const database = await OutboxRepository.open(`${this.filePath}.sqlite`, this.filePath);
    let file: OutboxFile;
    try {
      file = database.active();
      this.boundaryCaptureLost = database.boundaryCaptureInputLost();
      for (const operation of database.pendingBoundaryCaptures()) {
        this.pendingBoundaryCaptures.set(operation.id, operation);
        this.captureOrder.set(`boundary:${operation.id}`, ++this.nextCaptureOrder);
        this.durableBoundaryCaptures.add(operation.id);
        this.noteUnconfirmedWrite(`boundary:${operation.id}`);
      }
    } catch (error) {
      database.close();
      throw error;
    }
    this.database = database;
    this.records = file.records;
    this.boundaryIntents = file.boundaryIntents ?? [];
    this.boundaryGap = file.boundaryGap;
    this.boundaryGaps = file.boundaryGaps ?? [];
    this.boundaryOverflowOwners = file.boundaryOverflowOwners ?? [];
    this.continuity = file.continuity;
    this.continuityReference = file.continuityReference;
    this.unconfirmedRecovery = file.unconfirmedRecovery;
    if (file.unconfirmedRecovery) {
      this.recovery = recoveryReport(file);
      this.onRecovery?.(this.recovery, new Error('outbox_previous_recovery_unconfirmed'));
    }
  }
  private async archiveLegacyTerminals(): Promise<void> {
    const legacy = this.records.filter(
      (record) =>
        !record.source &&
        !record.awaitingSource &&
        record.status !== 'pending' &&
        this.repository()
          .byKey(record.event.idempotencyKey)
          .filter((item) => item.disposition === 'legacy' && item.kind === 'record')
          .every((item) => JSON.stringify(item.value) === JSON.stringify(record)) &&
        !this.repository().isDamaged(
          scopeDigest(
            record.event.competitionId,
            record.event.matchId,
            record.event.cursor.producerInstanceId,
            record.event.cursor.liveSessionId,
          ),
        ),
    );
    if (!legacy.length) return;
    await this.commit(
      this.records.filter((record) => !legacy.includes(record)),
      this.continuity,
      this.boundaryIntents,
      this.boundaryGap,
      this.boundaryGaps,
      this.boundaryOverflowOwners,
      [{ disposition: 'legacy', items: legacy.map((value) => ({ kind: 'record', value })) }],
    );
  }

  getRecords(): readonly ReliableOutboxRecord[] {
    const keys = new Set(this.records.map((record) => record.event.idempotencyKey));
    return [
      ...this.revokedSources
        .flatMap((archive) => archive.records)
        .filter(
          (record) =>
            record.status === 'rejected' &&
            record.event.kind === 'map_started' &&
            !keys.has(record.event.idempotencyKey),
        ),
      ...this.legacyRecords.filter(
        (record) =>
          record.status === 'rejected' &&
          record.event.kind === 'map_started' &&
          !keys.has(record.event.idempotencyKey),
      ),
      ...this.records,
    ];
  }

  getScopeDisposition(
    scope: ReliableDeliveryScope,
    source?: ExactSource,
  ): ReliableScopeDisposition {
    const belongs = (item: { source?: ExactSource }) =>
      !source || !item.source || sourceKey(source) === sourceKey(item.source);
    const history = this.repository()
      .forDelivery(scope)
      .filter((item) => belongs(item.value as ReliableOutboxRecord | BoundaryIntent));
    const records = history.filter((item) => item.kind === 'record');
    const result = {
      pending: 0,
      accepted: 0,
      needsAttention: 0,
      rejected: 0,
      superseded: 0,
      expired: 0,
      isolated: 0,
      isolatedIntents: 0,
      records: [] as {
        kind: ReliableEventV1['kind'];
        idempotencyKey: string;
        status: ReliableDeliveryStatus;
        needsAttention: boolean;
        isolation?: 'revoked_unconfirmed';
      }[],
    };
    const seen = new Set<string>();
    for (const record of [
      ...this.records,
      ...records
        .filter((item) => item.disposition !== 'revoked')
        .map((item) => item.value as ReliableOutboxRecord),
    ]) {
      const c = record.event.cursor;
      if (
        !belongs(record) ||
        record.event.matchId !== scope.matchId ||
        c.producerInstanceId !== scope.producerInstanceId ||
        c.liveSessionId !== scope.liveSessionId
      )
        continue;
      if (seen.has(record.event.idempotencyKey)) continue;
      seen.add(record.event.idempotencyKey);
      result[record.status]++;
      if (record.receiverOutcome === 'needs_attention') result.needsAttention++;
      result.records.push({
        kind: record.event.kind,
        idempotencyKey: record.event.idempotencyKey,
        status: record.status,
        needsAttention: record.receiverOutcome === 'needs_attention',
      });
    }
    for (const archive of [
      {
        records: records
          .filter((item) => item.disposition === 'revoked')
          .map((item) => item.value as ReliableOutboxRecord),
      },
    ]) {
      result.isolatedIntents += history.filter(
        (item) => item.disposition === 'revoked' && item.kind === 'intent',
      ).length;
      for (const record of archive.records) {
        if (seen.has(record.event.idempotencyKey)) {
          // A file-first commit can leave the active copy present after a crash.
          const item = result.records.find(
            (entry) => entry.idempotencyKey === record.event.idempotencyKey,
          );
          if (item) item.isolation = 'revoked_unconfirmed';
        } else {
          seen.add(record.event.idempotencyKey);
          result[record.status]++;
          if (record.receiverOutcome === 'needs_attention') result.needsAttention++;
          result.records.push({
            kind: record.event.kind,
            idempotencyKey: record.event.idempotencyKey,
            status: record.status,
            needsAttention: record.receiverOutcome === 'needs_attention',
            isolation: 'revoked_unconfirmed',
          });
        }
        result.isolated++;
      }
    }
    return result;
  }

  getRevokedIsolationSummary() {
    return this.repository().revokedSummary();
  }

  getActiveSources(): readonly ExactSource[] {
    const sources = new Map<string, ExactSource>(
      (this.database?.unresolvedCaptureSources() ?? []).map((source) => [
        sourceKey(source),
        source,
      ]),
    );
    for (const item of [...this.records, ...this.boundaryIntents]) {
      if (item.source) sources.set(sourceKey(item.source), item.source);
    }
    return [...sources.values()];
  }

  /** Exact closure moves records and its fence in the same transaction. */
  async archiveConfirmedSource(input: ExactSource): Promise<void> {
    if (this.captureCoverage(input).state !== 'sealed') throw new Error('capture_coverage_unknown');
    await this.retryPendingEnqueues();
    if (this.hasPendingEnqueues(input)) throw new Error('outbox_source_unsettled');
    return this.runDurable(`archive:${sourceKey(parseSource(input))}`, async () => {
      const identity = parseSource(input);
      const key = sourceKey(identity);
      if (
        this.repository().isDamaged(
          scopeDigest(
            identity.competitionId,
            identity.matchId,
            identity.producerInstanceId,
            identity.liveSessionId,
          ),
        )
      )
        throw new Error('outbox_archive_unreadable');
      if (
        this.records.some(
          (record) =>
            record.status === 'pending' &&
            sourceMatchesEvent(identity, record.event) &&
            (!record.source || sourceKey(record.source) === key),
        ) ||
        this.boundaryIntents.some(
          (intent) =>
            sourceMatchesEvent(identity, intent.event) &&
            (!intent.source || sourceKey(intent.source) === key),
        )
      )
        throw new Error('outbox_source_unsettled');
      const selected = this.records.filter(
        (record) => record.source && sourceKey(record.source) === key,
      );
      await this.commit(
        this.records.filter((record) => !record.source || sourceKey(record.source) !== key),
        this.continuity,
        this.boundaryIntents,
        this.boundaryGap,
        this.boundaryGaps,
        this.boundaryOverflowOwners,
        [
          {
            disposition: 'archived',
            source: identity,
            items: selected.map((value) => ({ kind: 'record', value })),
          },
        ],
      );
    });
  }
  /** Revocation preserves all evidence without claiming receiver acceptance. */
  async isolateRevokedSource(input: ExactSource): Promise<void> {
    const source = parseSource(input);
    const key = sourceKey(source);
    const pending = this.revoking.get(key);
    this.revoking.set(key, { source, count: (pending?.count ?? 0) + 1 });
    try {
      await this.isolateRevokedSourceOnce(source);
    } finally {
      const current = this.revoking.get(key)!;
      if (current.count === 1) this.revoking.delete(key);
      else this.revoking.set(key, { source, count: current.count - 1 });
    }
  }
  private async isolateRevokedSourceOnce(input: ExactSource): Promise<void> {
    await this.retryPendingEnqueues();
    if (this.hasPendingEnqueues(input)) throw new Error('outbox_source_unsettled');
    return this.runDurable(`revoke:${sourceKey(parseSource(input))}`, async () => {
      const identity = parseSource(input);
      const key = sourceKey(identity);
      if (
        this.repository().isDamaged(
          scopeDigest(
            identity.competitionId,
            identity.matchId,
            identity.producerInstanceId,
            identity.liveSessionId,
          ),
        )
      )
        throw new Error('outbox_archive_unreadable');
      const selected = this.records.filter(
        (record) => record.source && sourceKey(record.source) === key,
      );
      const intents = this.boundaryIntents.filter(
        (intent) => intent.source && sourceKey(intent.source) === key,
      );
      await this.commit(
        this.records.filter((record) => !record.source || sourceKey(record.source) !== key),
        this.continuity,
        this.boundaryIntents.filter((intent) => !intent.source || sourceKey(intent.source) !== key),
        this.boundaryGap,
        this.boundaryGaps,
        this.boundaryOverflowOwners,
        [
          {
            disposition: 'revoked',
            source: identity,
            items: [
              ...selected.map((value) => ({ kind: 'record' as const, value })),
              ...intents.map((value) => ({ kind: 'intent' as const, value })),
            ],
          },
        ],
      );
    });
  }
  private sourceHas(
    disposition: 'revoked' | 'archived',
    event: ReliableEventV1,
    source?: ExactSource,
  ): boolean {
    return source
      ? this.repository().sourceDisposition(source).includes(disposition)
      : this.repository()
          .sourcesByScope(
            scopeDigest(
              event.competitionId,
              event.matchId,
              event.cursor.producerInstanceId,
              event.cursor.liveSessionId,
            ),
          )
          .some((item) => item.disposition === disposition);
  }
  private isRevokingEvent(event: ReliableEventV1, source?: ExactSource): boolean {
    return [...this.revoking.values()].some(({ source: pending }) =>
      source ? sourceKey(source) === sourceKey(pending) : sourceMatchesEvent(pending, event),
    );
  }
  private isRevokedEvent(event: ReliableEventV1, source?: ExactSource): boolean {
    return this.sourceHas('revoked', event, source);
  }
  private assertSourceOpen(event: ReliableEventV1, source?: ExactSource, replaying = false): void {
    if (
      this.repository().isDamaged(
        scopeDigest(
          event.competitionId,
          event.matchId,
          event.cursor.producerInstanceId,
          event.cursor.liveSessionId,
        ),
      )
    )
      throw new Error('outbox_archive_unreadable');
    if (source && !sourceMatchesEvent(source, event)) throw new Error('outbox_source_mismatch');
    if (this.isRevokedEvent(event, source) || (!replaying && this.isRevokingEvent(event, source)))
      throw new Error('outbox_source_revoked');
    if (this.sourceHas('archived', event, source)) throw new Error('outbox_source_closed');
  }

  /** Pin unsent work to the current authority before any request can be issued. */
  bindUnsentSource(input: ExactSource): Promise<void> {
    return this.runDurable(`bind:${sourceKey(parseSource(input))}`, async () => {
      const source = parseSource(input);
      const records = this.records.map((record) => {
        if (
          record.status !== 'pending' ||
          record.attempts !== 0 ||
          !record.awaitingSource ||
          !sourceMatchesEvent(source, record.event)
        )
          return record;
        this.assertSourceOpen(record.event, source);
        const { awaitingSource, ...rest } = record;
        void awaitingSource;
        return { ...rest, source };
      });
      if (records.some((record, index) => record !== this.records[index]))
        await this.commit(records);
    });
  }

  hasUnconfirmedBoundary(event: ReliableEventV1): boolean {
    if (
      [...this.pendingEnqueues.values()].some(
        (item) => isContinuityBoundary(item.event) && dependsOnBoundary(event, item.event),
      )
    )
      return true;
    return [
      ...this.records,
      ...this.history([event])
        .filter((item) => item.kind === 'record' && item.disposition !== 'archived')
        .map((item) => item.value as ReliableOutboxRecord),
    ].some(
      (record) =>
        (record.status !== 'accepted' || record.receiverOutcome === 'needs_attention') &&
        isContinuityBoundary(record.event) &&
        dependsOnBoundary(event, record.event),
    );
  }

  /** Refusals remain authoritative for the original execution, even if context changes. */
  startRejections(event: ReliableEventV1): readonly ReliableOutboxRecord[] {
    const c = event.cursor;
    const seen = new Set<string>();
    return [
      ...this.records,
      ...this.history([event])
        .filter((item) => item.kind === 'record' && item.disposition !== 'archived')
        .map((item) => item.value as ReliableOutboxRecord),
    ].filter((record) => {
      if (seen.has(record.event.idempotencyKey)) return false;
      seen.add(record.event.idempotencyKey);
      const previous = record.event;
      const p = previous.cursor;
      return (
        record.status === 'rejected' &&
        previous.kind === 'map_started' &&
        previous.matchId === event.matchId &&
        previous.mapName === event.mapName &&
        p.producerInstanceId === c.producerInstanceId &&
        p.liveSessionId !== null &&
        p.liveSessionId === c.liveSessionId &&
        p.programSourceGeneration === c.programSourceGeneration &&
        p.mapEpoch === c.mapEpoch
      );
    });
  }

  async setStartRecovery(
    key: string,
    from: ReliableOutboxRecord['recoveryState'],
    to: NonNullable<ReliableOutboxRecord['recoveryState']>,
    boundaryKey?: string,
  ): Promise<boolean> {
    return this.queue.run(async () => {
      const record =
        this.records.find((item) => item.event.idempotencyKey === key) ??
        this.repository()
          .byKey(key)
          .filter((item) => item.kind === 'record' && item.disposition !== 'archived')
          .map((item) => item.value as ReliableOutboxRecord)[0];
      if (
        !record ||
        this.isRevokedEvent(record.event, record.source) ||
        record.status !== 'rejected' ||
        record.event.kind !== 'map_started' ||
        !['context_stale', 'generation_fence', 'epoch_fence'].includes(
          record.rejection?.reason ?? '',
        ) ||
        record.recoveryState !== from
      )
        return false;
      const updated = {
        ...record,
        recoveryState: to,
        ...(boundaryKey === undefined ? {} : { recoveryBoundaryKey: boundaryKey }),
        updatedAt: new Date().toISOString(),
      };
      const active = this.records.includes(record);
      if (!active && this.records.length >= RELIABLE_OUTBOX_MAX_RECORDS)
        throw new Error('reliable_outbox_full');
      await this.commit(
        active
          ? this.records.map((item) => (item === record ? updated : item))
          : [...this.records, updated],
      );
      return true;
    });
  }

  getBoundaryIntents(scope?: BoundaryScope): readonly BoundaryIntent[] {
    if (!scope) return this.boundaryIntents;
    const seen = new Set<string>();
    return [
      ...this.boundaryIntents,
      ...this.repository()
        .forDelivery(scope)
        .filter((item) => item.kind === 'intent' && item.disposition === 'revoked')
        .map((item) => item.value as BoundaryIntent),
    ].filter((intent) => {
      if (
        !this.matchesBoundaryScope(intent.event, intent.authorityFingerprint, scope) ||
        (scope.source && intent.source && sourceKey(scope.source) !== sourceKey(intent.source)) ||
        seen.has(intent.event.idempotencyKey)
      )
        return false;
      seen.add(intent.event.idempotencyKey);
      return true;
    });
  }

  private matchesBoundaryScope(
    event: ReliableEventV1,
    authority: string | undefined,
    scope: BoundaryScope,
  ): boolean {
    return (
      (!scope.matchId || event.matchId === scope.matchId) &&
      event.cursor.producerInstanceId === scope.producerInstanceId &&
      (!scope.liveSessionId || event.cursor.liveSessionId === scope.liveSessionId) &&
      (scope.runtimeSeq === undefined || event.cursor.runtimeSeq <= scope.runtimeSeq) &&
      (scope.programSourceGeneration === undefined ||
        event.cursor.programSourceGeneration <= scope.programSourceGeneration) &&
      (scope.mapEpoch === undefined || event.cursor.mapEpoch <= scope.mapEpoch) &&
      (!authority || !scope.authorityFingerprint || authority === scope.authorityFingerprint)
    );
  }

  private matchesGap(gap: BoundaryScope, scope: BoundaryScope): boolean {
    return (
      (!gap.source || !scope.source || sourceKey(gap.source) === sourceKey(scope.source)) &&
      // A new unknown-owner gap describes only its observed execution.
      // No matchId must not turn it into a wildcard for later formal
      // executions. Old-format uncertainty and known-owner causal
      // chains retain their conservative high-water comparisons below.
      (!(gap.ruleVersion === 2 && gap.reason === 'execution_owner_unknown' && !gap.matchId) ||
        ((gap.programSourceGeneration === undefined ||
          scope.programSourceGeneration === undefined ||
          gap.programSourceGeneration === scope.programSourceGeneration) &&
          (gap.mapEpoch === undefined ||
            scope.mapEpoch === undefined ||
            gap.mapEpoch === scope.mapEpoch))) &&
      (!gap.matchId || !scope.matchId || gap.matchId === scope.matchId) &&
      gap.producerInstanceId === scope.producerInstanceId &&
      (!gap.liveSessionId || !scope.liveSessionId || gap.liveSessionId === scope.liveSessionId) &&
      (!gap.ownerFingerprint ||
        !scope.ownerFingerprint ||
        gap.ownerFingerprint === scope.ownerFingerprint ||
        (gap.matchId !== undefined && gap.matchId === scope.matchId)) &&
      (gap.runtimeSeq === undefined ||
        scope.runtimeSeq === undefined ||
        gap.runtimeSeq <= scope.runtimeSeq) &&
      (gap.programSourceGeneration === undefined ||
        scope.programSourceGeneration === undefined ||
        gap.programSourceGeneration <= scope.programSourceGeneration) &&
      (gap.mapEpoch === undefined ||
        scope.mapEpoch === undefined ||
        gap.mapEpoch <= scope.mapEpoch) &&
      (!gap.authorityFingerprint ||
        !scope.authorityFingerprint ||
        gap.authorityFingerprint === scope.authorityFingerprint)
    );
  }

  hasBoundaryGap(scope?: BoundaryScope): boolean {
    return this.boundaryCaptureFailed || this.hasStoredBoundaryGap(scope);
  }

  private hasStoredBoundaryGap(scope?: BoundaryScope): boolean {
    return (
      this.boundaryGap === true ||
      (scope
        ? scope.ownerFingerprint
          ? this.boundaryOverflowOwners.includes(scope.ownerFingerprint)
          : this.boundaryOverflowOwners.length > 0
        : this.boundaryOverflowOwners.length > 0) ||
      (scope
        ? this.boundaryGaps.some((gap) => this.matchesGap(gap, scope))
        : this.boundaryGaps.length > 0)
    );
  }

  hasBoundaryOverflow(scope: BoundaryScope | undefined): boolean {
    if (!scope)
      return (
        this.boundaryOverflowOwners.length > 0 || this.boundaryGaps.some((gap) => gap.overflow)
      );
    return Boolean(
      (scope.ownerFingerprint && this.boundaryOverflowOwners.includes(scope.ownerFingerprint)) ||
      this.boundaryGaps.some((gap) => gap.overflow && this.matchesGap(gap, scope)),
    );
  }

  /** Capture every boundary from one runtime mutation in the same durable commit as its cursor. */
  captureBoundaries(
    events: readonly ReliableEventV1[],
    intents: readonly BoundaryIntent[],
    continuity: DeliveryContinuity | undefined,
    missing: boolean,
    now = new Date(),
    scope?: BoundaryScope,
    source?: ExactSource | null,
  ): Promise<void> {
    // Freeze before yielding; callers may advance runtime, binding or authority immediately.
    if (source && !this.canCapture(source))
      return Promise.reject(new Error('capture_interval_not_armed'));
    let operation: BoundaryCaptureOperation;
    try {
      operation = parseBoundaryCapture(
        JSON.parse(
          JSON.stringify({
            events,
            intents,
            continuity,
            missing,
            at: now.toISOString(),
            scope,
            source,
            reference: this.continuityReference ?? this.currentEvents().at(-1),
          }),
        ),
      );
      const requestKey = `boundary-request:${operation.id}`;
      const capture = this.reserveCapture(requestKey, source);
      if (capture) operation = parseBoundaryCapture({ ...operation.request, capture });
      this.captureOrder.set(`boundary:${operation.id}`, this.captureOrder.get(requestKey)!);
      if (!this.pendingBoundaryCaptures.has(operation.id)) {
        if (
          this.pendingBoundaryCaptures.size >= RELIABLE_OUTBOX_MAX_PENDING ||
          durableJsonByteLength([...this.pendingBoundaryCaptures.values(), operation]) > 4_000_000
        )
          throw new Error('boundary_capture_capacity_exhausted');
        this.pendingBoundaryCaptures.set(operation.id, operation);
      }
    } catch (error) {
      // The original request cannot be retained: no future successful write can erase this gap.
      this.boundaryCaptureLost = true;
      return Promise.reject(error);
    }
    return this.queue.run(() => this.captureBoundaryOperation(operation));
  }

  private async captureBoundaryOperation(operation: BoundaryCaptureOperation): Promise<void> {
    const { request } = operation;
    const { events, intents, continuity, missing, scope, source } = request;
    const key = `boundary:${operation.id}`;
    let stage: BoundaryCaptureError['stage'] = 'journal';
    try {
      await this.durableOperation(key, async () => {
        // Stage the complete ordered backlog together, including a prior failed journal write.
        if (
          this.boundaryCaptureLost ||
          [...this.pendingBoundaryCaptures.keys()].some(
            (id) => !this.durableBoundaryCaptures.has(id),
          )
        )
          this.repository().stageBoundaryCaptures(
            [...this.pendingBoundaryCaptures.values()],
            this.boundaryCaptureLost,
          );
        for (const id of this.pendingBoundaryCaptures.keys()) this.durableBoundaryCaptures.add(id);
        if (this.boundaryCaptureLost) throw new Error('boundary_capture_input_lost');
        stage = 'verify';
        if (this.repository().boundaryCaptureReceipt(operation)) {
          // A COMMIT response may have been lost. Read authoritative state, never overwrite it.
          const file = this.repository().active();
          this.records = file.records;
          this.boundaryIntents = file.boundaryIntents ?? [];
          this.boundaryGap = file.boundaryGap;
          this.boundaryGaps = file.boundaryGaps ?? [];
          this.boundaryOverflowOwners = file.boundaryOverflowOwners ?? [];
          this.continuity = file.continuity;
          this.continuityReference = file.continuityReference;
          return;
        }
        if (this.pendingBoundaryCaptures.keys().next().value !== operation.id)
          throw new Error('boundary_capture_waiting');
        this.activeBoundaryCapture = operation;
        stage = 'preflight';
        await this.archiveLegacyTerminals();
        for (const event of [...events, ...intents.map((intent) => intent.event)]) {
          if (source !== null) this.assertSourceOpen(event, source);
          if (
            this.repository().byKey(event.idempotencyKey).length ||
            this.records.some((record) => record.event.idempotencyKey === event.idempotencyKey) ||
            this.boundaryIntents.some(
              (intent) => intent.event.idempotencyKey === event.idempotencyKey,
            )
          )
            throw new Error('boundary_duplicate');
        }
        stage = 'commit';
        const at = request.at;
        const added = events.map((event) =>
          parseRecord({
            event,
            ...(source ? { source } : {}),
            ...(source === null ? { awaitingSource: true } : {}),
            status: 'pending',
            attempts: 0,
            nextAttemptAt: at,
            updatedAt: at,
          }),
        );
        if (added.some((record) => !isContinuityBoundary(record.event)))
          throw new Error('boundary_capture_invalid');
        const allIntents = [
          ...this.boundaryIntents,
          ...intents.map((intent) => ({
            event: intent.event,
            planFingerprint: intent.planFingerprint,
            authorityFingerprint: intent.authorityFingerprint,
            ...(intent.expired ? { expired: true as const } : {}),
            ...(source ? { source } : {}),
            ...(source === null ? { awaitingSource: true as const } : {}),
          })),
        ];
        const overflow =
          allIntents.length > RELIABLE_OUTBOX_MAX_PENDING ||
          this.records.filter((r) => r.status === 'pending').length +
            added.length +
            allIntents.length >
            RELIABLE_OUTBOX_MAX_PENDING;
        const boundaries = intents.map((intent) => intent.event);
        const previous = this.records.map((record): ReliableOutboxRecord =>
          record.status === 'pending' &&
          !this.isRevokedEvent(record.event, record.source) &&
          ['map_ended', 'map_player_snapshot', 'series_ended'].includes(record.event.kind) &&
          boundaries.some((boundary) => dependsOnBoundary(record.event, boundary))
            ? {
                ...record,
                status: 'superseded',
                dispositionReason: 'boundary_unconfirmed_result',
                updatedAt: at,
              }
            : record,
        );
        const records = this.trim([...previous, ...(overflow ? [] : added)]);
        const gap = missing || overflow || records.length > RELIABLE_OUTBOX_MAX_RECORDS;
        // Retain the old checkpoint if the boundary cannot be recorded.
        const gaps =
          gap && scope && this.boundaryGaps.length < RELIABLE_OUTBOX_MAX_RECORDS
            ? [
                ...this.boundaryGaps,
                ...(overflow || records.length > RELIABLE_OUTBOX_MAX_RECORDS
                  ? [
                      {
                        ...scope,
                        ruleVersion: 2 as const,
                        reason:
                          scope.reason === 'execution_owner_unknown'
                            ? scope.reason
                            : ('capacity_exhausted' as const),
                        overflow: true as const,
                      },
                    ]
                  : [
                      {
                        ...scope,
                        ruleVersion: 2 as const,
                        reason: scope.reason ?? ('boundary_capture_incomplete' as const),
                      },
                    ]),
              ]
            : this.boundaryGaps;
        let overflowOwners = this.boundaryOverflowOwners;
        if (gap && scope && gaps === this.boundaryGaps) {
          if (
            !scope.ownerFingerprint ||
            (overflowOwners.length >= RELIABLE_OUTBOX_MAX_RECORDS &&
              !overflowOwners.includes(scope.ownerFingerprint))
          )
            throw new Error('boundary_gap_capacity_exhausted');
          if (!overflowOwners.includes(scope.ownerFingerprint))
            overflowOwners = [...overflowOwners, scope.ownerFingerprint];
        }
        if (gap && !scope) throw new Error('boundary_gap_scope_unavailable');
        const frozen = gap || this.hasStoredBoundaryGap(scope);
        await this.commit(
          overflow || records.length > RELIABLE_OUTBOX_MAX_RECORDS ? this.records : records,
          frozen ? this.continuity : (continuity ?? this.continuity),
          overflow ? this.boundaryIntents : allIntents,
          this.boundaryGap,
          gaps,
          overflowOwners,
          [],
          operation,
        );
        stage = 'verify';
        if (!this.repository().boundaryCaptureReceipt(operation))
          throw new Error('boundary_capture_receipt_missing');
      });
      // Only the original operation's atomic receipt clears its write failure.
      this.unconfirmedWrites.delete(key);
      this.pendingBoundaryCaptures.delete(operation.id);
      this.durableBoundaryCaptures.delete(operation.id);
      this.captureOrder.delete(`boundary:${operation.id}`);
      this.captureOrder.delete(`boundary-request:${operation.id}`);
      if (request.capture) {
        this.captureTickets.delete(request.capture.requestId);
        this.captureOrder.delete(request.capture.requestId);
      }
    } catch (error) {
      this.noteUnconfirmedWrite(key);
      throw new BoundaryCaptureError(operation.id, stage, request, error);
    } finally {
      this.activeBoundaryCapture = undefined;
    }
  }

  retryPendingCaptures(drain = false): Promise<void> {
    if (this.orderedReplay) return this.orderedReplay;
    const replay = (async () => {
      await this.queue.flush();
      if (this.boundaryCaptureLost) {
        await this.queue.run(async () => this.repository().stageBoundaryCaptures([], true));
        throw new Error('boundary_capture_input_lost');
      }
      const pending = [
        ...[...this.pendingBoundaryCaptures.values()].map((operation) => ({
          order: this.captureOrder.get(`boundary:${operation.id}`) ?? 0,
          retry: () => this.queue.run(() => this.captureBoundaryOperation(operation)),
        })),
        ...[...this.pendingEnqueues.entries()].map(([key, value]) => ({
          order: this.captureOrder.get(key) ?? 0,
          retry: value.retry,
        })),
        ...[...this.pendingContinuities.entries()].map(([key, value]) => ({
          order: this.captureOrder.get(key) ?? 0,
          retry: value.retry,
        })),
      ]
        .sort((a, b) => a.order - b.order)
        .slice(0, drain ? RELIABLE_OUTBOX_MAX_PENDING * 3 : 4);
      for (const entry of pending) {
        await entry.retry();
        await setImmediate();
      }
    })();
    this.orderedReplay = replay;
    void replay
      .finally(() => {
        if (this.orderedReplay === replay) this.orderedReplay = undefined;
      })
      .catch(() => undefined);
    return replay;
  }

  expireBoundaryIntents(now = new Date()): Promise<void> {
    return this.queue.run(async () => {
      const intents = this.boundaryIntents.map((intent) =>
        !intent.expired &&
        !this.isRevokedEvent(intent.event, intent.source) &&
        now.getTime() - Date.parse(intent.event.observedAt) >= RELIABLE_OUTBOX_RETENTION_MS
          ? { ...intent, expired: true as const }
          : intent,
      );
      if (intents.some((intent, index) => intent !== this.boundaryIntents[index]))
        await this.commit(this.records, this.continuity, intents);
    });
  }

  materializeBoundary(
    intent: BoundaryIntent,
    event: ReliableEventV1,
    now = new Date(),
  ): Promise<boolean> {
    return this.queue.run(async () => {
      await this.archiveLegacyTerminals();
      if (
        this.boundaryCaptureFailed ||
        this.boundaryGap ||
        intent.expired ||
        this.isRevokedEvent(intent.event, intent.source) ||
        !this.boundaryIntents.includes(intent)
      )
        return false;
      if (now.getTime() - Date.parse(intent.event.observedAt) >= RELIABLE_OUTBOX_RETENTION_MS) {
        return false;
      }
      const valid = parseReliableEventV1(event);
      if (!intent.awaitingSource) this.assertSourceOpen(valid, intent.source);
      const original = intent.event;
      if (
        !isContinuityBoundary(valid) ||
        valid.kind !== original.kind ||
        JSON.stringify(valid.cursor) !== JSON.stringify(original.cursor) ||
        JSON.stringify(valid.payload) !== JSON.stringify(original.payload) ||
        JSON.stringify(valid.evidence) !== JSON.stringify(original.evidence) ||
        valid.observedAt !== original.observedAt ||
        valid.mapName !== original.mapName ||
        valid.matchId !== original.matchId ||
        valid.competitionId !== original.competitionId ||
        valid.entryAId !== original.entryAId ||
        valid.entryBId !== original.entryBId ||
        valid.mapId !== original.mapId
      )
        throw new Error('boundary_materialization_invalid');
      if (
        this.records.some((record) => record.event.idempotencyKey === valid.idempotencyKey) ||
        this.repository().byKey(valid.idempotencyKey).length
      )
        throw new Error('boundary_duplicate');
      const at = now.toISOString();
      const next = parseRecord({
        event: valid,
        ...(intent.source ? { source: intent.source } : {}),
        ...(intent.awaitingSource ? { awaitingSource: true } : {}),
        boundaryQualification: {
          planFingerprint: intent.planFingerprint,
          authorityFingerprint: intent.authorityFingerprint,
        },
        status: 'pending',
        attempts: 0,
        nextAttemptAt: at,
        updatedAt: at,
      });
      const ordered = [...this.records];
      const position = ordered.findIndex(
        (item) => item.status === 'pending' && dependsOnBoundary(item.event, valid),
      );
      ordered.splice(position < 0 ? ordered.length : position, 0, next);
      const records = this.trim(ordered);
      if (records.length > RELIABLE_OUTBOX_MAX_RECORDS) throw new Error('reliable_outbox_full');
      await this.commit(
        records,
        this.continuity,
        this.boundaryIntents.filter((item) => item !== intent),
      );
      return true;
    });
  }

  getContinuity(): DeliveryContinuity | undefined {
    return this.continuity;
  }

  updateContinuity(
    checkpoint: DeliveryContinuity,
    scope?: BoundaryScope,
    replaying = false,
  ): Promise<void> {
    // Keep the original scope and checkpoint, including authority, before yielding.
    [checkpoint, scope] = structuredClone([checkpoint, scope]);
    const { cursor } = checkpoint;
    const requested = JSON.stringify([
      checkpoint.matchId,
      checkpoint.contextRevision,
      cursor.producerInstanceId,
      cursor.liveSessionId,
      cursor.programSourceGeneration,
      cursor.mapEpoch,
      scope?.authorityFingerprint,
    ]);
    const operationKey = `continuity:${createHash('sha256')
      .update(
        JSON.stringify([
          requested,
          checkpoint.mapName,
          scope && { ...scope, runtimeSeq: undefined },
        ]),
      )
      .digest('hex')}`;
    const order = replaying ? this.captureOrder.get(operationKey)! : ++this.nextCaptureOrder;
    return this.queue.run(() => {
      // Reject a newer same-key call before durability tracking too: its later
      // sequence was never attempted and cannot advance the original failure.
      if (!replaying && this.pendingContinuities.has(operationKey))
        throw new Error('outbox_continuity_pending');
      return this.durableOperation(
        operationKey,
        async () => {
          if (
            requested === this.requestedScope &&
            !this.unconfirmedWrites.has(operationKey) &&
            !this.pendingContinuities.has(operationKey)
          ) {
            this.captureOrder.delete(operationKey);
            return;
          }
          try {
            if (
              this.records.length === 0 ||
              (replaying ? this.hasStoredBoundaryGap(scope) : this.hasBoundaryGap(scope)) ||
              this.getBoundaryIntents(scope).length
            ) {
              if (this.pendingContinuities.has(operationKey))
                throw new Error('outbox_continuity_unconfirmed');
              this.captureOrder.delete(operationKey);
              return;
            }
            this.activeContinuity = replaying ? operationKey : undefined;
            await this.commit(this.records, checkpoint);
            this.requestedScope = requested;
            this.pendingContinuities.delete(operationKey);
            this.captureOrder.delete(operationKey);
          } catch (error) {
            if (
              !this.pendingContinuities.has(operationKey) &&
              (this.unconfirmedWrites.has(operationKey) || this.pendingContinuities.size > 0)
            ) {
              const bytes = durableJsonByteLength([checkpoint, scope]);
              if (
                this.pendingContinuities.size >= RELIABLE_OUTBOX_MAX_PENDING ||
                [...this.pendingContinuities.values()].reduce(
                  (total, entry) => total + entry.bytes,
                  bytes,
                ) > 4_000_000
              ) {
                this.boundaryCaptureLost = true;
                throw new Error('outbox_pending_continuity_capacity_exhausted', { cause: error });
              }
              this.captureOrder.set(operationKey, order);
              this.pendingContinuities.set(operationKey, {
                bytes,
                retry: () => this.updateContinuity(checkpoint, scope, true),
              });
            } else if (!this.pendingContinuities.has(operationKey)) {
              this.captureOrder.delete(operationKey);
            }
            throw error;
          } finally {
            this.activeContinuity = undefined;
          }
        },
        cursor.runtimeSeq,
      );
    });
  }

  async enqueue(
    event: ReliableEventV1,
    now = new Date(),
    continuity?: DeliveryContinuity,
    lineupSteam64?: readonly string[],
    recoveryKey?: string,
    scope?: BoundaryScope,
    source?: ExactSource | null,
    replaying = false,
  ): Promise<boolean> {
    let operationKey: string;
    let retryArgs: readonly [
      ReliableEventV1,
      Date,
      DeliveryContinuity | undefined,
      readonly string[] | undefined,
      string | undefined,
      BoundaryScope | undefined,
      ExactSource | null | undefined,
    ];
    let capture: CaptureTicket | undefined;
    let acceptingSource: ExactSource | undefined;
    try {
      if (source && this.canCapture(source))
        acceptingSource = this.captures.get(sourceKey(source))?.source;
      event = parseReliableEventV1(event);
      operationKey = `enqueue:${createHash('sha256')
        .update(JSON.stringify([event, now, continuity, lineupSteam64, recoveryKey, scope, source]))
        .digest('hex')}`;
      retryArgs = structuredClone([
        event,
        now,
        continuity,
        lineupSteam64,
        recoveryKey,
        scope,
        source,
      ] as const);
      [event, now, continuity, lineupSteam64, recoveryKey, scope, source] = retryArgs;
      capture = this.reserveCapture(operationKey, source);
    } catch (error) {
      // Pre-ticket validation/freezing failures are not retained for replay.
      // Only an active interval is poisoned; deliberate post-seal calls are not.
      if (acceptingSource) this.markCaptureUnknown(acceptingSource);
      throw error;
    }
    return this.runDurable(operationKey, async () => {
      this.activeOrdinaryCapture = capture;
      try {
        if (capture && this.repository().captureReceipt(capture)) {
          const file = this.repository().active();
          this.records = file.records;
          this.boundaryIntents = file.boundaryIntents ?? [];
          this.boundaryGap = file.boundaryGap;
          this.boundaryGaps = file.boundaryGaps ?? [];
          this.boundaryOverflowOwners = file.boundaryOverflowOwners ?? [];
          this.continuity = file.continuity;
          this.continuityReference = file.continuityReference;
          this.unconfirmedWrites.delete(operationKey);
          return true;
        }
        if (capture) {
          const interval = this.repository().captureInterval(capture.intervalId);
          if (!interval || interval.committedSequence + 1 !== capture.sequence)
            throw new Error('capture_sequence_unconfirmed');
        }
        // Retain legitimate one-shot results while their preceding boundary is unconfirmed.
        // Do not classify a transient write failure as a missing historical fact.
        if (this.boundaryCaptureFailed && !capture) {
          this.noteUnconfirmedWrite(operationKey);
          throw new Error('boundary_capture_pending');
        }
        // Preserve original accepted work before committing unrelated later events.
        if (!replaying && this.pendingEnqueues.size) {
          this.noteUnconfirmedWrite(operationKey);
          throw new Error('outbox_preceding_write_unconfirmed');
        }
        await this.archiveLegacyTerminals();
        const valid = parseReliableEventV1(event);
        if (source) source = parseSource(source);
        if (source !== null) this.assertSourceOpen(valid, source, replaying);
        const duplicates = [
          ...this.records.filter((record) => record.event.idempotencyKey === valid.idempotencyKey),
          ...this.repository()
            .byKey(valid.idempotencyKey)
            .map((item) => item.value),
        ];
        if (duplicates.length) {
          const expectedSourceKey = source ? sourceKey(source) : undefined;
          if (
            capture &&
            source &&
            duplicates.some(
              (record) =>
                JSON.stringify(record.event) !== JSON.stringify(valid) ||
                !record.source ||
                sourceKey(record.source) !== expectedSourceKey ||
                JSON.stringify(
                  'lineupSteam64' in record ? [...(record.lineupSteam64 ?? [])].sort() : undefined,
                ) !==
                  JSON.stringify(
                    lineupSteam64 === undefined ? undefined : [...lineupSteam64].sort(),
                  ),
            )
          ) {
            this.markCaptureUnknown(source);
            throw new Error('outbox_capture_idempotency_conflict');
          }
          if (this.unconfirmedWrites.has(operationKey)) {
            await this.commit(
              this.records,
              this.continuity,
              this.boundaryIntents,
              this.boundaryGap,
              this.boundaryGaps,
              this.boundaryOverflowOwners,
              [],
              undefined,
              capture,
            );
            return true;
          }
          if (capture)
            await this.commit(
              this.records,
              this.continuity,
              this.boundaryIntents,
              this.boundaryGap,
              this.boundaryGaps,
              this.boundaryOverflowOwners,
              [],
              undefined,
              capture,
            );
          return false;
        }
        if (
          this.records.filter((record) => record.status === 'pending').length +
            this.boundaryIntents.length >=
          RELIABLE_OUTBOX_MAX_PENDING
        )
          throw new Error('reliable_outbox_full');
        const at = now.toISOString();
        const unsafeResult =
          ['map_ended', 'map_player_snapshot', 'series_ended'].includes(valid.kind) &&
          ((capture ? this.hasStoredBoundaryGap(scope) : this.hasBoundaryGap(scope)) ||
            this.getBoundaryIntents(scope).some((intent) =>
              dependsOnBoundary(valid, intent.event),
            ) ||
            [
              ...this.records,
              ...this.history([valid])
                .filter((item) => item.kind === 'record' && item.disposition !== 'archived')
                .map((item) => item.value as ReliableOutboxRecord),
            ].some(
              (record) =>
                isContinuityBoundary(record.event) &&
                (['rejected', 'expired', 'superseded'].includes(record.status) ||
                  record.receiverOutcome === 'needs_attention') &&
                dependsOnBoundary(valid, record.event),
            ));
        const next = parseRecord({
          event: valid,
          ...(source ? { source } : {}),
          ...(source === null ? { awaitingSource: true } : {}),
          ...(lineupSteam64 === undefined ? {} : { lineupSteam64 }),
          ...(unsafeResult ? { dispositionReason: 'boundary_unconfirmed_result' } : {}),
          status: unsafeResult ? 'superseded' : 'pending',
          attempts: 0,
          nextAttemptAt: at,
          updatedAt: at,
        });
        let existing = this.records;
        if (recoveryKey !== undefined) {
          const rejected = this.startRejections(valid);
          if (
            valid.kind !== 'map_started' ||
            rejected.length !== 1 ||
            rejected[0] === undefined ||
            this.isRevokedEvent(rejected[0].event, rejected[0].source) ||
            rejected[0]?.event.idempotencyKey !== recoveryKey ||
            rejected[0].recoveryState !== 'awaiting_observation'
          )
            throw new Error('recovery_scope_invalid');
          const proofQueued = {
            ...rejected[0],
            recoveryState: 'proof_queued' as const,
            updatedAt: at,
          };
          existing = this.records.includes(rejected[0])
            ? this.records.map((item) => (item === rejected[0] ? proofQueued : item))
            : [...this.records, proofQueued];
        }
        // A repaired boundary may already be stored after this original result's cursor.
        // Restore its causal position in the existing queue, never change the event itself.
        const before = existing.findIndex(
          (record) =>
            record.status === 'pending' &&
            this.sameDeliveryScope(record, next) &&
            record.event.cursor.runtimeSeq > valid.cursor.runtimeSeq,
        );
        const records = this.trim(
          before < 0
            ? [...existing, next]
            : [...existing.slice(0, before), next, ...existing.slice(before)],
        );
        if (records.length > RELIABLE_OUTBOX_MAX_RECORDS) throw new Error('reliable_outbox_full');
        const checkpoint = continuity ?? {
          matchId: valid.matchId,
          contextRevision: valid.contextRevision,
          cursor: valid.cursor,
          mapName: valid.mapName,
          savedAt: at,
        };
        const keepCheckpoint =
          replaying &&
          this.continuity &&
          (this.continuity.cursor.producerInstanceId !== checkpoint.cursor.producerInstanceId ||
            this.continuity.cursor.liveSessionId !== checkpoint.cursor.liveSessionId ||
            this.continuity.cursor.runtimeSeq >= checkpoint.cursor.runtimeSeq);
        await this.commit(
          records,
          keepCheckpoint || this.hasBoundaryGap(scope) || this.getBoundaryIntents(scope).length
            ? this.continuity
            : checkpoint,
          this.boundaryIntents,
          this.boundaryGap,
          this.boundaryGaps,
          this.boundaryOverflowOwners,
          [],
          undefined,
          capture,
        );
        return true;
      } finally {
        this.activeOrdinaryCapture = undefined;
      }
    }).then(
      (result) => {
        this.pendingEnqueues.delete(operationKey);
        this.captureTickets.delete(operationKey);
        this.captureOrder.delete(operationKey);
        return result;
      },
      (error: unknown) => {
        if (capture) this.noteUnconfirmedWrite(operationKey);
        if (this.unconfirmedWrites.has(operationKey)) {
          const bytes = durableJsonByteLength(retryArgs);
          if (
            !this.pendingEnqueues.has(operationKey) &&
            (this.pendingEnqueues.size >= RELIABLE_OUTBOX_MAX_PENDING ||
              [...this.pendingEnqueues.values()].reduce(
                (total, item) => total + item.bytes,
                bytes,
              ) > 4_000_000)
          ) {
            this.boundaryCaptureLost = true;
            throw new Error('outbox_pending_enqueue_capacity_exhausted', { cause: error });
          }
          this.pendingEnqueues.set(operationKey, {
            event: retryArgs[0],
            bytes,
            ...(retryArgs[6] === undefined ? {} : { source: retryArgs[6] }),
            retry: () => this.enqueue(...retryArgs, true),
          });
        }
        throw error;
      },
    );
  }

  private sameDeliveryScope(
    a: { event: ReliableEventV1; source?: ExactSource | null },
    b: { event: ReliableEventV1; source?: ExactSource | null },
  ): boolean {
    return (
      a.event.matchId === b.event.matchId &&
      a.event.cursor.producerInstanceId === b.event.cursor.producerInstanceId &&
      a.event.cursor.liveSessionId === b.event.cursor.liveSessionId &&
      (!a.source || !b.source || sourceKey(a.source) === sourceKey(b.source))
    );
  }

  hasUnconfirmedWrites(): boolean {
    return (
      this.unconfirmedWrites.size > 0 ||
      this.boundaryCaptureFailed ||
      this.pendingBoundaryCaptures.size > 0 ||
      this.pendingEnqueues.size > 0 ||
      this.pendingContinuities.size > 0
    );
  }

  /** Captures are registered synchronously before their journal operation is queued. */
  hasPendingBoundaryCaptures(scope: ReliableDeliveryScope): boolean {
    const matches = (value: {
      matchId?: string;
      producerInstanceId: string;
      liveSessionId?: string | null;
    }) =>
      (!value.matchId || value.matchId === scope.matchId) &&
      value.producerInstanceId === scope.producerInstanceId &&
      (!value.liveSessionId || value.liveSessionId === scope.liveSessionId);
    return [...this.pendingBoundaryCaptures.values()].some(({ request }) => {
      // Without the prior execution scope, do not infer ownership from a newer binding.
      if (!request.scope) return true;
      if (matches(request.scope)) return true;
      return [...request.events, ...request.intents.map((intent) => intent.event)].some((event) =>
        matches({
          matchId: event.matchId,
          producerInstanceId: event.cursor.producerInstanceId,
          liveSessionId: event.cursor.liveSessionId,
        }),
      );
    });
  }

  hasPendingEnqueues(scope: ReliableDeliveryScope, source?: ExactSource): boolean {
    return [...this.pendingEnqueues.values()].some(
      ({ event, source: pendingSource }) =>
        (!source || !pendingSource || sourceKey(source) === sourceKey(pendingSource)) &&
        event.matchId === scope.matchId &&
        event.cursor.producerInstanceId === scope.producerInstanceId &&
        event.cursor.liveSessionId === scope.liveSessionId,
    );
  }

  hasPendingEnqueue(idempotencyKey: string): boolean {
    return [...this.pendingEnqueues.values()].some(
      (item) => item.event.idempotencyKey === idempotencyKey,
    );
  }

  async retryPendingEnqueues(): Promise<void> {
    try {
      await this.retryPendingCaptures(true);
    } catch {
      /* Retain the original request. */
    }
  }

  async flush(input: {
    readonly sink: ReliableEventSink;
    readonly isCurrent: (event: ReliableEventV1, lineupSteam64?: readonly string[]) => boolean;
    readonly canSend?: (event: ReliableEventV1, lineupSteam64?: readonly string[]) => boolean;
    readonly now?: Date;
  }): Promise<readonly string[]> {
    if (this.closing) return [];
    if (this.pendingFlush) return this.pendingFlush;
    const flush = this.flushOnce(input);
    this.pendingFlush = flush;
    try {
      return await flush;
    } finally {
      if (this.pendingFlush === flush) this.pendingFlush = undefined;
    }
  }

  private async flushOnce(input: {
    readonly sink: ReliableEventSink;
    readonly isCurrent: (event: ReliableEventV1, lineupSteam64?: readonly string[]) => boolean;
    readonly canSend?: (event: ReliableEventV1, lineupSteam64?: readonly string[]) => boolean;
    readonly now?: Date;
  }): Promise<readonly string[]> {
    const invalidatedStarts: string[] = [];
    const attempted = new Set<string>();
    const responseBoundaries: ReliableEventV1[] = [];
    const responseMapEnds = new Set<string>();
    const deliveryScope = (event: ReliableEventV1) =>
      JSON.stringify([event.matchId, event.cursor.producerInstanceId, event.cursor.liveSessionId]);
    while (!this.closing) {
      const selected = await this.queue.run(async () => {
        if (this.boundaryCaptureFailed) throw new Error('boundary_capture_blocked');
        const now = input.now ?? new Date();
        let changed = false;
        const unconfirmedBoundaries = [
          ...this.records,
          ...this.legacyRecords,
          ...this.revokedSources.flatMap((archive) => archive.records),
        ].filter(
          (record) =>
            isContinuityBoundary(record.event) &&
            (record.status !== 'accepted' || record.receiverOutcome === 'needs_attention'),
        );
        const rejectedStarts = this.getRecords()
          .filter((record) => record.status === 'rejected' && record.event.kind === 'map_started')
          .map((record) => record.event);
        const next: ReliableOutboxRecord[] = [];
        const blockedByMapEnd = new Set(responseMapEnds);
        // Terminal failures remain fences: a later event cannot turn a rejected or
        // expired continuity transition into an implicit acknowledgement.
        const blockedBoundaries = [
          ...this.records,
          ...this.legacyRecords,
          ...this.revokedSources.flatMap((archive) => archive.records),
        ]
          .filter(
            (record) =>
              isContinuityBoundary(record.event) &&
              (['rejected', 'expired', 'superseded'].includes(record.status) ||
                record.receiverOutcome === 'needs_attention'),
          )
          .map((record) => record.event);
        blockedBoundaries.push(
          ...responseBoundaries,
          ...this.revokedSources
            .flatMap((archive) => archive.records)
            .filter((record) => record.status === 'pending' && isContinuityBoundary(record.event))
            .map((record) => record.event),
        );
        for (const record of this.records) {
          if (record.status !== 'pending') {
            next.push(record);
            continue;
          }
          // An original fact still waiting for a local write cannot be overtaken by
          // a later boundary/start in the same delivery scope. Other scopes continue.
          if (
            [...this.pendingEnqueues.values()].some(
              (pending) =>
                pending.event.kind !== 'map_player_snapshot' &&
                this.sameDeliveryScope(pending, record) &&
                pending.event.cursor.runtimeSeq <= record.event.cursor.runtimeSeq,
            )
          ) {
            next.push(record);
            continue;
          }
          if (
            this.isRevokedEvent(record.event, record.source) ||
            this.isRevokingEvent(record.event, record.source)
          ) {
            if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
            next.push(record);
            continue;
          }
          if (
            this.repository().isDamaged(
              scopeDigest(
                record.event.competitionId,
                record.event.matchId,
                record.event.cursor.producerInstanceId,
                record.event.cursor.liveSessionId,
              ),
            )
          ) {
            if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
            next.push(record);
            continue;
          }
          // A refused start never authorizes replay of a result that was already
          // queued for that execution. Preserve the refusal and retire the result.
          if (
            ['map_ended', 'map_player_snapshot', 'series_ended'].includes(record.event.kind) &&
            rejectedStarts.some((start) => {
              const a = record.event.cursor;
              const b = start.cursor;
              return (
                record.event.matchId === start.matchId &&
                a.producerInstanceId === b.producerInstanceId &&
                a.liveSessionId !== null &&
                a.liveSessionId === b.liveSessionId &&
                a.programSourceGeneration === b.programSourceGeneration &&
                a.mapEpoch === b.mapEpoch &&
                a.runtimeSeq >= b.runtimeSeq &&
                ![
                  ...next,
                  ...this.records,
                  ...this.legacyRecords,
                  ...this.revokedSources.flatMap((archive) => archive.records),
                ].some((proof) => {
                  const c = proof.event.cursor;
                  return (
                    proof.status === 'accepted' &&
                    proof.receiverOutcome !== 'needs_attention' &&
                    proof.event.kind === 'map_started' &&
                    proof.event.matchId === start.matchId &&
                    c.producerInstanceId === b.producerInstanceId &&
                    c.liveSessionId === b.liveSessionId &&
                    c.programSourceGeneration === b.programSourceGeneration &&
                    c.mapEpoch === b.mapEpoch &&
                    c.runtimeSeq > b.runtimeSeq &&
                    c.runtimeSeq < a.runtimeSeq
                  );
                })
              );
            })
          ) {
            next.push({
              ...record,
              status: 'superseded',
              supersessionReason: 'rejected_start_result',
              updatedAt: now.toISOString(),
            });
            changed = true;
            continue;
          }
          // A start observed before a boundary ACK is not a post-ACK proof,
          // including starts left in a queue written by an older version.
          if (
            record.event.kind === 'map_started' &&
            unconfirmedBoundaries.some((boundary) =>
              dependsOnBoundary(record.event, boundary.event),
            )
          ) {
            invalidatedStarts.push(record.event.idempotencyKey);
            next.push({
              ...record,
              status: 'superseded',
              supersessionReason: 'boundary_unconfirmed_start',
              updatedAt: now.toISOString(),
            });
            changed = true;
            continue;
          }
          if (
            blockedByMapEnd.has(deliveryScope(record.event)) ||
            blockedBoundaries.some((boundary) => dependsOnBoundary(record.event, boundary))
          ) {
            if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
            next.push(record);
            continue;
          }
          const expired =
            now.getTime() - Date.parse(record.event.observedAt) >= RELIABLE_OUTBOX_RETENTION_MS;
          if (expired || !input.isCurrent(record.event, record.lineupSteam64)) {
            if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
            next.push({
              ...record,
              status: expired ? 'expired' : 'superseded',
              ...(!expired ? { supersessionReason: 'current_scope_failed' as const } : {}),
              updatedAt: now.toISOString(),
            });
            changed = true;
            continue;
          }
          if (record.event.kind === 'map_player_snapshot') {
            const mapEndedKey = record.event.payload.mapEndedKey;
            const parent = [
              ...next,
              ...this.records,
              ...this.legacyRecords,
              ...this.revokedSources.flatMap((archive) => archive.records),
            ].find((r) => r.event.idempotencyKey === mapEndedKey);
            if (!parent || ['rejected', 'expired', 'superseded'].includes(parent.status)) {
              next.push({
                ...record,
                status: 'superseded',
                supersessionReason: 'map_end_unavailable',
                updatedAt: now.toISOString(),
              });
              changed = true;
              continue;
            }
            if (parent.status !== 'accepted') {
              next.push(record);
              continue;
            }
          }
          if (input.canSend !== undefined && !input.canSend(record.event, record.lineupSteam64)) {
            this.evidence(record, 'send_guard_blocked');
            if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
            else if (['map_ended', 'map_started'].includes(record.event.kind))
              blockedByMapEnd.add(deliveryScope(record.event));
            next.push(record);
            continue;
          }
          if (Date.parse(record.nextAttemptAt) > now.getTime()) {
            if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
            else if (['map_ended', 'map_started'].includes(record.event.kind))
              blockedByMapEnd.add(deliveryScope(record.event));
            next.push(record);
            continue;
          }
          if (attempted.has(record.event.idempotencyKey)) {
            next.push(record);
            continue;
          }
          // Persist decisions made before this record before releasing the queue.
          next.push(...this.records.slice(next.length));
          if (changed) {
            const changedRecords = next.filter((item, index) => item !== this.records[index]);
            await this.commitStatusChanges(changedRecords, this.trim(next));
            return { rescan: true as const };
          }
          // Start the request while the same queue slot still owns the authorization
          // decision. Only its promise, not the network wait, leaves the slot.
          if (this.closing) return undefined;
          const controller = new AbortController();
          let timeout: ReturnType<typeof setTimeout> | undefined;
          let sending: Promise<ReliableDeliveryResult>;
          try {
            sending = input.sink.send(
              record.event,
              controller.signal,
              record.lineupSteam64,
              record.source,
            );
          } catch {
            sending = Promise.resolve('retry');
          }
          const outcome = Promise.race([
            sending.catch(() => 'retry' as const),
            new Promise<'retry'>((resolve) => {
              timeout = setTimeout(() => {
                controller.abort(new DOMException('Reliable delivery timed out', 'TimeoutError'));
                resolve('retry');
              }, RELIABLE_SEND_TIMEOUT_MS);
              timeout.unref();
            }),
          ]).finally(() => {
            if (timeout !== undefined) clearTimeout(timeout);
          });
          return { record, outcome };
        }

        if (changed) {
          const changedRecords = next.filter((record, index) => record !== this.records[index]);
          await this.commitStatusChanges(changedRecords, this.trim(next));
        }
        return undefined;
      });
      if (!selected) break;
      if ('rescan' in selected) continue;
      const record = selected.record;
      attempted.add(record.event.idempotencyKey);
      const outcome = await selected.outcome;
      const accepted =
        outcome === 'accepted' || (typeof outcome === 'object' && outcome.status === 'accepted');
      if ((!accepted || typeof outcome === 'object') && isContinuityBoundary(record.event))
        responseBoundaries.push(record.event);
      else if (
        (outcome === 'retry' ||
          (typeof outcome === 'object' &&
            outcome.status === 'rejected' &&
            ['generation_fence', 'epoch_fence'].includes(outcome.reason))) &&
        ['map_ended', 'map_started'].includes(record.event.kind)
      )
        responseMapEnds.add(deliveryScope(record.event));
      await this.queue.run(async () => {
        const current = this.records.find(
          (item) => item.event.idempotencyKey === record.event.idempotencyKey,
        );
        // Revocation, archival, or another state change wins over a late response.
        if (
          !current ||
          current.status !== 'pending' ||
          current.attempts !== record.attempts ||
          this.deliveryIdentity(current) !== this.deliveryIdentity(record) ||
          this.isRevokedEvent(current.event, current.source) ||
          this.isRevokingEvent(current.event, current.source)
        )
          return;
        const accepted =
          outcome === 'accepted' || (typeof outcome === 'object' && outcome.status === 'accepted');
        const attempts = current.attempts + 1;
        const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6));
        const now = input.now ?? new Date();
        const updated: ReliableOutboxRecord = {
          ...current,
          status: outcome === 'retry' ? 'pending' : accepted ? 'accepted' : 'rejected',
          ...(typeof outcome === 'object' && outcome.status === 'rejected'
            ? { rejection: outcome }
            : {}),
          ...(typeof outcome === 'object' && outcome.status === 'accepted'
            ? { receiverOutcome: outcome.outcome }
            : {}),
          attempts,
          nextAttemptAt: new Date(now.getTime() + delayMs).toISOString(),
          updatedAt: now.toISOString(),
        };
        const changed = [updated];
        const records = this.records.map((item) => {
          if (item === current) return updated;
          if (
            isContinuityBoundary(current.event) &&
            item.status === 'pending' &&
            item.event.kind === 'map_started' &&
            dependsOnBoundary(item.event, current.event)
          ) {
            const superseded: ReliableOutboxRecord = {
              ...item,
              status: 'superseded',
              supersessionReason: 'boundary_unconfirmed_start',
              updatedAt: now.toISOString(),
            };
            changed.push(superseded);
            return superseded;
          }
          return item;
        });
        await this.commitStatusChanges(changed, this.trim(records));
        for (const item of changed.slice(1)) invalidatedStarts.push(item.event.idempotencyKey);
      });
    }
    return invalidatedStarts;
  }

  private deliveryIdentity(record: ReliableOutboxRecord): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          ...record,
          status: undefined,
          attempts: undefined,
          updatedAt: undefined,
          nextAttemptAt: undefined,
          receiverOutcome: undefined,
          rejection: undefined,
        }),
      )
      .digest('hex');
  }

  private statusWriteKey(record: ReliableOutboxRecord): string {
    if (
      record.status === 'pending' &&
      record.attempts > 0 &&
      record.receiverOutcome === undefined &&
      record.rejection === undefined
    )
      return `pending-retry:${this.deliveryIdentity(record)}:${record.attempts}`;
    return `status:${createHash('sha256')
      .update(JSON.stringify({ ...record, updatedAt: undefined, nextAttemptAt: undefined }))
      .digest('hex')}`;
  }

  private acknowledgeStatusWrite(record: ReliableOutboxRecord): void {
    this.unconfirmedWrites.delete(this.statusWriteKey(record));
    if (record.status !== 'accepted' && record.status !== 'rejected') return;
    const prefix = `pending-retry:${this.deliveryIdentity(record)}:`;
    for (const key of this.unconfirmedWrites) {
      if (key.startsWith(prefix) && Number(key.slice(prefix.length)) <= record.attempts)
        this.unconfirmedWrites.delete(key);
    }
  }

  private async commitStatusChanges(
    changed: readonly ReliableOutboxRecord[],
    records: readonly ReliableOutboxRecord[],
  ): Promise<void> {
    // Delivery decisions may finish while a checkpoint is waiting to be retried.
    // They can trim existing records, but must not admit new facts or ownership.
    const content = (record: ReliableOutboxRecord) =>
      JSON.stringify({
        ...record,
        status: undefined,
        attempts: undefined,
        updatedAt: undefined,
        nextAttemptAt: undefined,
        receiverOutcome: undefined,
        rejection: undefined,
        supersessionReason: undefined,
      });
    const original = new Map(
      this.records.map((record) => [record.event.idempotencyKey, content(record)]),
    );
    if (records.some((record) => original.get(record.event.idempotencyKey) !== content(record)))
      throw new Error('outbox_status_content_changed');
    const batch = `status-batch:${randomUUID()}`;
    const previous = this.durabilityContext;
    this.durabilityContext = batch;
    try {
      await this.commit(
        records,
        this.continuity,
        this.boundaryIntents,
        this.boundaryGap,
        this.boundaryGaps,
        this.boundaryOverflowOwners,
        [],
        undefined,
        undefined,
        'status-only',
      );
      for (const record of changed) {
        if (records.includes(record)) this.acknowledgeStatusWrite(record);
      }
    } catch (error) {
      if (this.unconfirmedWrites.delete(batch))
        for (const record of changed) this.noteUnconfirmedWrite(this.statusWriteKey(record));
      throw error;
    } finally {
      this.durabilityContext = previous;
    }
  }

  async sweep(
    isCurrent: (event: ReliableEventV1, lineupSteam64?: readonly string[]) => boolean,
    now = new Date(),
  ): Promise<void> {
    return this.queue.run(async () => {
      const next = this.records.map((record): ReliableOutboxRecord => {
        if (record.status !== 'pending' || this.isRevokedEvent(record.event, record.source))
          return record;
        const expired =
          now.getTime() - Date.parse(record.event.observedAt) >= RELIABLE_OUTBOX_RETENTION_MS;
        if (!expired && isCurrent(record.event, record.lineupSteam64)) return record;
        return {
          ...record,
          status: expired ? 'expired' : 'superseded',
          ...(!expired ? { supersessionReason: 'current_scope_failed' as const } : {}),
          updatedAt: now.toISOString(),
        };
      });
      const changed = next.filter((record, index) => record !== this.records[index]);
      if (changed.length) await this.commitStatusChanges(changed, this.trim(next));
    });
  }

  supersedeWhere(selected: (event: ReliableEventV1) => boolean, now = new Date()): Promise<void> {
    return this.queue.run(async () => {
      const records = this.records.map((record) =>
        record.status === 'pending' &&
        !this.isRevokedEvent(record.event, record.source) &&
        selected(record.event)
          ? {
              ...record,
              status: 'superseded' as const,
              supersessionReason: 'scope_superseded' as const,
              updatedAt: now.toISOString(),
            }
          : record,
      );
      const changed = records.filter((record, index) => record !== this.records[index]);
      if (changed.length) await this.commitStatusChanges(changed, records);
    });
  }

  async flushPending(): Promise<void> {
    await this.pendingFlush;
    await this.queue.flush();
  }

  async flushForShutdown(): Promise<void> {
    await this.queue.flush();
    await this.retryPendingCaptures(true);
    if (this.hasUnconfirmedWrites()) throw new Error('outbox_durable_write_unconfirmed');
  }

  close(): Promise<void> {
    this.closing = true;
    if (this.closeTask) return this.closeTask;
    const pending = this.closeOnce();
    this.closeTask = pending;
    void pending
      .finally(() => {
        if (this.closeTask === pending) this.closeTask = undefined;
      })
      .catch(() => undefined);
    return pending;
  }

  private async closeOnce(): Promise<void> {
    // Startup rollback may already have closed this object's database while
    // retaining the original failure evidence. Disposal must not reopen/replay it.
    if (!this.database) return;
    try {
      await this.pendingFlush;
      await this.flushForShutdown();
    } finally {
      this.database?.close();
      this.database = undefined;
    }
  }

  private trim(records: readonly ReliableOutboxRecord[]): readonly ReliableOutboxRecord[] {
    const pending = records.filter((record) => record.status === 'pending');
    // A failed boundary is a durable fence, even after ordinary receipt history
    // rotates. At capacity, reject new work rather than forget the missing ACK.
    const fences = records.filter(
      (record) =>
        (isContinuityBoundary(record.event) &&
          (['rejected', 'expired', 'superseded'].includes(record.status) ||
            record.receiverOutcome === 'needs_attention')) ||
        (record.event.kind === 'map_started' && record.status === 'rejected'),
    );
    const terminal = records.filter(
      (record) => record.status !== 'pending' && !fences.includes(record),
    );
    const room = Math.max(
      0,
      Math.min(64, RELIABLE_OUTBOX_MAX_RECORDS - pending.length - fences.length),
    );
    return [...fences, ...(room === 0 ? [] : terminal.slice(-room)), ...pending];
  }

  private async commit(
    records: readonly ReliableOutboxRecord[],
    continuity = this.continuity,
    boundaryIntents = this.boundaryIntents,
    boundaryGap = this.boundaryGap,
    boundaryGaps = this.boundaryGaps,
    boundaryOverflowOwners = this.boundaryOverflowOwners,
    history: readonly OutboxHistory[] = [],
    boundaryCapture?: BoundaryCaptureOperation,
    capture = boundaryCapture?.request.capture,
    mode?: 'status-only',
  ): Promise<void> {
    if (
      mode === 'status-only' &&
      (continuity !== this.continuity ||
        boundaryIntents !== this.boundaryIntents ||
        boundaryGap !== this.boundaryGap ||
        boundaryGaps !== this.boundaryGaps ||
        boundaryOverflowOwners !== this.boundaryOverflowOwners ||
        history.length > 0 ||
        boundaryCapture !== undefined ||
        capture !== undefined)
    )
      throw new Error('outbox_status_metadata_changed');
    // A failed checkpoint must be written in its original place before later
    // events or acknowledgements can advance any durable continuity. Otherwise
    // replaying it after a newer success would roll the checkpoint backwards.
    const firstContinuity = [...this.pendingContinuities.keys()].sort(
      (a, b) => this.captureOrder.get(a)! - this.captureOrder.get(b)!,
    )[0];
    if (firstContinuity && this.activeContinuity !== firstContinuity && mode !== 'status-only') {
      const order = this.durabilityContext
        ? this.captureOrder.get(this.durabilityContext)
        : undefined;
      // An older retained event must still be allowed to reach its own commit;
      // the checkpoint is not permitted to jump ahead of it during recovery.
      if (order === undefined || order >= this.captureOrder.get(firstContinuity)!)
        throw new Error('outbox_continuity_pending');
    }
    if (
      this.boundaryCaptureFailed &&
      !this.activeBoundaryCapture &&
      !this.activeOrdinaryCapture &&
      !this.activeContinuity
    )
      throw new Error('boundary_capture_blocked');
    const continuityReference =
      mode === 'status-only'
        ? this.continuityReference
        : (records.at(-1)?.event ??
          boundaryIntents.at(-1)?.event ??
          this.continuityReference ??
          this.repository().latestEvent());
    const preparationStarted = performance.now();
    const file: OutboxFile = sealOutbox({
      version: RELIABLE_OUTBOX_VERSION,
      records,
      ...(boundaryIntents.length ? { boundaryIntents } : {}),
      ...(boundaryGap ? { boundaryGap } : {}),
      ...(boundaryGaps.length ? { boundaryGaps } : {}),
      ...(boundaryOverflowOwners.length ? { boundaryOverflowOwners } : {}),
      ...(continuity === undefined ? {} : { continuity }),
      ...(continuity === undefined || continuityReference === undefined
        ? {}
        : { continuityReference }),
      ...(this.unconfirmedRecovery ? { unconfirmedRecovery: true } : {}),
    });
    // SQLite owns the commit: active state and history/fences succeed together.
    // Failure never advances the in-memory queue or reports success.
    if (durableJsonByteLength(file) > 4_000_000) {
      this.noteUnconfirmedWrite(this.durabilityContext ?? 'outbox_too_large');
      throw new Error('outbox_too_large');
    }
    const identity = {
      ...file,
      commit: undefined,
      records: file.records.map((record) => ({
        ...record,
        updatedAt: undefined,
        nextAttemptAt: undefined,
      })),
      ...(file.continuity ? { continuity: { ...file.continuity, savedAt: undefined } } : {}),
      history,
    };
    const key = createHash('sha256').update(JSON.stringify(identity)).digest('hex');
    const preparationMs = performance.now() - preparationStarted;
    this.preparationTiming.count++;
    this.preparationTiming.totalMs += preparationMs;
    this.preparationTiming.maxMs = Math.max(this.preparationTiming.maxMs, preparationMs);
    await this.trackDurability(`snapshot:${key}`, async () =>
      this.repository().commit({
        active: file,
        history,
        ...(boundaryCapture ? { boundaryCapture } : {}),
        ...(capture ? { capture } : {}),
      }),
    );
    const previous = this.records;
    this.records = records;
    this.boundaryIntents = boundaryIntents;
    this.boundaryGap = boundaryGap;
    this.boundaryGaps = boundaryGaps;
    this.boundaryOverflowOwners = boundaryOverflowOwners;
    this.continuity = continuity;
    this.continuityReference = continuityReference;
    for (const record of records) {
      if (previous.includes(record)) continue;
      this.evidence(
        record,
        {
          accepted: 'receiver_accepted',
          rejected: 'delivery_rejected_unknown',
          expired: 'retention_expired',
          superseded:
            record.dispositionReason ?? record.supersessionReason ?? 'current_scope_failed',
          pending: record.attempts === 0 ? 'queued' : 'retry_unknown',
        }[record.status],
      );
    }
  }

  private evidence(record: ReliableOutboxRecord, reason: string): void {
    // Optional diagnostics cannot fail a durable queue commit or affect delivery.
    try {
      this.onEvidence?.(record, reason);
    } catch {
      /* Keep the queue authoritative. */
    }
  }
}
