import type { RoleScopedGameEventObservation, GameEventSourceRole } from '@mizar/core/game-events';
import {
  createCstvLiveSession,
  type CstvDiagnostic,
  type CstvDiagnosticCode,
  type CstvLiveSession,
  type CstvObservationClock,
  type CstvParserSessionFactory,
  type CstvSessionTerminalStatus,
  type CstvSyncMetadata,
} from '@mizar/telemetry-cstv';

export const CSTV_RECENT_GAME_EVENTS_MAX = 64;
export const CSTV_RECENT_DIAGNOSTICS_MAX = 32;
export const CSTV_RECONNECT_BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 10_000] as const;

export type CstvSourceState =
  'disabled' | 'connecting' | 'live' | 'reconnecting' | 'ended' | 'stopped' | 'failed';

export interface CstvSourceHealth<R extends GameEventSourceRole = GameEventSourceRole> {
  readonly role: R;
  readonly state: CstvSourceState;
  readonly generation: number;
  readonly reconnectAttempt: number;
  readonly lastSync?: CstvSyncMetadata;
  readonly tailTick?: number;
  readonly lastEventTick?: number;
  readonly lastEventSequence?: number;
  readonly lastEventObservedAt?: string;
  readonly lastErrorCode?: CstvDiagnosticCode;
  readonly lastTerminalStatus?: CstvSessionTerminalStatus;
}

export interface CstvSourceSnapshot<R extends GameEventSourceRole = GameEventSourceRole> {
  readonly health: CstvSourceHealth<R>;
  readonly recentGameEvents: readonly RoleScopedGameEventObservation<R>[];
  readonly recentDiagnostics: readonly CstvDiagnostic[];
}

export interface CstvScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CstvSourceManagerOptions<R extends GameEventSourceRole = GameEventSourceRole> {
  readonly role: R;
  readonly url?: string;
  readonly parserSessionFactory?: CstvParserSessionFactory;
  readonly clock?: CstvObservationClock;
  readonly scheduler?: CstvScheduler;
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
}

const defaultScheduler: CstvScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Validate an env-provided CSTV URL without ever including it in diagnostics. */
export function parseCstvSourceUrl(value: string | undefined, envName: string): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const normalized = value.trim();
  if (!isValidHttpUrl(normalized)) {
    throw new Error(`${envName} must be a valid http(s) URL`);
  }
  return normalized;
}

function appendBounded<T>(items: T[], item: T, max: number): void {
  items.push(item);
  const overflow = items.length - max;
  if (overflow > 0) items.splice(0, overflow);
}

class DefaultCstvSourceManager<R extends GameEventSourceRole> implements CstvSourceManager<R> {
  readonly role: R;

  private readonly url: string | undefined;
  private readonly parserSessionFactory: CstvParserSessionFactory | undefined;
  private readonly clock: CstvObservationClock | undefined;
  private readonly scheduler: CstvScheduler;
  private readonly recentGameEvents: RoleScopedGameEventObservation<R>[] = [];
  private readonly recentDiagnostics: CstvDiagnostic[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly liveGameEventListeners = new Set<
    (event: RoleScopedGameEventObservation<R>) => void
  >();
  private activeSession: CstvLiveSession<R> | undefined;
  private activeAttempt: Promise<void> | undefined;
  private reconnectTimer: unknown;
  private reconnectScheduled = false;
  private stopPromise: Promise<void> | undefined;
  private state: CstvSourceState;
  private generation = 0;
  private nextGeneration = 0;
  private reconnectAttempt = 0;
  private lastSync: CstvSyncMetadata | undefined;
  private tailTick: number | undefined;
  private lastEventTick: number | undefined;
  private lastEventSequence: number | undefined;
  private lastEventObservedAt: string | undefined;
  private lastErrorCode: CstvDiagnosticCode | undefined;
  private lastTerminalStatus: CstvSessionTerminalStatus | undefined;
  private started = false;
  private stopRequested = false;

  constructor(options: CstvSourceManagerOptions<R>) {
    this.role = options.role;
    this.url = options.url;
    this.parserSessionFactory = options.parserSessionFactory;
    this.clock = options.clock;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.state = this.url === undefined ? 'disabled' : 'stopped';
  }

  start(): void {
    if (this.url === undefined || this.started || this.stopRequested) return;
    this.started = true;
    this.connect();
  }

  async stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.stopRequested = true;
    if (this.reconnectScheduled) {
      this.scheduler.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.reconnectScheduled = false;
    }
    if (this.url !== undefined) {
      this.state = 'stopped';
      this.notifySnapshotChanged();
    }
    this.activeSession?.stop();
    const activeAttempt = this.activeAttempt;
    this.stopPromise = (async () => {
      try {
        await activeAttempt;
      } catch {
        // Shutdown reports the final health state; parser failure is already bounded in diagnostics.
      }
    })();
    return this.stopPromise;
  }

  getHealth(): CstvSourceHealth<R> {
    if (this.refreshTailTick()) this.notifySnapshotChanged();
    return {
      role: this.role,
      state: this.state,
      generation: this.generation,
      reconnectAttempt: this.reconnectAttempt,
      ...(this.lastSync === undefined ? {} : { lastSync: { ...this.lastSync } }),
      ...(this.tailTick === undefined ? {} : { tailTick: this.tailTick }),
      ...(this.lastEventTick === undefined ? {} : { lastEventTick: this.lastEventTick }),
      ...(this.lastEventSequence === undefined
        ? {}
        : { lastEventSequence: this.lastEventSequence }),
      ...(this.lastEventObservedAt === undefined
        ? {}
        : { lastEventObservedAt: this.lastEventObservedAt }),
      ...(this.lastErrorCode === undefined ? {} : { lastErrorCode: this.lastErrorCode }),
      ...(this.lastTerminalStatus === undefined
        ? {}
        : { lastTerminalStatus: this.lastTerminalStatus }),
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

  private connect(): void {
    if (this.stopRequested || this.url === undefined) return;

    const generation = this.nextGeneration;
    this.generation = generation;
    this.lastSync = undefined;
    this.tailTick = undefined;
    this.lastEventTick = undefined;
    this.lastEventSequence = undefined;
    this.lastEventObservedAt = undefined;
    this.lastErrorCode = undefined;
    this.lastTerminalStatus = undefined;
    this.state = 'connecting';
    this.notifySnapshotChanged();

    let attempt: Promise<void>;
    try {
      const session = createCstvLiveSession<R>({
        role: this.role,
        generation,
        url: this.url,
        ...(this.parserSessionFactory === undefined
          ? {}
          : { parserSessionFactory: this.parserSessionFactory }),
        ...(this.clock === undefined ? {} : { clock: this.clock }),
        onSync: (sync) => this.handleSync(generation, sync),
        onObservation: (observation) => this.handleObservation(generation, observation),
        onDiagnostic: (diagnostic) => this.handleDiagnostic(generation, diagnostic),
      });
      this.activeSession = session;
      attempt = this.runAttempt(generation, session);
    } catch {
      this.lastTerminalStatus = 'failed';
      this.recordDiagnostic({ code: 'session-start-failed' });
      this.scheduleReconnect('session-start-failed');
      return;
    }

    this.activeAttempt = attempt;
    void attempt.finally(() => {
      if (this.activeAttempt === attempt) this.activeAttempt = undefined;
      if (this.activeSession?.generation === generation) this.activeSession = undefined;
    });
  }

  private async runAttempt(generation: number, session: CstvLiveSession<R>): Promise<void> {
    let phase: 'start' | 'run' = 'start';
    try {
      const started = await session.start();
      if (!this.isCurrent(generation, session)) return;
      if (started.status !== 'ready') {
        this.handleTerminal(generation, session, started.status);
        return;
      }

      this.state = 'live';
      this.notifySnapshotChanged();
      phase = 'run';
      const result = await session.run();
      if (!this.isCurrent(generation, session)) return;
      this.handleTerminal(generation, session, result.status);
    } catch {
      if (!this.isCurrent(generation, session)) return;
      session.stop();
      this.lastTerminalStatus = 'failed';
      this.scheduleReconnect(
        this.lastErrorCode ?? (phase === 'start' ? 'session-start-failed' : 'session-run-failed'),
      );
    }
  }

  private isCurrent(generation: number, session: CstvLiveSession<R>): boolean {
    return !this.stopRequested && this.generation === generation && this.activeSession === session;
  }

  private handleSync(generation: number, sync: CstvSyncMetadata): void {
    if (!this.isCurrentGeneration(generation)) return;
    this.lastSync = sync;
    this.reconnectAttempt = 0;
    this.lastErrorCode = undefined;
    this.notifySnapshotChanged();
  }

  private handleObservation(
    generation: number,
    observation: RoleScopedGameEventObservation<R>,
  ): void {
    if (!this.isCurrentGeneration(generation)) return;
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

  private handleDiagnostic(generation: number, diagnostic: CstvDiagnostic): void {
    if (!this.isCurrentGeneration(generation)) return;
    this.recordDiagnostic(diagnostic);
  }

  private recordDiagnostic(diagnostic: CstvDiagnostic): void {
    appendBounded(this.recentDiagnostics, diagnostic, CSTV_RECENT_DIAGNOSTICS_MAX);
    this.lastErrorCode = diagnostic.code;
    this.notifySnapshotChanged();
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.stopRequested && this.generation === generation;
  }

  private handleTerminal(
    generation: number,
    session: CstvLiveSession<R>,
    status: 'complete' | 'timeout' | 'cancelled',
  ): void {
    if (!this.isCurrent(generation, session)) return;
    this.refreshTailTick();
    this.lastTerminalStatus = status;
    if (status === 'complete') {
      this.state = 'ended';
      this.notifySnapshotChanged();
      return;
    }
    if (status === 'timeout') {
      this.recordDiagnostic({ code: 'session-timeout', status });
      this.scheduleReconnect('session-timeout');
      return;
    }
    this.scheduleReconnect('session-cancelled');
  }

  private refreshTailTick(): boolean {
    if (this.activeSession === undefined || this.tailTick === this.activeSession.tailTick) {
      return false;
    }
    this.tailTick = this.activeSession.tailTick;
    return true;
  }

  private scheduleReconnect(code: CstvDiagnosticCode): void {
    if (this.stopRequested || this.url === undefined || this.reconnectScheduled) return;
    this.lastErrorCode = code;
    this.state = 'reconnecting';
    const backoffIndex = Math.min(this.reconnectAttempt, CSTV_RECONNECT_BACKOFF_MS.length - 1);
    const delayMs = CSTV_RECONNECT_BACKOFF_MS[backoffIndex] ?? 10_000;
    this.reconnectAttempt += 1;
    this.nextGeneration = this.generation + 1;
    this.reconnectScheduled = true;
    this.notifySnapshotChanged();
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnectScheduled = false;
      this.connect();
    }, delayMs);
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
  if (options.url !== undefined && !isValidHttpUrl(options.url)) {
    throw new Error('CSTV source URL must be a valid http(s) URL');
  }
  return new DefaultCstvSourceManager<R>(options);
}

export interface CstvSourceManagers {
  readonly program: CstvSourceManager<'program'>;
  readonly lookahead: CstvSourceManager<'lookahead'>;
}

export function createCstvSourceManagers(options: {
  readonly programUrl?: string;
  readonly lookaheadUrl?: string;
  readonly parserSessionFactory?: CstvParserSessionFactory;
  readonly clock?: CstvObservationClock;
  readonly scheduler?: CstvScheduler;
}): CstvSourceManagers {
  const shared = {
    ...(options.parserSessionFactory === undefined
      ? {}
      : { parserSessionFactory: options.parserSessionFactory }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.scheduler === undefined ? {} : { scheduler: options.scheduler }),
  };
  return {
    program: createCstvSourceManager({
      role: 'program',
      ...(options.programUrl === undefined ? {} : { url: options.programUrl }),
      ...shared,
    }),
    lookahead: createCstvSourceManager({
      role: 'lookahead',
      ...(options.lookaheadUrl === undefined ? {} : { url: options.lookaheadUrl }),
      ...shared,
    }),
  };
}
