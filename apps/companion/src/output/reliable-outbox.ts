import { createHash, randomUUID } from 'node:crypto';
import { parseReliableEventV1, type ReliableEventV1 } from '@mizar/protocol/output';
import type { ExactSource } from '../match-context/rivalhub-source-state.js';
import { durableJsonByteLength } from '../match-context/durable-json.js';
import { SerialCommitQueue } from '../match-context/serial-commit.js';
import { OutboxRepository, type OutboxHistory } from './outbox-repository.js';
export * from './outbox-codec.js';
import {
  RELIABLE_OUTBOX_VERSION,
  RELIABLE_OUTBOX_MAX_PENDING,
  RELIABLE_OUTBOX_MAX_RECORDS,
  RELIABLE_OUTBOX_RETENTION_MS,
  RELIABLE_SEND_TIMEOUT_MS,
  type ReliableDeliveryResult,
  type ReliableDeliveryStatus,
  isContinuityBoundary,
  dependsOnBoundary,
  type ReliableEventSink,
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
  private sourceHistory(kind: 'archived' | 'revoked') {
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
      .filter((item) => item.disposition === kind)
      .map((item) => {
        const history = this.repository()
          .bySource(item.source)
          .filter((row) => row.disposition === kind);
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
  private get archivedSources() {
    return this.sourceHistory('archived');
  }
  private get revokedSources() {
    return this.sourceHistory('revoked');
  }
  private boundaryIntents: readonly BoundaryIntent[] = [];
  private boundaryGap: true | undefined;
  private boundaryGaps: readonly BoundaryScope[] = [];
  private boundaryOverflowOwners: readonly string[] = [];
  private boundaryCaptureFailed = false;
  private readonly queue = new SerialCommitQueue();
  private readonly unconfirmedWrites = new Set<string>();
  private durabilityContext: string | undefined;
  private readonly continuityFailures = new Map<string, number>();
  private successfulDurableWrites = 0;
  private pendingReplay: Promise<void> | undefined;
  private readonly pendingEnqueues = new Map<
    string,
    { event: ReliableEventV1; retry: () => Promise<boolean> }
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

  getScopeDisposition(scope: ReliableDeliveryScope): ReliableScopeDisposition {
    const history = this.repository().forDelivery(scope);
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
    const sources = new Map<string, ExactSource>();
    for (const item of [...this.records, ...this.boundaryIntents]) {
      if (item.source) sources.set(sourceKey(item.source), item.source);
    }
    return [...sources.values()];
  }

  /** Exact closure moves records and its fence in the same transaction. */
  async archiveConfirmedSource(input: ExactSource): Promise<void> {
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
  private isRevokedEvent(event: ReliableEventV1, source?: ExactSource): boolean {
    return this.sourceHas('revoked', event, source);
  }
  private assertSourceOpen(event: ReliableEventV1, source?: ExactSource): void {
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
    if (this.isRevokedEvent(event, source)) throw new Error('outbox_source_revoked');
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

  hasBoundaryGap(scope?: BoundaryScope): boolean {
    return (
      this.boundaryCaptureFailed ||
      this.boundaryGap === true ||
      (scope
        ? scope.ownerFingerprint
          ? this.boundaryOverflowOwners.includes(scope.ownerFingerprint)
          : this.boundaryOverflowOwners.length > 0
        : this.boundaryOverflowOwners.length > 0) ||
      (scope
        ? this.boundaryGaps.some(
            (gap) =>
              (!gap.matchId || !scope.matchId || gap.matchId === scope.matchId) &&
              gap.producerInstanceId === scope.producerInstanceId &&
              (!gap.liveSessionId ||
                !scope.liveSessionId ||
                gap.liveSessionId === scope.liveSessionId) &&
              (!gap.ownerFingerprint ||
                !scope.ownerFingerprint ||
                gap.ownerFingerprint === scope.ownerFingerprint) &&
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
                gap.authorityFingerprint === scope.authorityFingerprint),
          )
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
      this.boundaryGaps.some(
        (gap) =>
          gap.overflow &&
          gap.producerInstanceId === scope.producerInstanceId &&
          (!gap.ownerFingerprint ||
            !scope.ownerFingerprint ||
            gap.ownerFingerprint === scope.ownerFingerprint) &&
          (!gap.matchId || !scope.matchId || gap.matchId === scope.matchId) &&
          (!gap.liveSessionId || !scope.liveSessionId || gap.liveSessionId === scope.liveSessionId),
      ),
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
    return this.queue.run(async () => {
      await this.archiveLegacyTerminals();
      if (source) source = parseSource(source);
      for (const event of [...events, ...intents.map((intent) => intent.event)]) {
        if (source !== null) this.assertSourceOpen(event, source);
        if (this.repository().byKey(event.idempotencyKey).length)
          throw new Error('boundary_duplicate');
      }
      try {
        if (this.boundaryCaptureFailed) throw new Error('boundary_capture_blocked');
        const at = now.toISOString();
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
                  ? [{ ...scope, overflow: true as const }]
                  : [scope]),
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
        const frozen = gap || this.hasBoundaryGap(scope);
        await this.commit(
          overflow || records.length > RELIABLE_OUTBOX_MAX_RECORDS ? this.records : records,
          frozen ? this.continuity : continuity,
          overflow ? this.boundaryIntents : allIntents,
          this.boundaryGap,
          gaps,
          overflowOwners,
        );
      } catch (error) {
        this.boundaryCaptureFailed = true;
        throw error;
      }
    });
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

  updateContinuity(checkpoint: DeliveryContinuity, scope?: BoundaryScope): Promise<void> {
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
    return this.runDurable(
      operationKey,
      async () => {
        if (requested === this.requestedScope && !this.unconfirmedWrites.has(operationKey)) return;
        if (
          this.records.length > 0 &&
          !this.hasBoundaryGap(scope) &&
          !this.getBoundaryIntents(scope).length
        ) {
          await this.commit(this.records, checkpoint);
          this.requestedScope = requested;
        }
      },
      cursor.runtimeSeq,
    );
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
    event = parseReliableEventV1(event);
    const operationKey = `enqueue:${createHash('sha256')
      .update(JSON.stringify([event, lineupSteam64, recoveryKey, source]))
      .digest('hex')}`;
    const retryArgs = structuredClone([
      event,
      now,
      continuity,
      lineupSteam64,
      recoveryKey,
      scope,
      source,
    ] as const);
    if (!replaying && this.pendingEnqueues.size) await this.retryPendingEnqueues();
    return this.runDurable(operationKey, async () => {
      // Preserve original accepted work before committing unrelated later events.
      if (!replaying && this.pendingEnqueues.size) {
        this.noteUnconfirmedWrite(operationKey);
        throw new Error('outbox_preceding_write_unconfirmed');
      }
      await this.archiveLegacyTerminals();
      const valid = parseReliableEventV1(event);
      if (source) source = parseSource(source);
      if (source !== null) this.assertSourceOpen(valid, source);
      if (
        this.records.some((record) => record.event.idempotencyKey === valid.idempotencyKey) ||
        this.repository().byKey(valid.idempotencyKey).length
      ) {
        if (this.unconfirmedWrites.has(operationKey)) {
          await this.commit(this.records, this.continuity);
          return true;
        }
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
        (this.hasBoundaryGap(scope) ||
          this.getBoundaryIntents(scope).some((intent) => dependsOnBoundary(valid, intent.event)) ||
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
      const records = this.trim([...existing, next]);
      if (records.length > RELIABLE_OUTBOX_MAX_RECORDS) throw new Error('reliable_outbox_full');
      await this.commit(
        records,
        this.hasBoundaryGap(scope) || this.getBoundaryIntents(scope).length
          ? this.continuity
          : (continuity ?? {
              matchId: valid.matchId,
              contextRevision: valid.contextRevision,
              cursor: valid.cursor,
              mapName: valid.mapName,
              savedAt: at,
            }),
      );
      return true;
    }).then(
      (result) => {
        this.pendingEnqueues.delete(operationKey);
        return result;
      },
      (error: unknown) => {
        if (this.unconfirmedWrites.has(operationKey))
          this.pendingEnqueues.set(operationKey, {
            event: retryArgs[0],
            retry: () => this.enqueue(...retryArgs, true),
          });
        throw error;
      },
    );
  }

  hasPendingEnqueues(scope: ReliableDeliveryScope): boolean {
    return [...this.pendingEnqueues.values()].some(
      ({ event }) =>
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
    if (this.pendingReplay) return this.pendingReplay;
    const replay = (async () => {
      for (const pending of [...this.pendingEnqueues.values()]) {
        try {
          await pending.retry();
        } catch {
          break;
        } // Keep every original request; retry storage later, not a newer replacement.
      }
    })();
    this.pendingReplay = replay;
    try {
      await replay;
    } finally {
      if (this.pendingReplay === replay) this.pendingReplay = undefined;
    }
  }

  async flush(input: {
    readonly sink: ReliableEventSink;
    readonly isCurrent: (event: ReliableEventV1, lineupSteam64?: readonly string[]) => boolean;
    readonly canSend?: (event: ReliableEventV1, lineupSteam64?: readonly string[]) => boolean;
    readonly now?: Date;
  }): Promise<readonly string[]> {
    return this.queue.run(async () => {
      if (this.boundaryCaptureFailed) throw new Error('boundary_capture_blocked');
      const now = input.now ?? new Date();
      let changed = false;
      const invalidatedStarts: string[] = [];
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
      const blockedByMapEnd = new Set<string>();
      const deliveryScope = (event: ReliableEventV1) =>
        JSON.stringify([
          event.matchId,
          event.cursor.producerInstanceId,
          event.cursor.liveSessionId,
        ]);
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
        if (this.isRevokedEvent(record.event, record.source)) {
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
          next.push({ ...record, status: 'superseded', updatedAt: now.toISOString() });
          changed = true;
          continue;
        }
        // A start observed before a boundary ACK is not a post-ACK proof,
        // including starts left in a queue written by an older version.
        if (
          record.event.kind === 'map_started' &&
          unconfirmedBoundaries.some((boundary) => dependsOnBoundary(record.event, boundary.event))
        ) {
          invalidatedStarts.push(record.event.idempotencyKey);
          next.push({ ...record, status: 'superseded', updatedAt: now.toISOString() });
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
            next.push({ ...record, status: 'superseded', updatedAt: now.toISOString() });
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
        let outcome: ReliableDeliveryResult;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();
        try {
          outcome = await Promise.race([
            input.sink.send(record.event, controller.signal, record.lineupSteam64, record.source),
            new Promise<'retry'>((resolve) => {
              timeout = setTimeout(() => {
                controller.abort(new DOMException('Reliable delivery timed out', 'TimeoutError'));
                resolve('retry');
              }, RELIABLE_SEND_TIMEOUT_MS);
              timeout.unref();
            }),
          ]);
        } catch {
          outcome = 'retry';
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
        }
        const accepted =
          outcome === 'accepted' || (typeof outcome === 'object' && outcome.status === 'accepted');
        if (
          (!accepted || (typeof outcome === 'object' && outcome.status === 'accepted')) &&
          isContinuityBoundary(record.event)
        )
          blockedBoundaries.push(record.event);
        else if (
          (outcome === 'retry' ||
            (typeof outcome === 'object' &&
              outcome.status === 'rejected' &&
              ['generation_fence', 'epoch_fence'].includes(outcome.reason))) &&
          ['map_ended', 'map_started'].includes(record.event.kind)
        )
          blockedByMapEnd.add(deliveryScope(record.event));
        if (!accepted && outcome !== 'retry' && record.event.kind === 'map_started')
          rejectedStarts.push(record.event);
        const attempts = record.attempts + 1;
        const delayMs = Math.min(60_000, 1_000 * 2 ** Math.min(attempts - 1, 6));
        next.push({
          ...record,
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
        });
        changed = true;
      }
      if (changed) {
        const changedRecords = next.filter((record, index) => record !== this.records[index]);
        await this.commitStatusChanges(changedRecords, this.trim(next));
      }
      return invalidatedStarts;
    });
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
    const batch = `status-batch:${randomUUID()}`;
    const previous = this.durabilityContext;
    this.durabilityContext = batch;
    try {
      await this.commit(records);
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
          ? { ...record, status: 'superseded' as const, updatedAt: now.toISOString() }
          : record,
      );
      const changed = records.filter((record, index) => record !== this.records[index]);
      if (changed.length) await this.commitStatusChanges(changed, records);
    });
  }

  async flushPending(): Promise<void> {
    await this.queue.flush();
  }

  async flushForShutdown(): Promise<void> {
    await this.queue.flush();
    await this.retryPendingEnqueues();
    if (this.unconfirmedWrites.size || this.boundaryCaptureFailed || this.pendingEnqueues.size)
      throw new Error('outbox_durable_write_unconfirmed');
  }

  async close(): Promise<void> {
    try {
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
  ): Promise<void> {
    if (this.boundaryCaptureFailed) throw new Error('boundary_capture_blocked');
    const continuityReference =
      records.at(-1)?.event ??
      boundaryIntents.at(-1)?.event ??
      this.continuityReference ??
      this.repository().latestEvent();
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
    await this.trackDurability(`snapshot:${key}`, async () =>
      this.repository().commit({ active: file, history }),
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
          superseded: record.dispositionReason ?? 'current_scope_failed',
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
