import {
  registerWorkspaceObserver,
  type WorkspaceObserver,
} from './telemetry/observer-workspace.js';
import { ObserverSettingsStore, registerObserverSettings } from './telemetry/observer-settings.js';
import { verifyIsolatedPack } from './orchestration/isolated-pack.js';
import { CameraDirector } from './orchestration/director.js';
import { MulnxTool } from './orchestration/tool.js';
import { OrchestrationStore } from './orchestration/store.js';
import { MulnxProvider } from './orchestration/provider.js';
import { registerOrchestrationRoutes } from './orchestration/routes.js';
import { registerDiagnosticDelivery } from './support/delivery-routes.js';
import { checkLocalWebOrigin } from './local-web/origin-policy.js';
import { SessionJournal, diagnosticValue } from './support/session-journal.js';
import { PerformanceWindow, selectedGsiContext } from './support/performance-window.js';
import { NativeSource } from './support/native-source.js';
import { ProgramChat } from './projections/program-chat.js';
import { MusicStore } from './music/store.js';
import { MusicDirector } from './music/director.js';
import { ObsMusicProvider } from './music/obs-provider.js';
import { registerMusicRoutes } from './music/routes.js';
import {
  DemoTestController,
  readDemoTestRecovery,
  registerDemoTestRoutes,
} from './demo-test/controller.js';
import { BilibiliStatus } from './platform/bilibili.js';
import { registerSteamAvatarRoutes, type SteamAvatars } from './media/steam-avatars.js';
import { ProductionGuidanceStore } from './program-scenes/guidance.js';
import { ProgramDirector } from './program-scenes/director.js';
import { ProgramPresentationStore } from './program-scenes/presentation.js';
import { productionReadiness } from './program-scenes/readiness.js';
import { registerDesktopOverlayRoutes } from './program-scenes/desktop-overlay.js';
import { registerProductionRoutes } from './program-scenes/production.js';
import { registerUpdateRoutes } from './updates/routes.js';
import type { UpdateManager } from './updates/manager.js';
import type { ResourceTrustPolicy } from '@mizar/resource-pack-contract/runtime';
import { ResourceStore } from './resource-store/store.js';
import {
  createRuntimeVerifier,
  isOfficialWebResource,
  PACK_ID,
} from './resource-store/runtime-adapter.js';
import { registerResourceRoutes } from './resource-store/routes.js';
import { MatchContextController, MatchManifestLkgStore } from './match-context/index.js';
import { LocalTournamentStore } from './match-context/local-tournament-store.js';
import { registerLocalTournamentRoutes } from './match-context/local-tournament-routes.js';
import { registerLocalMatchExitRoutes } from './match-context/local-match-exit.js';
import { registerLocalAssetRoutes } from './match-context/local-assets.js';
import { dirname, join } from 'node:path';
import { toMatchDocumentV1 } from '@mizar/rivalhub';
import { isStandaloneLocalMatch } from './match-context/lkg-store.js';
import { OutputService, type OutputServiceOptions } from './output/service.js';
import { outboxLocalError, ReliableOutbox } from './output/reliable-outbox.js';
import type { OnlineManifestConfig } from './match-context/http-source.js';
import { registerOnlineManifestRoutes } from './match-context/online-routes.js';
import { registerRivalHubConnectionRoutes } from './match-context/rivalhub-routes.js';
import type { RivalHubConnection } from './match-context/rivalhub-connection.js';
import {
  RivalsRehearsal,
  registerRivalsRehearsalRoutes,
} from './match-context/rivals-rehearsal.js';
import { registerBpRoutes } from './bp/controller.js';
import { registerBpDemoRoute } from './bp/demo-controller.js';
import { getBpDemoProjection } from './bp/demo-projection.js';
import { BpDemoStateController } from './bp/demo-state.js';
import { registerBpWorkspaceRoutes } from './bp/workspace-controller.js';
import { ObsAdapter } from './obs/adapter.js';
import { ObsConfigStore } from './obs/config.js';
import type { ObsNativeEvidence } from './obs/native-evidence.js';
import { registerObsRoutes } from './obs/routes.js';
import { ProgramSceneController, registerProgramSceneRoutes } from './program-scenes/controller.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import Fastify, { type FastifyInstance } from 'fastify';

import { DebugEvidenceStore, type DebugRuntimeClock } from './runtime/debug-state.js';
import { registerSupportRoutes } from './support/routes.js';
import { BusinessJournal } from './support/business-journal.js';
import type { LatestWinsConsumerHealth } from './runtime/latest-wins.js';
import { createProgramRuntime, type ProgramRuntime } from './runtime/program-runtime.js';
import type { SeriesProgressCheckpointStore } from '@mizar/core/series-progress';
import type { TelemetryObservation } from '@mizar/core/telemetry';
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
  readonly resources?: {
    readonly root: string;
    readonly required?: boolean;
    readonly policy?: ResourceTrustPolicy;
    readonly cacheHistory?: readonly ResourceTrustPolicy[];
  };
  readonly updates?: UpdateManager;
  readonly steamAvatars?: SteamAvatars;
  readonly supportLogsDirectory?: string;
  readonly supportJournal?: SessionJournal;
  readonly productRuntime?: {
    readonly appVersion?: string;
    readonly artifactSha256: string;
    readonly gitSha: string;
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
  readonly localTournamentPath?: string;
  readonly reliableOutboxPath?: string;
  readonly reliableSink?: OutputServiceOptions['sink'];
  readonly liveSink?: OutputServiceOptions['liveSink'];
  readonly onlineManifestConfig?: OnlineManifestConfig;
  readonly rivalhubConnection?: RivalHubConnection;
  readonly rehearsalFixturePath?: string;
  readonly projectionNowMonotonicMs?: () => number;
  readonly bpNowMonotonicMs?: () => number;
  readonly debugEvidenceStore?: DebugEvidenceStore;
  readonly debugClock?: DebugRuntimeClock;
  readonly deliveryConsumers?: readonly DeliveryHealthSource[];
  readonly cstvSources?: CstvSourceManagers;
  readonly workspaceObserver?: WorkspaceObserver;
  readonly observerSettingsPath?: string;
  readonly diagnosticsEndpoint?: string;
  readonly diagnosticsFetch?: typeof fetch;
  readonly onAcceptedRaw?: AcceptedRawSink;
  readonly onObservation?: ObservationSink;
  readonly onGsiDiagnostics?: GsiDiagnosticsSink;
  readonly clock?: GsiClock;
  readonly qualificationMode?: boolean;
  readonly qualificationControlToken?: string;
  readonly hudConfigPath?: string;
  readonly hudConfigStore?: HudConfigStore;
  readonly obsConfigPath?: string;
  readonly mulnxCamPacksRoot?: string;
  readonly mulnxBundle?: string;
  readonly readObsCaptureEvidence?: () => Promise<ObsNativeEvidence>;
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
  readonly port?: number;
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
  const demoMarkerPath = options.localTournamentPath
    ? join(dirname(options.localTournamentPath), 'demo-test.json')
    : undefined;
  const demoRecovery = readDemoTestRecovery(demoMarkerPath);
  const formalMutations = new Set<string>();
  let resources: ResourceStore | undefined;
  let recorder = options.recorder ?? createDisabledRecorder('recorder_not_configured');
  const currentRecorder = (): CaptureRecorder => recorder;
  const programRuntime =
    options.programRuntime ??
    createProgramRuntime(options.producerInstanceId ?? randomUUID(), {
      liveSession: { kind: 'bound', liveSessionId: randomUUID() },
      ...(options.seriesProgressCheckpointStore === undefined
        ? {}
        : { seriesProgressCheckpointStore: options.seriesProgressCheckpointStore }),
      ...(options.onSeriesProgressDiagnostic === undefined
        ? {}
        : { onSeriesProgressDiagnostic: options.onSeriesProgressDiagnostic }),
    });
  if (demoRecovery) programRuntime.resetSession(true);
  const debugEvidenceStore =
    options.debugEvidenceStore ?? new DebugEvidenceStore(programRuntime.getSnapshot());
  debugEvidenceStore.recordRuntime(programRuntime.getSnapshot());
  const debugClock = options.debugClock ?? { nowMonotonicMs: () => performance.now() };
  const deliveryConsumers = options.deliveryConsumers ?? [];
  let outputBinding = options.matchContextBinding;
  let businessJournal: BusinessJournal | undefined;
  const outputService: OutputService = new OutputService({
    ...(options.reliableOutboxPath === undefined
      ? {}
      : {
          outbox: new ReliableOutbox(
            options.reliableOutboxPath,
            (recovery, error) => {
              // Raw cause stays in the local log; support export applies its existing redaction.
              const evidence = {
                event: 'outbox',
                stage: 'outbox_load',
                err: outboxLocalError(error),
                recovery: recovery ?? null,
                result:
                  recovery === undefined
                    ? 'failure'
                    : recovery.code === 'outbox_recovered'
                      ? 'success'
                      : 'unconfirmed',
              };
              if (recovery === undefined)
                app.log.error(evidence, '发送队列无法安全恢复；原始文件保留。');
              else {
                app.log.warn(evidence, recovery.message);
                recordRuntimeDiagnostic(`output-${recovery.code}`, 'projection', false);
              }
            },
            (record, reason) => businessJournal?.reliable(record, reason),
          ),
        }),
    ...(options.rivalhubConnection !== undefined
      ? {
          authorityScope: () => options.rivalhubConnection!.reliableAuthorityScope(),
          sink: {
            send: (
              event: Parameters<NonNullable<OutputServiceOptions['sink']>['send']>[0],
              signal?: AbortSignal,
            ) =>
              options.rivalhubConnection!.view().paired &&
              outputBinding?.origin === 'online' &&
              outputBinding.context.matchId === event.matchId
                ? options.rivalhubConnection!.sendReliable(
                    event,
                    outputService.current(true),
                    signal,
                  )
                : (options.reliableSink?.send(event, signal) ??
                  Promise.resolve('rejected' as const)),
          },
        }
      : options.reliableSink === undefined
        ? {}
        : { sink: options.reliableSink }),
    ...(options.rivalhubConnection !== undefined
      ? {
          liveSink: {
            send: (
              snapshot: Parameters<NonNullable<OutputServiceOptions['liveSink']>['send']>[0],
            ) =>
              options.rivalhubConnection!.view().paired &&
              outputBinding?.origin === 'online' &&
              outputBinding.context.matchId === snapshot.matchId
                ? options.rivalhubConnection!.sendLive(snapshot)
                : (options.liveSink?.send(snapshot) ?? Promise.resolve()),
          },
        }
      : options.liveSink === undefined
        ? {}
        : { liveSink: options.liveSink }),
    restoreContinuity: (checkpoint) => {
      if (
        outputBinding?.context.matchId !== checkpoint.matchId ||
        outputBinding.manifest.revision !== checkpoint.contextRevision ||
        programRuntime.getCurrentState().runtimeSeq !== 0
      )
        return undefined;
      programRuntime.restoreDeliveryContinuity({
        ...checkpoint.cursor,
        mapName: checkpoint.mapName,
      });
      return projectionCoordinator.refresh();
    },
    onDiagnostic: (code) => recordRuntimeDiagnostic(`output-${code}`, 'projection', false),
    onBusinessEvidence: (stage, evidence) => businessJournal?.write(stage, evidence),
  });
  if (demoRecovery)
    void outputService.setQuarantined(true).catch((error) =>
      app.log.error(
        {
          event: 'demo-test',
          stage: 'recovery_output_quarantine',
          diagnostic: diagnosticValue(error),
        },
        'Demo test quarantine failed',
      ),
    );
  const baseSources = options.cstvSources ?? createCstvSourceManagers({});
  const cstvSources = {
    ...baseSources,
    ...(options.workspaceObserver ? { lookahead: options.workspaceObserver.source } : {}),
  };

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
  const sessionJournal =
    options.supportJournal ??
    (options.supportLogsDirectory
      ? new SessionJournal(options.supportLogsDirectory, {
          appVersion: options.productRuntime?.appVersion ?? null,
          gitSha: options.productRuntime?.gitSha ?? null,
          artifactSha256: options.productRuntime?.artifactSha256 ?? null,
        })
      : undefined);
  const app = Fastify({
    logger: sessionJournal
      ? {
          stream: {
            write: (line: string) => {
              sessionJournal.write(line);
              if (options.logger) process.stdout.write(line);
            },
          },
        }
      : (options.logger ?? false),
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    requestTimeout: GSI_REQUEST_TIMEOUT_MS,
  });
  const performanceContext = sessionJournal
    ? new PerformanceWindow(
        sessionJournal,
        () => debugClock.nowMonotonicMs(),
        options.supportLogsDirectory,
      )
    : undefined;
  const programChat = new ProgramChat();
  const observerSettings = new ObserverSettingsStore(options.observerSettingsPath);
  let observerEligible = () => false;
  app.addHook('onReady', async () => {
    try {
      await observerSettings.load();
    } catch (error) {
      app.log.error(
        { stage: 'observer_settings_load', err: error },
        '观察辅助设置需要重新保存，基础制播继续就绪',
      );
    }
  });
  const nativeSource =
    options.supportLogsDirectory && sessionJournal
      ? new NativeSource(options.supportLogsDirectory, sessionJournal, (record) => {
          if (programChat.ingest(record)) projectionCoordinator.refresh();
        })
      : undefined;
  app.addHook('onReady', () => {
    nativeSource?.start();
  });
  if (options.supportLogsDirectory !== undefined) {
    businessJournal = new BusinessJournal(
      options.supportLogsDirectory,
      () =>
        app.log.warn(
          { event: 'business', stage: 'business_log_write_failed', result: 'failure' },
          '业务诊断日志写入失败',
        ),
      options.productRuntime?.appVersion,
      (entry) => sessionJournal?.record('business_evidence', entry),
    );
  }
  const browserOperationId = (value: unknown): string | null =>
    typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
      ? value
      : null;
  app.addHook('onRequest', (request, _reply, done) => {
    if (sessionJournal)
      sessionJournal.withRequest(
        {
          requestId: request.id,
          browserOperationId: browserOperationId(request.headers['x-mizar-operation-id']),
          taskId: browserOperationId(request.headers['x-mizar-task-id']),
          parentOperationId: browserOperationId(request.headers['x-mizar-parent-operation-id']),
          trigger:
            request.headers['x-mizar-trigger'] === 'user'
              ? 'user'
              : request.headers['x-mizar-trigger'] === 'system'
                ? 'system'
                : 'unattributed',
        },
        done,
      );
    else done();
  });
  const isControl = (url: string, method: string) =>
    method !== 'GET' && /^(?:\/operator\/|\/runtime\/)/.test(url);
  const controlState = () => ({
    production: production.get(),
    program: sceneController.get(),
    runtime: debugEvidenceStore.getSupportSummary(debugClock.nowMonotonicMs()),
    hud: hudConfigStore.getState().document,
    match: matchContextController?.getActiveBinding() ?? null,
  });
  app.addHook('onRequest', (request, _reply, done) => {
    if (isControl(request.url, request.method))
      sessionJournal?.record('operation_received', {
        requestId: request.id,
        browserOperationId: browserOperationId(request.headers['x-mizar-operation-id']),
        method: request.method,
        route: request.routeOptions.url,
        before: controlState(),
      });
    done();
  });
  app.addHook('preHandler', (request, _reply, done) => {
    if (isControl(request.url, request.method))
      sessionJournal?.record('operation_begin', {
        requestId: request.id,
        browserOperationId: browserOperationId(request.headers['x-mizar-operation-id']),
        method: request.method,
        route: request.routeOptions.url,
        parameters: diagnosticValue(request.body),
        filename: request.headers['x-mizar-filename'],
      });
    done();
  });
  app.addHook('onSend', (request, reply, payload, done) => {
    if (isControl(request.url, request.method)) {
      let result: unknown = payload;
      if (typeof payload === 'string') {
        try {
          result = JSON.parse(payload);
        } catch {
          result = { bytes: Buffer.byteLength(payload) };
        }
      }
      sessionJournal?.record('operation_result', {
        requestId: request.id,
        browserOperationId: browserOperationId(request.headers['x-mizar-operation-id']),
        method: request.method,
        route: request.routeOptions.url,
        httpStatus: reply.statusCode,
        result,
        after: controlState(),
      });
    }
    done(null, payload);
  });
  options.rivalhubConnection?.setBusinessEvidenceHandler?.((stage, evidence) => {
    if (stage === 'business_live' || stage === 'original_error')
      sessionJournal?.record(
        stage === 'business_live' ? 'website_live_evidence' : 'website_original_error',
        evidence,
      );
    businessJournal?.write(stage, evidence);
  });
  app.addHook('onResponse', async (request, reply) => {
    if (
      reply.statusCode >= 400 ||
      (request.method !== 'GET' && request.url.startsWith('/operator/'))
    )
      request.log.info(
        {
          method: request.method,
          route: request.routeOptions.url,
          res: { statusCode: reply.statusCode },
        },
        'Local operation completed',
      );
  });
  app.addHook('onError', async (request, _reply, error) => {
    sessionJournal?.record('request_error', {
      requestId: request.id,
      browserOperationId: browserOperationId(request.headers['x-mizar-operation-id']),
      method: request.method,
      route: request.routeOptions.url,
      error,
    });
    request.log.error({ err: error, route: request.routeOptions.url }, 'Local operation failed');
  });
  registerStaticHost(app, {
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
    qualificationMode: options.qualificationMode ?? false,
    readResource: async (path, range) => {
      if (!resources || !isOfficialWebResource(path) || !resources.getStatus(PACK_ID).activeVersion)
        return undefined;
      return resources.read(PACK_ID, path, range);
    },
  });
  const hudConfigStore =
    options.hudConfigStore ??
    new HudConfigStore({
      ...(options.hudConfigPath === undefined ? {} : { filePath: options.hudConfigPath }),
      onDiagnostic: (code, error) =>
        app.log.warn(
          { code, error: diagnosticValue(error), path: options.hudConfigPath },
          'Companion HUD 配置诊断',
        ),
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
  let observerMatchId: string | null | undefined;
  const projectionCoordinator =
    options.projectionCoordinator ??
    createProjectionCoordinator({
      observerSettings: () => ({
        ...observerSettings.settings,
        enabled: observerSettings.settings.enabled && observerEligible(),
      }),
      programChat: (cursor, fresh) => programChat.view(cursor, fresh),
      ...(options.steamAvatars ? { avatars: options.steamAvatars } : {}),
      programRuntime,
      cstvSources,
      ...(options.matchContextBinding === undefined || demoRecovery
        ? {}
        : { matchContextBinding: options.matchContextBinding }),
      ...(projectionNowMonotonicMs === undefined
        ? {}
        : { nowMonotonicMs: projectionNowMonotonicMs }),
      onDiagnostic: ({ code }) =>
        recordRuntimeDiagnostic(code, 'projection', projectionDiagnosticDegradesRuntime(code)),
      onProjection: (bundle) => {
        const matchId = bundle.program.match?.matchId ?? null;
        if (observerMatchId !== undefined && observerMatchId !== matchId)
          observerSettings.clearConnection();
        observerMatchId = matchId;
        outputService.setCurrent(bundle, outputBinding);
      },
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
      sessionJournal?.record('local_transport', diagnostic);
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
  void app.register(async (scope) => {
    await registerDesktopOverlayRoutes(
      scope,
      options.localTournamentPath
        ? join(dirname(options.localTournamentPath), 'desktop-overlay.json')
        : undefined,
      localWebTransport.getOriginPolicy(),
    );
  });
  const bpDemoState = new BpDemoStateController();
  const bpSession = registerBpRoutes(app, {
    originPolicy: localWebTransport.getOriginPolicy(),
    ...(options.bpNowMonotonicMs === undefined ? {} : { now: options.bpNowMonotonicMs }),
    getProjection: () =>
      bpDemoState.getProjection(() => projectionCoordinator.getBpProjection(), getBpDemoProjection),
  });
  registerBpDemoRoute(app, {
    originPolicy: localWebTransport.getOriginPolicy(),
    session: bpSession,
    state: bpDemoState,
  });
  const obsConfigStore =
    options.obsConfigPath === undefined ? undefined : new ObsConfigStore(options.obsConfigPath);
  const obsAdapter =
    obsConfigStore === undefined
      ? undefined
      : new ObsAdapter(
          obsConfigStore,
          `http://${options.host ?? '127.0.0.1'}:${options.port ?? 3000}`,
          (stage, error) =>
            app.log.warn(
              { event: 'obs', stage, result: 'failure', diagnostic: { error } },
              'OBS request failed',
            ),
        );
  let musicDirector: MusicDirector | undefined;
  let cameraDirector: CameraDirector | undefined;
  const sceneController = new ProgramSceneController(
    projectionCoordinator,
    bpSession,
    obsAdapter === undefined
      ? undefined
      : (id, options) =>
          obsAdapter.switchScene(id, {
            ...options,
            onStarted: () => {
              const preparing = sceneController.get().preparing;
              if (
                id === 'matchup' &&
                preparing?.target === 'matchup' &&
                options.valid?.() !== false
              ) {
                const sound = cameraDirector?.store.map(
                  projectionCoordinator.getCurrent().program.map.name,
                )?.openingSound;
                musicDirector?.opening(`opening:${preparing.revision}`, sound ?? undefined);
                cameraDirector?.opening();
              }
            },
          }),
    obsAdapter === undefined ? undefined : (options) => obsAdapter.switchToWaitingForExit(options),
  );
  if (options.steamAvatars) {
    options.steamAvatars.onChanged(() => projectionCoordinator.refresh());
    registerSteamAvatarRoutes(app, options.steamAvatars, localWebTransport.getOriginPolicy());
    app.addHook('onClose', () => {
      options.steamAvatars?.close();
      return Promise.resolve();
    });
  }
  app.get('/local/v1/readiness', async (_request, reply) => {
    const obs = await obsAdapter?.status();
    return reply
      .header('cache-control', 'no-store')
      .send(productionReadiness(projectionCoordinator.getCurrent(), sceneController.get(), obs));
  });
  registerProgramSceneRoutes(app, {
    originPolicy: localWebTransport.getOriginPolicy(),
    controller: sceneController,
  });
  if (obsConfigStore !== undefined && obsAdapter !== undefined) {
    // Browser sources that opened before HTTP readiness otherwise stay on
    // Chromium's connection-error page and never run the WebSocket retry code.
    app.addHook('onListen', () => {
      obsAdapter.startBrowserRecovery();
      return Promise.resolve();
    });
    registerObsRoutes(app, {
      originPolicy: localWebTransport.getOriginPolicy(),
      configStore: obsConfigStore,
      adapter: obsAdapter,
      ...(options.readObsCaptureEvidence
        ? { readCaptureEvidence: options.readObsCaptureEvidence }
        : {}),
      activeScene: () => sceneController.get().active,
    });
  }
  let previousBindingOrigin: string | undefined = options.matchContextBinding?.origin;
  // The binding listener must retire fixture state on the way out, but it is created
  // before the rehearsal exists; this slot carries the later-constructed instance.
  const fixtureLifecycle: { rehearsal: RivalsRehearsal | undefined } = { rehearsal: undefined };
  const matchContextController =
    options.matchManifestPath === undefined
      ? null
      : new MatchContextController({
          lkgStore: new MatchManifestLkgStore({ filePath: options.matchManifestPath }),
          ...(options.matchContextBinding === undefined
            ? {}
            : { initialBinding: options.matchContextBinding }),
          onBindingChanged: (binding) => {
            const previousOrigin = previousBindingOrigin;
            previousBindingOrigin = binding?.origin;
            outputBinding = binding;
            outputService.setBinding(binding);
            projectionCoordinator.setMatchContextBinding(binding);

            // Leaving the Rivals sample by any route retires fixture runtime state
            // without waiting for an explicit "stop rehearsal" action.
            if (previousOrigin === 'fixture' && binding?.origin !== 'fixture') {
              fixtureLifecycle.rehearsal?.exitFixtureRuntimeState();
            }

            programCueCoordinator.afterRuntimeMutation();
          },
        });
  let performanceWindowStart = performance.now();
  let processing = { count: 0, totalMs: 0, maxMs: 0 };
  let latestInput: TelemetryObservation['receive'] | null = null;
  let latestRawInput: { sequence: number; receivedAt: string; receivedMonotonicMs: number } | null =
    null;
  let slowProcessingCount = 0;
  const slowProcessing: { time: string; sequence: number; durationMs: number }[] = [];
  const dispatchObservation = (
    observation: TelemetryObservation,
    sampleStageBinding?: { mapOrder: number },
  ): void => {
    const processingStarted = performance.now();
    latestInput = observation.receive;
    try {
      const source = programRuntime.getCurrentState().programSource;
      const lastAccepted = source.lastAccepted;
      if (
        lastAccepted !== undefined &&
        observation.receive.receivedMonotonicMs - lastAccepted.receivedMonotonicMs >
          programRuntime.getSnapshot().continuityPolicy.staleAfterMs
      ) {
        outputService.beforeRuntimeMutation();
        const changed = programRuntime.advanceProgramSourceGeneration({
          monotonicMs: observation.receive.receivedMonotonicMs,
          utc: observation.receive.receivedAt,
        });
        const continuityBundle = projectionCoordinator.afterRuntimeMutation(changed);
        outputService.afterRuntimeMutation(changed, continuityBundle, outputBinding);
        programCueCoordinator.afterRuntimeMutation(changed);
      }
      outputService.beforeRuntimeMutation();
      const result = programRuntime.acceptObservation(observation);
      if (result.disposition.kind === 'ignored')
        performanceContext?.trigger('observation_ignored', {
          receive: observation.receive,
          disposition: result.disposition,
        });
      if (sampleStageBinding) {
        programRuntime.executeOperatorCommand({
          kind: 'bind-current-map-execution-to-series-map',
          mapOrder: sampleStageBinding.mapOrder,
          reason: `Rivals 示例第 ${sampleStageBinding.mapOrder} 图执行绑定`,
        });
      }
      const bundle = projectionCoordinator.afterRuntimeMutation(result);
      outputService.afterRuntimeMutation(result, bundle, outputBinding);
      programCueCoordinator.afterRuntimeMutation(result);
      debugEvidenceStore.recordNormalizedObservation(observation);
      debugEvidenceStore.recordRuntime(programRuntime.getSnapshot());
      demoTest?.observationAccepted();
    } catch (error) {
      sessionJournal?.record('observation_failure', { error, receive: observation.receive });
      performanceContext?.trigger('observation_failure', {
        receive: observation.receive,
        error: diagnosticValue(error),
      });
      throw error;
    } finally {
      const durationMs = performance.now() - processingStarted;
      processing.count++;
      processing.totalMs += durationMs;
      processing.maxMs = Math.max(processing.maxMs, durationMs);
      if (durationMs >= 50) {
        performanceContext?.trigger('slow_observation', {
          sequence: observation.receive.sequence,
          durationMs,
        });
        slowProcessingCount++;
        slowProcessing.push({
          time: new Date().toISOString(),
          sequence: observation.receive.sequence,
          durationMs,
        });
        if (slowProcessing.length > 8) slowProcessing.shift();
      }
    }
  };

  const rehearsal =
    options.rehearsalFixturePath && matchContextController
      ? new RivalsRehearsal(
          options.rehearsalFixturePath,
          matchContextController,
          sceneController,
          dispatchObservation,
          {
            activateFixtureSeriesProgress: (context) => {
              programRuntime.activateFixtureSeriesProgress(context);
              projectionCoordinator.refresh();
            },
            clearFixtureSeriesProgress: () => {
              programRuntime.clearFixtureSeriesProgress();
              projectionCoordinator.refresh();
            },
          },
        )
      : undefined;
  fixtureLifecycle.rehearsal = rehearsal;
  if (rehearsal)
    registerRivalsRehearsalRoutes(app, {
      rehearsal,
      originPolicy: localWebTransport.getOriginPolicy(),
      beforeLoad: async () => {
        await programRuntime.flushSeriesProgressCheckpoint();
        await options.rivalhubConnection?.release();
      },
    });
  const localTournamentStore =
    options.localTournamentPath === undefined
      ? null
      : new LocalTournamentStore(options.localTournamentPath);
  if (matchContextController !== null) {
    app.get('/local/v1/match-document', (_request, reply) => {
      const envelope = matchContextController.getActiveDocumentEnvelope();
      return envelope === null
        ? reply
            .code(404)
            .header('cache-control', 'no-store')
            .send({ error: 'match_document_unavailable' })
        : reply.header('cache-control', 'no-store').send(envelope);
    });
  }
  const production = registerProductionRoutes(app, {
    originPolicy: localWebTransport.getOriginPolicy(),
    hasContext: () =>
      matchContextController?.getActiveBinding() !== undefined &&
      matchContextController?.getActiveBinding() != null,
    scenes: sceneController,
    beforeEnter: () => demoTest?.openFormalBoundary(),
    beforeFinish: () => cameraDirector?.finishProduction(),
    finishTrial: async () => {
      await demoTest?.finish();
    },
    release: async () => {
      await options.rivalhubConnection?.release();
    },
  });
  const localMatchExit =
    matchContextController === null
      ? undefined
      : registerLocalMatchExitRoutes(app, {
          controlToken: options.productRuntime?.controlToken,
          loopback: localWebTransport.getOriginPolicy().mode === 'loopback',
          controller: matchContextController,
          runtime: programRuntime,
          isPreparationWaiting: () =>
            !production.isTrialPending() &&
            !matchContextController.isTemporary() &&
            production.get().mode === 'preparation' &&
            sceneController.get().active === 'waiting' &&
            sceneController.get().preparing === undefined,
          productionRevision: () => production.get().revision,
        });
  if (localTournamentStore !== null && matchContextController !== null) {
    registerLocalTournamentRoutes(app, {
      store: localTournamentStore,
      projections: projectionCoordinator,
      controller: matchContextController,
      canReleaseLocalSelection: () => localMatchExit?.canReleaseLocalSelection() ?? false,
      canConfirmLocalExit: () => localMatchExit?.canConfirmLocalExit() ?? false,
      // The existing production owner serializes preparation mutations with enter/finish/update.
      withLocalSelectionRelease: (commit) => production.withResourceActivation(commit),
      originPolicy: localWebTransport.getOriginPolicy(),
    });
    registerLocalAssetRoutes(app, {
      directory: join(dirname(options.localTournamentPath!), 'local-assets'),
      originPolicy: localWebTransport.getOriginPolicy(),
    });
  }
  if (options.resources) {
    app.decorate('getResourceStore', () => resources);
    registerResourceRoutes(app, () => resources);
    app.addHook('onReady', async () => {
      try {
        resources = await ResourceStore.open({
          root: options.resources!.root,
          diagnostic: (packId, error) =>
            app.log.warn(
              {
                event: 'resource',
                stage: 'resource_cache_verify',
                result: 'failure',
                packId,
                diagnostic: { error: diagnosticValue(error) },
              },
              '官方素材缓存验证失败。',
            ),
          verifyTrustedPack: createRuntimeVerifier(
            options.resources!.policy,
            options.resources!.cacheHistory,
            options.productRuntime?.appVersion
              ? {
                  appVersion: options.productRuntime.appVersion,
                  gitSha: options.productRuntime.gitSha,
                }
              : undefined,
          ),
          activateWhenSafe: (commit) => production.withResourceActivation(commit),
        });
      } catch (error) {
        app.log.warn(
          {
            event: 'resource',
            stage: 'resource_store_open',
            result: 'failure',
            diagnostic: { error: diagnosticValue(error) },
          },
          '官方素材缓存不可用；保留原 Full 资源路径。',
        );
        if (options.resources?.required) {
          throw new Error('resource_store_open_failed', { cause: error });
        }
      }
    });
    app.addHook('onClose', async () => {
      await resources?.shutdown();
    });
  }
  if (options.updates && options.productRuntime)
    registerUpdateRoutes(app, {
      manager: options.updates,
      controlToken: options.productRuntime.controlToken,
      originPolicy: localWebTransport.getOriginPolicy(),
      production,
      scenes: sceneController,
      obs: async () => obsAdapter?.status(),
    });
  const guidance = new ProductionGuidanceStore();
  const bilibili = new BilibiliStatus();
  app.get('/local/v1/production-guidance', async (_request, reply) => {
    const binding = matchContextController?.getActiveBinding() ?? options.matchContextBinding;
    const view = guidance.get(projectionCoordinator.getCurrent(), binding);
    const state = await bilibili.read(
      binding?.origin === 'fixture'
        ? []
        : (binding?.context.commentators.map((person) => person.liveStreamUrl) ?? []),
    );
    const current = matchContextController?.getActiveBinding() ?? options.matchContextBinding;
    return reply.header('cache-control', 'no-store').send({
      ...(current === binding ? view : guidance.get(projectionCoordinator.getCurrent(), current)),
      bilibili: current === binding ? state : 'unknown',
    });
  });
  const presentation = new ProgramPresentationStore();
  const presentationUnsubscribe = projectionCoordinator.subscribePresentation((bundle) => {
    businessJournal?.runtime(
      bundle,
      matchContextController?.getActiveBinding() ?? options.matchContextBinding,
      programRuntime.getCurrentState().programTelemetry,
    );
    guidance.update(
      bundle,
      matchContextController?.getActiveBinding() ?? options.matchContextBinding,
    );
    presentation.update(
      bundle.program,
      matchContextController?.getActiveBinding()?.manifest.revision ??
        options.matchContextBinding?.manifest.revision ??
        'initial',
    );
  });
  app.get('/local/v1/program-presentation', (_request, reply) => {
    const envelope = matchContextController?.getActiveDocumentEnvelope();
    const document = envelope?.freshness === 'fresh' ? envelope.document : null;
    const schedule = demoTest.get().active
      ? undefined
      : envelope?.source === 'local' && document?.competition
        ? localTournamentStore?.scheduleWindow(document.competition?.competitionId)
        : options.rivalhubConnection?.getSchedule();
    return reply.header('cache-control', 'no-store').send(presentation.get(document, schedule));
  });
  const director = new ProgramDirector(
    projectionCoordinator,
    sceneController,
    bpSession,
    () => production.get().mode !== 'preparation',
  );
  if (obsConfigStore && options.obsConfigPath) {
    const musicStore = new MusicStore(
      join(dirname(options.obsConfigPath), 'music'),
      (stage, evidence) => sessionJournal?.record(stage, evidence),
    );
    app.addHook('onReady', async () => {
      await musicStore.load().catch((error) => {
        app.log.error({ stage: 'music_load', err: error, result: 'failure' }, '音乐配置加载失败');
        musicStore.failure = true;
      });
    });
    musicDirector = new MusicDirector(
      musicStore,
      new ObsMusicProvider(obsConfigStore, (stage, evidence) =>
        sessionJournal?.record(stage, evidence),
      ),
      () => ({
        program: projectionCoordinator.getCurrent().program,
        active: sceneController.get().active,
        production:
          production.get().mode !== 'preparation' &&
          projectionCoordinator.getCurrent().operator.matchContext.origin !== 'fixture',
      }),
    );
    registerMusicRoutes(app, musicStore, musicDirector, localWebTransport.getOriginPolicy());
    const cameraStore = new OrchestrationStore(
      join(dirname(options.obsConfigPath), 'orchestration'),
      (stage, evidence) => sessionJournal?.record(stage, evidence),
    );
    const cameraEvidence = (stage: string, evidence: unknown) =>
      sessionJournal?.record(stage, evidence);
    const mulnxTool = options.mulnxBundle
      ? new MulnxTool(
          join(dirname(options.obsConfigPath), 'mulnx'),
          options.mulnxBundle,
          cameraEvidence,
        )
      : undefined;
    cameraDirector = new CameraDirector(
      cameraStore,
      new MulnxProvider(cameraEvidence),
      () => ({
        program: projectionCoordinator.getCurrent().program,
        active: sceneController.get().active,
        production:
          production.get().mode !== 'preparation' &&
          projectionCoordinator.getCurrent().operator.matchContext.origin !== 'fixture',
        manual: director.get().mode === 'manual',
        demoAudition:
          demoTest.get().gameOwnership === 'external'
            ? demoTest.canUseCamera('audition')
            : undefined,
      }),
      cameraEvidence,
      undefined,
      undefined,
      (pack) => verifyIsolatedPack(options.mulnxCamPacksRoot ?? mulnxTool?.camPacksRoot, pack),
      options.productRuntime !== undefined,
    );
    app.addHook('onReady', async () => {
      await mulnxTool
        ?.load()
        .catch((error) => app.log.error({ stage: 'mulnx_load', err: error }, 'MulNX 加载失败'));
      await cameraStore
        .load()
        .catch((error) =>
          app.log.error(
            { stage: 'camera_load', err: error, result: 'failure' },
            '运镜预设加载失败',
          ),
        );
    });
    registerOrchestrationRoutes(
      app,
      cameraDirector,
      musicStore,
      localWebTransport.getOriginPolicy(),
      {
        controlToken: options.productRuntime?.controlToken,
        configure: production.configureCameraSession,
        configureDemo: (requestId, commit) => demoTest.configureCameraSession(requestId, commit),
        canPrepare: () => production.get().mode === 'preparation',
      },
      mulnxTool,
    );
  }
  sceneController.attachDirector(director);
  const directorTimer = setInterval(() => {
    void director.tick().catch(() => director.hold());
    void musicDirector?.tick();
    cameraDirector?.tick();
  }, 100);
  directorTimer.unref();
  registerBpWorkspaceRoutes(app, {
    originPolicy: localWebTransport.getOriginPolicy(),
    controller: matchContextController,
    projections: projectionCoordinator,
    demoState: bpDemoState,
    ...(localTournamentStore === null ? {} : { localTournamentStore }),
  });
  registerOnlineManifestRoutes(app, {
    isConnected: () => options.rivalhubConnection?.view().paired === true,
    originPolicy: localWebTransport.getOriginPolicy(),
    controller: matchContextController,
    ...(options.onlineManifestConfig === undefined ? {} : { config: options.onlineManifestConfig }),
  });
  if (options.rivalhubConnection)
    registerRivalHubConnectionRoutes(app, {
      connection: options.rivalhubConnection,
      canClaim: () => !production.isTrialPending() && production.get().mode === 'live',
      canUpdatePlan: () => !production.isTrialPending() && programRuntime.canUpdateSeriesPlan(),
      controller: matchContextController,
      currentSnapshot: () => outputService.current(true),
      originPolicy: localWebTransport.getOriginPolicy(),
    });
  const restoreFormal = async (trial = false) => {
    if (matchContextController === null) return;
    await localTournamentStore?.load();
    const restored = trial
      ? await matchContextController.restoreTemporaryBinding()
      : await matchContextController.restoreLatest();
    if (localTournamentStore === null) return;
    const selected = localTournamentStore
      .getSnapshot()
      .matches.find(
        (match) => match.matchId === localTournamentStore.getSnapshot().selectedMatchId,
      );
    const localSelectedAt = localTournamentStore.getSnapshot().selectedAt;
    const localWasSelectedLast =
      localSelectedAt !== null &&
      Date.parse(localSelectedAt) >= Date.parse(restored?.storedAt ?? '1970-01-01T00:00:00.000Z');
    if (
      selected !== undefined &&
      (restored === undefined || isStandaloneLocalMatch(restored) || localWasSelectedLast)
    ) {
      if (!trial) localMatchExit?.requireHostConfirmation();
      if (trial) matchContextController.restoreTemporaryLocalDocument(selected);
      else matchContextController.activateLocalDocument(selected);
    } else if (restored !== undefined && isStandaloneLocalMatch(restored)) {
      const migrated = await localTournamentStore.importLegacyMatch(
        toMatchDocumentV1(restored.manifest),
      );
      if (!trial) localMatchExit?.requireHostConfirmation();
      if (trial) matchContextController.restoreTemporaryLocalDocument(migrated);
      else matchContextController.activateLocalDocument(migrated);
    }
  };
  const demoTest = new DemoTestController({
    canBegin: () => formalMutations.size === 0,
    dataReady: () => {
      const current = programRuntime.getCurrentState();
      const telemetry = current.programTelemetry;
      return (
        projectionCoordinator.getCurrent().operator.runtime.telemetryFreshness === 'fresh' &&
        programRuntime.getSourceFreshness(projectionNowMonotonicMs()) === 'fresh' &&
        telemetry?.coverage.map === 'present' &&
        telemetry.coverage.allPlayers === 'present' &&
        (telemetry.telemetry.allPlayers?.length ?? 0) > 0 &&
        telemetry.telemetry.map?.name !== undefined
      );
    },
    diagnostic: (stage, error) =>
      app.log.error(
        { event: 'demo-test', stage, result: 'failure', diagnostic: error },
        'Demo test operation failed',
      ),
    markerPath: demoMarkerPath,
    recovery: demoRecovery,
    context: matchContextController,
    runtime: programRuntime,
    scenes: sceneController,
    production,
    obs: async () => obsAdapter?.status(),
    quarantineOutput: (value) => outputService.setQuarantined(value),
    refresh: () => {
      projectionCoordinator.refresh();
      programCueCoordinator.afterRuntimeMutation();
    },
    restoreFormal: () => restoreFormal(true),
    hold: () => director.hold(),
  });
  registerDemoTestRoutes(app, demoTest, options.productRuntime?.controlToken);
  observerEligible = () =>
    production.get().mode !== 'preparation' &&
    !production.isTrialPending() &&
    !demoTest.get().active;
  registerObserverSettings(app, observerSettings, localWebTransport.getOriginPolicy());
  const observerSettingsUnsubscribe = observerSettings.subscribe((kind) => {
    if (kind !== 'game') projectionCoordinator.resetAssist();
  });
  app.addHook('onClose', () => {
    observerSettingsUnsubscribe();
  });
  if (options.workspaceObserver && options.productRuntime)
    registerWorkspaceObserver(
      app,
      options.workspaceObserver,
      options.productRuntime.controlToken,
      observerEligible,
      observerSettings,
    );
  app.addHook('onRequest', async (request, reply) => {
    if (['GET', 'HEAD'].includes(request.method)) return;
    const path = request.url.split('?')[0];
    if (!path?.startsWith('/operator/')) return;
    if (!production.isTrialPending() && demoTest?.get().active !== true) {
      if (!path.startsWith('/operator/runtime/')) formalMutations.add(request.id);
      return;
    }
    if (
      [
        '/operator/runtime/demo-test',
        '/operator/runtime/camera-session',
        '/operator/runtime/observer',
        '/operator/runtime/stop',
        '/operator/production',
        '/operator/program-scene',
        // Local evidence capture does not mutate trial or formal match state.
        '/operator/diagnostics/report',
      ].includes(path)
    )
      return;
    if (path === '/operator/orchestration') return;
    // Trial presentation is manual. Keep all match, platform, update and resource mutations excluded.
    return reply
      .code(409)
      .send({ error: 'demo_test_active', message: '请先结束试播并完成 CS2 恢复。' });
  });
  app.addHook('preHandler', async (request, reply) => {
    if (
      (production.isTrialPending() || demoTest.get().active) &&
      request.url.split('?')[0] === '/operator/orchestration' &&
      !demoTest.canUseCamera((request.body as { action?: unknown } | null)?.action)
    )
      return reply
        .code(409)
        .send({ error: 'demo_camera_manual_only', message: '请在 Demo 试播中手动试播运镜。' });
    if (demoTest?.get().active !== true || request.url.split('?')[0] !== '/operator/program-scene')
      return;
    const body = request.body as { sceneId?: unknown } | null;
    if (body?.sceneId === 'waiting') return;
    if (demoTest.get().phase !== 'playing' || !demoTest.get().dataReady)
      return reply
        .code(409)
        .send({ error: 'demo_test_not_ready', message: '请等待有效的 Demo 观察数据。' });
  });
  app.addHook('onResponse', (request, _reply, done) => {
    formalMutations.delete(request.id);
    done();
  });
  app.addHook('onReady', async () => {
    if (demoTest.get().active) await demoTest.recover();
    else await restoreFormal();
  });
  app.addHook('onReady', async () => {
    outputService.setCurrent(projectionCoordinator.getCurrent(), outputBinding);
    await outputService.start();
    businessJournal?.runtime(
      projectionCoordinator.getCurrent(),
      outputBinding,
      programRuntime.getCurrentState().programTelemetry,
    );
    for (const record of outputService.getReliableRecords())
      businessJournal?.reliable(record, 'restored');
    await businessJournal?.flush();
    sessionJournal?.record('configuration_snapshot', {
      ...controlState(),
      obs: await obsConfigStore
        ?.read()
        .catch((error: unknown) => ({ readError: diagnosticValue(error) })),
    });
  });
  app.get('/local/v1/live-snapshot', (request, reply) => {
    outputService.setCurrent(projectionCoordinator.getCurrent(), outputBinding);
    const withRadar = (request.query as Record<string, unknown>).radar === '1';
    const current = outputService.current(withRadar);
    return current === null
      ? reply
          .code(503)
          .header('cache-control', 'no-store')
          .send({ error: 'live_snapshot_unavailable' })
      : reply.header('cache-control', 'no-store').send(current);
  });
  app.get('/local/v1/reliable-output-status', (_request, reply) =>
    reply.header('cache-control', 'no-store').send({
      recovery: outputService.getReliableRecovery() ?? null,
      records: outputService.getReliableRecords().map((record) => ({
        idempotencyKey: record.event.idempotencyKey,
        kind: record.event.kind,
        status: record.status,
        attempts: record.attempts,
        updatedAt: record.updatedAt,
      })),
    }),
  );
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
              repository: 'Starfie1d1272/Mizar',
              appVersion: options.productRuntime.appVersion,
              artifactSha256: options.productRuntime.artifactSha256,
              gitSha: options.productRuntime.gitSha,
              instanceId: options.productRuntime.instanceId,
              mode: 'product',
            },
          }),
    };
  });

  if (options.productRuntime !== undefined) {
    const product = options.productRuntime;
    app.post('/operator/runtime/stop', async (request, reply) => {
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
      // Host must finish the owned game and configuration transaction while
      // this service is still available to keep the formal boundary isolated.
      if (demoTest.get().active)
        return reply.code(409).send({
          message: '请先在桌面结束 Demo 试播并恢复游戏配置，再停止服务。',
        });
      // The capability-verified CLI stop uses the same transaction as both UIs.
      const result = await production.shutdown();
      if (result.code !== 200) return reply.code(result.code).send(result.value);
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

  const recordPerformanceWindow = (reason: string) => {
    if (!sessionJournal) return;
    const now = performance.now();
    const channels = (['program', 'radar', 'operator', 'assist'] as const).map((channel) => {
      const publisher = projectionCoordinator.getPublisher(channel);
      const current = publisher.getCurrent();
      return {
        channel,
        channelSeq: current?.channelSeq ?? null,
        cursor: current?.cursor ?? null,
        subscribers: publisher.getHealth?.() ?? null,
      };
    });
    sessionJournal.record('runtime_performance_window', {
      reason,
      windowMs: now - performanceWindowStart,
      schedulerDelayMs:
        reason === 'interval' ? Math.max(0, now - performanceWindowStart - 15000) : null,
      input: {
        raw: latestRawInput,
        normalized: latestInput,
        ageMs: latestInput
          ? Math.max(0, debugClock.nowMonotonicMs() - latestInput.receivedMonotonicMs)
          : null,
      },
      processing: {
        ...processing,
        meanMs: processing.count ? processing.totalMs / processing.count : null,
        scope:
          'synchronous observation acceptance, runtime mutation and projection/output scheduling; excludes upstream adapter and asynchronous delivery',
      },
      slowProcessing: {
        count: slowProcessingCount,
        omittedSamples: Math.max(0, slowProcessingCount - slowProcessing.length),
        samples: slowProcessing.splice(0),
      },
      runtime: debugEvidenceStore.getSupportSummary(debugClock.nowMonotonicMs()),
      recorder: currentRecorder().getHealth(),
      delivery: deliveryConsumers.map((consumer) => consumer.getHealth()),
      channels,
      anomalyContext: performanceContext?.health() ?? null,
      nativeSource: nativeSource?.health() ?? null,
      cstv: {
        program: cstvSources.program.getHealth(),
        lookahead: cstvSources.lookahead.getHealth(),
      },
      scope:
        'producer publish and local send counters do not prove pixels rendered or OBS capture latency',
    });
    processing = { count: 0, totalMs: 0, maxMs: 0 };
    slowProcessingCount = 0;
    performanceWindowStart = now;
  };
  const performanceTimer = sessionJournal
    ? setInterval(() => recordPerformanceWindow('interval'), 15000)
    : undefined;
  performanceTimer?.unref();
  let inputGapReported = false;
  const contextTimer = performanceContext
    ? setInterval(() => {
        performanceContext.tick();
        const now = debugClock.nowMonotonicMs();
        // Input silence is evidence, not proof that rendering or the game froze.
        if (
          latestRawInput &&
          !inputGapReported &&
          now - latestRawInput.receivedMonotonicMs >= 1000
        ) {
          inputGapReported = true;
          performanceContext.trigger('input_silence', {
            lastRaw: latestRawInput,
            ageMs: now - latestRawInput.receivedMonotonicMs,
            interpretation: 'source stopped sending; may be normal game/menu inactivity',
          });
        }
      }, 1000)
    : undefined;
  contextTimer?.unref();
  app.get('/debug/hosts', () => localWebTransport.getHostDiagnostics());

  app.post('/debug/control-event', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    if (
      !checkLocalWebOrigin(localWebTransport.getOriginPolicy(), request.headers.origin).allowed ||
      localWebTransport.getOriginPolicy().mode !== 'loopback'
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    sessionJournal?.record('browser_control', request.body);
    const body = request.body as { operation?: string; time?: string; browserDocumentId?: string };
    if (
      body &&
      ['browser_error', 'browser_unhandled_rejection', 'browser_performance'].includes(
        body.operation ?? '',
      ) &&
      (body.operation !== 'browser_performance' ||
        (body as { evidence?: { anomalyCount?: number } }).evidence?.anomalyCount)
    )
      performanceContext?.trigger('browser_anomaly', {
        operation: body.operation,
        observedAt: body.time,
        browserDocumentId: body.browserDocumentId,
        contextCapturedAt: new Date().toISOString(),
        originalEvidence: (body as { evidence?: unknown }).evidence,
      });
    return reply.code(204).send();
  });
  const diagnosticDelivery = registerDiagnosticDelivery(app, {
    ...(options.supportLogsDirectory ? { directory: options.supportLogsDirectory } : {}),
    ...(sessionJournal ? { journal: sessionJournal } : {}),
    originPolicy: localWebTransport.getOriginPolicy(),
    ...(options.diagnosticsEndpoint ? { endpoint: options.diagnosticsEndpoint } : {}),
    ...(options.diagnosticsFetch ? { fetch: options.diagnosticsFetch } : {}),
    onReport: () => {
      recordPerformanceWindow('problem_report');
      performanceContext?.trigger('problem_report', {
        interpretation:
          'context begins at report receipt; past untriggered buffers are unavailable',
      });
    },
  });
  registerSupportRoutes(app, {
    originPolicy: localWebTransport.getOriginPolicy(),
    ...(options.supportLogsDirectory === undefined
      ? {}
      : { logsDirectory: options.supportLogsDirectory }),
    ...(options.productRuntime === undefined ? {} : { artifact: options.productRuntime }),
    runtimeSummary: () => debugEvidenceStore.getSupportSummary(debugClock.nowMonotonicMs()),
    flushBusinessLog: async () => {
      await nativeSource?.poll();
      recordPerformanceWindow('export');
      await performanceContext?.flush();
      await businessJournal?.flush();
      await sessionJournal?.flush();
    },
    sessionLogHealth: () =>
      sessionJournal
        ? { ...sessionJournal.health(), performanceContext: performanceContext?.health() ?? null }
        : null,
    pendingPerformanceEvidence: () => performanceContext?.exportMemory() ?? [],
    pendingJournalEvidence: () => sessionJournal?.pendingEvidence() ?? [],
    retainedDiagnosticBatches: () => diagnosticDelivery.retainedBatches(),
    beginPerformanceExport: () =>
      performanceContext?.beginExport() ?? Promise.resolve(async () => {}),
    ...(businessJournal ? { businessLogHealth: () => businessJournal.getHealth() } : {}),
    businessLogStatus: () => businessJournal?.getStatus() ?? 'not_configured',
    recorder: () => currentRecorder().getHealth(),
    delivery: () => deliveryConsumers.map((consumer) => consumer.getHealth()),
    hosts: () => localWebTransport.getHostDiagnostics(),
    obs: async () => obsAdapter?.status(),
    program: () => sceneController.get(),
    programContext: () => {
      const { operator, program } = projectionCoordinator.getCurrent();
      return {
        contextFreshness: operator.matchContext.freshness,
        identity: operator.identity.state,
        binding: program.series?.bindingState ?? null,
      };
    },
    gsiConfigured: options.gsiToken !== undefined,
  });

  if (options.gsiToken !== undefined) {
    registerGsiIngress(app, {
      gsiToken: options.gsiToken,
      canAccept: () => demoTest?.canAcceptGsi() ?? true,
      canRecord: () => demoTest?.get().active !== true,
      recorder: currentRecorder,
      ...(options.gsiSequenceSource === undefined
        ? {}
        : { sequenceSource: options.gsiSequenceSource }),
      onAcceptedRaw: (input) => {
        if (
          latestRawInput &&
          input.receivedMonotonicMs - latestRawInput.receivedMonotonicMs >= 1000
        )
          performanceContext?.trigger('input_resumed_after_gap', {
            previous: latestRawInput,
            sequence: input.sequence,
            gapMs: input.receivedMonotonicMs - latestRawInput.receivedMonotonicMs,
          });
        inputGapReported = false;
        latestRawInput = {
          sequence: input.sequence,
          receivedAt: input.receivedAt,
          receivedMonotonicMs: input.receivedMonotonicMs,
        };
        if (performanceContext?.shouldSample(input.receivedMonotonicMs))
          performanceContext.sample({
            time: input.receivedAt,
            monotonicMs: input.receivedMonotonicMs,
            sequence: input.sequence,
            evidence: {
              input: selectedGsiContext(input.payload),
              normalizedBeforeCurrentRaw: latestInput,
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
      onObservation: (observation) => {
        dispatchObservation(observation);
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
              outputService.beforeRuntimeMutation();
              projectionCoordinator.afterRuntimeMutation(generationAdvance);
              outputService.afterRuntimeMutation(
                generationAdvance,
                projectionCoordinator.getCurrent(),
                outputBinding,
              );
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
      onAcceptedMapReset: (result) => {
        outputService.beforeRuntimeMutation();
        debugEvidenceStore.clearCurrentTelemetry();
        debugEvidenceStore.recordRuntime(programRuntime.getSnapshot());
        const bundle = projectionCoordinator.afterRuntimeMutation(result);
        outputService.afterRuntimeMutation(result, bundle, outputBinding);
        programCueCoordinator.afterRuntimeMutation(result);
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
    getBindingState: () =>
      matchContextController?.getActiveBinding()
        ? {
            contextRevision: matchContextController.getActiveRevision(),
            operator: projectionCoordinator.getCurrent().operator,
          }
        : null,
  });

  app.addHook('onClose', async () => {
    clearInterval(performanceTimer);
    clearInterval(contextTimer);
    recordPerformanceWindow('close');
    clearInterval(directorTimer);
    presentationUnsubscribe();
    objectiveReferenceUnsubscribe?.();
    cameraDirector?.close();
    await musicDirector?.close();
    await obsAdapter?.close();
    const sourceCleanup = await Promise.allSettled([
      cstvSources.program.stop(),
      cstvSources.lookahead.stop(),
      ...deliveryConsumers.map((consumer) => consumer.close()),
      outputService.close(),
    ]);
    await Promise.all([projectionCoordinator.close(), programCueCoordinator.close()]);
    await programRuntime.close();
    await localWebTransport.close();
    await hudConfigStore.flush();
    await currentRecorder().finalize();
    await businessJournal?.close();
    await nativeSource?.close();
    await performanceContext?.close();
    await sessionJournal?.close();
    await diagnosticDelivery.close();
    const sourceFailures = sourceCleanup
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (sourceFailures.length > 0)
      throw new AggregateError(sourceFailures, 'Companion source or consumer shutdown failed');
  });

  return app;
}
