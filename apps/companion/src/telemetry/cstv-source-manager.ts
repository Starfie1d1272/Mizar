import type { RoleScopedGameEventObservation, GameEventSourceRole } from '@mizar/core/game-events';
import {
  normalizeObserverGameEvent,
  observerEventTick,
  SUPPORTED_CSTV_GAME_EVENT_NAMES,
  type CstvDiagnostic,
  type CstvDiagnosticCode,
  type CstvObservationClock,
} from '@mizar/telemetry-cstv';

export const CSTV_RECENT_GAME_EVENTS_MAX = 64;
export const CSTV_RECENT_DIAGNOSTICS_MAX = 32;

export type CstvSourceState =
  'disabled' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'stopped' | 'failed';

export interface CstvSourceHealth<R extends GameEventSourceRole = GameEventSourceRole> {
  readonly role: R;
  readonly state: CstvSourceState;
  readonly generation: number;
  readonly lastReceiveMonotonicMs?: number;
  readonly mapName?: string;
  readonly tailTick?: number;
  readonly lastEventTick?: number;
  readonly lastEventSequence?: number;
  readonly lastEventObservedAt?: string;
  readonly lastErrorCode?: CstvDiagnosticCode;
}

export interface CstvSourceSnapshot<R extends GameEventSourceRole = GameEventSourceRole> {
  readonly health: CstvSourceHealth<R>;
  readonly recentGameEvents: readonly RoleScopedGameEventObservation<R>[];
  readonly recentDiagnostics: readonly CstvDiagnostic[];
}

export interface CstvSourceManagerOptions<R extends GameEventSourceRole = GameEventSourceRole> {
  readonly role: R;
  readonly observerManaged?: boolean;
  readonly clock?: CstvObservationClock;
}

export interface CstvSourceManager<R extends GameEventSourceRole = GameEventSourceRole> {
  readonly role: R;
  start(): void;
  stop(): Promise<void>;
  getHealth(): CstvSourceHealth<R>;
  getRecentGameEvents(): readonly RoleScopedGameEventObservation<R>[];
  getRecentDiagnostics(): readonly CstvDiagnostic[];
  getSnapshot(): CstvSourceSnapshot<R>;
  subscribe(listener: () => void): () => void;
  subscribeLiveGameEvents(listener: (event: RoleScopedGameEventObservation<R>) => void): () => void;
  subscribeTimelineReset?(listener: () => void): () => void;
}

export interface ObserverSourceManager<R extends GameEventSourceRole> extends CstvSourceManager<R> {
  disconnectObserver(reason: 'failed' | 'ended'): void;
  consumeObserverRecord(input: unknown): void;
}

function appendBounded<T>(items: T[], item: T, max: number): void {
  items.push(item);
  const overflow = items.length - max;
  if (overflow > 0) items.splice(0, overflow);
}

class DefaultCstvSourceManager<R extends GameEventSourceRole> implements ObserverSourceManager<R> {
  readonly role: R;

  private readonly observerManaged: boolean;
  private readonly clock: CstvObservationClock | undefined;
  private readonly recentGameEvents: RoleScopedGameEventObservation<R>[] = [];
  private readonly recentDiagnostics: CstvDiagnostic[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly liveGameEventListeners = new Set<
    (event: RoleScopedGameEventObservation<R>) => void
  >();
  private readonly timelineResetListeners = new Set<() => void>();
  private state: CstvSourceState;
  private generation = 0;
  private lastReceiveMonotonicMs: number | undefined;
  private tailTick: number | undefined;
  private lastEventTick: number | undefined;
  private lastEventSequence: number | undefined;
  private lastEventObservedAt: string | undefined;
  private lastErrorCode: CstvDiagnosticCode | undefined;
  private observerChannelOpen = false;
  private observerChannel = 0;
  private observerWorld = 1;
  private observerSequence = 0;
  private observerMap: string | undefined;
  private observerTicksPerSecond: number | undefined;
  private started = false;
  private stopRequested = false;

  constructor(options: CstvSourceManagerOptions<R>) {
    this.role = options.role;
    this.observerManaged = options.observerManaged === true;
    this.clock = options.clock;
    this.state = this.observerManaged ? 'stopped' : 'disabled';
  }

  start(): void {
    if (!this.observerManaged || this.started || this.stopRequested) return;
    this.started = true;
    this.state = 'connecting';
    this.notifySnapshotChanged();
  }

  async stop(): Promise<void> {
    if (this.stopRequested) return;
    this.stopRequested = true;
    if (this.observerManaged) {
      this.resetObserverContinuity('stopped');
    }
  }

  getHealth(): CstvSourceHealth<R> {
    return {
      role: this.role,
      state: this.state,
      generation: this.generation,
      ...(this.lastReceiveMonotonicMs === undefined
        ? {}
        : { lastReceiveMonotonicMs: this.lastReceiveMonotonicMs }),
      ...(this.observerMap === undefined ? {} : { mapName: this.observerMap }),
      ...(this.tailTick === undefined ? {} : { tailTick: this.tailTick }),
      ...(this.lastEventTick === undefined ? {} : { lastEventTick: this.lastEventTick }),
      ...(this.lastEventSequence === undefined
        ? {}
        : { lastEventSequence: this.lastEventSequence }),
      ...(this.lastEventObservedAt === undefined
        ? {}
        : { lastEventObservedAt: this.lastEventObservedAt }),
      ...(this.lastErrorCode === undefined ? {} : { lastErrorCode: this.lastErrorCode }),
    };
  }

  getRecentGameEvents(): readonly RoleScopedGameEventObservation<R>[] {
    return this.recentGameEvents.slice();
  }

  getRecentDiagnostics(): readonly CstvDiagnostic[] {
    return this.recentDiagnostics.slice();
  }

  getSnapshot(): CstvSourceSnapshot<R> {
    return {
      health: this.getHealth(),
      recentGameEvents: this.getRecentGameEvents(),
      recentDiagnostics: this.getRecentDiagnostics(),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeLiveGameEvents(
    listener: (event: RoleScopedGameEventObservation<R>) => void,
  ): () => void {
    this.liveGameEventListeners.add(listener);
    return () => this.liveGameEventListeners.delete(listener);
  }

  subscribeTimelineReset(listener: () => void): () => void {
    this.timelineResetListeners.add(listener);
    return () => this.timelineResetListeners.delete(listener);
  }

  disconnectObserver(reason: 'failed' | 'ended'): void {
    if (!this.observerManaged || this.stopRequested) return;
    if (reason === 'ended' && this.state === 'ended' && this.observerMap !== undefined) return;
    this.observerChannelOpen = false;
    this.resetObserverContinuity(reason);
    if (reason === 'failed') this.recordDiagnostic({ code: 'session-run-failed' });
  }

  private resetObserverContinuity(
    state: CstvSourceState = 'connecting',
    cause?: CstvDiagnosticCode,
  ): void {
    this.generation += 1;
    this.observerMap = undefined;
    this.observerTicksPerSecond = undefined;
    this.recentGameEvents.length = 0;
    this.tailTick = undefined;
    this.lastEventTick = undefined;
    this.lastEventSequence = undefined;
    this.lastEventObservedAt = undefined;
    this.lastReceiveMonotonicMs = undefined;
    this.state = state;
    if (cause) this.recordDiagnostic({ code: cause });
    else this.notifySnapshotChanged();
  }

  /** Consume bounded, parsed local observer v3 output. */
  consumeObserverRecord(input: unknown): void {
    if (
      !this.started ||
      this.stopRequested ||
      !this.observerManaged ||
      typeof input !== 'object' ||
      input === null ||
      Array.isArray(input)
    )
      return;
    const row = input as Record<string, unknown>;
    const { kind, sequence, channel, world } = row;
    if (
      typeof kind !== 'string' ||
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence <= this.observerSequence ||
      typeof channel !== 'number' ||
      !Number.isSafeInteger(channel) ||
      typeof world !== 'number' ||
      !Number.isSafeInteger(world)
    )
      return;

    if (kind === 'session-start') {
      if (row.protocol !== 3 || world !== 1 || channel <= this.observerChannel) return;
      if (sequence !== this.observerSequence + 1 || channel !== this.observerChannel + 1)
        this.recordDiagnostic({ code: 'session-run-failed' });
      this.observerSequence = sequence;
      this.observerChannel = channel;
      this.observerWorld = world;
      this.observerChannelOpen = true;
      this.resetObserverContinuity();
      return;
    }
    if (!this.observerChannelOpen || channel !== this.observerChannel) return;
    const worldChange = kind === 'discontinuity' && row.scope === 'world';
    if (worldChange ? world <= this.observerWorld : world !== this.observerWorld) return;
    if (sequence !== this.observerSequence + 1) {
      this.observerChannelOpen = false;
      this.resetObserverContinuity('reconnecting');
      this.recordDiagnostic({ code: 'session-run-failed' });
      return;
    }
    this.observerSequence = sequence;

    if (kind === 'discontinuity') {
      if (row.scope === 'connection') {
        this.observerChannelOpen = false;
        if (
          row.reason === 'source-hltv-stop' &&
          this.role === 'lookahead' &&
          this.state === 'live'
        ) {
          this.state = 'ended';
          this.notifySnapshotChanged();
          return;
        }
      } else if (worldChange) {
        this.observerWorld = world;
      } else if (row.scope !== 'snapshot') {
        this.observerChannelOpen = false;
      }
      this.resetObserverContinuity(this.observerChannelOpen ? 'connecting' : 'reconnecting');
      return;
    }

    if (kind === 'cursor') {
      if (
        typeof row.committedTick !== 'number' ||
        !Number.isSafeInteger(row.committedTick) ||
        row.committedTick < 1 ||
        typeof row.tickInterval !== 'number' ||
        !Number.isFinite(row.tickInterval) ||
        row.tickInterval <= 0 ||
        row.tickInterval > 1 ||
        typeof row.map !== 'string' ||
        row.map.length === 0 ||
        row.map.length > 256
      )
        return;
      this.lastReceiveMonotonicMs = this.receiveNow();
      this.observerMap = row.map;
      this.observerTicksPerSecond = 1 / row.tickInterval;
      this.tailTick = row.committedTick;
      this.state = 'live';
      this.lastErrorCode = undefined;
      this.notifySnapshotChanged();
      return;
    }

    if (kind !== 'event' || this.state !== 'live' || row.map !== this.observerMap) return;
    const name = row.name;
    if (typeof name !== 'string') return;
    if (name === 'begin_new_match' || name === 'round_announce_warmup') {
      for (const listener of [...this.timelineResetListeners]) {
        try {
          listener();
        } catch {
          this.recordDiagnostic({ code: 'event-sink-failed' });
        }
      }
      this.notifySnapshotChanged();
      return;
    }
    if (
      name === 'round_freeze_end' ||
      name === 'round_end' ||
      name === 'round_prestart' ||
      name === 'round_start' ||
      name === 'round_officially_ended'
    )
      return;
    if (!SUPPORTED_CSTV_GAME_EVENT_NAMES.some((supported) => supported === name)) return;

    const residenceUs =
      this.role === 'lookahead' &&
      typeof row.residenceUs === 'number' &&
      Number.isFinite(row.residenceUs) &&
      row.residenceUs >= 0
        ? row.residenceUs
        : undefined;
    const sample = this.clock?.now() ?? {
      observedAt: new Date().toISOString(),
      observedMonotonicMs: performance.now(),
    };
    try {
      const observation = normalizeObserverGameEvent(
        row,
        {
          role: this.role === 'lookahead' ? 'ahead' : 'delayed',
          channel: this.observerChannel,
          world: this.observerWorld,
        },
        {
          cursor: {
            kind: 'cs2-cstv',
            role: this.role,
            generation: this.generation,
            sequence,
            tick: observerEventTick(row),
            observedAt: sample.observedAt,
            observedMonotonicMs: sample.observedMonotonicMs,
            ...(residenceUs !== undefined && sample.observedMonotonicMs >= residenceUs / 1000
              ? { sourceArrivalMonotonicMs: sample.observedMonotonicMs - residenceUs / 1000 }
              : {}),
            ...(this.observerMap === undefined ? {} : { mapName: this.observerMap }),
            ...(this.observerTicksPerSecond === undefined
              ? {}
              : { ticksPerSecond: this.observerTicksPerSecond }),
          },
        },
      ) as RoleScopedGameEventObservation<R>;
      this.handleObservation(this.generation, observation);
    } catch {
      this.recordDiagnostic({ code: 'normalization-failed' });
    }
  }

  private handleObservation(
    generation: number,
    observation: RoleScopedGameEventObservation<R>,
  ): void {
    if (this.stopRequested || this.generation !== generation) return;
    this.lastReceiveMonotonicMs = this.receiveNow();
    appendBounded(this.recentGameEvents, observation, CSTV_RECENT_GAME_EVENTS_MAX);
    this.lastEventTick = observation.cursor.tick;
    this.lastEventSequence = observation.cursor.sequence;
    this.lastEventObservedAt = observation.cursor.observedAt;
    this.notifySnapshotChanged();
    if (this.state !== 'live') return;
    for (const listener of [...this.liveGameEventListeners]) {
      try {
        listener(observation);
      } catch {
        this.recordDiagnostic({ code: 'event-sink-failed' });
      }
    }
  }

  private recordDiagnostic(diagnostic: CstvDiagnostic): void {
    appendBounded(this.recentDiagnostics, diagnostic, CSTV_RECENT_DIAGNOSTICS_MAX);
    this.lastErrorCode = diagnostic.code;
    this.notifySnapshotChanged();
  }

  private receiveNow(): number {
    return this.clock?.now().observedMonotonicMs ?? performance.now();
  }

  private notifySnapshotChanged(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch {
        // A health observer must not affect parser lifecycle or another observer.
      }
    }
  }
}

export function createCstvSourceManager<R extends GameEventSourceRole>(
  options: CstvSourceManagerOptions<R>,
): CstvSourceManager<R> {
  return new DefaultCstvSourceManager<R>(options);
}

export interface CstvSourceManagers {
  readonly program: CstvSourceManager<'program'>;
  readonly lookahead: CstvSourceManager<'lookahead'>;
}

export function createCstvSourceManagers(
  options: {
    readonly clock?: CstvObservationClock;
  } = {},
): CstvSourceManagers {
  return {
    program: createCstvSourceManager({
      role: 'program',
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }),
    lookahead: createCstvSourceManager({
      role: 'lookahead',
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    }),
  };
}

/** Reuse the existing event/health owner; transport process lifecycle stays outside it. */
export function createObserverSourceManager<R extends GameEventSourceRole>(options: {
  readonly role: R;
  readonly clock?: CstvObservationClock;
}): ObserverSourceManager<R> {
  return new DefaultCstvSourceManager({
    role: options.role,
    observerManaged: true,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}

export function selectCstvSources(
  injected: CstvSourceManagers | undefined,
  lookahead: CstvSourceManagers['lookahead'] | undefined,
): CstvSourceManagers {
  const sources = injected ?? createCstvSourceManagers();
  return { ...sources, ...(lookahead ? { lookahead } : {}) };
}
