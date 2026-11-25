import type { GameEventSourceRole, RoleScopedGameEventObservation } from '@mizar/core/game-events';

export const SUPPORTED_CSTV_GAME_EVENT_NAMES = [
  'player_death',
  'player_hurt',
  'weapon_fire',
  'grenade_thrown',
  'bomb_beginplant',
  'bomb_abortplant',
  'bomb_planted',
  'bomb_begindefuse',
  'bomb_abortdefuse',
  'bomb_defused',
  'bomb_exploded',
  'bomb_dropped',
  'bomb_pickup',
] as const;

export type CstvGameEventName = (typeof SUPPORTED_CSTV_GAME_EVENT_NAMES)[number];

export interface CstvSyncMetadata {
  readonly protocol: number;
  readonly tick: number;
  readonly ticksPerSecond: number;
  readonly fragment: number;
  readonly signupFragment: number;
  readonly mapName?: string;
  readonly realTimeDelaySeconds?: number;
  readonly receiveAgeSeconds?: number;
}

export interface CstvObservationClockSample {
  readonly observedAt: string;
  readonly observedMonotonicMs: number;
}

export interface CstvObservationClock {
  now(): CstvObservationClockSample;
}

export type CstvDiagnosticCode =
  | 'invalid-sync'
  | 'normalization-failed'
  | 'event-sink-failed'
  | 'sync-sink-failed'
  | 'session-start-failed'
  | 'session-run-failed'
  | 'session-timeout'
  | 'session-cancelled';

/** Diagnostic metadata is deliberately bounded and never carries raw parser errors or URLs. */
export interface CstvDiagnostic {
  readonly code: CstvDiagnosticCode;
  readonly eventName?: CstvGameEventName;
  readonly status?: CstvSessionTerminalStatus;
}

export interface CstvDiagnosticBatch {
  readonly entries: readonly CstvDiagnostic[];
  readonly suppressedCount: number;
}

export type CstvSessionTerminalStatus = 'complete' | 'timeout' | 'cancelled' | 'failed';

export type CstvSessionStartResult =
  { readonly status: 'ready' } | { readonly status: Exclude<CstvSessionTerminalStatus, 'failed'> };

export type CstvSessionRunResult = {
  readonly status: Exclude<CstvSessionTerminalStatus, 'failed'>;
};

/** Package-owned seam used by deterministic tests and by the cs2parser binding. */
export interface CstvParserSession {
  readonly sync: CstvSyncMetadata | null;
  readonly tailTick: number;
  start(): Promise<CstvSessionStartResult>;
  run(): Promise<CstvSessionRunResult>;
  stop(): void;
}

export interface CstvParserSessionFactoryOptions {
  readonly role: GameEventSourceRole;
  readonly generation: number;
  readonly url: string;
  readonly onSync: (sync: CstvSyncMetadata) => void;
  readonly onEvent: (eventName: CstvGameEventName, event: unknown, tick: number) => void;
  readonly onDiagnostic: (diagnostic: CstvDiagnostic) => void;
}

export type CstvParserSessionFactory = (
  options: CstvParserSessionFactoryOptions,
) => CstvParserSession;

export interface CstvLiveSessionOptions<R extends GameEventSourceRole = GameEventSourceRole> {
  readonly role: R;
  readonly generation: number;
  readonly url: string;
  readonly parserSessionFactory?: CstvParserSessionFactory;
  readonly clock?: CstvObservationClock;
  readonly onObservation: (observation: RoleScopedGameEventObservation<R>) => void;
  readonly onSync?: (sync: CstvSyncMetadata) => void;
  readonly onDiagnostic?: (diagnostic: CstvDiagnostic) => void;
}

export interface CstvLiveSession<R extends GameEventSourceRole = GameEventSourceRole> {
  readonly role: R;
  readonly generation: number;
  readonly sync: CstvSyncMetadata | null;
  readonly tailTick: number;
  start(): Promise<CstvSessionStartResult>;
  run(): Promise<CstvSessionRunResult>;
  stop(): void;
}

export const CSTV_MAX_DIAGNOSTICS = 32;
