import { performance } from 'node:perf_hooks';
import type { ProgramRuntime } from '../runtime/program-runtime.js';
import type { ObsConfigStore } from '../obs/config.js';
import { diagnosticValue } from './session-journal.js';
import type { FastifyBaseLogger } from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { LocalWebHostDiagnostics } from '../local-web/websocket-transport.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import { DebugEvidenceStore, type DebugRuntimeClock } from '../runtime/debug-state.js';
import type { LatestWinsConsumerHealth } from '../runtime/latest-wins.js';
import type { createObservationDriver } from '../runtime/observation-driver.js';
import type { CaptureRecorder } from '../telemetry/capture-recorder.js';
import type { CstvSourceManagers } from '../telemetry/cstv-source-manager.js';
import type { PerformanceWindow } from './performance-window.js';
import { observeRuntime } from './runtime-observation.js';
import type { SessionJournal } from './session-journal.js';

export function registerRuntimeEvidence(
  app: FastifyInstance,
  options: {
    debugEvidenceStore: DebugEvidenceStore;
    debugClock: DebugRuntimeClock;
    currentRecorder: () => CaptureRecorder;
    deliveryConsumers: readonly { getHealth(): LatestWinsConsumerHealth }[];
    cstvSources: CstvSourceManagers;
    sessionJournal: SessionJournal | undefined;
    performanceContext: PerformanceWindow | undefined;
    latestInput: ReturnType<typeof createObservationDriver>['latestInput'];
    projectionCoordinator: Pick<ProjectionCoordinator, 'getPublisher'>;
    readOutboxTiming: () => unknown;
    readResourceTiming: () => unknown;
    readNativeHealth: () => unknown;
    readHosts: () => LocalWebHostDiagnostics;
  },
) {
  const {
    debugEvidenceStore,
    debugClock,
    currentRecorder,
    deliveryConsumers,
    cstvSources,
    sessionJournal,
    performanceContext,
    latestInput,
    projectionCoordinator,
  } = options;
  const recorder = () => currentRecorder().getHealth();
  const delivery = () => deliveryConsumers.map((consumer) => consumer.getHealth());
  const runtimeSummary = () => debugEvidenceStore.getSupportSummary(debugClock.nowMonotonicMs());
  const getDebugResponse = (nowMonotonicMs: number) =>
    debugEvidenceStore.getResponse({
      nowMonotonicMs,
      recorderHealth: recorder(),
      deliveryHealth: delivery(),
      cstvSources: {
        program: cstvSources.program.getSnapshot(),
        lookahead: cstvSources.lookahead.getSnapshot(),
      },
    });
  app.get('/debug/runtime', () => getDebugResponse(debugClock.nowMonotonicMs()));

  const runtimeObservation = observeRuntime({
    journal: sessionJournal,
    context: performanceContext,
    monotonicNow: () => debugClock.nowMonotonicMs(),
    snapshot: () => {
      const now = debugClock.nowMonotonicMs();
      const normalized = latestInput();
      return {
        input: {
          raw: runtimeObservation.latestRaw,
          normalized,
          ageMs: normalized ? Math.max(0, now - normalized.receivedMonotonicMs) : null,
        },
        outbox: options.readOutboxTiming(),
        resources: options.readResourceTiming(),
        runtime: debugEvidenceStore.getSupportSummary(now),
        recorder: recorder(),
        delivery: delivery(),
        channels: (['program', 'radar', 'operator', 'assist'] as const).map((channel) => {
          const publisher = projectionCoordinator.getPublisher(channel);
          const current = publisher.getCurrent();
          return {
            channel,
            channelSeq: current?.channelSeq ?? null,
            cursor: current?.cursor ?? null,
            subscribers: publisher.getHealth?.() ?? null,
          };
        }),
        anomalyContext: performanceContext?.health() ?? null,
        nativeSource: options.readNativeHealth(),
        cstv: {
          program: cstvSources.program.getHealth(),
          lookahead: cstvSources.lookahead.getHealth(),
        },
      };
    },
  });
  app.get('/debug/hosts', options.readHosts);

  return {
    getDebugResponse,
    runtimeObservation,
    recorder,
    delivery,
    runtimeSummary,
    readHosts: options.readHosts,
  };
}

export function createRuntimeDiagnostics(
  log: FastifyBaseLogger,
  debugEvidenceStore: DebugEvidenceStore,
  debugClock: DebugRuntimeClock,
  sessionJournal: SessionJournal | undefined,
) {
  let runtimeDegraded = false;
  const emittedRuntimeDiagnostics = new Set<string>();
  const recordRuntimeDiagnostic = (
    code: string,
    source: 'projection' | 'telemetry',
    degradeRuntime = true,
  ): void => {
    if (degradeRuntime) runtimeDegraded = true;
    debugEvidenceStore.recordRuntimeDiagnostic(code);
    if (emittedRuntimeDiagnostics.has(code)) return;
    emittedRuntimeDiagnostics.add(code);
    log.warn(
      { code },
      degradeRuntime ? `Companion ${source} 路径已降级` : `Companion ${source} 路径记录可恢复诊断`,
    );
  };
  let observerDiagnosticKey = '';
  let observerDiagnosticLoggedAt = -Infinity;
  let observerDiagnosticCounts = '';
  return {
    get degraded() {
      return runtimeDegraded;
    },
    record: recordRuntimeDiagnostic,
    recordProjection: ({ code }: { readonly code: string }) =>
      recordRuntimeDiagnostic(
        code,
        'projection',
        code.endsWith('-schema-validation-failed') || code.endsWith('-wire-validation-failed'),
      ),
    recordObserver: (
      diagnostics: Parameters<DebugEvidenceStore['recordObserverDiagnostics']>[0],
    ) => {
      debugEvidenceStore.recordObserverDiagnostics(diagnostics);
      const key = JSON.stringify([
        diagnostics.blocked,
        diagnostics.lastReset,
        diagnostics.pending > 0,
      ]);
      const now = debugClock.nowMonotonicMs();
      const sinceLast = now - observerDiagnosticLoggedAt;
      if (sinceLast < 5000 || (key === observerDiagnosticKey && sinceLast < 30_000)) return;
      const counts = JSON.stringify([
        diagnostics.acceptedDeaths,
        diagnostics.enteredWindow,
        diagnostics.generatedHints,
        diagnostics.publishedHints,
        diagnostics.ended,
        diagnostics.expiredBeforeWindow,
        diagnostics.endedAfterGeneration,
        diagnostics.discarded,
      ]);
      if (key === observerDiagnosticKey && counts === observerDiagnosticCounts) return;
      observerDiagnosticKey = key;
      observerDiagnosticCounts = counts;
      observerDiagnosticLoggedAt = now;
      sessionJournal?.record('observer_assist_state', diagnostics);
    },
  };
}

export function createConfigurationEvidence(
  sessionJournal: SessionJournal | undefined,
  controlState: () => Record<string, unknown>,
  obsConfigStore: Pick<ObsConfigStore, 'read'> | undefined,
): () => Promise<void> {
  return async () => {
    if (!sessionJournal) return;
    await sessionJournal.recordCommitted('configuration_snapshot', {
      ...controlState(),
      obs: await obsConfigStore
        ?.read()
        .catch((error: unknown) => ({ readError: diagnosticValue(error) })),
    });
  };
}

export function createRuntimeEvidenceStore(
  runtime: Pick<ProgramRuntime, 'getSnapshot'>,
  injectedStore: DebugEvidenceStore | undefined,
  debugClock: DebugRuntimeClock = { nowMonotonicMs: () => performance.now() },
) {
  const debugEvidenceStore = injectedStore ?? new DebugEvidenceStore(runtime.getSnapshot());
  debugEvidenceStore.recordRuntime(runtime.getSnapshot());
  return { debugEvidenceStore, debugClock };
}
