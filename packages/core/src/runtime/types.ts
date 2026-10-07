import type { SourceSide } from '../telemetry/map.js';
import type { TelemetryObservation } from '../telemetry/observation.js';
import { createMapPlayerStatsAccumulator, type MapPlayerStatsAccumulator } from './player-stats.js';
import {
  createObjectiveTimingState,
  type RuntimeObjectiveTimingState,
} from './objective-timing.js';

export interface RuntimeTime {
  readonly monotonicMs: number;
  readonly utc: string;
}

export type LiveSessionBinding =
  { readonly kind: 'unbound' } | { readonly kind: 'bound'; readonly liveSessionId: string };

interface RuntimeReceiveCursor {
  readonly generation: number;
  readonly sequence: number;
  readonly receivedAt: string;
  readonly receivedMonotonicMs: number;
}

interface RuntimeProgramSourceState {
  readonly kind: 'cs2-gsi';
  readonly generation: number;
  readonly lastAccepted?: RuntimeReceiveCursor;
}

interface RuntimeMapState {
  readonly epoch: number;
  readonly name?: string;
  /** Continuity evidence only; never a claim about the current map phase. */
  readonly competitiveObserved?: true;
}

export interface RuntimeState {
  readonly producerInstanceId: string;
  readonly liveSession: LiveSessionBinding;
  readonly runtimeSeq: number;
  readonly programSource: RuntimeProgramSourceState;
  readonly map: RuntimeMapState;
  readonly playerStats: MapPlayerStatsAccumulator;
  readonly objectiveTiming: RuntimeObjectiveTimingState;
  readonly programTelemetry?: TelemetryObservation;
}

export interface RuntimeContinuityPolicy {
  readonly staleAfterMs: number;
  /** Short lease for numeric plant/defuse/explosion interpolation. */
  readonly objectiveClockLeaseMs?: number;
}

export type MapExecutionResetReason = 'same-map-restart' | 'restore' | 'operator-correction';

export type RuntimeInput =
  | {
      readonly kind: 'program-telemetry';
      readonly sourceGeneration: number;
      readonly observation: TelemetryObservation;
    }
  | {
      readonly kind: 'advance-program-source-generation';
      readonly nextGeneration: number;
      readonly at: RuntimeTime;
    }
  | {
      readonly kind: 'reset-map-execution';
      readonly reason: MapExecutionResetReason;
      readonly at: RuntimeTime;
    };

export interface RuntimeTransitionBase {
  readonly runtimeSeq: number;
  readonly producerInstanceId: string;
  readonly liveSession: LiveSessionBinding;
  readonly mapEpoch: number;
  readonly at: RuntimeTime;
}

export interface ProgramTelemetryTransitionBase extends RuntimeTransitionBase {
  readonly sourceGeneration: number;
  readonly receiveSequence: number;
}

export interface RoundStartedTransition extends ProgramTelemetryTransitionBase {
  readonly kind: 'round_started';
  readonly roundNumber?: number;
}

export interface RoundEndedTransition extends ProgramTelemetryTransitionBase {
  readonly kind: 'round_ended';
  readonly roundNumber?: number;
  readonly winnerSide?: SourceSide;
}

export interface MapEndedTransition extends ProgramTelemetryTransitionBase {
  readonly kind: 'map_ended';
}

export interface MapExecutionChangedTransitionBase extends RuntimeTransitionBase {
  readonly kind: 'map_execution_changed';
  readonly previousMapEpoch: number;
  readonly previousMapName?: string;
  readonly mapName?: string;
}

export interface ObservedMapExecutionChangedTransition extends MapExecutionChangedTransitionBase {
  readonly reason: 'observed-map-name-change' | 'observed-same-map-restart';
  readonly sourceGeneration: number;
  readonly receiveSequence: number;
}

export interface ExplicitMapExecutionChangedTransition extends MapExecutionChangedTransitionBase {
  readonly reason: 'explicit-reset';
  readonly resetReason: MapExecutionResetReason;
}

export type MapExecutionChangedTransition =
  ObservedMapExecutionChangedTransition | ExplicitMapExecutionChangedTransition;

export type RuntimeTransition =
  | RoundStartedTransition
  | RoundEndedTransition
  | MapEndedTransition
  | MapExecutionChangedTransition;

interface RuntimeSequenceRange {
  readonly from: number;
  readonly to: number;
}

type RuntimeAcceptedDisposition =
  | {
      readonly kind: 'accepted';
      readonly reason: 'baseline' | 'contiguous' | 'gap-resync' | 'stale-recovery';
      readonly missingSequenceRange?: RuntimeSequenceRange;
    }
  | { readonly kind: 'accepted'; readonly reason: 'source-generation-advanced' }
  | { readonly kind: 'accepted'; readonly reason: 'map-execution-reset' };

type RuntimeIgnoredReason =
  | 'duplicate'
  | 'out-of-order'
  | 'non-monotonic-time'
  | 'stale-generation'
  | 'generation-ahead'
  | 'invalid-generation-advance'
  | 'map-not-established';

interface RuntimeIgnoredDisposition {
  readonly kind: 'ignored';
  readonly reason: RuntimeIgnoredReason;
}

export type RuntimeDisposition = RuntimeAcceptedDisposition | RuntimeIgnoredDisposition;

export interface RuntimeReduceResult {
  readonly state: RuntimeState;
  readonly transitions: readonly RuntimeTransition[];
  readonly disposition: RuntimeDisposition;
}

export function createInitialRuntimeState(
  producerInstanceId: string,
  liveSession: LiveSessionBinding = { kind: 'unbound' },
): RuntimeState {
  return {
    producerInstanceId,
    liveSession,
    runtimeSeq: 0,
    programSource: {
      kind: 'cs2-gsi',
      generation: 0,
    },
    map: {
      epoch: 0,
    },
    playerStats: createMapPlayerStatsAccumulator(0),
    objectiveTiming: createObjectiveTimingState(0, 0),
  };
}
