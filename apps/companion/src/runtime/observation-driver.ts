import { performance } from 'node:perf_hooks';
import type { TelemetryObservation } from '@mizar/core/telemetry';
import type { PerformanceWindow } from '../support/performance-window.js';
import { diagnosticValue, type SessionJournal } from '../support/session-journal.js';
import type { DebugEvidenceStore } from './debug-state.js';
import type { createObservationCommit } from './observation-commit.js';
import type { ProgramRuntime } from './program-runtime.js';

export function createObservationDriver({
  commit: commitObservation,
  debugEvidenceStore,
  programRuntime,
  notifyDemo,
  sessionJournal,
  performanceContext,
  observe,
}: {
  commit: ReturnType<typeof createObservationCommit>;
  debugEvidenceStore: DebugEvidenceStore;
  programRuntime: ProgramRuntime;
  notifyDemo: () => void;
  sessionJournal: SessionJournal | undefined;
  performanceContext: PerformanceWindow | undefined;
  observe: (sequence: number, elapsedMs: number) => void;
}) {
  let latestInput: TelemetryObservation['receive'] | null = null;
  const dispatch = (
    observation: TelemetryObservation,
    sampleStageBinding?: { mapOrder: number },
    managedSourceId?: string,
    managedOwner?: { matchId: string },
  ): boolean => {
    const processingStarted = performance.now();
    latestInput = observation.receive;
    try {
      const accepted = commitObservation(
        observation,
        sampleStageBinding,
        managedSourceId,
        managedOwner,
      );
      debugEvidenceStore.recordNormalizedObservation(observation);
      debugEvidenceStore.recordRuntime(programRuntime.getSnapshot());
      notifyDemo();
      return accepted;
    } catch (error) {
      sessionJournal?.record('observation_failure', { error, receive: observation.receive });
      performanceContext?.trigger('observation_failure', {
        receive: observation.receive,
        error: diagnosticValue(error),
      });
      throw error;
    } finally {
      observe(observation.receive.sequence, performance.now() - processingStarted);
    }
  };

  return { dispatch, latestInput: () => latestInput };
}
