import { programSnapshotSchema, type ProgramSnapshot } from '@mizar/protocol/program';
import { radarSnapshotSchema, type RadarSnapshot } from '@mizar/protocol/radar';
import type { MatchContext } from '@mizar/core/match-context';
import type { GsiAdaptResult } from '@mizar/telemetry-gsi';

import type { MatchContextBinding } from '../match-context/index.js';
import { createProjectionCoordinator } from '../projections/projection-coordinator.js';
import { createProgramRuntime } from '../runtime/program-runtime.js';
import type {
  CstvSourceHealth,
  CstvSourceManager,
  CstvSourceManagers,
  CstvSourceSnapshot,
} from '../telemetry/cstv-source-manager.js';

export type ProductionReplayEvent =
  | {
      readonly kind: 'source-generation-boundary';
      readonly scheduledElapsedUs: number;
    }
  | {
      readonly kind: 'frame';
      readonly scheduledElapsedUs: number;
      readonly sourceFrame: { readonly sequence: number };
      readonly result: GsiAdaptResult;
    };

export interface ProductionReplayCompositionOptions {
  readonly producerInstanceId: string;
  readonly context: MatchContext;
  readonly matchContextBinding: MatchContextBinding;
  readonly cstvSources: CstvSourceManagers;
}

export interface AtomicReplaySnapshots {
  readonly program: ProgramSnapshot;
  readonly radar: RadarSnapshot;
}

function createDisabledReplaySource<R extends 'program' | 'lookahead'>(
  role: R,
): CstvSourceManager<R> {
  const health: CstvSourceHealth<R> = {
    role,
    state: 'disabled',
    generation: 0,
    reconnectAttempt: 0,
  };
  const snapshot: CstvSourceSnapshot<R> = {
    health,
    recentGameEvents: [],
    recentDiagnostics: [],
  };
  return {
    role,
    start: () => undefined,
    stop: () => Promise.resolve(),
    getHealth: () => health,
    getRecentGameEvents: () => [],
    getRecentDiagnostics: () => [],
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    subscribeLiveGameEvents: () => () => undefined,
  };
}

export function createDisabledReplayCstvSources(): CstvSourceManagers {
  return {
    program: createDisabledReplaySource('program'),
    lookahead: createDisabledReplaySource('lookahead'),
  };
}

export function sameReplayCursor(
  left: ProgramSnapshot['cursor'],
  right: RadarSnapshot['cursor'],
): boolean {
  return (
    left.producerInstanceId === right.producerInstanceId &&
    left.liveSessionId === right.liveSessionId &&
    left.runtimeSeq === right.runtimeSeq &&
    left.programSourceGeneration === right.programSourceGeneration &&
    left.programReceiveSequence === right.programReceiveSequence &&
    left.mapEpoch === right.mapEpoch
  );
}

/** Owns the production Runtime + ProjectionCoordinator composition used by replay acceptance. */
export function createProductionReplayComposition(options: ProductionReplayCompositionOptions) {
  let nowMonotonicMs = 0;
  const runtime = createProgramRuntime(options.producerInstanceId, {
    continuityPolicy: { staleAfterMs: 1_000_000_000 },
  });
  const coordinator = createProjectionCoordinator({
    predictionPublishCoalescing: false,
    programRuntime: runtime,
    cstvSources: options.cstvSources,
    matchContextBinding: {
      manifest: options.matchContextBinding.manifest,
      context: options.context,
      origin: 'fixture',
      freshness: 'fresh',
      diagnostics: [],
    },
    nowMonotonicMs: () => nowMonotonicMs,
    scheduler: { setTimeout: () => ({}), clearTimeout: () => {} },
  });

  return {
    runtime,
    coordinator,
    accept(event: ProductionReplayEvent): AtomicReplaySnapshots | null {
      nowMonotonicMs = event.scheduledElapsedUs / 1_000;
      if (event.kind === 'source-generation-boundary') {
        const reduction = runtime.advanceProgramSourceGeneration({
          monotonicMs: nowMonotonicMs,
          utc: new Date(nowMonotonicMs).toISOString(),
        });
        coordinator.afterRuntimeMutation(reduction);
        return null;
      }
      if (!event.result.ok) {
        throw new Error(`Capture adaptation failed: ${event.sourceFrame.sequence}`);
      }
      const reduction = runtime.acceptObservation(event.result.observation);
      if (reduction.disposition.kind !== 'accepted') {
        throw new Error(
          `Capture sequence ${event.sourceFrame.sequence}: ${reduction.disposition.reason}`,
        );
      }
      coordinator.afterRuntimeMutation(reduction);
      const snapshots = {
        program: programSnapshotSchema.parse(coordinator.getPublisher('program').getCurrent()),
        radar: radarSnapshotSchema.parse(coordinator.getPublisher('radar').getCurrent()),
      };
      if (!sameReplayCursor(snapshots.program.cursor, snapshots.radar.cursor)) {
        throw new Error(
          `Program/Radar replay cursor mismatch at sequence ${event.sourceFrame.sequence}`,
        );
      }
      if (snapshots.program.cursor.programReceiveSequence !== event.sourceFrame.sequence) {
        throw new Error(
          `Replay snapshot cursor mismatch at sequence ${event.sourceFrame.sequence}`,
        );
      }
      return snapshots;
    },
    async close(): Promise<void> {
      await coordinator.close();
    },
  };
}
