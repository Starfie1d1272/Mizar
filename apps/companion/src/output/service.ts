import { createHash, randomUUID } from 'node:crypto';
import { BoundaryCaptureError } from './boundary-capture.js';
import type { RuntimeReduceResult } from '@mizar/core/runtime';
import type { ProgramCommitResult } from '../runtime/program-runtime.js';
import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';

import type { MatchContextBinding } from '../match-context/index.js';
import type { ExactSource } from '../match-context/rivalhub-source-state.js';
import { manifestPlanFingerprint } from '../match-context/manifest-plan.js';
import { hasLineupMismatchOnly } from './lineup-mismatch.js';
import type { ProjectionBundle } from '../projections/projection-coordinator.js';
import { createLatestWinsConsumer, type LatestWinsConsumer } from '../runtime/latest-wins.js';
import { sameMapExecution, sameMatchIdentity, sameSourceSession } from '../scope/identities.js';
import {
  ReliableOutbox,
  type DeliveryContinuity,
  type ReliableEventSink,
  type ReliableDeliveryScope,
  type BoundaryIntent,
  type BoundaryScope,
  parseSource,
} from './reliable-outbox.js';
import {
  buildReliableEventV1,
  materializeBoundaryEvent,
  buildMapPlayerSnapshotV1,
  projectLiveSnapshotV1,
  liveSnapshotBlockedReason,
  type LiveSnapshotBlockedReason,
  transitionReliableEventsV1,
} from './projector.js';

export interface LiveSnapshotStatus {
  readonly localPersistencePending?: true;
  readonly snapshot: LiveSnapshotV1 | null;
  readonly blockedReason:
    | LiveSnapshotBlockedReason
    | 'projection_unavailable'
    | 'output_unavailable'
    | 'output_quarantined'
    | 'output_persistence_pending'
    | 'snapshot_projection_failed'
    | null;
}

export interface LiveSnapshotConsumer {
  send(snapshot: LiveSnapshotV1): Promise<void>;
}

export interface OutputServiceOptions {
  readonly outbox?: ReliableOutbox;
  readonly sink?: ReliableEventSink;
  readonly restoreContinuity?: (continuity: DeliveryContinuity) => ProjectionBundle | undefined;
  readonly liveSink?: LiveSnapshotConsumer;
  readonly now?: () => Date;
  readonly authorityScope?: () => string | null;
  readonly exactSource?: () => ExactSource | undefined;
  readonly isActiveOnlineBinding?: (binding: MatchContextBinding) => boolean;
  readonly isExecutionOwnedBy?: (binding: MatchContextBinding) => boolean;
  readonly managedSourceId?: () => string | undefined;
  readonly onDiagnostic?: (code: string) => void;
  readonly onOutboxLoadError?: (error: unknown) => void;
  readonly onBoundaryCaptureError?: (
    error: unknown,
    evidence: {
      stage: string;
      operationId?: string;
      cursor?: ReliableEventV1['cursor'] | undefined;
    },
  ) => void;
  readonly onBusinessEvidence?: (stage: string, evidence: unknown) => void;
  readonly onRecoveryProgress?: (
    event: ReliableEventV1,
    state: 'continuity_chain_missing' | 'continuity_waiting' | 'context_reconfirming',
  ) => void;
}

/** Immutable projection evidence held only across the corresponding runtime mutation. */
export interface OutputMutationContext {
  readonly bundle: ProjectionBundle;
  readonly binding: MatchContextBinding | undefined;
  readonly source: ExactSource | null | undefined;
  readonly authority: string | undefined;
}

/** One public-safe output boundary for local consumers and later outbound adapters. */
export class OutputService {
  private readonly consumers = new Map<LatestWinsConsumer<LiveSnapshotV1>, boolean>();
  private readonly outbox: ReliableOutbox | undefined;
  private readonly sink: ReliableEventSink | undefined;
  private readonly now: () => Date;
  private readonly onDiagnostic: ((code: string) => void) | undefined;
  private bundle: ProjectionBundle | undefined;
  private priorForMutation: ProjectionBundle | undefined;
  private boundaryContext: OutputMutationContext | undefined;
  private priorBoundaryContext: OutputMutationContext | undefined;
  private binding: MatchContextBinding | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private readonly retiringScopes = new Set<string>();
  private trialQuarantined = false;
  private faultQuarantined = false;
  private get quarantined(): boolean {
    const recovery = this.outbox?.getBoundaryCaptureRecovery();
    return (
      this.trialQuarantined || this.faultQuarantined || Boolean(recovery?.pending || recovery?.lost)
    );
  }
  private outboxUnavailable = false;
  async setQuarantined(value: boolean): Promise<void> {
    this.trialQuarantined = value;
    if (value) await this.outbox?.flushPending();
  }
  private mapStartScope: string | undefined;
  private mapStartRevision = 0;
  private publishedMapStart: { revision: number; key: string } | undefined;
  private pendingMapStart: { revision: number; key: string; recovery?: string } | undefined;
  private lastMapObservation: ReliableEventV1['cursor'] | undefined;
  private recoveredCursor: ReliableEventV1['cursor'] | undefined;
  private readonly boundaryEnqueues = new Set<ReliableEventV1>();
  private readonly boundaryOwner = randomUUID();
  private readonly boundaryCommits = new Map<string, number>();
  private boundaryScope(
    matchId: string | undefined,
    cursor: ReliableEventV1['cursor'] | undefined,
  ): BoundaryScope | undefined {
    if (!cursor) return undefined;
    const authorityFingerprint =
      this.boundaryAuthority() ??
      createHash('sha256')
        .update(JSON.stringify([this.boundaryOwner, null]))
        .digest('hex');
    return {
      ...(matchId ? { matchId } : {}),
      producerInstanceId: cursor.producerInstanceId,
      ...(cursor.liveSessionId ? { liveSessionId: cursor.liveSessionId } : {}),
      ownerFingerprint: createHash('sha256').update(this.boundaryOwner).digest('hex'),
      runtimeSeq: cursor.runtimeSeq,
      programSourceGeneration: cursor.programSourceGeneration,
      mapEpoch: cursor.mapEpoch,
      authorityFingerprint,
    };
  }
  private boundaryScopeKey(scope: BoundaryScope | undefined): string {
    return scope
      ? JSON.stringify([
          scope.matchId,
          scope.ownerFingerprint,
          scope.producerInstanceId,
          scope.liveSessionId,
          scope.authorityFingerprint,
        ])
      : '*';
  }
  private boundaryCommitIsPending(scope: BoundaryScope | undefined): boolean {
    return (
      this.boundaryCommits.has('*') ||
      (scope
        ? this.boundaryCommits.has(this.boundaryScopeKey(scope))
        : this.boundaryCommits.size > 0)
    );
  }

  private boundaryAuthority(): string | undefined {
    const scope = this.options.authorityScope?.();
    return scope
      ? createHash('sha256')
          .update(JSON.stringify([this.boundaryOwner, scope]))
          .digest('hex')
      : undefined;
  }

  private sourceFor(
    matchId: string | undefined,
    cursor: ReliableEventV1['cursor'],
  ): ExactSource | null | undefined {
    if (!this.options.exactSource) return undefined;
    const source = this.options.exactSource?.();
    return source && source.matchId === matchId && sameSourceSession(source, cursor)
      ? source
      : null;
  }

  private async materializeIntents(): Promise<void> {
    const binding = this.binding;
    const bundle = this.bundle;
    const authority = this.boundaryAuthority();
    if (
      !this.outbox ||
      !binding ||
      binding.origin !== 'online' ||
      binding.freshness !== 'fresh' ||
      !bundle ||
      bundle.program.status.context !== 'fresh' ||
      bundle.program.series?.status === 'completed' ||
      !authority ||
      !this.options.isActiveOnlineBinding?.(binding)
    )
      return;
    const scope = this.boundaryScope(binding.context.matchId, bundle.program.cursor);
    if (!scope || this.outbox.hasBoundaryGap(scope)) return;
    for (const intent of this.outbox.getBoundaryIntents(scope)) {
      const c = bundle.program.cursor;
      const e = intent.event.cursor;
      if (
        intent.expired ||
        intent.authorityFingerprint !== authority ||
        intent.planFingerprint !== manifestPlanFingerprint(binding.manifest) ||
        !sameMatchIdentity(binding.context, intent.event) ||
        binding.context.competition?.competitionId !== intent.event.competitionId ||
        binding.context.entrants.a.entryId !== intent.event.entryAId ||
        binding.context.entrants.b.entryId !== intent.event.entryBId ||
        !sameSourceSession(c, e) ||
        c.programSourceGeneration !== e.programSourceGeneration ||
        c.mapEpoch < e.mapEpoch
      )
        return;
      await this.outbox.materializeBoundary(
        intent,
        materializeBoundaryEvent(intent.event, binding.manifest.revision),
        this.now(),
      );
    }
  }

  private contextRecoveryHandler:
    ((event: ReliableEventV1, authority: string) => Promise<boolean>) | undefined;
  private waitingFence: { key: string; boundaryKey: string; scope: string } | undefined;
  private approvedRecovery: { key: string; scope: string; afterRuntimeSeq: number } | undefined;

  setContextRecoveryHandler(
    handler: (event: ReliableEventV1, authority: string) => Promise<boolean>,
  ): void {
    this.contextRecoveryHandler = handler;
  }

  private recoveryScope(event: ReliableEventV1, lineup?: readonly string[]): string | undefined {
    const bundle = this.bundle;
    const binding = this.binding;
    const authority = this.options.authorityScope?.();
    if (
      !bundle ||
      !binding ||
      binding.origin !== 'online' ||
      binding.freshness !== 'fresh' ||
      !authority ||
      !lineup ||
      lineup.length !== 10 ||
      bundle.program.series?.status !== 'live' ||
      bundle.program.status.telemetry !== 'fresh' ||
      bundle.program.status.context !== 'fresh' ||
      bundle.program.status.identity !== 'matched' ||
      bundle.program.map.phase !== 'live' ||
      bundle.program.match?.matchId !== event.matchId ||
      !sameMatchIdentity(binding.context, event) ||
      bundle.program.map.name !== event.mapName ||
      !this.mapStartScope
    )
      return undefined;
    const c = bundle.program.cursor;
    const e = event.cursor;
    if (
      !e.liveSessionId ||
      !sameMapExecution(c, e) ||
      c.programSourceGeneration !== e.programSourceGeneration
    )
      return undefined;
    const current = bundle.program.players
      .filter((player) => player.lineupEvidence === 'current')
      .map((player) => player.sourcePlayerId)
      .sort();
    if (current.length !== 10 || JSON.stringify(current) !== JSON.stringify([...lineup].sort()))
      return undefined;
    return JSON.stringify([
      event.matchId,
      event.mapName,
      e.producerInstanceId,
      e.liveSessionId,
      e.programSourceGeneration,
      e.mapEpoch,
      authority,
      current,
    ]);
  }

  private async reconcileFence(): Promise<void> {
    if (!this.outbox || this.closed || this.quarantined) return;
    const waiting = this.waitingFence;
    if (waiting) {
      const record = this.outbox
        .getRecords()
        .find((item) => item.event.idempotencyKey === waiting.key);
      const boundary = this.outbox
        .getRecords()
        .find((item) => item.event.idempotencyKey === waiting.boundaryKey);
      if (
        !record ||
        !boundary ||
        this.recoveryScope(record.event, record.lineupSteam64) !== waiting.scope ||
        (boundary.status !== 'pending' &&
          (boundary.status !== 'accepted' || boundary.receiverOutcome === 'needs_attention'))
      ) {
        await this.outbox.setStartRecovery(waiting.key, 'awaiting_boundary', 'blocked');
        this.waitingFence = undefined;
      } else if (boundary.status === 'accepted' && this.bundle) {
        if (
          await this.outbox.setStartRecovery(
            waiting.key,
            'awaiting_boundary',
            'awaiting_observation',
          )
        ) {
          this.options.onRecoveryProgress?.(record.event, 'context_reconfirming');
          this.approvedRecovery = {
            key: waiting.key,
            scope: waiting.scope,
            afterRuntimeSeq: this.bundle.program.cursor.runtimeSeq,
          };
          if (this.publishedMapStart?.key === waiting.key) this.publishedMapStart = undefined;
        }
        this.waitingFence = undefined;
      }
      return;
    }
    const record = [...this.outbox.getRecords()]
      .reverse()
      .find(
        (item) =>
          item.status === 'rejected' &&
          item.event.kind === 'map_started' &&
          ['generation_fence', 'epoch_fence'].includes(item.rejection?.reason ?? '') &&
          item.recoveryState === undefined &&
          this.recoveryScope(item.event, item.lineupSteam64) !== undefined,
      );
    if (!record || this.outbox.startRejections(record.event).length !== 1) return;
    const target = record.event.cursor;
    const matches = this.outbox.getRecords().filter((item) => {
      const e = item.event;
      const c = e.cursor;
      if (
        item.status !== 'pending' ||
        !sameMatchIdentity(e, record.event) ||
        !sameMapExecution(c, target) ||
        c.programSourceGeneration !== target.programSourceGeneration ||
        c.runtimeSeq > target.runtimeSeq
      )
        return false;
      return record.rejection?.reason === 'generation_fence'
        ? e.kind === 'source_generation_changed' &&
            e.payload.previousSourceGeneration === c.programSourceGeneration - 1
        : e.kind === 'map_epoch_changed' && e.payload.previousMapEpoch === c.mapEpoch - 1;
    });
    const scope = this.recoveryScope(record.event, record.lineupSteam64);
    if (!scope) return;
    if (matches.length !== 1) {
      await this.outbox.setStartRecovery(record.event.idempotencyKey, undefined, 'blocked');
      this.options.onRecoveryProgress?.(record.event, 'continuity_chain_missing');
      return;
    }
    const boundaryKey = matches[0]!.event.idempotencyKey;
    if (
      await this.outbox.setStartRecovery(
        record.event.idempotencyKey,
        undefined,
        'awaiting_boundary',
        boundaryKey,
      )
    ) {
      this.waitingFence = { key: record.event.idempotencyKey, boundaryKey, scope };
      this.options.onRecoveryProgress?.(record.event, 'continuity_waiting');
    }
  }

  private async recoverRejectedStart(): Promise<void> {
    if (!this.outbox || !this.contextRecoveryHandler || this.closed || this.quarantined) return;
    const record = [...this.outbox.getRecords()]
      .reverse()
      .find(
        (item) =>
          item.status === 'rejected' &&
          item.event.kind === 'map_started' &&
          item.rejection?.reason === 'context_stale' &&
          item.recoveryState === undefined &&
          this.recoveryScope(item.event, item.lineupSteam64) !== undefined,
      );
    if (!record || this.outbox.startRejections(record.event).length !== 1) return;
    const scope = this.recoveryScope(record.event, record.lineupSteam64);
    const authority = this.options.authorityScope?.();
    if (
      !scope ||
      !authority ||
      !(await this.outbox.setStartRecovery(record.event.idempotencyKey, undefined, 'refreshing'))
    )
      return;
    let compatible: boolean;
    try {
      compatible = await this.contextRecoveryHandler(record.event, authority);
    } catch {
      compatible = false;
    }
    compatible =
      compatible &&
      !this.closed &&
      !this.quarantined &&
      this.recoveryScope(record.event, record.lineupSteam64) === scope;
    const state = compatible ? 'awaiting_observation' : 'blocked';
    if (!(await this.outbox.setStartRecovery(record.event.idempotencyKey, 'refreshing', state)))
      return;
    if (compatible && this.bundle) {
      this.approvedRecovery = {
        key: record.event.idempotencyKey,
        scope,
        afterRuntimeSeq: this.bundle.program.cursor.runtimeSeq,
      };
      if (this.publishedMapStart?.key === record.event.idempotencyKey)
        this.publishedMapStart = undefined;
    }
  }

  private retryPending = false;
  private retryCompletion: Promise<void> | undefined;
  private outboundUnsubscribe: (() => Promise<void>) | undefined;
  private outboundTimer: ReturnType<typeof setInterval> | undefined;
  private lastBundleAt = 0;
  private playerSnapshot:
    | {
        scope: string;
        players: NonNullable<
          Extract<ReliableEventV1, { kind: 'map_player_snapshot' }>['payload']['players']
        >;
      }
    | undefined;

  private snapshotScope(
    bundle: ProjectionBundle,
    binding: MatchContextBinding | undefined,
  ): string | undefined {
    if (
      !binding ||
      binding.origin === 'fixture' ||
      binding.freshness !== 'fresh' ||
      bundle.program.match?.matchId !== binding.context.matchId
    )
      return undefined;
    const c = bundle.program.cursor;
    if (!c.liveSessionId || !c.mapEpoch || !bundle.program.map.name) return undefined;
    return JSON.stringify([
      binding.context.matchId,
      c.producerInstanceId,
      c.liveSessionId,
      c.mapEpoch,
      bundle.program.map.name,
    ]);
  }

  constructor(private readonly options: OutputServiceOptions = {}) {
    this.outbox = options.outbox;
    this.sink = options.sink;
    this.now = options.now ?? (() => new Date());
    this.onDiagnostic = options.onDiagnostic;
  }

  async start(): Promise<void> {
    try {
      await this.outbox?.load();
    } catch (error) {
      this.outboxUnavailable = true;
      this.options.onOutboxLoadError?.(error);
      this.onDiagnostic?.('outbox_unavailable');
      return;
    }
    try {
      await this.outbox?.retryPendingBoundaryCaptures(true);
    } catch (error) {
      this.reportBoundaryCaptureError(error);
    }
    const continuity = this.outbox?.getContinuity();
    if (
      continuity !== undefined &&
      this.now().getTime() - Date.parse(continuity.savedAt) < 24 * 60 * 60 * 1000
    ) {
      const restored = this.options.restoreContinuity?.(continuity);
      if (restored !== undefined) {
        this.recoveredCursor = continuity.cursor;
        this.setCurrent(restored, this.binding);
        // A continuity checkpoint is not proof that a start was durably published.
      }
    }
    if (this.options.liveSink !== undefined) {
      const lane = createLatestWinsConsumer<LiveSnapshotV1>({
        id: 'cloud-live',
        send: (snapshot) => {
          const current = this.current(true);
          return this.executionEligible(this.binding) &&
            this.getBoundaryStatus() === null &&
            current !== null &&
            current.cursor.liveSessionId === snapshot.cursor.liveSessionId
            ? this.options.liveSink!.send(current)
            : Promise.resolve();
        },
        onDiagnostic: ({ code }) => this.onDiagnostic?.(`snapshot_${code}`),
      });
      // Cloud cadence is capped at 2 Hz; projecting the latest bundle every 500 ms
      // also gives reconnecting viewers a fresh baseline at least once per second.
      this.outboundTimer = setInterval(() => {
        if (this.closed || this.now().getTime() - this.lastBundleAt > 1_500) return;
        const snapshot = this.current(true);
        if (snapshot?.capability.telemetryFresh && snapshot.capability.contextFresh)
          lane.offer(snapshot);
      }, 500);
      this.outboundTimer.unref();
      this.outboundUnsubscribe = () => lane.close();
    }
    if (this.outbox !== undefined) {
      this.timer = setInterval(() => {
        void this.retry();
      }, 1_000);
      this.timer.unref();
      await this.retry();
    }
  }

  setBinding(binding: MatchContextBinding | undefined): void {
    this.binding = binding;
  }

  private executionEligible(binding: MatchContextBinding | undefined): boolean {
    return binding !== undefined && (this.options.isExecutionOwnedBy?.(binding) ?? true);
  }

  setCurrent(bundle: ProjectionBundle, binding: MatchContextBinding | undefined): void {
    if (this.closed) return;
    this.bundle = bundle;
    this.lastBundleAt = this.now().getTime();
    this.binding = binding;
    const source = this.sourceFor(binding?.context.matchId, bundle.program.cursor);
    this.boundaryContext = {
      bundle,
      binding,
      source: source ? { ...source } : source,
      authority: this.boundaryAuthority(),
    };
    this.updateMapStartScope(bundle, binding);
    const scope = this.snapshotScope(bundle, binding);
    if (scope !== undefined && this.playerSnapshot?.scope !== scope)
      this.playerSnapshot = undefined;
    const players = bundle.program.players.filter((p) => p.lineupEvidence === 'current');
    if (
      scope &&
      this.executionEligible(binding) &&
      bundle.program.status.context === 'fresh' &&
      bundle.program.status.telemetry === 'fresh' &&
      bundle.program.status.identity === 'matched' &&
      players.length === 10 &&
      new Set(players.map((p) => p.sourcePlayerId)).size === 10 &&
      players.some(
        (p) =>
          p.matchStats &&
          (p.matchStats.kills != null ||
            p.matchStats.assists != null ||
            p.matchStats.deaths != null),
      )
    ) {
      this.playerSnapshot = {
        scope,
        players: players.map((p) => ({
          sourcePlayerId: p.sourcePlayerId,
          canonicalPlayerId: p.canonicalPlayerId,
          kills: p.matchStats?.kills ?? null,
          assists: p.matchStats?.assists ?? null,
          deaths: p.matchStats?.deaths ?? null,
        })),
      };
    }
    const producedAt = this.now().toISOString();
    for (const [consumer, includeRadar] of this.consumers) {
      const snapshot = this.safeProject(bundle, binding, producedAt, includeRadar);
      if (snapshot !== null) consumer.offer(snapshot);
    }
  }

  private updateMapStartScope(
    bundle: ProjectionBundle,
    binding: MatchContextBinding | undefined,
  ): void {
    const { program, operator } = bundle;
    const players = program.players.filter((player) => player.lineupEvidence === 'current');
    const scope =
      binding !== undefined &&
      binding.origin !== 'fixture' &&
      binding.freshness === 'fresh' &&
      program.status.context === 'fresh' &&
      program.match?.matchId === binding.context.matchId &&
      program.status.telemetry === 'fresh' &&
      (program.status.identity === 'matched' || hasLineupMismatchOnly(bundle, binding)) &&
      program.map.phase === 'live' &&
      program.map.name !== null &&
      program.cursor.mapEpoch > 0 &&
      players.length === 10 &&
      operator.activeLineup.ctCount === 5 &&
      operator.activeLineup.tCount === 5
        ? JSON.stringify([
            binding.context.matchId,
            binding.manifest.revision,
            binding.origin,
            program.cursor.producerInstanceId,
            program.cursor.liveSessionId,
            program.cursor.programSourceGeneration,
            program.cursor.mapEpoch,
            program.map.name,
            program.series?.currentMapOrder ?? null,
            players.map((player) => [player.sourcePlayerId, player.canonicalPlayerId]).sort(),
            this.options.authorityScope?.() ?? null,
          ])
        : undefined;
    if (scope !== this.mapStartScope) {
      this.mapStartScope = scope;
      this.mapStartRevision += 1;
      this.publishedMapStart = undefined;
    }
  }

  private newMapObservation(result: RuntimeReduceResult, bundle: ProjectionBundle): boolean {
    if (
      result.disposition.kind !== 'accepted' ||
      !['baseline', 'contiguous', 'gap-resync', 'stale-recovery'].includes(
        result.disposition.reason,
      )
    )
      return false;
    const cursor = bundle.program.cursor;
    const received = result.state.programSource.lastAccepted;
    if (
      received === undefined ||
      received.generation !== cursor.programSourceGeneration ||
      received.sequence !== cursor.programReceiveSequence
    )
      return false;
    const prior = this.lastMapObservation;
    if (
      prior !== undefined &&
      prior.producerInstanceId === cursor.producerInstanceId &&
      prior.liveSessionId === cursor.liveSessionId &&
      (cursor.runtimeSeq <= prior.runtimeSeq ||
        cursor.programSourceGeneration < prior.programSourceGeneration ||
        (cursor.programSourceGeneration === prior.programSourceGeneration &&
          (cursor.programReceiveSequence === null ||
            cursor.programReceiveSequence <= (prior.programReceiveSequence ?? 0))))
    )
      return false;
    this.lastMapObservation = cursor;
    return true;
  }

  captureRuntimeMutationContext(): OutputMutationContext | undefined {
    return this.boundaryContext;
  }

  beforeRuntimeMutation(context = this.captureRuntimeMutationContext()): void {
    this.priorForMutation = context?.bundle ?? this.bundle;
    this.priorBoundaryContext = context;
  }

  current(includeRadar = false): LiveSnapshotV1 | null {
    return this.currentStatus(includeRadar).snapshot;
  }

  /** Read-only explanation from the publisher, never a second runtime or a recovery command. */
  currentStatus(includeRadar = false): LiveSnapshotStatus {
    const cursor = this.bundle?.program.cursor;
    const localPending =
      !this.outboxUnavailable &&
      !this.trialQuarantined &&
      !this.faultQuarantined &&
      !this.outbox?.getBoundaryCaptureRecovery().lost &&
      this.binding &&
      cursor?.liveSessionId &&
      this.outbox?.hasPendingEnqueues(
        {
          matchId: this.binding.context.matchId,
          producerInstanceId: cursor.producerInstanceId,
          liveSessionId: cursor.liveSessionId,
        },
        this.sourceFor(this.binding.context.matchId, cursor) ?? undefined,
      )
        ? { localPersistencePending: true as const }
        : {};
    const result = (
      snapshot: LiveSnapshotV1 | null,
      blockedReason: LiveSnapshotStatus['blockedReason'],
    ): LiveSnapshotStatus => ({
      ...localPending,
      snapshot,
      // Local projection can remain readable when the durable publisher could not start.
      blockedReason: this.outboxUnavailable ? 'output_unavailable' : blockedReason,
    });
    if (this.quarantined)
      return result(
        null,
        !this.trialQuarantined &&
          !this.faultQuarantined &&
          !this.outbox?.getBoundaryCaptureRecovery().lost &&
          this.outbox?.getBoundaryCaptureRecovery().pending
          ? 'output_persistence_pending'
          : 'output_quarantined',
      );
    if (!this.bundle) return result(null, 'projection_unavailable');
    const blockedReason = liveSnapshotBlockedReason(this.bundle, this.binding);
    if (blockedReason) return result(null, blockedReason);
    const snapshot = this.safeProject(
      this.bundle,
      this.binding,
      this.now().toISOString(),
      includeRadar,
    );
    return result(snapshot, snapshot ? null : 'snapshot_projection_failed');
  }

  private safeProject(
    bundle: ProjectionBundle,
    binding: MatchContextBinding | undefined,
    producedAt: string,
    includeRadar: boolean,
  ): LiveSnapshotV1 | null {
    if (this.quarantined) return null;
    try {
      return projectLiveSnapshotV1({ bundle, binding, producedAt, includeRadar });
    } catch {
      this.onDiagnostic?.('snapshot_projection_failed');
      return null;
    }
  }

  subscribe(consumer: LiveSnapshotConsumer, includeRadar = false): () => Promise<void> {
    if (this.closed) throw new Error('output_service_closed');
    const lane = createLatestWinsConsumer<LiveSnapshotV1>({
      id: `output-${this.consumers.size + 1}`,
      send: (snapshot) => {
        const current = this.current(includeRadar);
        if (
          current === null ||
          current.matchId !== snapshot.matchId ||
          current.cursor.producerInstanceId !== snapshot.cursor.producerInstanceId ||
          current.cursor.liveSessionId !== snapshot.cursor.liveSessionId ||
          current.cursor.programSourceGeneration !== snapshot.cursor.programSourceGeneration ||
          current.cursor.mapEpoch !== snapshot.cursor.mapEpoch
        )
          return Promise.resolve();
        return consumer.send(current);
      },
      onDiagnostic: ({ code }) => this.onDiagnostic?.(`snapshot_${code}`),
    });
    this.consumers.set(lane, includeRadar);
    const current = this.current(includeRadar);
    if (current !== null) lane.offer(current);
    return async () => {
      this.consumers.delete(lane);
      await lane.close();
    };
  }

  afterRuntimeMutation(
    result: RuntimeReduceResult & Partial<Pick<ProgramCommitResult, 'executionBoundary'>>,
    bundle: ProjectionBundle,
    binding: MatchContextBinding | undefined,
  ): void {
    if (this.closed || result.disposition.kind !== 'accepted') return;
    const previous = this.priorForMutation ?? this.bundle;
    const frozen = this.priorBoundaryContext ?? this.boundaryContext;
    this.priorForMutation = undefined;
    this.priorBoundaryContext = undefined;
    const now = this.now().toISOString();
    if (this.bundle !== bundle || this.binding !== binding) this.setCurrent(bundle, binding);

    const before = result.executionBoundary?.before;
    if (
      this.trialQuarantined ||
      this.faultQuarantined ||
      this.outboxUnavailable ||
      (before?.kind === 'owned' ? before.fixture : binding?.origin === 'fixture')
    )
      return;
    const cursor = bundle.program.cursor;
    const preparationBoundary = before?.kind === 'none';
    const eligible = !binding || this.executionEligible(binding);
    const frozenMatches =
      before?.kind === 'owned' &&
      frozen?.binding?.context.matchId === before.matchId &&
      frozen.bundle.program.match?.matchId === before.matchId &&
      sameMapExecution(frozen.bundle.program.cursor, before.cursor) &&
      frozen.bundle.program.cursor.programSourceGeneration ===
        before.cursor.programSourceGeneration;
    // A boundary with explicit owner evidence must use that owner's frozen
    // context. If it is unavailable, retain a scoped gap rather than borrow a
    // later binding or current source. Legacy callers keep conservative behavior.
    const boundaryContext =
      before === undefined
        ? {
            bundle,
            binding,
            source: this.sourceFor(binding?.context.matchId, cursor),
            authority: this.boundaryAuthority(),
          }
        : frozenMatches
          ? frozen
          : undefined;
    if (
      binding &&
      cursor.liveSessionId &&
      !result.transitions.some((transition) => transition.kind === 'map_execution_changed') &&
      result.disposition.reason !== 'source-generation-advanced' &&
      this.retiringScopes.has(
        JSON.stringify([binding.context.matchId, cursor.producerInstanceId, cursor.liveSessionId]),
      )
    )
      return;

    const managedSourceId = this.options.managedSourceId?.();
    const continuity: DeliveryContinuity | undefined =
      binding === undefined || !eligible
        ? undefined
        : {
            matchId: binding.context.matchId,
            contextRevision: binding.manifest.revision,
            cursor: bundle.program.cursor,
            mapName: result.state.map.name ?? null,
            savedAt: now,
            ...(managedSourceId ? { managedSourceId } : {}),
          };
    const transitions = result.transitions.filter(
      (transition) => transition.kind === 'map_execution_changed',
    );
    const generationAdvanced = result.disposition.reason === 'source-generation-advanced';
    const hasBoundary = !preparationBoundary && (transitions.length > 0 || generationAdvanced);
    const outputScope = this.boundaryScope(binding?.context.matchId, bundle.program.cursor);
    const priorExecutionScope =
      before && before.kind !== 'none'
        ? this.boundaryScope(before.kind === 'owned' ? before.matchId : undefined, before.cursor)
        : outputScope;
    // Gaps belong to the prior execution and survive a later authority revision.
    const { authorityFingerprint: priorAuthority, ...priorScope } = priorExecutionScope ?? {};
    void priorAuthority;
    const gapScope = priorExecutionScope
      ? ({
          ...priorScope,
          ...(boundaryContext?.source &&
          before?.kind === 'owned' &&
          boundaryContext.source.matchId === before.matchId &&
          sameSourceSession(boundaryContext.source, before.cursor)
            ? { source: boundaryContext.source }
            : {}),
          ruleVersion: 2 as const,
          reason:
            before?.kind === 'unknown'
              ? ('execution_owner_unknown' as const)
              : ('boundary_capture_incomplete' as const),
        } as BoundaryScope)
      : outputScope;
    if (!eligible && !hasBoundary) return;
    if (!this.quarantined && !hasBoundary && continuity !== undefined)
      void this.outbox
        ?.updateContinuity(continuity, outputScope)
        .catch(() => this.onDiagnostic?.('outbox_continuity_write_failed'));
    if (
      !this.quarantined &&
      eligible &&
      bundle.program.status.telemetry === 'fresh' &&
      bundle.program.map.phase === 'gameover'
    ) {
      const cursor = bundle.program.cursor;
      const map = bundle.program.map;
      void this.outbox
        ?.supersedeWhere((event) => {
          if (
            event.kind !== 'map_ended' ||
            event.cursor.liveSessionId !== cursor.liveSessionId ||
            event.cursor.mapEpoch !== cursor.mapEpoch ||
            event.cursor.programSourceGeneration !== cursor.programSourceGeneration
          )
            return false;
          const final = bundle.program.series?.maps.find((item) => item.mapId === event.mapId);
          return (
            (final?.status === 'completed' &&
              final.finalScore !== null &&
              (final.finalScore.a !== event.payload.scoreA ||
                final.finalScore.b !== event.payload.scoreB)) ||
            (map.name !== null && map.name !== event.mapName) ||
            (map.score.ct !== null &&
              map.score.t !== null &&
              (map.score.ct !== event.payload.scoreCT || map.score.t !== event.payload.scoreT))
          );
        })
        .catch(() => {
          this.faultQuarantined = true;
          this.onDiagnostic?.('outbox_supersede_failed');
        });
    }
    const newMapObservation =
      !this.quarantined && eligible && this.newMapObservation(result, bundle);
    let candidates: ReliableEventV1[];
    let projectionFailed = false;
    try {
      candidates = !eligible
        ? []
        : [
            ...transitionReliableEventsV1({
              result,
              bundle,
              binding,
            }).filter(
              (event) =>
                !preparationBoundary ||
                (event.kind !== 'map_epoch_changed' && event.kind !== 'source_generation_changed'),
            ),
          ];
    } catch {
      this.onDiagnostic?.('event_projection_failed');
      if (!hasBoundary) return;
      candidates = [];
      projectionFailed = true;
    }
    if (hasBoundary && this.outbox) {
      const entries: {
        kind: 'map_epoch_changed' | 'source_generation_changed';
        previous?: number | null;
        reason?: string | null;
        observedAt: string;
      }[] = transitions.map((transition) => ({
        kind: 'map_epoch_changed',
        previous: transition.previousMapEpoch,
        reason: transition.reason,
        observedAt: transition.at.utc,
      }));
      if (generationAdvanced)
        entries.unshift({
          kind: 'source_generation_changed',
          previous: Math.max(0, bundle.program.cursor.programSourceGeneration - 1),
          observedAt: result.state.programTelemetry?.receive.receivedAt ?? now,
        });
      const events: ReliableEventV1[] = [];
      const intents: BoundaryIntent[] = [];
      const sameSession = !before || sameSourceSession(before.cursor, cursor);
      let missing = projectionFailed || !boundaryContext || !sameSession;
      for (const entry of boundaryContext && sameSession ? entries : []) {
        try {
          const candidate = buildReliableEventV1({
            kind: entry.kind,
            bundle:
              before?.kind === 'owned' && bundle.program.match?.matchId === before.matchId
                ? bundle
                : boundaryContext!.bundle,
            binding: boundaryContext!.binding,
            // The event is the transition's watermark but belongs to the
            // frozen previous owner and exact source, not the new binding.
            cursor,
            observedAt: entry.observedAt,
            source:
              entry.kind === 'map_epoch_changed' ? 'runtime-transition' : 'runtime-continuity',
            ...(entry.kind === 'map_epoch_changed'
              ? { previousMapEpoch: entry.previous ?? null, reason: entry.reason ?? null }
              : { previousSourceGeneration: entry.previous ?? null }),
            retainStaleBoundary: true,
          });
          if (!candidate) {
            missing = true;
            continue;
          }
          if (candidate.evidence.contextFresh) events.push(candidate);
          else {
            const authorityFingerprint = boundaryContext!.authority;
            const boundaryBinding = boundaryContext!.binding;
            if (
              !boundaryBinding ||
              boundaryBinding.origin !== 'online' ||
              !authorityFingerprint ||
              !candidate.cursor.liveSessionId
            ) {
              missing = true;
              continue;
            }
            intents.push({
              event: candidate,
              planFingerprint: manifestPlanFingerprint(boundaryBinding.manifest),
              authorityFingerprint,
            });
          }
        } catch {
          missing = true;
        }
      }
      const pendingKey = this.boundaryScopeKey(outputScope);
      this.boundaryCommits.set(pendingKey, (this.boundaryCommits.get(pendingKey) ?? 0) + 1);
      void this.outbox
        .captureBoundaries(
          events,
          intents,
          continuity,
          missing,
          this.now(),
          gapScope,
          boundaryContext?.source ?? (this.options.exactSource ? null : undefined),
        )
        .then(() => {
          if (this.outbox?.hasBoundaryOverflow(outputScope))
            this.onDiagnostic?.('outbox_boundary_overflow');
          else if (missing || this.outbox?.hasBoundaryGap(outputScope))
            this.onDiagnostic?.('outbox_boundary_gap');
        })
        .catch((error: unknown) => {
          this.reportBoundaryCaptureError(error);
        })
        .finally(() => {
          const remaining = (this.boundaryCommits.get(pendingKey) ?? 1) - 1;
          if (remaining) this.boundaryCommits.set(pendingKey, remaining);
          else this.boundaryCommits.delete(pendingKey);
        });
      candidates = candidates.filter(
        (event) => event.kind !== 'map_epoch_changed' && event.kind !== 'source_generation_changed',
      );
    }
    if (!eligible) return;
    const ended = candidates.find(
      (event): event is Extract<ReliableEventV1, { kind: 'map_ended' }> =>
        event.kind === 'map_ended',
    );
    if (
      ended &&
      this.playerSnapshot &&
      this.playerSnapshot.scope === this.snapshotScope(bundle, binding)
    )
      candidates.push(buildMapPlayerSnapshotV1(ended, this.playerSnapshot.players));
    const add = (
      kind: Parameters<typeof buildReliableEventV1>[0]['kind'],
      source: Parameters<typeof buildReliableEventV1>[0]['source'],
      reason?: string | null,
      previousSourceGeneration?: number,
    ) => {
      let candidate: ReliableEventV1 | null;
      try {
        candidate = buildReliableEventV1({
          kind,
          bundle,
          binding,
          observedAt:
            result.state.programTelemetry?.receive.receivedAt ??
            result.transitions[0]?.at.utc ??
            now,
          source,
          ...(reason === undefined ? {} : { reason }),
          ...(previousSourceGeneration === undefined ? {} : { previousSourceGeneration }),
        });
      } catch {
        this.onDiagnostic?.('event_projection_failed');
        return;
      }
      if (candidate !== null) candidates.push(candidate);
      return candidate;
    };
    if (
      previous?.program.series?.status !== 'live' &&
      bundle.program.series?.status === 'live' &&
      bundle.program.status.identity === 'matched'
    )
      add('match_started', 'series-progress');
    if (
      newMapObservation &&
      !hasBoundary &&
      !this.boundaryCommitIsPending(outputScope) &&
      !this.outbox?.hasBoundaryGap(outputScope) &&
      !this.outbox?.getBoundaryIntents(outputScope).length &&
      this.mapStartScope !== undefined &&
      this.publishedMapStart?.revision !== this.mapStartRevision &&
      this.pendingMapStart?.revision !== this.mapStartRevision &&
      this.outbox !== undefined
    ) {
      const event = add('map_started', 'runtime-transition');
      if (event) {
        const boundaries = [...this.boundaryEnqueues, ...candidates].filter(
          (candidate) =>
            (candidate.kind === 'source_generation_changed' ||
              candidate.kind === 'map_epoch_changed') &&
            candidate.matchId === event.matchId &&
            candidate.cursor.producerInstanceId === event.cursor.producerInstanceId &&
            candidate.cursor.liveSessionId === event.cursor.liveSessionId &&
            candidate.cursor.runtimeSeq <= event.cursor.runtimeSeq &&
            candidate.cursor.programSourceGeneration <= event.cursor.programSourceGeneration &&
            candidate.cursor.mapEpoch <= event.cursor.mapEpoch,
        );
        const refusals = this.outbox.startRejections(event);
        const approval = this.approvedRecovery;
        const recovery =
          refusals.length === 1 &&
          approval !== undefined &&
          approval.key === refusals[0]?.event.idempotencyKey &&
          refusals[0]?.recoveryState === 'awaiting_observation' &&
          approval.scope === this.recoveryScope(refusals[0].event, refusals[0].lineupSteam64) &&
          event.cursor.runtimeSeq > approval.afterRuntimeSeq
            ? approval.key
            : undefined;
        if (
          boundaries.length ||
          this.outbox.hasUnconfirmedBoundary(event) ||
          (refusals.length > 0 && !recovery)
        )
          candidates.pop();
        else
          this.pendingMapStart = {
            revision: this.mapStartRevision,
            key: event.idempotencyKey,
            ...(recovery ? { recovery } : {}),
          };
      }
    }
    if (
      previous?.program.series?.status !== 'completed' &&
      bundle.program.series?.status === 'completed'
    )
      add('series_ended', 'series-progress');
    if (
      previous?.program.status.identity !== 'mismatch' &&
      bundle.program.status.identity === 'mismatch'
    )
      add('identity_mismatch', 'identity');
    if (
      !previous?.identity.issues.some((issue) => issue.code === 'lineup_differs_from_expected') &&
      bundle.identity.issues.some((issue) => issue.code === 'lineup_differs_from_expected')
    )
      add('lineup_mismatch', 'identity', 'lineup_differs_from_expected');
    for (const event of candidates) {
      const start = event.kind === 'map_started' ? this.pendingMapStart : undefined;
      const lineup = bundle.program.players
        .filter((p) => p.lineupEvidence === 'current')
        .map((p) => p.sourcePlayerId);
      const retainedLineup =
        lineup.length === 10 &&
        new Set(lineup).size === 10 &&
        lineup.every((id) => /^\d{17}$/.test(id))
          ? lineup
          : undefined;
      const boundary =
        event.kind === 'source_generation_changed' || event.kind === 'map_epoch_changed';
      if (boundary) this.boundaryEnqueues.add(event);
      void this.outbox
        ?.enqueue(
          event,
          this.now(),
          continuity,
          event.kind === 'map_started' ? retainedLineup : undefined,
          start?.recovery,
          this.boundaryScope(event.matchId, event.cursor),
          this.sourceFor(event.matchId, event.cursor),
        )
        .then(() => {
          if (start !== undefined && start.revision === this.mapStartRevision)
            this.publishedMapStart = start;
          if (start?.recovery === this.approvedRecovery?.key) this.approvedRecovery = undefined;
        })
        .catch((error: unknown) => {
          if (boundary && !this.outbox?.hasPendingEnqueue(event.idempotencyKey))
            this.faultQuarantined = true;
          if (
            error instanceof Error &&
            error.message === 'outbox_pending_enqueue_capacity_exhausted'
          )
            this.reportBoundaryCaptureError(error);
          this.onDiagnostic?.('outbox_enqueue_failed');
        })
        .finally(() => {
          if (boundary) this.boundaryEnqueues.delete(event);
          if (
            start !== undefined &&
            this.pendingMapStart === start &&
            !this.outbox?.hasPendingEnqueue(start.key)
          )
            this.pendingMapStart = undefined;
        });
    }
  }

  async retry(options: { localOnly?: boolean } = {}): Promise<void> {
    if (this.retryPending) return this.retryCompletion;
    if (this.closed || this.outboxUnavailable || this.outbox === undefined) return;
    if (this.bundle !== undefined) this.updateMapStartScope(this.bundle, this.binding);
    this.retryPending = true;
    let finishRetry!: () => void;
    this.retryCompletion = new Promise<void>((resolve) => {
      finishRetry = resolve;
    });
    try {
      await this.outbox.retryPendingBoundaryCaptures();
      if (this.outbox.getBoundaryCaptureRecovery().pending) return;
      await this.outbox.retryPendingEnqueues();
      const start = this.pendingMapStart;
      if (
        start &&
        !this.outbox.hasPendingEnqueue(start.key) &&
        this.outbox.getRecords().some((record) => record.event.idempotencyKey === start.key)
      ) {
        if (start.revision === this.mapStartRevision) this.publishedMapStart = start;
        if (start.recovery === this.approvedRecovery?.key) this.approvedRecovery = undefined;
        this.pendingMapStart = undefined;
      }
      if (options.localOnly || this.quarantined || this.binding?.origin === 'fixture') return;
      await this.outbox.expireBoundaryIntents(this.now());
      if (this.closed) return;
      await this.materializeIntents();
      if (this.closed) return;
      await this.reconcileFence();
      if (this.closed) return;
      if (this.sink === undefined)
        await this.outbox.sweep(
          (event, lineup) => this.isCurrentForRetry(event, lineup),
          this.now(),
        );
      else {
        const source = this.options.exactSource?.();
        if (source) await this.outbox.bindUnsentSource(source);
        if (this.closed) return;
        const invalidatedStarts = await this.outbox.flush({
          sink: this.sink,
          now: this.now(),
          // Closing suppresses new sends without converting retained work into
          // superseded records while the last in-flight send settles.
          isCurrent: (event, lineup) =>
            this.closed || this.quarantined || this.isCurrentForRetry(event, lineup),
          canSend: (event, lineup) => {
            if (this.closed) return false;
            const allowed = this.canSend(event, lineup);
            if (!allowed) {
              try {
                const bundle = this.bundle;
                const series = bundle?.program.series;
                const mapOrder = series?.currentMapOrder ?? series?.roundHistory?.mapOrder ?? null;
                const resultMap = series?.maps.find((map) => map.mapOrder === mapOrder);
                // Explain the failed existing decision without changing its result.
                const blockers = [
                  ...(this.quarantined ? ['quarantined'] : []),
                  ...(!bundle ? ['bundle_unavailable'] : []),
                  ...(this.binding?.freshness !== 'fresh' ? ['context_not_fresh'] : []),
                  ...(!this.isCurrentForRetry(event, lineup) ? ['scope_not_current'] : []),
                ];
                if (bundle && blockers.length === 0) {
                  if (event.kind === 'map_ended') {
                    if (bundle.program.map.phase !== 'gameover')
                      blockers.push('map_phase_not_gameover');
                    if (bundle.program.map.name !== event.mapName)
                      blockers.push('map_name_changed');
                    if (
                      bundle.program.map.score.ct !== event.payload.scoreCT ||
                      bundle.program.map.score.t !== event.payload.scoreT
                    )
                      blockers.push('map_score_changed');
                    if (!(
                      event.evidence.lineupMismatchOnly === true &&
                      hasLineupMismatchOnly(bundle, this.binding)
                    )) {
                      if (resultMap?.status !== 'completed')
                        blockers.push('map_result_not_completed');
                      if (
                        resultMap?.mapId !== event.mapId ||
                        resultMap?.mapName !== event.mapName ||
                        resultMap?.finalScore?.a !== event.payload.scoreA ||
                        resultMap?.finalScore?.b !== event.payload.scoreB
                      )
                        blockers.push('canonical_result_changed');
                    }
                  }
                  if (event.kind === 'identity_mismatch' || event.kind === 'lineup_mismatch') {
                    if (!['mismatch', 'degraded'].includes(bundle.program.status.identity))
                      blockers.push('mismatch_no_longer_current');
                  } else {
                    if (bundle.program.status.telemetry !== 'fresh')
                      blockers.push('telemetry_not_fresh');
                    if (
                      bundle.program.status.identity !== 'matched' &&
                      !hasLineupMismatchOnly(bundle, this.binding)
                    )
                      blockers.push('identity_not_matched');
                  }
                }
                this.options.onBusinessEvidence?.('business_guard', {
                  matchId: event.matchId,
                  liveSessionId: event.cursor.liveSessionId,
                  idempotencyKey: event.idempotencyKey,
                  producerInstanceId: event.cursor.producerInstanceId,
                  originalObservedAt: event.observedAt,
                  reason: 'send_guard_blocked',
                  telemetry: bundle?.program.status.telemetry,
                  identity: bundle?.program.status.identity,
                  context: this.binding?.freshness,
                  mapName: bundle?.program.map.name,
                  mapPhase: bundle?.program.map.phase,
                  scoreCT: bundle?.program.map.score.ct,
                  scoreT: bundle?.program.map.score.t,
                  blockers: blockers.length ? blockers : ['final_evidence_not_current'],
                });
              } catch {
                /* Optional diagnostics cannot affect guards. */
              }
            }
            return allowed;
          },
        });
        if (this.closed) return;
        if (this.publishedMapStart && invalidatedStarts.includes(this.publishedMapStart.key))
          this.publishedMapStart = undefined;
        await this.reconcileFence();
        if (this.closed) return;
        await this.recoverRejectedStart();
      }
    } catch (error) {
      if (error instanceof BoundaryCaptureError) this.reportBoundaryCaptureError(error);
      this.onDiagnostic?.('outbox_retry_failed');
    } finally {
      this.retryPending = false;
      finishRetry();
      this.retryCompletion = undefined;
    }
  }

  private reportBoundaryCaptureError(error: unknown): void {
    // The queue owns recoverable failures. Trial and unrelated fault isolation stay independent.
    if (!this.outbox?.getBoundaryCaptureRecovery().pending) this.faultQuarantined = true;
    try {
      this.options.onBoundaryCaptureError?.(
        error,
        error instanceof BoundaryCaptureError
          ? {
              stage: error.stage,
              operationId: error.operationId,
              cursor:
                error.request.continuity?.cursor ??
                error.request.events[0]?.cursor ??
                error.request.intents[0]?.event.cursor,
            }
          : { stage: 'freeze' },
      );
    } catch {
      /* Diagnostics are optional. */
    }
    this.onDiagnostic?.('outbox_boundary_capture_failed');
  }

  getBoundaryStatus(): 'continuity_chain_missing' | 'continuity_waiting' | null {
    if (
      this.trialQuarantined ||
      this.faultQuarantined ||
      this.outboxUnavailable ||
      this.outbox?.getBoundaryCaptureRecovery().lost
    )
      return 'continuity_chain_missing';
    if (this.outbox?.getBoundaryCaptureRecovery().pending) return 'continuity_waiting';
    const scope = this.boundaryScope(this.binding?.context.matchId, this.bundle?.program.cursor);
    if (!scope) return null;
    if (this.outbox?.hasBoundaryGap(scope)) return 'continuity_chain_missing';
    const intents = this.outbox?.getBoundaryIntents(scope) ?? [];
    if (intents.some((intent) => intent.expired)) return 'continuity_chain_missing';
    const records = (this.outbox?.getRecords() ?? []).filter(
      (record) =>
        record.event.matchId === scope.matchId &&
        record.event.cursor.producerInstanceId === scope.producerInstanceId &&
        record.event.cursor.liveSessionId === scope.liveSessionId &&
        record.boundaryQualification !== undefined &&
        record.boundaryQualification.authorityFingerprint === scope.authorityFingerprint,
    );
    if (
      records.some(
        (record) =>
          ['rejected', 'expired', 'superseded'].includes(record.status) ||
          record.receiverOutcome === 'needs_attention',
      )
    )
      return 'continuity_chain_missing';
    if (
      this.boundaryCommitIsPending(scope) ||
      intents.length ||
      records.some((record) => record.status === 'pending')
    )
      return 'continuity_waiting';
    return null;
  }

  isPersistenceConfirmed(): boolean {
    return (
      this.outbox !== undefined &&
      !this.outboxUnavailable &&
      !this.quarantined &&
      !this.outbox.hasUnconfirmedWrites() &&
      this.getBoundaryStatus() !== 'continuity_chain_missing'
    );
  }

  isReliableAvailable(): boolean {
    return !this.outboxUnavailable;
  }

  getReliableRecovery() {
    return this.outbox?.getRecovery();
  }

  getReliableScopeDisposition(scope: ReliableDeliveryScope) {
    return this.outboxUnavailable ? undefined : this.outbox?.getScopeDisposition(scope);
  }

  getRevokedIsolationSummary() {
    return this.outboxUnavailable ? undefined : this.outbox?.getRevokedIsolationSummary();
  }

  getReliableActiveSources(): readonly ExactSource[] {
    if (this.outboxUnavailable) throw new Error('outbox_unavailable');
    return this.outbox?.getActiveSources() ?? [];
  }

  async archiveConfirmedSource(identity: ExactSource): Promise<void> {
    if (this.outboxUnavailable) throw new Error('outbox_unavailable');
    await this.outbox?.archiveConfirmedSource(identity);
  }

  async isolateRevokedSource(identity: ExactSource): Promise<void> {
    if (this.outboxUnavailable) throw new Error('outbox_unavailable');
    await this.outbox?.isolateRevokedSource(identity);
  }

  /** Stop producing this scope, then wait for the existing owner to settle its queue. */
  async settleSourceForRelease(scope: ReliableDeliveryScope): Promise<boolean> {
    this.retiringScopes.add(
      JSON.stringify([scope.matchId, scope.producerInstanceId, scope.liveSessionId]),
    );
    if (this.outboxUnavailable) return false;
    if (!this.outbox) return true;
    const exact = 'authorityRevision' in scope ? parseSource(scope) : undefined;
    const frozenScope: BoundaryScope = { ...scope, ...(exact ? { source: exact } : {}) };
    // Tail settlement intentionally has no current authority or ephemeral
    // service-owner filter. All retained intents/gaps in the exact old delivery
    // scope must settle, including awaitingSource and previous-authority work.
    if (
      this.outbox.getRecovery()?.code === 'outbox_preserved_without_records' ||
      this.outbox.hasBoundaryGap(frozenScope) ||
      this.outbox.getBoundaryIntents(frozenScope).length
    )
      return false;
    await this.outbox.flushPending();
    await this.retryCompletion;
    await this.retry();
    await this.retryCompletion;
    await this.outbox.flushPending();
    return (
      !this.outbox.hasPendingEnqueues(scope, exact) &&
      !this.outbox.hasBoundaryGap(frozenScope) &&
      this.outbox.getBoundaryIntents(frozenScope).length === 0 &&
      this.outbox.getScopeDisposition(scope, exact).pending === 0
    );
  }

  resumeSource(scope: ReliableDeliveryScope): void {
    this.retiringScopes.delete(
      JSON.stringify([scope.matchId, scope.producerInstanceId, scope.liveSessionId]),
    );
  }

  getReliableRecords() {
    return this.outboxUnavailable ? [] : (this.outbox?.getRecords() ?? []);
  }

  private isCurrentForRetry(event: ReliableEventV1, lineup?: readonly string[]): boolean {
    const bundle = this.bundle;
    const binding = this.binding;
    if (bundle === undefined || binding === undefined) return true;
    const retained = this.outbox
      ?.getRecords()
      .find((record) => record.event.idempotencyKey === event.idempotencyKey);
    if (
      retained &&
      (binding.context.matchId !== event.matchId ||
        bundle.program.cursor.producerInstanceId !== event.cursor.producerInstanceId ||
        bundle.program.cursor.liveSessionId !== event.cursor.liveSessionId)
    )
      return true;
    if (
      event.kind === 'map_started' &&
      bundle.program.cursor.mapEpoch !== event.cursor.mapEpoch &&
      lineup === undefined
    )
      return false;
    if (
      event.kind === 'map_started' &&
      bundle.program.cursor.mapEpoch === event.cursor.mapEpoch &&
      ![this.publishedMapStart, this.pendingMapStart].some(
        (start) => start?.revision === this.mapStartRevision && start.key === event.idempotencyKey,
      )
    )
      return false;
    // Continuity transitions belong to the same producer and live session even
    // after a compatible context refresh or a later map/generation. Preserve the
    // original event and let the receiver acknowledge the chain in order.
    if (
      (event.kind === 'source_generation_changed' || event.kind === 'map_epoch_changed') &&
      binding.context.matchId === event.matchId &&
      bundle.program.cursor.producerInstanceId === event.cursor.producerInstanceId &&
      event.cursor.liveSessionId !== null &&
      bundle.program.cursor.liveSessionId === event.cursor.liveSessionId &&
      bundle.program.cursor.programSourceGeneration >= event.cursor.programSourceGeneration &&
      bundle.program.cursor.mapEpoch >= event.cursor.mapEpoch
    )
      return true;
    if (
      this.outbox
        ?.getRecords()
        .some(
          (record) =>
            record.event.idempotencyKey === event.idempotencyKey && record.boundaryQualification,
        )
    )
      return true;
    const recovered = this.recoveredCursor;
    const recoveredEvent =
      recovered !== undefined &&
      recovered.liveSessionId === event.cursor.liveSessionId &&
      recovered.mapEpoch === event.cursor.mapEpoch &&
      recovered.programSourceGeneration === event.cursor.programSourceGeneration &&
      (recovered.producerInstanceId === event.cursor.producerInstanceId ||
        recovered.liveSessionId !== null);
    if (
      (bundle.program.cursor.producerInstanceId !== event.cursor.producerInstanceId &&
        !recoveredEvent) ||
      binding.context.matchId !== event.matchId ||
      (binding.manifest.revision !== event.contextRevision &&
        !['map_ended', 'map_player_snapshot', 'map_started', 'map_epoch_changed'].includes(
          event.kind,
        )) ||
      bundle.program.cursor.liveSessionId !== event.cursor.liveSessionId ||
      (bundle.program.cursor.mapEpoch !== event.cursor.mapEpoch &&
        !['map_ended', 'map_player_snapshot', 'map_started', 'map_epoch_changed'].includes(
          event.kind,
        )) ||
      bundle.program.cursor.programSourceGeneration !== event.cursor.programSourceGeneration
    )
      return false;
    return true;
  }

  private canSend(event: ReliableEventV1, lineup?: readonly string[]): boolean {
    const bundle = this.bundle;
    const recorded = this.outbox
      ?.getRecords()
      .find((record) => record.event.idempotencyKey === event.idempotencyKey);
    if (recorded?.awaitingSource) return false;
    const recordedSource = recorded?.source;
    const detached =
      recorded &&
      (this.binding?.context.matchId !== event.matchId ||
        bundle?.program.cursor.producerInstanceId !== event.cursor.producerInstanceId ||
        bundle?.program.cursor.liveSessionId !== event.cursor.liveSessionId);
    if (detached && this.options.exactSource && !recordedSource) return false;
    if (
      (recordedSource &&
        JSON.stringify(recordedSource) !==
          JSON.stringify(this.sourceFor(event.matchId, event.cursor))) ||
      (detached && !this.options.exactSource)
    ) {
      // The sink revalidates this exact durable authority, never the current selection's claim.
      // Missing authority pauses delivery; changing selection does not cancel accepted work.
      return (
        !this.quarantined &&
        (event.kind !== 'map_started' || recorded.lineupSteam64?.length === 10) &&
        !this.outbox?.hasUnconfirmedBoundary(event) &&
        !this.outbox
          ?.getBoundaryIntents()
          .some(
            (intent) =>
              intent.event.matchId === event.matchId &&
              sameSourceSession(intent.event.cursor, event.cursor),
          )
      );
    }
    if (this.binding?.context.matchId === event.matchId && !this.executionEligible(this.binding))
      return false;
    const scope = this.boundaryScope(event.matchId, event.cursor);
    if (this.boundaryCommitIsPending(scope) || this.outbox?.hasBoundaryGap(scope)) return false;
    if (
      this.outbox
        ?.getBoundaryIntents(scope)
        .some((intent) => intent.event.cursor.runtimeSeq <= event.cursor.runtimeSeq)
    )
      return false;
    const qualification = this.outbox
      ?.getRecords()
      .find(
        (record) => record.event.idempotencyKey === event.idempotencyKey,
      )?.boundaryQualification;
    if (qualification)
      return Boolean(
        !this.quarantined &&
        this.binding &&
        this.binding.context.matchId === event.matchId &&
        bundle?.program.cursor.producerInstanceId === event.cursor.producerInstanceId &&
        bundle.program.cursor.liveSessionId === event.cursor.liveSessionId &&
        bundle.program.cursor.programSourceGeneration === event.cursor.programSourceGeneration &&
        bundle.program.cursor.mapEpoch >= event.cursor.mapEpoch &&
        this.binding.origin === 'online' &&
        this.binding.freshness === 'fresh' &&
        bundle?.program.status.context === 'fresh' &&
        bundle.program.series?.status !== 'completed' &&
        this.options.isActiveOnlineBinding?.(this.binding) &&
        qualification.authorityFingerprint === this.boundaryAuthority() &&
        qualification.planFingerprint === manifestPlanFingerprint(this.binding.manifest) &&
        this.isCurrentForRetry(event, lineup),
      );
    if (
      this.quarantined ||
      bundle === undefined ||
      this.binding?.freshness !== 'fresh' ||
      !this.isCurrentForRetry(event, lineup)
    )
      return false;
    if (
      (event.kind === 'source_generation_changed' || event.kind === 'map_epoch_changed') &&
      (bundle.program.cursor.mapEpoch !== event.cursor.mapEpoch ||
        bundle.program.cursor.programSourceGeneration !== event.cursor.programSourceGeneration ||
        this.binding.manifest.revision !== event.contextRevision)
    )
      return event.evidence.contextFresh;
    if (
      (event.kind === 'map_player_snapshot' ||
        (['map_started', 'map_epoch_changed', 'map_ended'].includes(event.kind) &&
          bundle.program.cursor.mapEpoch !== event.cursor.mapEpoch)) &&
      bundle.program.cursor.producerInstanceId === event.cursor.producerInstanceId
    ) {
      if (event.kind === 'map_epoch_changed') return event.evidence.contextFresh;
      return (
        (event.kind !== 'map_started' || lineup !== undefined) &&
        event.evidence.telemetryFresh &&
        event.evidence.contextFresh &&
        (event.evidence.identity === 'matched' || event.evidence.lineupMismatchOnly === true)
      );
    }
    if (
      event.kind === 'map_ended' &&
      event.evidence.lineupMismatchOnly === true &&
      hasLineupMismatchOnly(bundle, this.binding)
    )
      return (
        bundle.program.map.phase === 'gameover' &&
        bundle.program.map.name === event.mapName &&
        bundle.program.map.score.ct === event.payload.scoreCT &&
        bundle.program.map.score.t === event.payload.scoreT
      );
    if (event.kind === 'map_ended') {
      const series = bundle.program.series;
      const mapOrder = series?.currentMapOrder ?? series?.roundHistory?.mapOrder ?? null;
      const resultMap =
        mapOrder === null ? undefined : series?.maps.find((map) => map.mapOrder === mapOrder);
      if (
        bundle.program.map.phase !== 'gameover' ||
        bundle.program.map.name !== event.mapName ||
        bundle.program.map.score.ct !== event.payload.scoreCT ||
        bundle.program.map.score.t !== event.payload.scoreT ||
        resultMap?.status !== 'completed' ||
        resultMap.finalScore === null ||
        resultMap.mapId !== event.mapId ||
        resultMap.mapName !== event.mapName ||
        resultMap.finalScore.a !== event.payload.scoreA ||
        resultMap.finalScore.b !== event.payload.scoreB
      )
        return false;
    }
    if (event.kind === 'identity_mismatch' || event.kind === 'lineup_mismatch')
      return (
        bundle.program.status.identity === 'mismatch' ||
        bundle.program.status.identity === 'degraded'
      );
    return (
      bundle.program.status.telemetry === 'fresh' &&
      (bundle.program.status.identity === 'matched' ||
        ([
          'map_started',
          'match_started',
          'map_epoch_changed',
          'source_generation_changed',
        ].includes(event.kind) &&
          (event.evidence.lineupMismatchOnly === true ||
            event.kind === 'map_epoch_changed' ||
            event.kind === 'source_generation_changed') &&
          hasLineupMismatchOnly(bundle, this.binding)))
    );
  }

  private stopping: Promise<void> | undefined;
  stopDelivery(): Promise<void> {
    this.stopping ??= this.stopDeliveryOnce();
    return this.stopping;
  }
  async close(): Promise<void> {
    try {
      await this.stopDelivery();
    } finally {
      await this.outbox?.close();
    }
  }
  private async stopDeliveryOnce(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.outboundTimer !== undefined) clearInterval(this.outboundTimer);
    const results = await Promise.allSettled([
      Promise.resolve().then(() => this.outboundUnsubscribe?.()),
    ]);
    results.push(
      ...(await Promise.allSettled(
        [...this.consumers.keys()].map((consumer) =>
          Promise.resolve().then(() => consumer.close()),
        ),
      )),
    );
    this.consumers.clear();
    // retry() can enqueue more durable work after its current queue operation.
    // closed prevents a new retry, but an already running retry must settle.
    await this.retryCompletion;
    try {
      await this.outbox?.flushForShutdown();
    } catch (error) {
      results.push({ status: 'rejected', reason: error });
    }
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length) throw new AggregateError(failures, 'output_local_shutdown_failed');
  }
}
