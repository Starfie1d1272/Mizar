import type { RuntimeReduceResult } from '@mizar/core/runtime';
import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';

import type { MatchContextBinding } from '../match-context/index.js';
import type { ProjectionBundle } from '../projections/projection-coordinator.js';
import { createLatestWinsConsumer, type LatestWinsConsumer } from '../runtime/latest-wins.js';
import { ReliableOutbox, type ReliableEventSink } from './reliable-outbox.js';
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

  constructor(options: OutputServiceOptions = {}) {
    this.outbox = options.outbox;
    this.sink = options.sink;
    this.now = options.now ?? (() => new Date());
    this.onDiagnostic = options.onDiagnostic;
  }

  async start(): Promise<void> {
    await this.outbox?.load();
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
      send: (snapshot) => consumer.send(snapshot),
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
          observedAt: now,
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
      previous !== undefined &&
      bundle.program.cursor.mapEpoch > 0 &&
      previous.program.cursor.mapEpoch === 0 &&
      bundle.program.map.name !== null
    )
      add('map_started', 'series-progress');
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
        ?.enqueue(event, this.now())
        .catch(() => this.onDiagnostic?.('outbox_enqueue_failed'));
    }
  }

  async retry(): Promise<void> {
    if (this.closed || this.outbox === undefined) return;
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
    }
  }

  getReliableRecords() {
    return this.outbox?.getRecords() ?? [];
  }

  private isCurrentForRetry(event: ReliableEventV1): boolean {
    const bundle = this.bundle;
    const binding = this.binding;
    if (
      bundle === undefined ||
      binding === undefined ||
      binding.freshness !== 'fresh' ||
      binding.context.matchId !== event.matchId ||
      binding.manifest.revision !== event.contextRevision ||
      bundle.program.cursor.producerInstanceId !== event.cursor.producerInstanceId ||
      bundle.program.cursor.liveSessionId !== event.cursor.liveSessionId ||
      bundle.program.cursor.mapEpoch !== event.cursor.mapEpoch ||
      bundle.program.cursor.programSourceGeneration !== event.cursor.programSourceGeneration
    )
      return false;
    return true;
  }

  private canSend(event: ReliableEventV1): boolean {
    const bundle = this.bundle;
    if (bundle === undefined || !this.isCurrentForRetry(event)) return false;
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
    await Promise.all([...this.consumers.keys()].map((consumer) => consumer.close()));
    this.consumers.clear();
    await this.outbox?.flushPending();
  }
}
