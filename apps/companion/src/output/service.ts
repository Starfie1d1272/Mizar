import type { RuntimeReduceResult } from '@mizar/core/runtime';
import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';

import type { MatchContextBinding } from '../match-context/index.js';
import type { ProjectionBundle } from '../projections/projection-coordinator.js';
import { createLatestWinsConsumer, type LatestWinsConsumer } from '../runtime/latest-wins.js';
import {
  ReliableOutbox,
  type DeliveryContinuity,
  type ReliableEventSink,
} from './reliable-outbox.js';
import {
  buildReliableEventV1,
  projectLiveSnapshotV1,
  transitionReliableEventsV1,
} from './projector.js';

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
  readonly onDiagnostic?: (code: string) => void;
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
  private binding: MatchContextBinding | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private quarantined = false;
  async setQuarantined(value: boolean): Promise<void> {
    this.quarantined = value;
    if (value) await this.outbox?.flushPending();
  }
  private mapStartScope: string | undefined;
  private mapStartRevision = 0;
  private publishedMapStart: { revision: number; key: string } | undefined;
  private pendingMapStart: { revision: number; key: string } | undefined;
  private lastMapObservation: ReliableEventV1['cursor'] | undefined;
  private recoveredCursor: ReliableEventV1['cursor'] | undefined;
  private retryPending = false;
  private outboundUnsubscribe: (() => Promise<void>) | undefined;
  private outboundTimer: ReturnType<typeof setInterval> | undefined;
  private lastBundleAt = 0;

  constructor(private readonly options: OutputServiceOptions = {}) {
    this.outbox = options.outbox;
    this.sink = options.sink;
    this.now = options.now ?? (() => new Date());
    this.onDiagnostic = options.onDiagnostic;
  }

  async start(): Promise<void> {
    await this.outbox?.load();
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
          return current !== null && current.cursor.liveSessionId === snapshot.cursor.liveSessionId
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

  setCurrent(bundle: ProjectionBundle, binding: MatchContextBinding | undefined): void {
    if (this.closed) return;
    this.bundle = bundle;
    this.lastBundleAt = this.now().getTime();
    this.binding = binding;
    this.updateMapStartScope(bundle, binding);
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
      program.status.identity === 'matched' &&
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

  beforeRuntimeMutation(): void {
    this.priorForMutation = this.bundle;
  }

  current(includeRadar = false): LiveSnapshotV1 | null {
    if (this.bundle === undefined) return null;
    return this.safeProject(this.bundle, this.binding, this.now().toISOString(), includeRadar);
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
    result: RuntimeReduceResult,
    bundle: ProjectionBundle,
    binding: MatchContextBinding | undefined,
  ): void {
    if (this.closed || result.disposition.kind !== 'accepted') return;
    const previous = this.priorForMutation ?? this.bundle;
    this.priorForMutation = undefined;
    const now = this.now().toISOString();
    if (this.bundle !== bundle || this.binding !== binding) this.setCurrent(bundle, binding);

    if (this.quarantined || binding?.origin === 'fixture') {
      return;
    }

    const continuity: DeliveryContinuity | undefined =
      binding === undefined
        ? undefined
        : {
            matchId: binding.context.matchId,
            contextRevision: binding.manifest.revision,
            cursor: bundle.program.cursor,
            mapName: result.state.map.name ?? null,
            savedAt: now,
          };
    if (continuity !== undefined)
      void this.outbox
        ?.updateContinuity(continuity)
        .catch(() => this.onDiagnostic?.('outbox_continuity_write_failed'));
    const newMapObservation = this.newMapObservation(result, bundle);
    let candidates: ReliableEventV1[];
    try {
      candidates = [...transitionReliableEventsV1({ result, bundle, binding })];
    } catch {
      this.onDiagnostic?.('event_projection_failed');
      return;
    }
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
    if (result.disposition.reason === 'source-generation-advanced')
      add(
        'source_generation_changed',
        'runtime-continuity',
        null,
        Math.max(0, bundle.program.cursor.programSourceGeneration - 1),
      );
    if (
      previous?.program.series?.status !== 'live' &&
      bundle.program.series?.status === 'live' &&
      bundle.program.status.identity === 'matched'
    )
      add('match_started', 'series-progress');
    if (
      newMapObservation &&
      this.mapStartScope !== undefined &&
      this.publishedMapStart?.revision !== this.mapStartRevision &&
      this.pendingMapStart?.revision !== this.mapStartRevision &&
      this.outbox !== undefined
    ) {
      const event = add('map_started', 'runtime-transition');
      if (event)
        this.pendingMapStart = { revision: this.mapStartRevision, key: event.idempotencyKey };
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
      void this.outbox
        ?.enqueue(event, this.now(), continuity)
        .then(() => {
          if (start !== undefined && start.revision === this.mapStartRevision)
            this.publishedMapStart = start;
        })
        .catch(() => this.onDiagnostic?.('outbox_enqueue_failed'))
        .finally(() => {
          if (start !== undefined && this.pendingMapStart === start)
            this.pendingMapStart = undefined;
        });
    }
  }

  async retry(): Promise<void> {
    if (
      this.closed ||
      this.quarantined ||
      this.outbox === undefined ||
      this.retryPending ||
      this.binding?.origin === 'fixture'
    ) {
      return;
    }
    if (this.bundle !== undefined) this.updateMapStartScope(this.bundle, this.binding);
    this.retryPending = true;
    try {
      if (this.sink === undefined)
        await this.outbox.sweep((event) => this.isCurrentForRetry(event), this.now());
      else
        await this.outbox.flush({
          sink: this.sink,
          now: this.now(),
          isCurrent: (event) => this.quarantined || this.isCurrentForRetry(event),
          canSend: (event) => this.canSend(event),
        });
    } catch {
      this.onDiagnostic?.('outbox_retry_failed');
    } finally {
      this.retryPending = false;
    }
  }

  getReliableRecords() {
    return this.outbox?.getRecords() ?? [];
  }

  private isCurrentForRetry(event: ReliableEventV1): boolean {
    const bundle = this.bundle;
    const binding = this.binding;
    if (bundle === undefined || binding === undefined) return true;
    if (
      event.kind === 'map_started' &&
      ![this.publishedMapStart, this.pendingMapStart].some(
        (start) => start?.revision === this.mapStartRevision && start.key === event.idempotencyKey,
      )
    )
      return false;
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
      binding.manifest.revision !== event.contextRevision ||
      bundle.program.cursor.liveSessionId !== event.cursor.liveSessionId ||
      bundle.program.cursor.mapEpoch !== event.cursor.mapEpoch ||
      bundle.program.cursor.programSourceGeneration !== event.cursor.programSourceGeneration
    )
      return false;
    return true;
  }

  private canSend(event: ReliableEventV1): boolean {
    const bundle = this.bundle;
    if (
      this.quarantined ||
      bundle === undefined ||
      this.binding?.freshness !== 'fresh' ||
      !this.isCurrentForRetry(event)
    )
      return false;
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
      bundle.program.status.identity === 'matched' && bundle.program.status.telemetry === 'fresh'
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    if (this.outboundTimer !== undefined) clearInterval(this.outboundTimer);
    await this.outboundUnsubscribe?.();
    await Promise.all([...this.consumers.keys()].map((consumer) => consumer.close()));
    this.consumers.clear();
    await this.outbox?.flushPending();
  }
}
