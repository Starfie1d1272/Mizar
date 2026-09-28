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
  private startedMapEpoch: number | undefined;
  private recoveredCursor: ReliableEventV1['cursor'] | undefined;
  private retryPending = false;
  private outboundUnsubscribe: (() => Promise<void>) | undefined;

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
        this.startedMapEpoch = restored.program.cursor.mapEpoch;
      }
    }
    if (this.options.liveSink !== undefined)
      this.outboundUnsubscribe = this.subscribe(this.options.liveSink);
    if (this.outbox !== undefined) {
      this.timer = setInterval(() => {
        void this.retry();
      }, 1_000);
      this.timer.unref();
      await this.retry();
    }
  }

  setCurrent(bundle: ProjectionBundle, binding: MatchContextBinding | undefined): void {
    if (this.closed) return;
    this.bundle = bundle;
    this.binding = binding;
    const producedAt = this.now().toISOString();
    for (const [consumer, includeRadar] of this.consumers) {
      const snapshot = this.safeProject(bundle, binding, producedAt, includeRadar);
      if (snapshot !== null) consumer.offer(snapshot);
    }
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
    };
    if (result.disposition.reason === 'source-generation-advanced')
      add(
        'source_generation_changed',
        'runtime-continuity',
        null,
        Math.max(0, bundle.program.cursor.programSourceGeneration - 1),
      );
    if (
      result.state.programTelemetry !== undefined &&
      bundle.program.cursor.mapEpoch > 0 &&
      this.startedMapEpoch !== bundle.program.cursor.mapEpoch &&
      bundle.program.map.name !== null &&
      bundle.program.map.phase === 'live' &&
      binding?.freshness === 'fresh' &&
      bundle.program.status.telemetry === 'fresh' &&
      bundle.program.status.identity === 'matched'
    ) {
      add('map_started', 'runtime-transition');
      this.startedMapEpoch = bundle.program.cursor.mapEpoch;
    }
    if (
      previous?.program.series?.status !== 'live' &&
      bundle.program.series?.status === 'live' &&
      bundle.program.status.identity === 'matched'
    )
      add('match_started', 'series-progress');
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
      void this.outbox
        ?.enqueue(event, this.now(), continuity)
        .catch(() => this.onDiagnostic?.('outbox_enqueue_failed'));
    }
  }

  async retry(): Promise<void> {
    if (this.closed || this.outbox === undefined || this.retryPending) return;
    this.retryPending = true;
    try {
      if (this.sink === undefined)
        await this.outbox.sweep((event) => this.isCurrentForRetry(event), this.now());
      else
        await this.outbox.flush({
          sink: this.sink,
          now: this.now(),
          isCurrent: (event) => this.isCurrentForRetry(event),
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
    await this.outboundUnsubscribe?.();
    await Promise.all([...this.consumers.keys()].map((consumer) => consumer.close()));
    this.consumers.clear();
    await this.outbox?.flushPending();
  }
}
