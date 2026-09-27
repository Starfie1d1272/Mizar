import { MatchContextController, MatchManifestLkgStore } from './match-context/index.js';
import { registerBpRoutes } from './bp/controller.js';
import { registerBpWorkspaceRoutes } from './bp/workspace-controller.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import Fastify, { type FastifyInstance } from 'fastify';

import { DebugEvidenceStore, type DebugRuntimeClock } from './runtime/debug-state.js';
import type { LatestWinsConsumerHealth } from './runtime/latest-wins.js';
import { createProgramRuntime, type ProgramRuntime } from './runtime/program-runtime.js';
import type { SeriesProgressCheckpointStore } from '@rivalhub-broadcast/core/series-progress';
import {
  createProjectionCoordinator,
  type ProjectionCoordinator,
} from './projections/projection-coordinator.js';
import {
  createProgramCueCoordinator,
  type ProgramCueCoordinator,
} from './projections/program-cue-coordinator.js';
import type { MatchContextBinding } from './match-context/index.js';
import {
  registerQualificationRoutes,
  type QualificationControllerOptions,
  type QualificationFinishInput,
} from './qualification/controller.js';
import {
  createQualificationEvidenceStore,
  type QualificationClock,
  type QualificationEvidenceStore,
  type QualificationProfile,
} from './qualification/evidence.js';
import { createDisabledRecorder, type CaptureRecorder } from './telemetry/capture-recorder.js';
import {
  createCstvSourceManagers,
  type CstvSourceManagers,
} from './telemetry/cstv-source-manager.js';
import {
  GSI_REQUEST_TIMEOUT_MS,
  registerGsiIngress,
  type AcceptedRawSink,
  type GsiClock,
  type GsiDiagnosticsSink,
  type GsiSequenceSource,
  type ObservationSink,
} from './telemetry/gsi-ingress.js';
import { registerStaticHost } from './local-web/static-host.js';
import { registerOperatorCommandRoutes } from './operator/controller.js';
import { registerHudConfigRoutes } from './hud-config/controller.js';
import { HudConfigStore } from './hud-config/store.js';
import {
  createLocalWebSocketTransport,
  registerLocalWebSocketTransport,
  type LocalWebSocketDiagnostic,
} from './local-web/websocket-transport.js';

export interface CompanionAppOptions {
  readonly productRuntime?: {
    readonly artifactSha256: string;
    readonly instanceId: string;
    readonly controlToken: string;
    readonly stop: () => void;
  };
  readonly logger?: boolean;
  readonly gsiToken?: string;
  readonly recorder?: CaptureRecorder;
  readonly producerInstanceId?: string;
  readonly gsiSequenceSource?: GsiSequenceSource;
  readonly programRuntime?: ProgramRuntime;
  readonly seriesProgressCheckpointStore?: SeriesProgressCheckpointStore;
  readonly onSeriesProgressDiagnostic?: (diagnostic: { readonly code: string }) => void;
  readonly projectionCoordinator?: ProjectionCoordinator;
  readonly programCueCoordinator?: ProgramCueCoordinator;
  readonly matchContextBinding?: MatchContextBinding;
  readonly matchManifestPath?: string;
  readonly projectionNowMonotonicMs?: () => number;
  readonly debugEvidenceStore?: DebugEvidenceStore;
  readonly debugClock?: DebugRuntimeClock;
  readonly deliveryConsumers?: readonly DeliveryHealthSource[];
  readonly cstvSources?: CstvSourceManagers;
  readonly onAcceptedRaw?: AcceptedRawSink;
  readonly onObservation?: ObservationSink;
  readonly onGsiDiagnostics?: GsiDiagnosticsSink;
  readonly clock?: GsiClock;
  readonly qualificationMode?: boolean;
  readonly qualificationControlToken?: string;
  readonly hudConfigPath?: string;
  readonly hudConfigStore?: HudConfigStore;
  readonly qualificationRunId?: string;
  readonly qualificationScenarioPath?: string;
  readonly qualificationHostCheckpointsPath?: string;
  readonly qualificationProfile?: QualificationProfile;
  readonly qualificationClock?: QualificationClock;
  readonly qualificationEvidenceStore?: QualificationEvidenceStore;
  readonly objectiveReferenceSource?: {
    readonly artifactId: string;
    readonly artifactSha256: string;
  };
  readonly onQualificationRecorderRotate?: (current: CaptureRecorder) => Promise<{
    readonly previousCaptureId: string;
    readonly captureId: string;
    readonly nextRecorder: CaptureRecorder;
  }>;
  readonly onQualificationRestart?: () => void | Promise<void>;
  readonly onQualificationFinish?: (input: QualificationFinishInput) => void | Promise<void>;
  readonly webRoot?: string;
  readonly host?: string;
  readonly localWebLanMode?: boolean;
  readonly localWebAllowedOrigins?: readonly string[];
}

export interface DeliveryHealthSource {
  getHealth(): LatestWinsConsumerHealth;
  close(): Promise<void>;
}

function projectionDiagnosticDegradesRuntime(code: string): boolean {
  return code.endsWith('-schema-validation-failed') || code.endsWith('-wire-validation-failed');
}

export function buildApp(options: CompanionAppOptions = {}): FastifyInstance {
  let recorder = options.recorder ?? createDisabledRecorder('recorder_not_configured');
  const currentRecorder = (): CaptureRecorder => recorder;
  const programRuntime =
    options.programRuntime ??
    createProgramRuntime(options.producerInstanceId ?? randomUUID(), {
      ...(options.seriesProgressCheckpointStore === undefined
        ? {}
        : { seriesProgressCheckpointStore: options.seriesProgressCheckpointStore }),
      ...(options.onSeriesProgressDiagnostic === undefined
        ? {}
        : { onSeriesProgressDiagnostic: options.onSeriesProgressDiagnostic }),
    });
  const debugEvidenceStore =
    options.debugEvidenceStore ?? new DebugEvidenceStore(programRuntime.getSnapshot());
  debugEvidenceStore.recordRuntime(programRuntime.getSnapshot());
  const debugClock = options.debugClock ?? { nowMonotonicMs: () => performance.now() };
  const deliveryConsumers = options.deliveryConsumers ?? [];
  const cstvSources = options.cstvSources ?? createCstvSourceManagers({});
  const objectiveReferenceSource = options.objectiveReferenceSource;
  const objectiveReferenceUnsubscribe =
    objectiveReferenceSource === undefined ||
    currentRecorder().tryRecordObjectiveReference === undefined
      ? undefined
      : cstvSources.program.subscribeLiveGameEvents((observation) => {
          if (!(
            observation.kind === 'bomb-begin-plant' ||
            observation.kind === 'bomb-abort-plant' ||
            observation.kind === 'bomb-planted' ||
            observation.kind === 'bomb-begin-defuse' ||
            observation.kind === 'bomb-abort-defuse' ||
            observation.kind === 'bomb-defused' ||
            observation.kind === 'bomb-exploded'
          ))
            return;
          const objective = observation;
          const mapName = objective.cursor.mapName;
          const ticksPerSecond = objective.cursor.ticksPerSecond;
          if (
            typeof mapName !== 'string' ||
            mapName.trim().length === 0 ||
            typeof ticksPerSecond !== 'number' ||
            !Number.isFinite(ticksPerSecond) ||
            ticksPerSecond <= 0
          )
            return;
          const referenceId = `cstv-${objective.cursor.role}-${objective.cursor.generation}-${objective.cursor.sequence}-${objective.kind}`;
          currentRecorder().tryRecordObjectiveReference?.({
            referenceId,
            kind: objective.kind,
            source: 'cstv',
            occurredMonotonicMs: objective.cursor.observedMonotonicMs,
            sourceCursor: {
              ...objective.cursor,
              mapName,
              ticksPerSecond,
            },
            sourceArtifact: {
              id: objectiveReferenceSource.artifactId,
              sha256: objectiveReferenceSource.artifactSha256,
            },
            ...(objective.kind === 'bomb-begin-defuse' ? { hasKit: objective.hasKit } : {}),
          });
        });
  const projectionNowMonotonicMs =
    options.projectionNowMonotonicMs ??
    (() => {
      const lastReceived =
        programRuntime.getSnapshot().current.programSource.lastAccepted?.receivedMonotonicMs ?? 0;
      return Math.max(performance.now(), lastReceived);
    });
  const app = Fastify({
    logger: options.logger ?? false,
    requestTimeout: GSI_REQUEST_TIMEOUT_MS,
  });
  registerStaticHost(app, {
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
    qualificationMode: options.qualificationMode ?? false,
  });
  const hudConfigStore =
    options.hudConfigStore ??
    new HudConfigStore({
      ...(options.hudConfigPath === undefined ? {} : { filePath: options.hudConfigPath }),
      onDiagnostic: (code) => app.log.warn({ code }, 'Companion HUD 配置诊断'),
    });
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
    app.log.warn(
      { code },
      degradeRuntime ? `Companion ${source} 路径已降级` : `Companion ${source} 路径记录可恢复诊断`,
    );
  };
  const projectionCoordinator =
    options.projectionCoordinator ??
    createProjectionCoordinator({
      programRuntime,
      cstvSources,
      ...(options.matchContextBinding === undefined
        ? {}
        : { matchContextBinding: options.matchContextBinding }),
      ...(projectionNowMonotonicMs === undefined
        ? {}
        : { nowMonotonicMs: projectionNowMonotonicMs }),
      onDiagnostic: ({ code }) =>
        recordRuntimeDiagnostic(code, 'projection', projectionDiagnosticDegradesRuntime(code)),
    });
  const programCueCoordinator =
    options.programCueCoordinator ??
    createProgramCueCoordinator({
      programSource: cstvSources.program,
      programRuntime,
      nowMonotonicMs: projectionNowMonotonicMs,
      onDiagnostic: ({ code }) => recordRuntimeDiagnostic(code, 'projection', false),
    });
  const localWebTransport = createLocalWebSocketTransport({
    getPublisher: (channel) =>
      channel === 'program-cue'
        ? programCueCoordinator.getPublisher()
        : projectionCoordinator.getPublisher(channel),
    originPolicyOptions: {
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.localWebLanMode === undefined ? {} : { lanMode: options.localWebLanMode }),
      ...(options.localWebAllowedOrigins === undefined
        ? {}
        : { allowedOrigins: options.localWebAllowedOrigins }),
    },
    logger: app.log,
    onDiagnostic: (diagnostic: LocalWebSocketDiagnostic) => {
      if (diagnostic.code === 'ws_closed' || diagnostic.code === 'ws_connected') return;
      app.log.debug(
        {
          code: diagnostic.code,
          ...(diagnostic.channel === undefined ? {} : { channel: diagnostic.channel }),
          ...(diagnostic.connectionId === undefined
            ? {}
            : { connectionId: diagnostic.connectionId }),
        },
        'Companion local WebSocket diagnostic',
      );
    },
  });
  registerLocalWebSocketTransport(app, localWebTransport);
  registerHudConfigRoutes(app, {
    store: hudConfigStore,
    originPolicy: localWebTransport.getOriginPolicy(),
  });
  registerBpRoutes(app, {
    originPolicy: localWebTransport.getOriginPolicy(),
    getProjection: () => projectionCoordinator.getBpProjection(),
  });
  const matchContextController =
    options.matchManifestPath === undefined
      ? null
      : new MatchContextController({
          lkgStore: new MatchManifestLkgStore({ filePath: options.matchManifestPath }),
          ...(options.matchContextBinding === undefined
            ? {}
            : { initialBinding: options.matchContextBinding }),
          onBindingChanged: (binding) => {
            projectionCoordinator.setMatchContextBinding(binding);
            programCueCoordinator.afterRuntimeMutation();
          },
        });
  registerBpWorkspaceRoutes(app, {
    originPolicy: localWebTransport.getOriginPolicy(),
    controller: matchContextController,
    projections: projectionCoordinator,
  });
  if (matchContextController !== null) {
    app.addHook('onReady', async () => {
      await matchContextController.restoreLatest();
    });
  }
  const qualificationMode = options.qualificationMode ?? false;

  app.get('/health', () => {
    const recorderHealth = currentRecorder().getHealth();
    const recorderDegraded =
      recorderHealth.state === 'degraded' || recorderHealth.state === 'failed';
    const cstvHealth = {
      program: cstvSources.program.getHealth(),
      lookahead: cstvSources.lookahead.getHealth(),
    };
    const cstvDegraded = [cstvHealth.program, cstvHealth.lookahead].some(
      (health) => health.state === 'reconnecting' || health.state === 'failed',
    );
    return {
      status: runtimeDegraded || recorderDegraded || cstvDegraded ? 'degraded' : 'ok',
      recorder: recorderHealth,
      cstv: cstvHealth,
      ...(options.productRuntime === undefined
        ? {}
        : {
            product: {
              repository: 'Starfie1d1272/RivalHub-Broadcast',
              artifactSha256: options.productRuntime.artifactSha256,
              instanceId: options.productRuntime.instanceId,
              mode: 'product',
            },
          }),
    };
  });

  if (options.productRuntime !== undefined) {
    const product = options.productRuntime;
    app.post('/operator/runtime/stop', (request, reply) => {
      const token = request.headers['x-runtime-token'];
      const expected = Buffer.from(product.controlToken);
      const supplied = Buffer.from(typeof token === 'string' ? token : '');
      // Only the local supervisor holds this per-launch capability. Browsers cannot stop it.
      if (
        request.headers.origin !== undefined ||
        supplied.length !== expected.length ||
        expected.length === 0 ||
        !timingSafeEqual(supplied, expected)
      ) {
        return reply.code(403).send({ error: 'runtime-control-denied' });
      }
      setImmediate(product.stop);
      return reply.code(202).send({ status: 'stopping' });
    });
  }

  app.get('/debug/runtime', () =>
    debugEvidenceStore.getResponse({
      nowMonotonicMs: debugClock.nowMonotonicMs(),
      recorderHealth: currentRecorder().getHealth(),
      deliveryHealth: deliveryConsumers.map((consumer) => consumer.getHealth()),
      cstvSources: {
        program: cstvSources.program.getSnapshot(),
        lookahead: cstvSources.lookahead.getSnapshot(),
      },
    }),
  );

  app.get('/debug/hosts', () => localWebTransport.getHostDiagnostics());

  if (options.gsiToken !== undefined) {
    registerGsiIngress(app, {
      gsiToken: options.gsiToken,
      recorder: currentRecorder,
      ...(options.gsiSequenceSource === undefined
        ? {}
        : { sequenceSource: options.gsiSequenceSource }),
      onAcceptedRaw: (input) => {
        debugEvidenceStore.recordAcceptedRaw(input);
        options.onAcceptedRaw?.(input);
      },
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      onObservation: (observation) => {
        const result = programRuntime.acceptObservation(observation);
        projectionCoordinator.afterRuntimeMutation(result);
        programCueCoordinator.afterRuntimeMutation(result);
        debugEvidenceStore.recordNormalizedObservation(observation);
        debugEvidenceStore.recordRuntime(programRuntime.getSnapshot());
        options.onObservation?.(observation);
      },
      onGsiDiagnostics: (diagnostics) => {
        debugEvidenceStore.recordGsiDiagnostics(diagnostics);
        options.onGsiDiagnostics?.(diagnostics);
      },
      onRuntimeDiagnostic: (code) => {
        recordRuntimeDiagnostic(code, 'telemetry');
      },
    });
  }

  if (qualificationMode) {
    const controlToken = options.qualificationControlToken;
    if (controlToken === undefined || controlToken.trim().length === 0) {
      throw new Error('启用现场验收模式时必须设置现场验收控制令牌。');
    }
    const runId = options.qualificationRunId ?? 'local-qualification';
    const evidence =
      options.qualificationEvidenceStore ??
      createQualificationEvidenceStore({
        runId,
        ...(options.qualificationScenarioPath === undefined
          ? {}
          : { scenarioPath: options.qualificationScenarioPath }),
        ...(options.qualificationHostCheckpointsPath === undefined
          ? {}
          : { hostCheckpointsPath: options.qualificationHostCheckpointsPath }),
        clock: options.qualificationClock ?? {
          now: () => ({ monotonicMs: performance.now(), utc: new Date().toISOString() }),
        },
      });
    const qualificationOptions: QualificationControllerOptions = {
      controlToken,
      runId,
      evidence,
      qualificationProfile: options.qualificationProfile ?? 'base',
      ...(options.qualificationClock === undefined ? {} : { clock: options.qualificationClock }),
      getHostDiagnostics: () => localWebTransport.getHostDiagnostics(),
      getDebugResponse: (nowMonotonicMs) =>
        debugEvidenceStore.getResponse({
          nowMonotonicMs,
          recorderHealth: currentRecorder().getHealth(),
          deliveryHealth: deliveryConsumers.map((consumer) => consumer.getHealth()),
          cstvSources: {
            program: cstvSources.program.getSnapshot(),
            lookahead: cstvSources.lookahead.getSnapshot(),
          },
        }),
      programRuntime,
      recorder: currentRecorder,
      ...(options.onQualificationRestart === undefined
        ? {}
        : { onRestart: options.onQualificationRestart }),
      ...(options.onQualificationRecorderRotate === undefined
        ? {}
        : {
            rotateRecorder: async () => {
              const previous = currentRecorder();
              const result = await options.onQualificationRecorderRotate?.(previous);
              if (result === undefined) throw new Error('采集记录切换回调未配置。');
              const at = options.qualificationClock?.now() ?? {
                monotonicMs: performance.now(),
                utc: new Date().toISOString(),
              };
              const generationAdvance = programRuntime.advanceProgramSourceGeneration(at);
              if (
                generationAdvance.disposition.kind !== 'accepted' ||
                generationAdvance.disposition.reason !== 'source-generation-advanced'
              ) {
                await result.nextRecorder.finalize();
                throw new Error('接收链路代际推进失败。');
              }
              projectionCoordinator.afterRuntimeMutation(generationAdvance);
              programCueCoordinator.afterRuntimeMutation(generationAdvance);
              debugEvidenceStore.recordRuntime(programRuntime.getSnapshot());
              recorder = result.nextRecorder;
              await previous.finalize();
              return {
                previousCaptureId: result.previousCaptureId,
                captureId: result.captureId,
              };
            },
          }),
      onAcceptedMapReset: () => {
        debugEvidenceStore.clearCurrentTelemetry();
        debugEvidenceStore.recordRuntime(programRuntime.getSnapshot());
        projectionCoordinator.afterRuntimeMutation();
        programCueCoordinator.afterRuntimeMutation();
      },
      ...(options.onQualificationFinish === undefined
        ? {}
        : { onFinish: options.onQualificationFinish }),
    };
    registerQualificationRoutes(app, qualificationOptions);
  }

  registerOperatorCommandRoutes(app, {
    originPolicy: localWebTransport.getOriginPolicy(),
    execute: (command) => projectionCoordinator.executeOperatorCommand(command),
  });

  app.addHook('onClose', async () => {
    objectiveReferenceUnsubscribe?.();
    await Promise.all([
      cstvSources.program.stop(),
      cstvSources.lookahead.stop(),
      ...deliveryConsumers.map((consumer) => consumer.close()),
    ]);
    await Promise.all([projectionCoordinator.close(), programCueCoordinator.close()]);
    await programRuntime.close();
    await localWebTransport.close();
    await hudConfigStore.flush();
    await currentRecorder().finalize();
  });

  return app;
}
