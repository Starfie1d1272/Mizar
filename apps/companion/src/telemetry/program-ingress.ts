import type { FastifyInstance } from 'fastify';
import type { DemoTestController } from '../demo-test/controller.js';
import type { MatchContextBinding } from '../match-context/index.js';
import type { registerManagedSourceRoutes } from '../match-context/managed-source.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import type { DebugEvidenceStore } from '../runtime/debug-state.js';
import type { createObservationDriver } from '../runtime/observation-driver.js';
import type { ProgramRuntime } from '../runtime/program-runtime.js';
import { selectedGsiContext, type PerformanceWindow } from '../support/performance-window.js';
import type { observeRuntime } from '../support/runtime-observation.js';
import { diagnosticValue, type SessionJournal } from '../support/session-journal.js';
import type { CaptureRecorder } from './capture-recorder.js';
import { registerGsiIngress, type GsiIngressOptions } from './gsi-ingress.js';

type ObservationDriver = ReturnType<typeof createObservationDriver>;

export function registerProgramIngress(
  app: FastifyInstance,
  options: {
    token: string;
    clock: GsiIngressOptions['clock'];
    sequenceSource: GsiIngressOptions['sequenceSource'];
    onAcceptedRaw: GsiIngressOptions['onAcceptedRaw'];
    onObservation: GsiIngressOptions['onObservation'];
    onGsiDiagnostics: GsiIngressOptions['onGsiDiagnostics'];
    managedSource: ReturnType<typeof registerManagedSourceRoutes>;
    readDemo: () => DemoTestController;
    currentRecorder: () => CaptureRecorder;
    runtimeObservation: ReturnType<typeof observeRuntime>;
    performanceContext: PerformanceWindow | undefined;
    debugEvidenceStore: DebugEvidenceStore;
    programRuntime: ProgramRuntime;
    projectionCoordinator: ProjectionCoordinator;
    sessionJournal: SessionJournal | undefined;
    latestInput: ObservationDriver['latestInput'];
    dispatchObservation: ObservationDriver['dispatch'];
    readBinding: () => MatchContextBinding | undefined;
    recordDiagnostic: (code: string) => void;
  },
): void {
  const {
    managedSource,
    currentRecorder,
    runtimeObservation,
    performanceContext,
    debugEvidenceStore,
    programRuntime,
    projectionCoordinator,
    sessionJournal,
    latestInput,
    dispatchObservation,
  } = options;
  registerGsiIngress(app, {
    gsiToken: options.token,
    classifySource: (sourceId) => managedSource.classify(sourceId),
    canAccept: () => options.readDemo().canAcceptGsi(),
    canRecord: () => options.readDemo().get().active !== true,
    recorder: currentRecorder,
    ...(options.sequenceSource === undefined ? {} : { sequenceSource: options.sequenceSource }),
    onAcceptedRaw: (input) => {
      runtimeObservation.acceptRaw(input);
      if (performanceContext?.shouldSample(input.receivedMonotonicMs))
        performanceContext.sample({
          time: input.receivedAt,
          monotonicMs: input.receivedMonotonicMs,
          sequence: input.sequence,
          evidence: {
            input: selectedGsiContext(input.payload),
            normalizedBeforeCurrentRaw: latestInput(),
            runtimeBeforeCurrentRaw: programRuntime.getCurrentState().programSource,
            publicationBeforeCurrentRaw: (['program', 'radar'] as const).map((channel) => {
              const current = projectionCoordinator.getPublisher(channel).getCurrent();
              return { channel, channelSeq: current?.channelSeq, cursor: current?.cursor };
            }),
          },
        });
      debugEvidenceStore.recordAcceptedRaw(input);
      options.onAcceptedRaw?.(input);
    },
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    onObservation: (observation, sourceId) => {
      const outputBinding = options.readBinding();
      if (
        (sourceId &&
          !managedSource.sourceMatchesSelection(sourceId) &&
          (!outputBinding ||
            !programRuntime.isExplicitSourceOwner(sourceId, outputBinding.context.matchId))) ||
        (!sourceId && managedSource.unverifiedExternal())
      )
        programRuntime.markSourceUnverified();
      const owner = observation.telemetry.map?.name
        ? managedSource.ownerForFirstObservation(sourceId)
        : undefined;
      if (dispatchObservation(observation, undefined, sourceId, owner) && owner && sourceId)
        managedSource.confirmFirstObservation(sourceId);
      options.onObservation?.(observation);
    },
    onGsiDiagnostics: (diagnostics) => {
      debugEvidenceStore.recordGsiDiagnostics(diagnostics);
      options.onGsiDiagnostics?.(diagnostics);
    },
    onRuntimeDiagnostic: (code, failure) => {
      sessionJournal?.record('telemetry_failure', { code, ...failure });
      performanceContext?.trigger('telemetry_diagnostic', {
        code,
        receive: failure.receive,
        error: diagnosticValue(failure.error),
      });
      options.recordDiagnostic(code);
    },
  });
}
