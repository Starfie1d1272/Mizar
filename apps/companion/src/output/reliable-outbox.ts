import {
  parseCaptureReference,
  type CaptureInterval,
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
import { OutboxReadView, deliveryScope } from './outbox-read-view.js';
import type { HistoryRow, HistoryScope, OutboxHistory } from './outbox-repository.js';
import { OutboxWorkerClient } from './outbox-worker-client.js';
import type { OutboxOperations } from './outbox-worker.js';
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
  recoveryReport,
} from './outbox-codec.js';

type SourceFence = ReturnType<OutboxOperations['sourceFences']>[number];
type LoadedOutbox = ReturnType<OutboxOperations['load']>;

interface DeliveryScopeTuple {
  readonly matchId?: string;
  readonly producerInstanceId: string;
  readonly liveSessionId?: string | null;
}

interface WriteOwner {
  readonly scope?: DeliveryScopeTuple;
  readonly source?: ExactSource;
}

function eventDeliveryScope(event: ReliableEventV1): ReliableDeliveryScope {
  return {
    matchId: event.matchId,
    producerInstanceId: event.cursor.producerInstanceId,
    liveSessionId: event.cursor.liveSessionId ?? '',
  };
}

function boundaryOwner(request: BoundaryCaptureOperation['request']): WriteOwner | undefined {
  const first = request.events[0] ?? request.intents[0]?.event;
  const scope = request.scope ?? (first ? eventDeliveryScope(first) : undefined);
  return scope || request.source
    ? { ...(scope ? { scope } : {}), ...(request.source ? { source: request.source } : {}) }
    : undefined;
}

function matchesScopeTuple(value: DeliveryScopeTuple, scope: DeliveryScopeTuple): boolean {
  return (
    (!value.matchId || !scope.matchId || value.matchId === scope.matchId) &&
    value.producerInstanceId === scope.producerInstanceId &&
    (!value.liveSessionId || !scope.liveSessionId || value.liveSessionId === scope.liveSessionId)
  );
}

function scopeKeyTuple(scope: DeliveryScopeTuple | undefined): string {
  return scope
    ? JSON.stringify([scope.matchId ?? null, scope.producerInstanceId, scope.liveSessionId ?? null])
    : '__global__';
}

function isBoundaryFenceRecord(record: ReliableOutboxRecord): boolean {
  return (
    ['rejected', 'expired', 'superseded'].includes(record.status) ||
    record.receiverOutcome === 'needs_attention'
  );
}

function sameStartExecution(a: ReliableEventV1, b: ReliableEventV1): boolean {
  return (
    a.matchId === b.matchId &&
    a.cursor.producerInstanceId === b.cursor.producerInstanceId &&
    a.cursor.liveSessionId !== null &&
    a.cursor.liveSessionId === b.cursor.liveSessionId &&
    a.cursor.programSourceGeneration === b.cursor.programSourceGeneration &&
    a.cursor.mapEpoch === b.cursor.mapEpoch
  );
}

function eventScope(event: ReliableEventV1): string {
  return scopeDigest(
    event.competitionId,
    event.matchId,
    event.cursor.producerInstanceId,
    event.cursor.liveSessionId,
  );
}

function hasDisposition(
  fence: SourceFence,
  disposition: 'archived' | 'revoked',
  source?: ExactSource,
): boolean {
  return fence.sources.some(
    (item) =>
      item.disposition === disposition && (!source || sourceKey(item.source) === sourceKey(source)),
  );
}

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
  private readonly sealRequests = new Map<string, number>();
  private readonly unknownCaptures = new Map<string, 'legacy' | 'unclean' | 'mismatch'>();
  private isCaptureUnknown(key: string): boolean {
    return this.unknownCaptures.has(key) || this.view.unknown.has(key);
  }
  private exceedsPendingBudget(count: number, totalBytes: number): boolean {
    return count >= RELIABLE_OUTBOX_MAX_PENDING || totalBytes > 4_000_000;
  }
  private readonly captureTickets = new Map<string, CaptureTicket>();
  private readonly captureOrder = new Map<string, number>();
  private nextCaptureOrder = 0;
  private activeOrdinaryCapture: CaptureTicket | undefined;
  private orderedReplay: Promise<void> | undefined;

  createCaptureReference(cursor: ReliableEventV1['cursor']): CaptureReference {
    return parseCaptureReference({
      id: randomUUID(),
      storeId: this.captureStoreId(),
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
        !this.isCaptureUnknown(key) &&
        JSON.stringify(current.reference) === JSON.stringify(reference)
      )
        return;
      if (
        this.sealRequests.has(key) ||
        this.isCaptureUnknown(key) ||
        current ||
        reference.storeId !== this.captureStoreId() ||
        this.view.intervalForSource(source)
      )
        throw new Error('capture_interval_not_reopenable');
      await this.createCaptureInterval({
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
      this.isCaptureUnknown(key) ||
      !this.available
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
      const current = this.view.intervalForSource(source);
      const retired =
        !current && reference && reference.storeId === this.captureStoreId()
          ? await this.repository().request('archivedInterval', source)
          : undefined;
      const interval = current ?? retired;
      if (
        !reference ||
        reference.storeId !== this.captureStoreId() ||
        (interval && JSON.stringify(interval.reference) !== JSON.stringify(reference))
      ) {
        await this.quarantineIntervalInQueue(source, reference ? 'mismatch' : 'legacy');
        return;
      }
      if (!interval) {
        if (
          this.view.intervals.has(reference.id) ||
          (await this.repository().request('captureInterval', reference.id))
        ) {
          await this.quarantineIntervalInQueue(source, 'mismatch');
          return;
        }
        // JSON intent is persisted before arm. Absence in this exact store proves no activation.
        await this.createCaptureInterval({
          reference,
          source,
          state: 'sealed',
          committedSequence: 0,
          endCursor: reference.startCursor,
        });
      } else if (retired) {
        this.view.setInterval(retired);
        this.view.archived.add(key);
      } else if (interval.state !== 'sealed' && !this.captures.has(key)) {
        await this.quarantineIntervalInQueue(source, 'unclean', interval.endCursor);
      }
    });
  }

  canCapture(source: ExactSource): boolean {
    const key = sourceKey(source);
    const current = this.captures.get(key);
    return (
      this.available &&
      !!current?.activationCursor &&
      !current.sealing &&
      !this.sealRequests.has(key) &&
      !this.isCaptureUnknown(key)
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
    if (!this.available) return { state: 'unknown', reason: 'unclean' };
    const interval = this.view.intervalForSource(source);
    const reason =
      this.unknownCaptures.get(key) ??
      this.view.unknown.get(key)?.reason ??
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
    this.sealRequests.set(key, (this.sealRequests.get(key) ?? 0) + 1);
    if (!complete) this.unknownCaptures.set(key, 'unclean');
    const current = this.captures.get(key);
    if (current) {
      current.endCursor ??= structuredClone(endCursor);
      current.sealing = true; // Fence before the first await, including all boundary kinds.
    }
    const end = current?.endCursor ?? structuredClone(endCursor);
    return (async () => {
      try {
        if (!complete) {
          await this.queue.run(() => this.quarantineIntervalInQueue(source, 'unclean', end));
          return false;
        }
        await this.queue.flush();
        if (this.captureCoverage(source).state === 'sealed') return true;
        if (!current || this.captureCoverage(source).state === 'unknown') return false;
        let phase: 'retry' | 'seal' = 'retry';
        try {
          await this.retryPendingCaptures(true, source);
          phase = 'seal';
          return await this.queue.run(async () => {
            // Release and tail settlement may request the same seal concurrently.
            // Read its state under the same queue that commits the transition.
            const coverage = this.captureCoverage(source);
            if (coverage.state === 'sealed') return true;
            if (!current || coverage.state === 'unknown') return false;
            const scope = {
              source,
              matchId: source.matchId,
              producerInstanceId: source.producerInstanceId,
              liveSessionId: source.liveSessionId,
            };
            const intents = await this.readBoundaryIntents(scope);
            if (
              this.boundaryCaptureLost ||
              this.isCaptureUnknown(key) ||
              this.hasUnconfirmedWrites(source, source) ||
              this.hasStoredBoundaryGap(scope) ||
              intents.length
            ) {
              await this.quarantineIntervalInQueue(source, 'unclean', end);
              return false;
            }
            const interval = await this.repository().request(
              'sealCaptureInterval',
              current.reference.id,
              current.nextSequence,
              end,
              current.activationCursor,
            );
            this.view.setInterval(interval);
            return true;
          });
        } catch (error) {
          this.reportCaptureFailure(error);
          if (phase === 'seal' || !this.available || this.hasUnconfirmedWrites(source, source)) {
            await this.queue
              .run(() => this.quarantineIntervalInQueue(source, 'unclean', end))
              .catch(() => undefined);
          }
          return false;
        }
      } finally {
        const remaining = (this.sealRequests.get(key) ?? 1) - 1;
        if (remaining > 0) this.sealRequests.set(key, remaining);
        else this.sealRequests.delete(key);
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

  hasDurableUnknownCapture(source: ExactSource): boolean {
    return (
      this.available &&
      this.view.unknown.has(sourceKey(source)) &&
      !this.hasUnconfirmedWrites(source, source)
    );
  }

  private markCaptureUnknown(source: ExactSource): void {
    const key = sourceKey(source);
    this.unknownCaptures.set(key, 'unclean');
    const current = this.captures.get(key);
    if (current) current.sealing = true;
    // Even if this write fails or the process dies first, the already armed
    // interval remains durable evidence that an empty queue cannot prove clean.
    void this.queue
      .run(() => this.quarantineIntervalInQueue(source, 'unclean', current?.endCursor))
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
  private database: OutboxWorkerClient | undefined;
  private readonly view = new OutboxReadView();
  private loadingObservation = false;
  private revokedSummary: LoadedOutbox['revoked'] | undefined;

  get available(): boolean {
    return this.database !== undefined && !this.database.failed;
  }

  private repository(): OutboxWorkerClient {
    if (!this.database) throw new Error('outbox_not_loaded');
    return this.database;
  }

  private captureStoreId(): string {
    if (!this.available || !this.view.captureStoreId) throw new Error('outbox_not_loaded');
    return this.view.captureStoreId;
  }

  private async createCaptureInterval(interval: CaptureInterval): Promise<void> {
    await this.repository().request('createCaptureInterval', interval);
    this.view.setInterval(interval);
  }

  private async quarantineIntervalInQueue(
    source: ExactSource,
    reason: 'legacy' | 'unclean' | 'mismatch',
    endCursor?: ReliableEventV1['cursor'],
  ): Promise<void> {
    const key = sourceKey(source);
    this.unknownCaptures.set(key, reason);
    const current = this.captures.get(key);
    if (current) current.sealing = true;
    const interval = await this.repository().request(
      'quarantineCaptureInterval',
      current?.reference.id,
      source,
      reason,
      endCursor ?? current?.endCursor,
    );
    if (interval) this.view.setInterval(interval);
    if (!this.view.unknown.has(key)) this.view.unknown.set(key, { source, reason });
    for (const [operationKey, item] of this.pendingEnqueues) {
      if (item.source && sourceKey(item.source) === key) {
        this.pendingEnqueues.delete(operationKey);
        this.unconfirmedWrites.delete(operationKey);
        this.captureTickets.delete(operationKey);
        this.captureOrder.delete(operationKey);
      }
    }
    for (const [id, operation] of this.pendingBoundaryCaptures) {
      if (operation.request.source && sourceKey(operation.request.source) === key) {
        this.pendingBoundaryCaptures.delete(id);
        this.durableBoundaryCaptures.delete(id);
        this.unconfirmedWrites.delete(`boundary:${id}`);
        this.captureOrder.delete(`boundary:${id}`);
        this.captureOrder.delete(`boundary-request:${id}`);
      }
    }
  }

  private commitCaptureOnly(capture?: CaptureTicket): Promise<void> {
    return this.commit(
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
  }

  private currentEvents(
    records: readonly ReliableOutboxRecord[],
    intents: readonly BoundaryIntent[],
    reference: ReliableEventV1 | undefined,
  ): ReliableEventV1[] {
    return [
      ...records.map((item) => item.event),
      ...intents.map((item) => item.event),
      ...(reference ? [reference] : []),
    ];
  }

  observeDelivery(scope: HistoryScope | undefined): void {
    this.view.observe(scope);
    this.refreshObservation();
  }

  private refreshObservation(): void {
    if (
      !this.available ||
      this.closing ||
      this.loadingObservation ||
      !this.view.missingObservation()
    )
      return;
    this.loadingObservation = true;
    void this.queue
      .run(async () => {
        const scope = this.view.missingObservation();
        if (!scope) return;
        const [rows] = await this.repository().request('readHistory', [scope]);
        this.view.setObservation(scope, rows!);
      })
      .then(
        () => {
          this.loadingObservation = false;
          this.refreshObservation();
        },
        (error: unknown) => {
          this.loadingObservation = false;
          this.reportCaptureFailure(error);
        },
      );
  }

  hasDeliveryHistory(scope: HistoryScope): boolean {
    return this.available && this.view.get(scope) !== undefined;
  }

  private async readHistory(scope: HistoryScope): Promise<readonly HistoryRow[]> {
    const cached = this.view.get(scope);
    if (cached && this.available) return cached;
    const [rows] = await this.repository().request('readHistory', [scope]);
    return rows!;
  }

  private historyRecords: readonly ReliableOutboxRecord[] = [];
  private revokedRecords: readonly ReliableOutboxRecord[] = [];
  private publishedRecords: readonly ReliableOutboxRecord[] = [];

  private publishRecords(): void {
    const scopes = new Set(
      this.currentEvents(this.records, this.boundaryIntents, this.continuityReference).map(
        eventScope,
      ),
    );
    const legacy: ReliableOutboxRecord[] = [];
    const revoked = new Map<string, ReliableOutboxRecord>();
    for (const item of this.view.activeHistory()) {
      if (item.kind !== 'record') continue;
      if (item.disposition === 'legacy') legacy.push(item.value);
      if (item.disposition === 'revoked' && scopes.has(eventScope(item.value.event))) {
        const record = item.value;
        revoked.set(JSON.stringify([record.source, record.event.idempotencyKey]), record);
      }
    }
    this.revokedRecords = [...revoked.values()];
    this.historyRecords = [...legacy, ...this.revokedRecords];
    const keys = new Set(this.records.map((record) => record.event.idempotencyKey));
    this.publishedRecords = [
      ...[...this.revokedRecords, ...legacy].filter(
        (record) =>
          record.status === 'rejected' &&
          record.event.kind === 'map_started' &&
          !keys.has(record.event.idempotencyKey),
      ),
      ...this.records,
    ];
  }

  private async readFence(event: ReliableEventV1): Promise<SourceFence> {
    const [fence] = await this.repository().request('sourceFences', [eventScope(event)]);
    return fence!;
  }

  private async readFences(items: readonly { event: ReliableEventV1 }[]) {
    const scopes = [...new Set(items.map(({ event }) => eventScope(event)))];
    const fences = await this.repository().request('sourceFences', scopes);
    const byScope = new Map(scopes.map((scope, index) => [scope, fences[index]!]));
    return (event: ReliableEventV1) => byScope.get(eventScope(event))!;
  }

  private boundaryIntents: readonly BoundaryIntent[] = [];
  private boundaryGap: true | undefined;
  private boundaryGaps: readonly BoundaryScope[] = [];
  private boundaryOverflowOwners: readonly string[] = [];
  private boundaryCaptureLost = false;
  private readonly pendingBoundaryCaptures = new Map<string, BoundaryCaptureOperation>();
  private readonly durableBoundaryCaptures = new Set<string>();
  private activeBoundaryCapture: BoundaryCaptureOperation | undefined;
  private boundaryCaptureFailedFor(scope?: ReliableDeliveryScope): boolean {
    return (
      this.boundaryCaptureLost ||
      [...this.pendingBoundaryCaptures.entries()].some(
        ([id, op]) =>
          this.unconfirmedWrites.has(`boundary:${id}`) &&
          this.operationMatchesScope(op.request, scope),
      )
    );
  }
  private get boundaryCaptureFailed(): boolean {
    return this.boundaryCaptureFailedFor();
  }

  getBoundaryCaptureRecovery(): { pending: number; durable: number; lost: boolean } {
    return {
      pending: this.pendingBoundaryCaptures.size,
      durable: this.durableBoundaryCaptures.size,
      lost: this.boundaryCaptureLost,
    };
  }
  private readonly queue = new SerialCommitQueue();
  private readonly unconfirmedWrites = new Map<string, WriteOwner | undefined>();
  private durabilityContext: string | undefined;
  private durabilityOwner: WriteOwner | undefined;
  private readonly continuityFailures = new Map<string, number>();
  private readonly pendingContinuities = new Map<
    string,
    { bytes: number; scope?: BoundaryScope; retry: () => Promise<void> }
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

  private noteUnconfirmedWrite(key: string, owner?: WriteOwner): void {
    if (
      this.unconfirmedWrites.has(key) ||
      this.unconfirmedWrites.size < RELIABLE_OUTBOX_MAX_RECORDS
    )
      this.unconfirmedWrites.set(key, owner);
    else this.unconfirmedWrites.set('unconfirmed-write-overflow', undefined);
  }

  private async durableOperation<T>(
    key: string,
    operation: () => Promise<T>,
    continuitySequence?: number,
    owner?: WriteOwner,
  ): Promise<T> {
    const previous = this.durabilityContext;
    const previousOwner = this.durabilityOwner;
    this.durabilityContext = key;
    this.durabilityOwner = owner;
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
      this.durabilityOwner = previousOwner;
    }
  }

  private runDurable<T>(
    key: string,
    operation: () => Promise<T>,
    continuitySequence?: number,
    owner?: WriteOwner,
  ): Promise<T> {
    return this.queue.run(() => this.durableOperation(key, operation, continuitySequence, owner));
  }

  private continuity: DeliveryContinuity | undefined;
  private continuityReference: ReliableEventV1 | undefined;
  private requestedScope: string | undefined;
  private scheduledContinuity: { key: string; task: Promise<void> } | undefined;
  private scheduledSupersession: { evidence: string; task: Promise<void> } | undefined;

  private recovery: OutboxRecovery | undefined;
  private unconfirmedRecovery: true | undefined;

  private preparationTiming = { count: 0, totalMs: 0, maxMs: 0, activeSnapshotBytes: 0 };

  takePersistenceTiming() {
    const preparation = this.preparationTiming;
    this.preparationTiming = { count: 0, totalMs: 0, maxMs: 0, activeSnapshotBytes: 0 };
    return { preparation, worker: this.database?.takeTiming() ?? null };
  }

  constructor(
    private readonly filePath: string,
    private readonly onRecovery?: (report: OutboxRecovery | undefined, error: unknown) => void,
    private readonly onEvidence?: (record: ReliableOutboxRecord, reason: string) => void,
    private readonly onWorkerFailure?: (error: Error) => void,
  ) {}

  getWorkerFailure() {
    return this.database?.failureReason;
  }

  getCaptureCapacity() {
    return this.available ? this.repository().request('captureCapacity') : undefined;
  }

  getRecovery(): OutboxRecovery | undefined {
    return this.recovery;
  }

  /** One-time JSON import lives in the repository; normal operation never writes legacy files. */
  load(): Promise<void> {
    return this.queue.run(async () => {
      if (this.database?.failed) throw new Error('outbox_worker_restart_required');
      if (this.database) return;
      const database = new OutboxWorkerClient(this.filePath, this.onWorkerFailure);
      this.database = database;
      let loaded: LoadedOutbox;
      try {
        loaded = await this.restoreSnapshot();
      } catch (error) {
        this.database = undefined;
        await database.close().catch(() => undefined);
        throw error;
      }
      this.boundaryCaptureLost = loaded.lost;
      for (const operation of loaded.staged) {
        this.pendingBoundaryCaptures.set(operation.id, operation);
        this.captureOrder.set(`boundary:${operation.id}`, ++this.nextCaptureOrder);
        this.durableBoundaryCaptures.add(operation.id);
        this.noteUnconfirmedWrite(`boundary:${operation.id}`, boundaryOwner(operation.request));
      }
      this.unconfirmedRecovery = loaded.file.unconfirmedRecovery;
      if (loaded.file.unconfirmedRecovery) {
        this.recovery = recoveryReport(loaded.file);
        this.onRecovery?.(this.recovery, new Error('outbox_previous_recovery_unconfirmed'));
      }
    });
  }

  private async restoreSnapshot(): Promise<LoadedOutbox> {
    const loaded = await this.repository().request('load');
    const { file } = loaded;
    const plan = this.view.plan(
      this.currentEvents(file.records, file.boundaryIntents ?? [], file.continuityReference),
      true,
    );
    const history = await this.repository().request('readHistory', plan.scopes);
    plan.apply(history);
    this.view.restoreCapture(loaded.capture);
    this.revokedSummary = loaded.revoked;
    this.records = file.records;
    this.boundaryIntents = file.boundaryIntents ?? [];
    this.boundaryGap = file.boundaryGap;
    this.boundaryGaps = file.boundaryGaps ?? [];
    this.boundaryOverflowOwners = file.boundaryOverflowOwners ?? [];
    this.continuity = file.continuity;
    this.continuityReference = file.continuityReference;
    this.publishRecords();
    this.refreshObservation();
    return loaded;
  }

  private async archiveLegacyTerminals(): Promise<void> {
    const candidates = this.records.filter(
      (record) => !record.source && !record.awaitingSource && record.status !== 'pending',
    );
    if (!candidates.length) return;
    const fence = await this.readFences(candidates);
    const safe = candidates.filter((record) => !fence(record.event).damaged);
    const history = await this.repository().request(
      'byKeys',
      safe.map((record) => record.event.idempotencyKey),
    );
    const legacy = safe.filter((record, index) =>
      history[index]!.filter(
        (item) => item.disposition === 'legacy' && item.kind === 'record',
      ).every((item) => JSON.stringify(item.value) === JSON.stringify(record)),
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
    return this.publishedRecords;
  }

  async getScopeDisposition(
    scope: ReliableDeliveryScope,
    source?: ExactSource,
  ): Promise<ReliableScopeDisposition> {
    const belongs = (item: { source?: ExactSource }) =>
      !source || !item.source || sourceKey(source) === sourceKey(item.source);
    return this.queue.run(async () => {
      const history = (await this.repository().request('forDelivery', scope)).filter((item) =>
        belongs(item.value),
      );
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
    });
  }

  getRevokedIsolationSummary() {
    return this.revokedSummary;
  }

  getActiveSources(): readonly ExactSource[] {
    if (!this.available) throw new Error('outbox_unavailable');
    const sources = new Map<string, ExactSource>(
      [...this.view.unknown].map(([key, item]) => [key, item.source]),
    );
    for (const interval of this.view.intervals.values()) {
      const key = sourceKey(interval.source);
      if (interval.state !== 'sealed' || !this.view.archived.has(key))
        sources.set(key, interval.source);
    }
    for (const item of [...this.records, ...this.boundaryIntents]) {
      if (item.source) sources.set(sourceKey(item.source), item.source);
    }
    return [...sources.values()];
  }

  private runSourceDisposition<T>(
    action: 'archive' | 'revoke',
    input: ExactSource,
    body: (identity: ExactSource, key: string) => Promise<T>,
  ): Promise<T> {
    const identity = parseSource(input);
    const key = sourceKey(identity);
    return (async () => {
      await this.retryPendingEnqueues();
      if (this.hasPendingEnqueues(identity)) throw new Error('outbox_source_unsettled');
      const commitDisposition = async () => {
        const digest = scopeDigest(
          identity.competitionId,
          identity.matchId,
          identity.producerInstanceId,
          identity.liveSessionId,
        );
        if ((await this.repository().request('sourceFences', [digest]))[0]?.damaged)
          throw new Error('outbox_archive_unreadable');
        return body(identity, key);
      };
      return this.runDurable(`${action}:${key}`, commitDisposition, undefined, {
        scope: identity,
        source: identity,
      });
    })();
  }
  /** Exact closure moves records and its fence in the same transaction. */
  async archiveConfirmedSource(input: ExactSource): Promise<void> {
    if (this.captureCoverage(input).state !== 'sealed') {
      const identity = parseSource(input);
      const key = sourceKey(identity);
      const previouslyArchived = await this.queue.run(
        async () =>
          this.available &&
          !this.view.intervalForSource(identity) &&
          !this.isCaptureUnknown(key) &&
          !!(await this.repository().request('archivedInterval', identity)),
      );
      if (previouslyArchived) return;
      throw new Error('capture_coverage_unknown');
    }
    return this.runSourceDisposition('archive', input, async (identity, key) => {
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
  private isolateRevokedSourceOnce(input: ExactSource): Promise<void> {
    return this.runSourceDisposition('revoke', input, async (identity, key) => {
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
  private isRevokingEvent(event: ReliableEventV1, source?: ExactSource): boolean {
    return [...this.revoking.values()].some(({ source: pending }) =>
      source ? sourceKey(source) === sourceKey(pending) : sourceMatchesEvent(pending, event),
    );
  }
  private assertSourceOpen(
    event: ReliableEventV1,
    fence: SourceFence,
    source?: ExactSource,
    replaying = false,
  ): void {
    if (fence.damaged) throw new Error('outbox_archive_unreadable');
    if (source && !sourceMatchesEvent(source, event)) throw new Error('outbox_source_mismatch');
    if (
      hasDisposition(fence, 'revoked', source) ||
      (!replaying && this.isRevokingEvent(event, source))
    )
      throw new Error('outbox_source_revoked');
    if (hasDisposition(fence, 'archived', source)) throw new Error('outbox_source_closed');
  }

  /** Pin unsent work to the current authority before any request can be issued. */
  bindUnsentSource(input: ExactSource): Promise<void> {
    const source = parseSource(input);
    const bind = async () => {
      const selected = new Set(
        this.records.filter(
          (record) =>
            record.status === 'pending' &&
            record.attempts === 0 &&
            record.awaitingSource &&
            sourceMatchesEvent(source, record.event),
        ),
      );
      if (selected.size === 0) return;
      const first = selected.values().next().value!;
      this.assertSourceOpen(first.event, await this.readFence(first.event), source);
      const records = this.records.map((record) => {
        if (!selected.has(record)) return record;
        const { awaitingSource, ...rest } = record;
        void awaitingSource;
        return { ...rest, source };
      });
      await this.commit(records);
    };
    return this.runDurable(`bind:${sourceKey(source)}`, bind, undefined, { scope: source, source });
  }

  hasUnconfirmedBoundary(
    event: ReliableEventV1,
    history = this.view.get(deliveryScope(event)) ?? [],
  ): boolean {
    if (
      [...this.pendingEnqueues.values()].some(
        (item) => isContinuityBoundary(item.event) && dependsOnBoundary(event, item.event),
      )
    )
      return true;
    return [
      ...this.records,
      ...history.filter((item) => item.kind === 'record').map((item) => item.value),
    ].some(
      (record) =>
        (record.status !== 'accepted' || record.receiverOutcome === 'needs_attention') &&
        isContinuityBoundary(record.event) &&
        dependsOnBoundary(event, record.event),
    );
  }

  /** Refusals remain authoritative for the original execution, even if context changes. */
  startRejections(
    event: ReliableEventV1,
    history = this.view.get(deliveryScope(event)) ?? [],
  ): readonly ReliableOutboxRecord[] {
    const c = event.cursor;
    const seen = new Set<string>();
    return [
      ...this.records,
      ...history.filter((item) => item.kind === 'record').map((item) => item.value),
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

  lookupStartRejections(event: ReliableEventV1): Promise<readonly ReliableOutboxRecord[]> {
    return this.queue.run(async () =>
      this.startRejections(event, await this.readHistory(deliveryScope(event))),
    );
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
        (await this.repository().request('byKeys', [key]))[0]!
          .filter((item) => item.kind === 'record' && item.disposition !== 'archived')
          .map((item) => item.value as ReliableOutboxRecord)[0];
      if (
        !record ||
        record.status !== 'rejected' ||
        record.event.kind !== 'map_started' ||
        !['context_stale', 'generation_fence', 'epoch_fence'].includes(
          record.rejection?.reason ?? '',
        ) ||
        record.recoveryState !== from ||
        hasDisposition(await this.readFence(record.event), 'revoked', record.source)
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

  getBoundaryIntents(
    scope?: BoundaryScope,
    history = scope ? (this.view.get(scope) ?? []) : [],
  ): readonly BoundaryIntent[] {
    if (!scope) return this.boundaryIntents;
    const seen = new Set<string>();
    return [
      ...this.boundaryIntents,
      ...history
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

  private async readBoundaryIntents(scope?: BoundaryScope): Promise<readonly BoundaryIntent[]> {
    return this.getBoundaryIntents(scope, scope ? await this.readHistory(scope) : []);
  }

  lookupBoundaryIntents(scope: BoundaryScope): Promise<readonly BoundaryIntent[]> {
    return this.queue.run(() => this.readBoundaryIntents(scope));
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
    const delivery =
      scope?.matchId !== undefined
        ? {
            matchId: scope.matchId,
            producerInstanceId: scope.producerInstanceId,
            liveSessionId: scope.liveSessionId ?? '',
          }
        : undefined;
    return this.boundaryCaptureFailedFor(delivery) || this.hasStoredBoundaryGap(scope);
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
            reference:
              this.continuityReference ??
              this.currentEvents(this.records, this.boundaryIntents, undefined).at(-1),
          }),
        ),
      );
      const requestKey = `boundary-request:${operation.id}`;
      const capture = this.reserveCapture(requestKey, source);
      if (capture) operation = parseBoundaryCapture({ ...operation.request, capture });
      this.captureOrder.set(`boundary:${operation.id}`, this.captureOrder.get(requestKey)!);
      if (!this.pendingBoundaryCaptures.has(operation.id)) {
        if (
          this.exceedsPendingBudget(
            this.pendingBoundaryCaptures.size,
            durableJsonByteLength([...this.pendingBoundaryCaptures.values(), operation]),
          )
        )
          throw new Error('boundary_capture_capacity_exhausted');
        this.pendingBoundaryCaptures.set(operation.id, operation);
      }
    } catch (error) {
      // Attribute known-source capture losses to that source so independent matches keep working.
      if (source) this.markCaptureUnknown(source);
      else this.boundaryCaptureLost = true;
      return Promise.reject(error);
    }
    return this.queue.run(() => this.captureBoundaryOperation(operation));
  }

  private async captureBoundaryOperation(operation: BoundaryCaptureOperation): Promise<void> {
    const { request } = operation;
    const { events, intents, continuity, missing, scope, source } = request;
    const key = `boundary:${operation.id}`;
    const owner = boundaryOwner(request);
    let stage: BoundaryCaptureError['stage'] = 'journal';
    try {
      const commitCapture = async () => {
        // Only the operations sent in this batch are durable after the acknowledgement.
        const staged = [...this.pendingBoundaryCaptures.values()];
        if (
          this.boundaryCaptureLost ||
          staged.some(({ id }) => !this.durableBoundaryCaptures.has(id))
        ) {
          await this.repository().request(
            'stageBoundaryCaptures',
            staged,
            this.boundaryCaptureLost,
          );
          for (const { id } of staged) this.durableBoundaryCaptures.add(id);
        }
        if (this.boundaryCaptureLost) throw new Error('boundary_capture_input_lost');
        stage = 'verify';
        if (await this.repository().request('boundaryCaptureReceipt', operation)) {
          // A COMMIT response may have been lost. Read authoritative state, never overwrite it.
          await this.restoreSnapshot();
          return;
        }
        if (this.pendingBoundaryCaptures.keys().next().value !== operation.id)
          throw new Error('boundary_capture_waiting');
        this.activeBoundaryCapture = operation;
        stage = 'preflight';
        await this.archiveLegacyTerminals();
        const inputs = [...events, ...intents.map((intent) => intent.event)];
        const fences = await this.readFences([
          ...inputs.map((event) => ({ event })),
          ...this.records,
        ]);
        const history = await this.repository().request(
          'byKeys',
          inputs.map((event) => event.idempotencyKey),
        );
        for (const [index, event] of inputs.entries()) {
          if (source !== null) this.assertSourceOpen(event, fences(event), source);
          if (
            history[index]!.length ||
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
          !hasDisposition(fences(record.event), 'revoked', record.source) &&
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
        if (!(await this.repository().request('boundaryCaptureReceipt', operation)))
          throw new Error('boundary_capture_receipt_missing');
      };
      await this.durableOperation(key, commitCapture, undefined, owner);
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
      this.noteUnconfirmedWrite(key, owner);
      throw new BoundaryCaptureError(operation.id, stage, request, error);
    } finally {
      this.activeBoundaryCapture = undefined;
    }
  }

  retryPendingCaptures(drain = false, onlySource?: ExactSource): Promise<void> {
    if (!onlySource && this.orderedReplay) return this.orderedReplay;
    const targetKey = onlySource ? sourceKey(onlySource) : undefined;
    const replay = (async () => {
      await this.queue.flush();
      if (this.boundaryCaptureLost) {
        await this.queue.run(() => this.repository().request('stageBoundaryCaptures', [], true));
        throw new Error('boundary_capture_input_lost');
      }
      if (targetKey && this.isCaptureUnknown(targetKey))
        throw new Error('boundary_capture_input_lost');
      const matchesTarget = (source?: ExactSource | null) =>
        !targetKey || (Boolean(source) && sourceKey(source!) === targetKey);
      const pending = [
        ...[...this.pendingBoundaryCaptures.values()]
          .filter((operation) => matchesTarget(operation.request.source))
          .map((operation) => ({
            order: this.captureOrder.get(`boundary:${operation.id}`) ?? 0,
            scopeKey: scopeKeyTuple(boundaryOwner(operation.request)?.scope),
            retry: () => this.queue.run(() => this.captureBoundaryOperation(operation)),
          })),
        ...[...this.pendingEnqueues.entries()]
          .filter(([, value]) => matchesTarget(value.source))
          .map(([key, value]) => ({
            order: this.captureOrder.get(key) ?? 0,
            scopeKey: scopeKeyTuple(eventDeliveryScope(value.event)),
            retry: value.retry,
          })),
        ...(targetKey
          ? []
          : [...this.pendingContinuities.entries()].map(([key, value]) => ({
              order: this.captureOrder.get(key) ?? 0,
              scopeKey: scopeKeyTuple(value.scope),
              retry: value.retry,
            }))),
      ]
        .sort((a, b) => a.order - b.order)
        .slice(0, drain ? RELIABLE_OUTBOX_MAX_PENDING * 3 : 4);
      const failedScopes = new Set<string>();
      let firstError: unknown;
      for (const entry of pending) {
        if (failedScopes.has('__global__') || failedScopes.has(entry.scopeKey)) continue;
        try {
          await entry.retry();
        } catch (error) {
          failedScopes.add(entry.scopeKey);
          if (firstError === undefined) firstError = error;
        }
        await setImmediate();
      }
      if (firstError !== undefined) throw firstError;
    })();
    if (!onlySource) {
      this.orderedReplay = replay;
      void replay
        .finally(() => {
          if (this.orderedReplay === replay) this.orderedReplay = undefined;
        })
        .catch(() => undefined);
    }
    return replay;
  }

  expireBoundaryIntents(now = new Date()): Promise<void> {
    return this.queue.run(async () => {
      if (!this.boundaryIntents.length) return;
      const fence = await this.readFences(this.boundaryIntents);
      const intents = this.boundaryIntents.map((intent) =>
        !intent.expired &&
        !hasDisposition(fence(intent.event), 'revoked', intent.source) &&
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
        this.boundaryCaptureFailedFor({
          matchId: intent.event.matchId,
          producerInstanceId: intent.event.cursor.producerInstanceId,
          liveSessionId: intent.event.cursor.liveSessionId ?? '',
        }) ||
        this.boundaryGap ||
        intent.expired ||
        !this.boundaryIntents.includes(intent)
      )
        return false;
      const fence = await this.readFence(intent.event);
      if (hasDisposition(fence, 'revoked', intent.source)) return false;
      if (now.getTime() - Date.parse(intent.event.observedAt) >= RELIABLE_OUTBOX_RETENTION_MS) {
        return false;
      }
      const valid = parseReliableEventV1(event);
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
      if (!intent.awaitingSource) this.assertSourceOpen(valid, fence, intent.source);
      if (
        this.records.some((record) => record.event.idempotencyKey === valid.idempotencyKey) ||
        (await this.repository().request('byKeys', [valid.idempotencyKey]))[0]!.length
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
    if (!replaying && this.scheduledContinuity?.key === operationKey)
      return this.scheduledContinuity.task;
    if (
      !replaying &&
      !this.scheduledContinuity &&
      requested === this.requestedScope &&
      !this.unconfirmedWrites.has(operationKey) &&
      !this.pendingContinuities.has(operationKey)
    )
      return Promise.resolve();
    // Keep the original scope and checkpoint, including authority, before yielding.
    [checkpoint, scope] = structuredClone([checkpoint, scope]);
    const order = replaying ? this.captureOrder.get(operationKey)! : ++this.nextCaptureOrder;
    const task = this.queue.run(() => {
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
              (await this.readBoundaryIntents(scope)).length
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
                this.exceedsPendingBudget(
                  this.pendingContinuities.size,
                  [...this.pendingContinuities.values()].reduce(
                    (total, entry) => total + entry.bytes,
                    bytes,
                  ),
                )
              ) {
                this.boundaryCaptureLost = true;
                throw new Error('outbox_pending_continuity_capacity_exhausted', { cause: error });
              }
              this.captureOrder.set(operationKey, order);
              this.pendingContinuities.set(operationKey, {
                bytes,
                ...(scope ? { scope } : {}),
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
        scope ? { scope } : undefined,
      );
    });
    if (replaying) return task;
    const scheduled = {
      key: operationKey,
      task: task.finally(() => {
        if (this.scheduledContinuity === scheduled) this.scheduledContinuity = undefined;
      }),
    };
    this.scheduledContinuity = scheduled;
    return scheduled.task;
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
    checkStartHistory = false,
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
        .update(
          JSON.stringify([
            event,
            now,
            continuity,
            lineupSteam64,
            recoveryKey,
            scope,
            source,
            ...(checkStartHistory ? [true] : []),
          ]),
        )
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
    if (event.kind === 'map_ended') this.scheduledSupersession = undefined;
    const enqueueOwner: WriteOwner = {
      scope: eventDeliveryScope(event),
      ...(source ? { source } : {}),
    };
    const commitEnqueue = async () => {
      this.activeOrdinaryCapture = capture;
      try {
        if (capture && (await this.repository().request('captureReceipt', capture))) {
          await this.restoreSnapshot();
          this.unconfirmedWrites.delete(operationKey);
          return true;
        }
        if (capture) {
          const interval = this.view.intervals.get(capture.intervalId);
          if (!interval) throw new Error('capture_sequence_unconfirmed:commit:interval_missing');
          if (interval.committedSequence + 1 !== capture.sequence)
            throw new Error(
              `capture_sequence_unconfirmed:commit:expected_${interval.committedSequence + 1}:received_${capture.sequence}`,
            );
        }
        // Retain legitimate one-shot results while their preceding boundary is unconfirmed.
        // Do not classify a transient write failure as a missing historical fact.
        if (
          !capture &&
          this.boundaryCaptureFailedFor({
            matchId: event.matchId,
            producerInstanceId: event.cursor.producerInstanceId,
            liveSessionId: event.cursor.liveSessionId ?? '',
          })
        ) {
          this.noteUnconfirmedWrite(operationKey, enqueueOwner);
          throw new Error('boundary_capture_pending');
        }
        // Preserve original accepted work before committing unrelated later events.
        if (!replaying && this.pendingEnqueues.size) {
          this.noteUnconfirmedWrite(operationKey, enqueueOwner);
          throw new Error('outbox_preceding_write_unconfirmed');
        }
        await this.archiveLegacyTerminals();
        const valid = parseReliableEventV1(event);
        if (source) source = parseSource(source);
        if (source !== null)
          this.assertSourceOpen(valid, await this.readFence(valid), source, replaying);
        const duplicates = [
          ...this.records.filter((record) => record.event.idempotencyKey === valid.idempotencyKey),
          ...(await this.repository().request('byKeys', [valid.idempotencyKey]))[0]!.map(
            (item) => item.value,
          ),
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
            await this.commitCaptureOnly(capture);
            return true;
          }
          if (capture) await this.commitCaptureOnly(capture);
          return false;
        }
        const isEndResult = ['map_ended', 'map_player_snapshot', 'series_ended'].includes(
          valid.kind,
        );
        const history =
          checkStartHistory || isEndResult || recoveryKey !== undefined
            ? await this.readHistory(deliveryScope(valid))
            : undefined;
        const boundaryIntents =
          checkStartHistory || isEndResult ? await this.readBoundaryIntents(scope) : undefined;
        const scopeGap = capture ? this.hasStoredBoundaryGap(scope) : this.hasBoundaryGap(scope);
        if (checkStartHistory) {
          const refusals = this.startRejections(valid, history);
          if (
            scopeGap ||
            boundaryIntents!.length ||
            this.hasUnconfirmedBoundary(valid, history) ||
            (refusals.length > 0 &&
              (refusals.length !== 1 ||
                refusals[0]?.event.idempotencyKey !== recoveryKey ||
                refusals[0]?.recoveryState !== 'awaiting_observation'))
          ) {
            if (capture) await this.commitCaptureOnly(capture);
            return false;
          }
        }
        if (
          this.records.filter((record) => record.status === 'pending').length +
            this.boundaryIntents.length >=
          RELIABLE_OUTBOX_MAX_PENDING
        )
          throw new Error('reliable_outbox_full');
        const at = now.toISOString();
        const unsafeResult =
          isEndResult &&
          (scopeGap ||
            boundaryIntents!.some((intent) => dependsOnBoundary(valid, intent.event)) ||
            [
              ...this.records,
              ...history!.filter((item) => item.kind === 'record').map((item) => item.value),
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
          const rejected = this.startRejections(valid, history);
          if (
            valid.kind !== 'map_started' ||
            rejected.length !== 1 ||
            rejected[0] === undefined ||
            hasDisposition(
              await this.readFence(rejected[0].event),
              'revoked',
              rejected[0].source,
            ) ||
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
          keepCheckpoint ||
            this.hasBoundaryGap(scope) ||
            (await this.readBoundaryIntents(scope)).length
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
    };
    return this.runDurable(operationKey, commitEnqueue, undefined, enqueueOwner).then(
      (result) => {
        this.pendingEnqueues.delete(operationKey);
        this.captureTickets.delete(operationKey);
        this.captureOrder.delete(operationKey);
        return result;
      },
      (error: unknown) => {
        if (
          error instanceof Error &&
          (error.message === 'outbox_source_revoked' || error.message === 'outbox_source_closed')
        ) {
          this.unconfirmedWrites.delete(operationKey);
          this.pendingEnqueues.delete(operationKey);
          this.captureTickets.delete(operationKey);
          this.captureOrder.delete(operationKey);
          if (capture && source) this.markCaptureUnknown(source);
          throw error;
        }
        if (capture) this.noteUnconfirmedWrite(operationKey, enqueueOwner);
        if (this.unconfirmedWrites.has(operationKey)) {
          const bytes = durableJsonByteLength(retryArgs);
          if (
            !this.pendingEnqueues.has(operationKey) &&
            this.exceedsPendingBudget(
              this.pendingEnqueues.size,
              [...this.pendingEnqueues.values()].reduce((total, item) => total + item.bytes, bytes),
            )
          ) {
            if (source) this.markCaptureUnknown(source);
            else this.boundaryCaptureLost = true;
            throw new Error('outbox_pending_enqueue_capacity_exhausted', { cause: error });
          }
          this.pendingEnqueues.set(operationKey, {
            event: retryArgs[0],
            bytes,
            ...(retryArgs[6] === undefined ? {} : { source: retryArgs[6] }),
            retry: () => this.enqueue(...retryArgs, true, checkStartHistory),
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
      matchesScopeTuple(eventDeliveryScope(a.event), eventDeliveryScope(b.event)) &&
      (!a.source || !b.source || sourceKey(a.source) === sourceKey(b.source))
    );
  }

  hasUnconfirmedWrites(scope?: ReliableDeliveryScope, source?: ExactSource): boolean {
    if (this.database?.failed === true || this.boundaryCaptureLost) return true;
    const effectiveScope = scope ?? source;
    if (!effectiveScope && !source) {
      return (
        this.unconfirmedWrites.size > 0 ||
        this.pendingBoundaryCaptures.size > 0 ||
        this.pendingEnqueues.size > 0 ||
        this.pendingContinuities.size > 0
      );
    }
    if (source) {
      const key = sourceKey(source);
      if (this.unknownCaptures.has(key) && !this.view.unknown.has(key)) return true;
    }
    for (const owner of this.unconfirmedWrites.values()) {
      if (
        !owner ||
        ((!source || !owner.source || sourceKey(owner.source) === sourceKey(source)) &&
          (!effectiveScope || !owner.scope || matchesScopeTuple(owner.scope, effectiveScope)))
      )
        return true;
    }
    if (!effectiveScope) return false;
    return (
      this.hasPendingBoundaryCaptures(effectiveScope) ||
      this.hasPendingEnqueues(effectiveScope, source) ||
      [...this.pendingContinuities.values()].some(
        (entry) => !entry.scope || matchesScopeTuple(entry.scope, effectiveScope),
      )
    );
  }

  private operationMatchesScope(
    request: BoundaryCaptureOperation['request'],
    scope?: DeliveryScopeTuple,
  ): boolean {
    if (!scope || !request.scope) return true;
    return (
      matchesScopeTuple(request.scope, scope) ||
      [...request.events, ...request.intents.map((intent) => intent.event)].some((event) =>
        matchesScopeTuple(eventDeliveryScope(event), scope),
      )
    );
  }

  /** Captures are registered synchronously before their journal operation is queued. */
  hasPendingBoundaryCaptures(scope: DeliveryScopeTuple): boolean {
    return [...this.pendingBoundaryCaptures.values()].some(({ request }) =>
      this.operationMatchesScope(request, scope),
    );
  }

  hasPendingEnqueues(scope: DeliveryScopeTuple, source?: ExactSource): boolean {
    return [...this.pendingEnqueues.values()].some(
      ({ event, source: pendingSource }) =>
        (!source || !pendingSource || sourceKey(source) === sourceKey(pendingSource)) &&
        matchesScopeTuple(eventDeliveryScope(event), scope),
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
        if (this.boundaryCaptureLost) throw new Error('boundary_capture_blocked');
        const now = input.now ?? new Date();
        const pending = this.records.filter((record) => record.status === 'pending');
        if (!pending.length) return;
        const fence = await this.readFences(pending);
        if (this.boundaryCaptureLost) throw new Error('boundary_capture_blocked');
        const retained = [...this.records, ...this.historyRecords];
        let changed = false;
        const unconfirmedBoundaries = retained.filter(
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
        const deferRecord = (record: ReliableOutboxRecord) => {
          if (isContinuityBoundary(record.event)) blockedBoundaries.push(record.event);
          next.push(record);
        };
        const blockedBoundaries = retained
          .filter((record) => isContinuityBoundary(record.event) && isBoundaryFenceRecord(record))
          .map((record) => record.event);
        blockedBoundaries.push(
          ...responseBoundaries,
          ...this.revokedRecords
            .filter((record) => record.status === 'pending' && isContinuityBoundary(record.event))
            .map((record) => record.event),
        );
        for (const record of this.records) {
          if (record.status !== 'pending') {
            next.push(record);
            continue;
          }
          const recordFence = fence(record.event);
          if (
            this.boundaryCaptureFailedFor(eventDeliveryScope(record.event)) ||
            [...this.pendingEnqueues.values()].some(
              (pending) =>
                pending.event.kind !== 'map_player_snapshot' &&
                this.sameDeliveryScope(pending, record) &&
                pending.event.cursor.runtimeSeq <= record.event.cursor.runtimeSeq,
            ) ||
            hasDisposition(recordFence, 'revoked', record.source) ||
            this.isRevokingEvent(record.event, record.source) ||
            recordFence.damaged
          ) {
            deferRecord(record);
            continue;
          }
          // A refused start never authorizes replay of a result that was already
          // queued for that execution. Preserve the refusal and retire the result.
          if (
            ['map_ended', 'map_player_snapshot', 'series_ended'].includes(record.event.kind) &&
            rejectedStarts.some(
              (start) =>
                sameStartExecution(record.event, start) &&
                record.event.cursor.runtimeSeq >= start.cursor.runtimeSeq &&
                ![...next, ...retained].some(
                  (proof) =>
                    proof.status === 'accepted' &&
                    proof.receiverOutcome !== 'needs_attention' &&
                    proof.event.kind === 'map_started' &&
                    sameStartExecution(proof.event, start) &&
                    proof.event.cursor.runtimeSeq > start.cursor.runtimeSeq &&
                    proof.event.cursor.runtimeSeq < record.event.cursor.runtimeSeq,
                ),
            )
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
            deferRecord(record);
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
            const parent = [...next, ...retained].find(
              (r) => r.event.idempotencyKey === mapEndedKey,
            );
            if (!parent || isBoundaryFenceRecord(parent)) {
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
          const guardBlocked =
            input.canSend !== undefined && !input.canSend(record.event, record.lineupSteam64);
          if (guardBlocked || Date.parse(record.nextAttemptAt) > now.getTime()) {
            if (guardBlocked) this.evidence(record, 'send_guard_blocked');
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
          hasDisposition(await this.readFence(current.event), 'revoked', current.source) ||
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
    for (const key of this.unconfirmedWrites.keys()) {
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
        for (const record of changed)
          this.noteUnconfirmedWrite(this.statusWriteKey(record), {
            scope: eventDeliveryScope(record.event),
            ...(record.source ? { source: record.source } : {}),
          });
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
      const pending = this.records.filter((record) => record.status === 'pending');
      if (!pending.length) return;
      const fence = await this.readFences(pending);
      const next = this.records.map((record): ReliableOutboxRecord => {
        if (
          record.status !== 'pending' ||
          hasDisposition(fence(record.event), 'revoked', record.source)
        )
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

  supersedeWhere(
    evidence: string,
    selected: (event: ReliableEventV1) => boolean,
    now = new Date(),
  ): Promise<void> {
    if (this.scheduledSupersession?.evidence === evidence) return this.scheduledSupersession.task;
    const task = this.queue.run(async () => {
      const candidates = new Set(
        this.records.filter((record) => record.status === 'pending' && selected(record.event)),
      );
      if (!candidates.size) return;
      const fence = await this.readFences([...candidates]);
      const records = this.records.map((record) =>
        candidates.has(record) && !hasDisposition(fence(record.event), 'revoked', record.source)
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
    const scheduled = {
      evidence,
      task: task.finally(() => {
        if (this.scheduledSupersession === scheduled) this.scheduledSupersession = undefined;
      }),
    };
    this.scheduledSupersession = scheduled;
    return scheduled.task;
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
      try {
        await this.database?.close();
      } finally {
        this.database = undefined;
      }
    }
  }

  private trim(records: readonly ReliableOutboxRecord[]): readonly ReliableOutboxRecord[] {
    const pending = records.filter((record) => record.status === 'pending');
    // A failed boundary is a durable fence, even after ordinary receipt history
    // rotates. At capacity, reject new work rather than forget the missing ACK.
    const fences = records.filter(
      (record) =>
        (isContinuityBoundary(record.event) && isBoundaryFenceRecord(record)) ||
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
      (this.boundaryCaptureLost ||
        [...this.pendingBoundaryCaptures.entries()].some(
          ([id, op]) => !op.request.scope && this.unconfirmedWrites.has(`boundary:${id}`),
        )) &&
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
          (await this.repository().request('latestEvent')));
    const file: OutboxFile = {
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
    };
    const plan = this.view.plan(
      this.currentEvents(records, boundaryIntents, continuityReference),
      history.length > 0,
    );
    const context = this.durabilityContext;
    const owner = context ? this.durabilityOwner : undefined;
    let result;
    try {
      result = await this.repository().request(
        'commit',
        {
          active: file,
          history,
          ...(boundaryCapture ? { boundaryCapture } : {}),
          ...(capture ? { capture } : {}),
        },
        plan.scopes,
        context === undefined,
      );
    } catch (error) {
      this.noteUnconfirmedWrite(context ?? 'outbox_worker_write_unconfirmed', owner);
      throw error;
    }
    const failureKey = context ?? result.key;
    if (!result.ok) {
      this.noteUnconfirmedWrite(failureKey ?? 'outbox_worker_write_unconfirmed', owner);
      throw result.error;
    }
    this.successfulDurableWrites++;
    if (!context && failureKey) this.unconfirmedWrites.delete(failureKey);
    this.preparationTiming.count++;
    this.preparationTiming.totalMs += result.preparationMs;
    this.preparationTiming.activeSnapshotBytes += result.activeBytes;
    this.preparationTiming.maxMs = Math.max(this.preparationTiming.maxMs, result.preparationMs);
    plan.apply(result.history);
    if (result.revoked) this.revokedSummary = result.revoked;
    if (result.interval) this.view.setInterval(result.interval);
    for (const entry of history) {
      if (entry.disposition === 'archived' && entry.source)
        this.view.archived.add(sourceKey(entry.source));
    }
    const previous = this.records;
    this.records = records;
    this.boundaryIntents = boundaryIntents;
    this.boundaryGap = boundaryGap;
    this.boundaryGaps = boundaryGaps;
    this.boundaryOverflowOwners = boundaryOverflowOwners;
    this.continuity = continuity;
    this.continuityReference = continuityReference;
    this.publishRecords();
    this.refreshObservation();
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
