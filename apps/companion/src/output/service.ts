import type { RuntimeReduceResult } from '@mizar/core/runtime';
import type { LiveSnapshotV1, ReliableEventV2 } from '@mizar/protocol/output';
import type { MatchContextBinding } from '../match-context/index.js';
import type { ExactSource } from '../match-context/rivalhub-source-state.js';
import type { ProgramCommitResult } from '../runtime/program-runtime.js';
import type { ProjectionBundle } from '../projections/projection-coordinator.js';
import { createLatestWinsConsumer, type LatestWinsConsumer } from '../runtime/latest-wins.js';
import {
  buildReliableEventV2,
  extractMapRosterSnapshot,
  liveSnapshotBlockedReason,
  projectLiveSnapshotV1,
  type LiveSnapshotBlockedReason,
  type MapRosterSnapshot,
  type ReliableMapResult,
} from './projector.js';
import type { ReliableEventSink } from './reliable-delivery.js';
import type { ReliableOutbox, ReliableOutboxRecord } from './reliable-outbox.js';

export interface LiveSnapshotStatus {
  readonly snapshot: LiveSnapshotV1 | null;
  readonly blockedReason:
    | LiveSnapshotBlockedReason
    | 'projection_unavailable'
    | 'output_unavailable'
    | 'output_quarantined'
    | 'snapshot_projection_failed'
    | null;
}

export interface LiveSnapshotConsumer {
  send(snapshot: LiveSnapshotV1): Promise<void>;
}

export interface OutputServiceOptions {
  readonly outbox?: ReliableOutbox;
  readonly sink?: ReliableEventSink;
  readonly liveSink?: LiveSnapshotConsumer;
  readonly now?: () => Date;
  readonly exactSource?: () => ExactSource | undefined;
  readonly isActiveOnlineBinding?: (binding: MatchContextBinding) => boolean;
  readonly isExecutionOwnedBy?: (binding: MatchContextBinding) => boolean;
  readonly onDiagnostic?: (code: string) => void;
  readonly onOutboxLoadError?: (error: unknown) => void;
}

const FLUSH_INTERVAL_MS = 2_000;

export class OutputService {
  private readonly consumers = new Map<LatestWinsConsumer<LiveSnapshotV1>, boolean>();
  private readonly mapRosterCache = new Map<string, MapRosterSnapshot>();
  private readonly outbox: ReliableOutbox | undefined;
  private readonly sink: ReliableEventSink | undefined;
  private readonly now: () => Date;
  private bundle: ProjectionBundle | undefined;
  private priorForMutation: ProjectionBundle | undefined;
  private binding: MatchContextBinding | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  private trialQuarantined = false;
  private outboxLoadFailed = false;
  private lastMapStartedScope: string | undefined;

  constructor(private readonly options: OutputServiceOptions = {}) {
    this.outbox = options.outbox;
    this.sink = options.sink;
    this.now = options.now ?? (() => new Date());
    if (options.liveSink) this.subscribe(options.liveSink, true);
  }

  async start(): Promise<void> {
    if (this.closed) return;
    if (this.outbox) {
      try {
        await this.outbox.load();
      } catch (error) {
        this.outboxLoadFailed = true;
        this.options.onOutboxLoadError?.(error);
      }
    }
    if (this.outbox?.isReady() && this.sink && !this.timer) {
      this.timer = setInterval(() => {
        void this.flushOutbox();
      }, FLUSH_INTERVAL_MS);
      this.timer.unref();
      void this.flushOutbox();
    }
  }

  private async flushOutbox(): Promise<void> {
    if (this.closed || !this.outbox?.isReady() || !this.sink) return;
    try {
      await this.outbox.flush(this.sink, this.now());
    } catch {
      // Retry on next interval; never block local projection.
    }
  }

  async setQuarantined(value: boolean): Promise<void> {
    this.trialQuarantined = value;
  }

  setBinding(binding: MatchContextBinding | undefined): void {
    this.binding = binding;
    this.offerLive();
    if (this.bundle) {
      this.updateMapRosterCache(this.bundle, this.binding);
      this.enqueueConfirmedMapEnded(this.bundle, this.binding, this.now().toISOString());
    }
  }

  beforeRuntimeMutation(): void {
    this.priorForMutation = this.bundle;
  }

  setCurrent(bundle: ProjectionBundle | undefined, binding?: MatchContextBinding): void {
    this.bundle = bundle;
    if (binding !== undefined) this.binding = binding;
    this.offerLive();
    if (bundle) {
      this.updateMapRosterCache(bundle, this.binding);
      this.enqueueConfirmedMapEnded(bundle, this.binding, this.now().toISOString());
    }
  }

  afterRuntimeMutation(
    result: RuntimeReduceResult | ProgramCommitResult,
    bundle: ProjectionBundle,
    binding?: MatchContextBinding,
  ): void {
    const previous = this.priorForMutation;
    this.priorForMutation = undefined;
    this.bundle = bundle;
    if (binding !== undefined) this.binding = binding;
    this.offerLive();

    const activeBinding = this.binding;
    this.updateMapRosterCache(bundle, activeBinding);
    const observedAt =
      result.state.programTelemetry?.receive.receivedAt ??
      result.transitions[0]?.at.utc ??
      this.now().toISOString();
    this.enqueueConfirmedMapEnded(bundle, activeBinding, observedAt);

    if (this.closed || this.trialQuarantined || !this.outbox?.isReady()) return;
    if (!this.isEligibleForStartEnqueue(bundle, activeBinding)) return;

    const authorityRevision = this.options.exactSource?.()?.authorityRevision ?? 1;

    const enqueueKind = (kind: Exclude<ReliableEventV2['kind'], 'map_ended'>) => {
      try {
        const event = buildReliableEventV2({
          kind,
          bundle,
          binding: activeBinding,
          observedAt,
          authorityRevision,
        });
        if (event) this.outbox!.enqueue(event, this.now());
      } catch {
        this.options.onDiagnostic?.('event_projection_failed');
      }
    };

    if (
      previous?.program.series?.status !== 'live' &&
      bundle.program.series?.status === 'live' &&
      bundle.program.status.identity === 'matched'
    ) {
      enqueueKind('match_started');
    }

    const lineupReady =
      bundle.operator.activeLineup.ctCount === 5 && bundle.operator.activeLineup.tCount === 5;
    if (
      bundle.program.map.phase === 'live' &&
      lineupReady &&
      bundle.program.status.identity === 'matched'
    ) {
      const scope = `${activeBinding!.context.matchId}:${bundle.program.cursor.producerInstanceId}:${bundle.program.cursor.liveSessionId ?? ''}:${bundle.program.cursor.mapEpoch}:${bundle.program.map.name ?? ''}`;
      if (this.lastMapStartedScope !== scope) {
        this.lastMapStartedScope = scope;
        enqueueKind('map_started');
      }
    }

    void this.flushOutbox();
  }

  private updateMapRosterCache(
    bundle: ProjectionBundle,
    binding: MatchContextBinding | undefined,
  ): void {
    if (
      !binding ||
      binding.origin !== 'online' ||
      binding.context.competition === null ||
      bundle.program.match?.matchId !== binding.context.matchId ||
      bundle.program.status.identity === 'mismatch' ||
      bundle.program.status.telemetry !== 'fresh' ||
      !bundle.program.map.name
    )
      return;
    const roster = extractMapRosterSnapshot(bundle);
    if (!roster.lineupSteam64.length && !roster.players.length) return;
    const key = `${binding.context.matchId}:${bundle.program.map.name}`;
    const existing = this.mapRosterCache.get(key);
    if (roster.lineupSteam64.length === 10 || !existing || existing.lineupSteam64.length < 10) {
      this.mapRosterCache.delete(key);
      this.mapRosterCache.set(key, {
        lineupSteam64: roster.lineupSteam64.length
          ? roster.lineupSteam64
          : (existing?.lineupSteam64 ?? []),
        players: roster.players.length ? roster.players : (existing?.players ?? []),
        ...(roster.scoreCT !== undefined && roster.scoreT !== undefined
          ? { scoreCT: roster.scoreCT, scoreT: roster.scoreT }
          : existing?.scoreCT !== undefined && existing?.scoreT !== undefined
            ? { scoreCT: existing.scoreCT, scoreT: existing.scoreT }
            : {}),
      });
      if (this.mapRosterCache.size > 32) {
        const oldest = this.mapRosterCache.keys().next().value;
        if (oldest !== undefined) this.mapRosterCache.delete(oldest);
      }
    }
  }

  private enqueueConfirmedMapEnded(
    bundle: ProjectionBundle,
    binding: MatchContextBinding | undefined,
    observedAt: string,
  ): void {
    if (this.closed || this.trialQuarantined || !this.outbox?.isReady()) return;
    if (
      !binding ||
      binding.origin !== 'online' ||
      binding.context.competition === null ||
      bundle.program.match?.matchId !== binding.context.matchId ||
      bundle.program.status.identity === 'mismatch' ||
      bundle.program.cursor.liveSessionId === null
    )
      return;
    if (this.options.isActiveOnlineBinding && !this.options.isActiveOnlineBinding(binding)) return;
    if (this.options.isExecutionOwnedBy && !this.options.isExecutionOwnedBy(binding)) return;

    const completed: ReliableMapResult[] = [];
    for (const map of bundle.program.series?.maps ?? []) {
      if (map.status === 'completed' && map.finalScore) {
        completed.push({
          mapId: map.mapId,
          mapName: map.mapName,
          scoreA: map.finalScore.a,
          scoreB: map.finalScore.b,
        });
      }
    }

    const currentSeriesMap = bundle.program.series?.maps.find(
      (item) => item.mapOrder === bundle.program.series?.currentMapOrder,
    );
    if (
      bundle.program.map.phase === 'gameover' &&
      currentSeriesMap &&
      bundle.program.map.score.ct !== null &&
      bundle.program.map.score.t !== null &&
      !completed.some((item) => item.mapName === currentSeriesMap.mapName)
    ) {
      completed.push({
        mapId: currentSeriesMap.mapId,
        mapName: currentSeriesMap.mapName,
        scoreA:
          bundle.operator.identity.sideMapping.a === 'CT'
            ? bundle.program.map.score.ct
            : bundle.program.map.score.t,
        scoreB:
          bundle.operator.identity.sideMapping.b === 'CT'
            ? bundle.program.map.score.ct
            : bundle.program.map.score.t,
      });
    }

    if (!completed.length) return;
    const authorityRevision = this.options.exactSource?.()?.authorityRevision ?? 1;
    let enqueuedAny = false;
    for (const completedMap of completed) {
      const cached = this.mapRosterCache.get(`${binding.context.matchId}:${completedMap.mapName}`);
      const sameCurrentMap = bundle.program.map.name === completedMap.mapName;
      const currentRoster = sameCurrentMap ? extractMapRosterSnapshot(bundle) : undefined;
      const roster =
        currentRoster && (currentRoster.lineupSteam64.length === 10 || !cached)
          ? currentRoster
          : (cached ?? currentRoster);
      try {
        const event = buildReliableEventV2({
          kind: 'map_ended',
          bundle,
          binding,
          observedAt,
          authorityRevision,
          completedMap,
          ...(roster ? { roster } : {}),
        });
        if (event && this.outbox.enqueue(event, this.now())) enqueuedAny = true;
      } catch {
        this.options.onDiagnostic?.('event_projection_failed');
      }
    }
    if (enqueuedAny) void this.flushOutbox();
  }

  private isEligibleForStartEnqueue(
    bundle: ProjectionBundle,
    binding: MatchContextBinding | undefined,
  ): boolean {
    if (!binding || binding.origin !== 'online' || binding.context.competition === null)
      return false;
    if (binding.freshness !== 'fresh' || bundle.program.status.context !== 'fresh') return false;
    if (bundle.program.match?.matchId !== binding.context.matchId) return false;
    if (bundle.program.status.telemetry !== 'fresh') return false;
    if (bundle.program.status.identity === 'mismatch') return false;
    if (this.options.isActiveOnlineBinding && !this.options.isActiveOnlineBinding(binding))
      return false;
    if (this.options.isExecutionOwnedBy && !this.options.isExecutionOwnedBy(binding)) return false;
    return true;
  }

  currentStatus(includeRadar = false): LiveSnapshotStatus {
    if (this.closed) return { snapshot: null, blockedReason: 'output_unavailable' };
    if (this.trialQuarantined) return { snapshot: null, blockedReason: 'output_quarantined' };
    if (!this.bundle) return { snapshot: null, blockedReason: 'projection_unavailable' };
    const blocked = liveSnapshotBlockedReason(this.bundle, this.binding);
    if (blocked) return { snapshot: null, blockedReason: blocked };
    try {
      const snapshot = projectLiveSnapshotV1({
        bundle: this.bundle,
        binding: this.binding,
        producedAt: this.now().toISOString(),
        includeRadar,
      });
      return snapshot
        ? { snapshot, blockedReason: null }
        : { snapshot: null, blockedReason: 'projection_unavailable' };
    } catch {
      return { snapshot: null, blockedReason: 'snapshot_projection_failed' };
    }
  }

  current(includeRadar = false): LiveSnapshotV1 | null {
    return this.currentStatus(includeRadar).snapshot;
  }

  subscribe(consumer: LiveSnapshotConsumer, includeRadar = false): () => void {
    const wrapped = createLatestWinsConsumer<LiveSnapshotV1>({
      id: 'live-snapshot',
      send: (snapshot) => consumer.send(snapshot),
    });
    this.consumers.set(wrapped, includeRadar);
    const snapshot = this.current(includeRadar);
    if (snapshot) wrapped.offer(snapshot);
    return () => {
      this.consumers.delete(wrapped);
      void wrapped.close();
    };
  }

  private offerLive(): void {
    if (this.closed || this.trialQuarantined || !this.consumers.size) return;
    for (const [consumer, includeRadar] of this.consumers) {
      const snapshot = this.current(includeRadar);
      if (snapshot) consumer.offer(snapshot);
    }
  }

  async retry(): Promise<void> {
    await this.flushOutbox();
  }

  isReliableAvailable(): boolean {
    return !this.closed && !this.outboxLoadFailed && (this.outbox?.isReady() ?? false);
  }

  isPersistenceConfirmed(): boolean {
    return this.isReliableAvailable();
  }

  getReliableRecords(): readonly ReliableOutboxRecord[] {
    return this.outbox?.records() ?? [];
  }

  stopDelivery(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    for (const consumer of this.consumers.keys()) void consumer.close();
    this.consumers.clear();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopDelivery();
    await this.outbox?.close();
  }
}
