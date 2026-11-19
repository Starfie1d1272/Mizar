import { registerSupportRuntime } from './support/runtime.js';
import { registerBroadcastOwners } from './broadcast-config/live-owners.js';
import type { BroadcastRuntimeDependencies } from './broadcast-config/runtime.js';
import { registerBroadcastMigrationStatus } from './broadcast-config/migration-status.js';
import {
  BpPresentationSettings,
  registerBpPresentationSettings,
} from './bp/presentation-settings.js';
import {
  registerWorkspaceObserver,
  type WorkspaceObserver,
} from './telemetry/observer-workspace.js';
import { ObserverSettingsStore, registerObserverSettings } from './telemetry/observer-settings.js';
import { SessionJournal, diagnosticValue } from './support/session-journal.js';
import { registerOperationDiagnostics } from './support/operation-diagnostics.js';
import { PerformanceWindow } from './support/performance-window.js';
import { observeRuntime } from './support/runtime-observation.js';
import { ProgramChatNativeInput } from './program-chat/native-input.js';
import { ProgramChat } from './projections/program-chat.js';
import { createObserverAssistScope } from './telemetry/observer-assist-scope.js';
import {
  DemoTestController,
  readDemoTestRecovery,
  registerDemoTestRoutes,
} from './demo-test/controller.js';
import { createDemoMutationGuard } from './demo-test/mutation-guard.js';
import { registerSteamAvatarRoutes, type SteamAvatars } from './media/steam-avatars.js';
import { ProductionGuidanceStore, registerProductionGuidance } from './program-scenes/guidance.js';
import { ProgramDirector } from './program-scenes/director.js';
import { startProgramAutomation } from './program-scenes/automation.js';
import { ProgramPresentationStore } from './program-scenes/presentation.js';
import { registerProductionReadiness } from './program-scenes/readiness.js';
import { registerDesktopOverlayRoutes } from './program-scenes/desktop-overlay.js';
import { createProduction, registerProductionRoutes } from './program-scenes/production.js';
import { registerUpdateRoutes } from './updates/routes.js';
import type { UpdateManager } from './updates/manager.js';
import type { ResourceTrustPolicy } from '@mizar/resource-pack-contract/runtime';
import { isOfficialWebResource, PACK_ID } from './resource-store/runtime-adapter.js';
import { registerResourceLibrary } from './resource-store/routes.js';
import { registerResourceRuntime } from './resource-store/runtime.js';
import { MatchContextController, MatchManifestLkgStore } from './match-context/index.js';
import { LocalTournamentStore } from './match-context/local-tournament-store.js';
import { registerLocalTournamentRoutes } from './match-context/local-tournament-routes.js';
import { registerLocalMatchExitRoutes } from './match-context/local-match-exit.js';
import { registerManagedSourceRoutes } from './match-context/managed-source.js';
import { registerLocalAssetRoutes } from './match-context/local-assets.js';
import { dirname, join } from 'node:path';
import { restoreMatchSelection } from './match-context/restore-selection.js';
import type { OutputServiceOptions } from './output/service.js';
import { registerOutputRoutes } from './output/routes.js';
import {
  closeWebsiteOutput,
  createWebsiteOutput,
  startWebsiteOutput,
} from './output/website-lifecycle.js';
import type { OnlineManifestConfig } from './match-context/http-source.js';
import { registerOnlineManifestRoutes } from './match-context/online-routes.js';
import {
  registerBroadcastStatsRoutes,
  registerHistoricalStatsProgramRoute,
  registerHistoricalStatsPresentationRoute,
  registerRivalHubConnectionRoutes,
} from './match-context/rivalhub-routes.js';
import type { RivalHubConnection } from './match-context/rivalhub-connection.js';
import {
  registerMatchDocument,
  subscribeRuntimeMatchBinding,
} from './match-context/runtime-binding.js';
import {
  RivalsRehearsal,
  registerRivalsRehearsalRoutes,
} from './match-context/rivals-rehearsal.js';
import { registerBpRoutes } from './bp/controller.js';
import { registerBpDemoRoute } from './bp/demo-controller.js';
import { getBpDemoProjection } from './bp/demo-projection.js';
import { BpDemoStateController } from './bp/demo-state.js';
import { registerBpWorkspaceRoutes } from './bp/workspace-controller.js';
import { createObsExitStatus } from './obs/exit-status.js';
import { createObsDisconnectCapture, type ObsNativeEvidence } from './obs/native-evidence.js';
import { registerObsRoutes } from './obs/routes.js';
import { createObsRuntime } from './obs/runtime.js';
import { ProgramSceneController, registerProgramSceneRoutes } from './program-scenes/controller.js';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import Fastify, { type FastifyInstance } from 'fastify';

import { DebugEvidenceStore, type DebugRuntimeClock } from './runtime/debug-state.js';
import { BusinessJournal } from './support/business-journal.js';
import type { LatestWinsConsumerHealth } from './runtime/latest-wins.js';
import { createObservationCommit } from './runtime/observation-commit.js';
import { createObservationDriver } from './runtime/observation-driver.js';
import {
  registerProductStop,
  registerRuntimeHealth,
  type ProductRuntime,
} from './runtime/product-runtime.js';
import { registerCompanionShutdown } from './runtime/shutdown.js';
import { createProgramRuntime, type ProgramRuntime } from './runtime/program-runtime.js';
import type { SeriesProgressCheckpointStore } from '@mizar/core/series-progress';
import {
  createProjectionCoordinator,
  type ProjectionCoordinator,
} from './projections/projection-coordinator.js';
import {
  createProgramCueCoordinator,
  type ProgramCueCoordinator,
} from './projections/program-cue-coordinator.js';
import type { MatchContextBinding } from './match-context/index.js';
import { registerQualification, type QualificationOptions } from './qualification/runtime.js';
import { createDisabledRecorder, type CaptureRecorder } from './telemetry/capture-recorder.js';
import {
  createCstvSourceManagers,
  type CstvSourceManagers,
} from './telemetry/cstv-source-manager.js';
import {
  GSI_REQUEST_TIMEOUT_MS,
  type AcceptedRawSink,
  type GsiClock,
  type GsiDiagnosticsSink,
  type GsiSequenceSource,
  type ObservationSink,
} from './telemetry/gsi-ingress.js';
import { registerProgramIngress } from './telemetry/program-ingress.js';
import { registerLocalWebAccess } from './local-web/access-policy.js';
import { defaultWebRoot, registerStaticHost } from './local-web/static-host.js';
import { registerOperatorCommandRoutes } from './operator/controller.js';
import { registerHudConfigRoutes } from './hud-config/controller.js';
import { HudConfigStore } from './hud-config/store.js';
import {
  createLocalWebSocketTransport,
  registerLocalWebSocketTransport,
  type LocalWebSocketDiagnostic,
} from './local-web/websocket-transport.js';

export interface CompanionAppOptions extends QualificationOptions {
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
  readonly productRuntime?: ProductRuntime;
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
  readonly diagnosticsEndpointSource?: 'product_default' | 'environment_override';
  readonly diagnosticsFetch?: typeof fetch;
  readonly onAcceptedRaw?: AcceptedRawSink;
  readonly onObservation?: ObservationSink;
  readonly onGsiDiagnostics?: GsiDiagnosticsSink;
  readonly clock?: GsiClock;
  readonly broadcastConfig?: BroadcastRuntimeDependencies;
  readonly hudConfigPath?: string;
  readonly hudConfigStore?: HudConfigStore;
  readonly obsConfigPath?: string;
  readonly builtinMusicPack?: string;
  readonly mulnxCamPacksRoot?: string;
  readonly mulnxBundle?: string;
  readonly readObsCaptureEvidence?: () => Promise<ObsNativeEvidence>;
  readonly objectiveReferenceSource?: {
    readonly artifactId: string;
    readonly artifactSha256: string;
  };
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
  const demoMutationGuard = createDemoMutationGuard();
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
  const { outbox, outputService } = createWebsiteOutput({
    reliableOutboxPath: options.reliableOutboxPath,
    connection: options.rivalhubConnection,
    reliableSink: options.reliableSink,
    liveSink: options.liveSink,
    readBinding: () => outputBinding,
    readLog: () => app.log,
    readJournal: () => businessJournal,
    recordDiagnostic: (code) => recordRuntimeDiagnostic(`output-${code}`, 'projection', false),
    restoreContinuity: (checkpoint) => {
      if (
        outputBinding?.context.matchId !== checkpoint.matchId ||
        outputBinding.manifest.revision !== checkpoint.contextRevision ||
        programRuntime.getCurrentState().runtimeSeq !== 0
      )
        return undefined;
      const committed = programRuntime.restoreDeliveryContinuity({
        ...checkpoint.cursor,
        mapName: checkpoint.mapName,
        ...(checkpoint.managedSourceId ? { managedSourceId: checkpoint.managedSourceId } : {}),
      });
      return projectionCoordinator.refresh(false, committed);
    },
    isExecutionOwnedBy: (binding) =>
      programRuntime.isExecutionOwnedBy(binding.context.matchId, binding.origin),
    managedSourceId: () => programRuntime.getManagedSourceId(),
    isActiveOnlineBinding: (binding) =>
      matchContextController !== null &&
      matchContextController.getActiveBinding() === binding &&
      !matchContextController.getPendingOnlineCandidate() &&
      !matchContextController.isOnlineCandidateLoading() &&
      !production.isTrialPending() &&
      production.get().mode === 'live' &&
      options.rivalhubConnection?.view().activeSourceMatchId === binding.context.matchId &&
      options.rivalhubConnection?.view().stoppedMatchId !== binding.context.matchId &&
      !options.rivalhubConnection?.view().activeDeviceName,
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
  const observerAssist = createObserverAssistScope(observerSettings, () => observerEligible());
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
      ? new ProgramChatNativeInput(options.supportLogsDirectory, sessionJournal, (record) => {
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
  const controlState = () => ({
    production: production.get(),
    program: sceneController.get(),
    runtime: debugEvidenceStore.getSupportSummary(debugClock.nowMonotonicMs()),
    hud: hudConfigStore.getState().document,
    match: matchContextController?.getActiveBinding() ?? null,
  });
  const flushOperationDiagnostics = registerOperationDiagnostics(app, sessionJournal, controlState);
  options.rivalhubConnection?.setBusinessEvidenceHandler?.((stage, evidence) => {
    // Pre-network guards contain only canonical business fields. Do not write
    // the same observation under a second event ID; response evidence stays raw.
    const reason =
      evidence && typeof evidence === 'object' && 'reason' in evidence ? evidence.reason : null;
    const guard =
      stage === 'business_live' &&
      (reason === 'source_unavailable' || reason === 'map_start_pending');
    if ((stage === 'business_live' && (!guard || !businessJournal)) || stage === 'original_error')
      sessionJournal?.record(
        stage === 'business_live' ? 'website_live_evidence' : 'website_original_error',
        evidence,
      );
    businessJournal?.write(stage, evidence);
  });
  registerStaticHost(app, {
    ...(options.webRoot === undefined ? {} : { webRoot: options.webRoot }),
    qualificationMode: options.qualificationMode ?? false,
    readResource: async (path, range, signal) => {
      const resources = readResources();
      if (!resources || !isOfficialWebResource(path) || !resources.getStatus(PACK_ID).activeVersion)
        return undefined;
      return resources.read(PACK_ID, path, range, signal);
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
  let observerDiagnosticKey = '';
  let observerDiagnosticLoggedAt = -Infinity;
  programRuntime.bindContext(
    demoRecovery ? undefined : outputBinding?.context,
    demoRecovery ? undefined : outputBinding?.origin,
  );
  const projectionCoordinator =
    options.projectionCoordinator ??
    createProjectionCoordinator({
      observerSettings: observerAssist.projectionSettings,
      programChat: (cursor, fresh) => programChat.view(cursor, fresh),
      ...(options.steamAvatars ? { avatars: options.steamAvatars } : {}),
      programRuntime,
      cstvSources,
      onObserverDiagnostics: (diagnostics) => {
        debugEvidenceStore.recordObserverDiagnostics(diagnostics);
        const key = JSON.stringify([
          diagnostics.blocked,
          diagnostics.lastReset,
          diagnostics.pending > 0,
        ]);
        const now = debugClock.nowMonotonicMs();
        if (key !== observerDiagnosticKey && now - observerDiagnosticLoggedAt >= 5000) {
          observerDiagnosticKey = key;
          observerDiagnosticLoggedAt = now;
          sessionJournal?.record('observer_assist_state', diagnostics);
        }
      },
      ...(options.matchContextBinding === undefined || demoRecovery
        ? {}
        : { matchContextBinding: options.matchContextBinding }),
      ...(projectionNowMonotonicMs === undefined
        ? {}
        : { nowMonotonicMs: projectionNowMonotonicMs }),
      onDiagnostic: ({ code }) =>
        recordRuntimeDiagnostic(code, 'projection', projectionDiagnosticDegradesRuntime(code)),
      onProjection: (bundle) => {
        observerAssist.observe(bundle.program, () => projectionCoordinator.resetObserverAssist());
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
  registerLocalWebAccess(app, localWebTransport.getOriginPolicy());
  registerLocalWebSocketTransport(app, localWebTransport);
  registerBroadcastMigrationStatus(
    app,
    localWebTransport.getOriginPolicy(),
    () => media?.broadcast?.status ?? { state: 'pending', reason: 'owner_unavailable' },
  );
  if (!options.obsConfigPath)
    app.get('/local/v1/broadcast-display-config', (_request, reply) =>
      reply.code(503).send({ error: 'broadcast_config_unavailable' }),
    );
  registerHudConfigRoutes(app, {
    store: hudConfigStore,
    getBroadcastDocument: () => media?.broadcast?.appliedDocument(),
    webRoot: options.webRoot ?? defaultWebRoot(),
    waitForBroadcast: async () => {
      await media?.broadcast?.waitForApply();
      if (options.obsConfigPath && !media?.broadcast?.ready)
        throw new Error('broadcast_config_unavailable');
    },
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
  const {
    configStore: obsConfigStore,
    adapter: obsAdapter,
    gameAudio,
    audioRouting: obsAudioRouting,
  } = createObsRuntime(app, {
    configPath: options.obsConfigPath,
    httpOrigin: `http://${options.host ?? '127.0.0.1'}:${options.port ?? 3000}`,
    appVersion: options.productRuntime?.appVersion ?? 'development',
  });
  const bpPresentationSettings = new BpPresentationSettings(
    options.obsConfigPath
      ? join(dirname(options.obsConfigPath), 'bp-presentation.json')
      : undefined,
  );
  app.addHook('onReady', () => bpPresentationSettings.load(app.log));
  registerBpPresentationSettings(app, bpPresentationSettings, localWebTransport.getOriginPolicy());
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
                const sound = media?.camera.store.map(
                  projectionCoordinator.getCurrent().program.map.name,
                )?.openingSound;
                media?.music.opening(`opening:${preparing.revision}`, sound ?? undefined);
                media?.camera.opening();
              }
            },
          }),
    obsAdapter === undefined ? undefined : (options) => obsAdapter.switchToWaitingForExit(options),
    obsAdapter === undefined
      ? undefined
      : (visible, valid) => obsAdapter.setBpCompactVisible(visible, valid),
    () => bpPresentationSettings.get().mode,
    () => obsAdapter?.gameBackgroundReady() ?? Promise.resolve(false),
  );
  obsAdapter?.onBpDisconnect(() =>
    sceneController.compactDisconnected(production.automaticAllowed()),
  );
  const captureObsDisconnect = createObsDisconnectCapture(
    () => support.consentTime(),
    sessionJournal && ((evidence) => sessionJournal.record('obs_native_disconnect', evidence)),
    (error) => app.log.warn({ err: diagnosticValue(error) }, 'OBS 断连诊断采集未完成'),
  );
  obsAdapter?.onProgramChanged((kind) => {
    sceneController.obsProgramChanged();
    production.invalidateObsExit();
    if (kind === 'disconnected') captureObsDisconnect();
  });
  if (options.steamAvatars) {
    options.steamAvatars.onChanged(() => projectionCoordinator.refresh());
    registerSteamAvatarRoutes(app, options.steamAvatars, localWebTransport.getOriginPolicy());
    app.addHook('onClose', () => {
      options.steamAvatars?.close();
      return Promise.resolve();
    });
  }
  registerProductionReadiness(app, {
    projection: () => projectionCoordinator.getCurrent(),
    scenes: () => sceneController.get(),
    obs: async () => obsAdapter?.status(),
  });
  registerProgramSceneRoutes(app, {
    originPolicy: localWebTransport.getOriginPolicy(),
    controller: sceneController,
    canControl: () => production.canControl(),
    productionActive: () => production.presentationAllowed(),
  });
  if (obsConfigStore !== undefined && obsAdapter !== undefined) {
    app.addHook('onListen', () => {
      obsAdapter.startCommentaryRecovery(media?.music, () => production.automaticAllowed());
      return Promise.resolve();
    });
    registerObsRoutes(app, {
      originPolicy: localWebTransport.getOriginPolicy(),
      configStore: obsConfigStore,
      adapter: obsAdapter,
      ...(gameAudio ? { gameAudio } : {}),
      musicAudio: () => media?.music,
      prepareMusic: async (valid, guard) => {
        await media?.prepareMusic(valid, guard);
      },
      ...(options.readObsCaptureEvidence
        ? { readCaptureEvidence: options.readObsCaptureEvidence }
        : {}),
      activeScene: () => sceneController.get().active,
      preparationValid: (revision) => production.preparationValid(revision),
      canStartOutput: () => production.canStartObsOutput(),
      ...(options.productRuntime
        ? { runtimeControlToken: options.productRuntime.controlToken }
        : {}),
    });
  }
  const matchContextController =
    options.matchManifestPath === undefined
      ? null
      : new MatchContextController({
          lkgStore: new MatchManifestLkgStore({ filePath: options.matchManifestPath }),
          ...(options.matchContextBinding === undefined
            ? {}
            : { initialBinding: options.matchContextBinding }),
        });
  const publishRuntimeCommit = (
    result: Parameters<typeof projectionCoordinator.afterRuntimeMutation>[0],
  ) => {
    const bundle = projectionCoordinator.afterRuntimeMutation(result);
    outputService.afterRuntimeMutation(result, bundle, outputBinding);
    programCueCoordinator.afterRuntimeMutation(result);
    return bundle;
  };
  const commitObservation = createObservationCommit({
    runtime: programRuntime,
    beforeMutation: () => outputService.beforeRuntimeMutation(),
    publish: publishRuntimeCommit,
    sourceMatchesSelection: (sourceId) => managedSource.sourceMatchesSelection(sourceId),
    onIgnored: (observation, disposition) =>
      performanceContext?.trigger('observation_ignored', {
        receive: observation.receive,
        disposition,
      }),
  });
  const { dispatch: dispatchObservation, latestInput } = createObservationDriver({
    commit: commitObservation,
    debugEvidenceStore,
    programRuntime,
    notifyDemo: () => demoTest?.observationAccepted(),
    sessionJournal,
    performanceContext,
    observe: (sequence, elapsedMs) => runtimeObservation.observation(sequence, elapsedMs),
  });

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
  if (matchContextController) registerMatchDocument(app, matchContextController);
  const production = createProduction({
    scenes: sceneController,
    obs: obsAdapter,
    music: () => media?.music,
    camera: () => media?.camera,
    demo: () => demoTest,
    observer: observerSettings,
    binding: () => matchContextController?.getActiveBinding() ?? options.matchContextBinding,
    source: {
      handoffForExit: async () => {
        await options.rivalhubConnection?.handoffForExit();
      },
      retryExitHandoffs: async () => {
        await options.rivalhubConnection?.retryExitHandoffs();
      },
      release: async () => {
        await options.rivalhubConnection?.release();
      },
      stats: (target) => options.rivalhubConnection?.stats(target),
      clearStats: () => options.rivalhubConnection?.clearStats(),
    },
    waitForBroadcast: () => media?.broadcast?.waitForApply() ?? Promise.resolve(),
    obsExit: createObsExitStatus(options.obsConfigPath, (error) => {
      app.log.warn({ err: error }, 'OBS exit status not saved');
    }),
    warn: (details, message) => app.log.warn(details, message),
    error: (details, message) => app.log.error(details, message),
  });
  registerProductionRoutes(app, { originPolicy: localWebTransport.getOriginPolicy(), production });
  const localMatchExit =
    matchContextController === null
      ? undefined
      : registerLocalMatchExitRoutes(app, {
          controlToken: options.productRuntime?.controlToken,
          loopback: localWebTransport.getOriginPolicy().mode === 'loopback',
          controller: matchContextController,
          runtime: programRuntime,
          eligibleSession: () =>
            !production.isTrialPending() && !matchContextController.isTemporary(),
          isPreparation: () => production.get().mode === 'preparation',
          productionSession: production.sessionId,
        });
  const managedSource = registerManagedSourceRoutes(app, {
    controlToken: options.productRuntime?.controlToken,
    loopback: localWebTransport.getOriginPolicy().mode === 'loopback',
    controller: matchContextController,
    runtime: programRuntime,
    productionSession: production.sessionId,
    onRuntimeCommit: (snapshot) => {
      projectionCoordinator.refresh(false, snapshot);
      programCueCoordinator.afterRuntimeMutation();
    },
  });
  if (localTournamentStore !== null && matchContextController !== null) {
    registerLocalTournamentRoutes(app, {
      store: localTournamentStore,
      projections: projectionCoordinator,
      controller: matchContextController,
      canReleaseLocalSelection: () => localMatchExit?.canReleaseLocalSelection() ?? false,
      canConfirmLocalExit: () => localMatchExit?.canConfirmLocalExit() ?? false,
      originPolicy: localWebTransport.getOriginPolicy(),
    });
    registerLocalAssetRoutes(app, {
      directory: join(dirname(options.localTournamentPath!), 'local-assets'),
      originPolicy: localWebTransport.getOriginPolicy(),
    });
  }
  const readResources: ReturnType<typeof registerResourceRuntime> = options.resources
    ? registerResourceRuntime(app, {
        config: options.resources,
        product: options.productRuntime,
        originPolicy: () => localWebTransport.getOriginPolicy(),
        activateWhenSafe: production.withResourceActivation,
        ...(options.obsConfigPath
          ? {
              references: {
                run: (operation) =>
                  (media?.config ?? options.broadcastConfig)!.references.run(operation),
                isReferenced: (ref) => {
                  if (!media) throw new Error('broadcast_config_unavailable');
                  return Promise.resolve(
                    media.broadcast
                      .referencedResources()
                      .some(
                        (used) =>
                          used.id === ref.id &&
                          used.version === ref.version &&
                          used.digest === ref.digest,
                      ),
                  );
                },
              },
            }
          : {}),
      })
    : () => undefined;
  let updateExit: ReturnType<typeof registerUpdateRoutes> | undefined;
  if (options.updates && options.productRuntime)
    updateExit = registerUpdateRoutes(app, {
      manager: options.updates,
      controlToken: options.productRuntime.controlToken,
      originPolicy: localWebTransport.getOriginPolicy(),
      production,
      scenes: sceneController,
      obs: async () => obsAdapter?.outputStatus(false),
      mulnx: () => media?.getCatalogTool(),
    });
  const guidance = new ProductionGuidanceStore();
  registerProductionGuidance(app, guidance, {
    getBinding: () => matchContextController?.getActiveBinding() ?? options.matchContextBinding,
    getProjection: () => projectionCoordinator.getCurrent(),
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
  const currentPresentation = () => {
    const envelope = matchContextController?.getActiveDocumentEnvelope();
    const document = envelope?.freshness === 'fresh' ? envelope.document : null;
    const schedule = demoTest.get().active
      ? undefined
      : envelope?.source === 'local' && document?.competition
        ? localTournamentStore?.getAvailability().available
          ? localTournamentStore.scheduleWindow(document.competition.competitionId)
          : undefined
        : options.rivalhubConnection?.getSchedule();
    return presentation.get(document, schedule);
  };
  app.get('/local/v1/program-presentation', (_request, reply) => {
    return reply.header('cache-control', 'no-store').send(currentPresentation());
  });
  registerHistoricalStatsPresentationRoute(app, {
    connection: options.rivalhubConnection,
    getBinding: () => matchContextController?.getActiveBinding() ?? options.matchContextBinding,
  });
  registerHistoricalStatsProgramRoute(app, {
    connection: options.rivalhubConnection,
    getBinding: () => matchContextController?.getActiveBinding() ?? options.matchContextBinding,
    getProgram: currentPresentation,
    getScene: () => sceneController.get().active,
  });
  registerBroadcastStatsRoutes(app, {
    connection: options.rivalhubConnection,
    getBinding: () => matchContextController?.getActiveBinding() ?? options.matchContextBinding,
  });
  const director = new ProgramDirector(
    projectionCoordinator,
    sceneController,
    bpSession,
    () => production.automaticAllowed(),
    undefined,
    undefined,
    () => presentation.get(),
  );
  const media =
    obsConfigStore && options.obsConfigPath
      ? registerBroadcastOwners(app, {
          configPath: options.obsConfigPath,
          hudConfigPath: options.hudConfigPath,
          builtinMusicPack: options.builtinMusicPack,
          mulnxBundle: options.mulnxBundle,
          mulnxCamPacksRoot: options.mulnxCamPacksRoot,
          controlToken: options.productRuntime?.controlToken,
          productMode: options.productRuntime !== undefined,
          originPolicy: localWebTransport.getOriginPolicy(),
          baseUrl: `http://${options.host ?? '127.0.0.1'}:${options.port ?? 3000}`,
          obsConfigStore,
          obsAudioRouting,
          obsAdapter,
          gameAudio,
          hudConfigStore,
          broadcastConfig: options.broadcastConfig,
          readResources,
          projectionCoordinator,
          sceneController,
          presentation,
          production,
          readMapConfirmed: () => observerAssist.mapConfirmed,
          readDemo: () => demoTest,
          updates: options.updates,
          record: (stage, evidence) => sessionJournal?.record(stage, evidence),
        })
      : undefined;
  registerResourceLibrary(app, {
    originPolicy: () => localWebTransport.getOriginPolicy(),
    resources: readResources,
    tool: () => media?.getCatalogTool()?.view(),
    resourceRecoveryAvailable: () => Boolean(readResources() && options.productRuntime?.appVersion),
    webRoot: () => options.webRoot ?? defaultWebRoot(),
  });
  const stopProgramAutomation = startProgramAutomation(app.log, {
    director,
    sceneController,
    production,
    obsConfigStore,
    projectionCoordinator,
    gameAudio,
    tickMedia: () => media?.tick(),
  });
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
      canClaim: () =>
        !production.isTrialPending() &&
        production.sessionAllowed() &&
        production.get().mode === 'live',
      canUpdatePlan: () => !production.isTrialPending() && programRuntime.canUpdateSeriesPlan(),
      canFetchStats: () => production.statsActive(),
      controller: matchContextController,
      currentSnapshot: () => outputService.current(true),
      currentSnapshotStatus: () => outputService.currentStatus(true),
      retryOutputPersistence: async () => {
        await outputService.retry({ localOnly: true });
        return outputService.isPersistenceConfirmed();
      },
      setContextRecoveryHandler: (handler) => outputService.setContextRecoveryHandler(handler),
      originPolicy: localWebTransport.getOriginPolicy(),
    });
  const restoreFormal = (trial = false) =>
    restoreMatchSelection(
      app.log,
      {
        matchContextController,
        localTournamentStore,
        requireHostConfirmation: () => localMatchExit?.requireHostConfirmation(),
      },
      trial,
    );
  const demoTest = new DemoTestController({
    canBegin: demoMutationGuard.canBegin,
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
    production.sessionAllowed() && !production.isTrialPending() && !demoTest.get().active;
  registerObserverSettings(
    app,
    observerSettings,
    localWebTransport.getOriginPolicy(),
    observerEligible,
    () =>
      observerEligible() &&
      projectionCoordinator.getCurrent().program.status.telemetry === 'fresh' &&
      Boolean(projectionCoordinator.getCurrent().program.map.name),
  );
  const observerSettingsUnsubscribe = observerAssist.subscribe({
    program: () => projectionCoordinator.getCurrent().program,
    refresh: () => projectionCoordinator.refresh(),
    refreshAssist: () => projectionCoordinator.refreshAssist(),
    resetAssist: () => projectionCoordinator.resetObserverAssist(),
    mapConnectionChanged: () =>
      media?.camera.invalidatePreparation('本图连接已变更，正在准备运镜。'),
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
      () => matchContextController?.getActiveBinding() ?? undefined,
    );
  const unsubscribeMatchBinding = subscribeRuntimeMatchBinding(matchContextController, {
    rehearseEnded: () => rehearsal?.exitFixtureRuntimeState(),
    connection: options.rivalhubConnection,
    readStatsActive: production.statsActive,
    publishBinding: (binding) => {
      outputBinding = binding;
      outputService.setBinding(binding);
      const committed = programRuntime.bindContext(binding?.context, binding?.origin);
      projectionCoordinator.setMatchContextBinding(binding, committed);
    },
    refreshCues: () => programCueCoordinator.afterRuntimeMutation(),
  });
  demoMutationGuard.register(app, demoTest, production.isTrialPending);
  app.addHook('onReady', async () => {
    if (demoTest.get().active) await demoTest.recover();
    else await restoreFormal();
  });
  const recordConfiguration = async () => {
    if (!sessionJournal) return;
    await sessionJournal.recordCommitted('configuration_snapshot', {
      ...controlState(),
      obs: await obsConfigStore
        ?.read()
        .catch((error: unknown) => ({ readError: diagnosticValue(error) })),
    });
  };
  app.addHook('onReady', async () => {
    outputService.setCurrent(projectionCoordinator.getCurrent(), outputBinding);
    await startWebsiteOutput(options.rivalhubConnection, outputService, (error) =>
      app.log.error({ err: error }, '网站启动所有权清理未确认，本机制作继续；修复后重启。'),
    );
    businessJournal?.runtime(
      projectionCoordinator.getCurrent(),
      outputBinding,
      programRuntime.getCurrentState().programTelemetry,
    );
    for (const record of outputService.getReliableRecords())
      businessJournal?.reliable(record, 'restored');
    await businessJournal?.flush();
    await recordConfiguration().catch((error: unknown) => {
      sessionJournal?.record('diagnostic_delivery_failure', {
        phase: 'configuration_snapshot',
        error: diagnosticValue(error),
      });
    });
  });
  registerOutputRoutes(app, outputService, outbox, () =>
    outputService.setCurrent(projectionCoordinator.getCurrent(), outputBinding),
  );
  registerRuntimeHealth(app, {
    currentRecorder,
    cstvSources,
    runtimeDegraded: () => runtimeDegraded,
    product: options.productRuntime,
  });

  if (options.productRuntime)
    registerProductStop(app, options.productRuntime, {
      readTrial: () => demoTest.get(),
      shutdown: production.shutdown,
      beforeStop: () => updateExit?.beforeStop(),
    });

  const getDebugResponse = (nowMonotonicMs: number) =>
    debugEvidenceStore.getResponse({
      nowMonotonicMs,
      recorderHealth: currentRecorder().getHealth(),
      deliveryHealth: deliveryConsumers.map((consumer) => consumer.getHealth()),
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
        outbox: outbox?.takePersistenceTiming() ?? null,
        resources: readResources()?.takeRangeTiming() ?? null,
        runtime: debugEvidenceStore.getSupportSummary(now),
        recorder: currentRecorder().getHealth(),
        delivery: deliveryConsumers.map((consumer) => consumer.getHealth()),
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
        nativeSource: nativeSource?.health() ?? null,
        cstv: {
          program: cstvSources.program.getHealth(),
          lookahead: cstvSources.lookahead.getHealth(),
        },
      };
    },
  });
  app.get('/debug/hosts', () => localWebTransport.getHostDiagnostics());

  const support = registerSupportRuntime(app, {
    supportLogsDirectory: options.supportLogsDirectory,
    product: options.productRuntime,
    endpoint: options.diagnosticsEndpoint,
    endpointSource: options.diagnosticsEndpointSource,
    fetch: options.diagnosticsFetch,
    workspaceObserver: options.workspaceObserver,
    originPolicy: localWebTransport.getOriginPolicy(),
    sessionJournal,
    performanceContext,
    runtimeObservation,
    flushOperationDiagnostics,
    recordConfiguration,
    nativeSource,
    runtimeSummary: () => debugEvidenceStore.getSupportSummary(debugClock.nowMonotonicMs()),
    businessLogStatus: () => businessJournal?.getStatus() ?? 'not_configured',
    recorder: () => currentRecorder().getHealth(),
    delivery: () => deliveryConsumers.map((consumer) => consumer.getHealth()),
    hosts: () => localWebTransport.getHostDiagnostics(),
    obs: async () => obsAdapter?.status(),
    obsAudioDiagnostics: async () => obsAdapter?.readAudioDeviceDiagnostics(),
    program: () => sceneController.get(),
    projection: () => projectionCoordinator.getCurrent(),
    gsiConfigured: options.gsiToken !== undefined,
  });

  if (options.gsiToken !== undefined)
    registerProgramIngress(app, {
      token: options.gsiToken,
      clock: options.clock,
      sequenceSource: options.gsiSequenceSource,
      onAcceptedRaw: options.onAcceptedRaw,
      onObservation: options.onObservation,
      onGsiDiagnostics: options.onGsiDiagnostics,
      managedSource,
      readDemo: () => demoTest,
      currentRecorder,
      runtimeObservation,
      performanceContext,
      debugEvidenceStore,
      programRuntime,
      projectionCoordinator,
      sessionJournal,
      latestInput,
      dispatchObservation,
      readBinding: () => outputBinding,
      recordDiagnostic: (code) => recordRuntimeDiagnostic(code, 'telemetry'),
    });

  if (options.qualificationMode)
    registerQualification(app, options, {
      runtime: programRuntime,
      currentRecorder,
      replaceRecorder: (next) => {
        recorder = next;
      },
      beforeRuntimeMutation: () => outputService.beforeRuntimeMutation(),
      publishRuntimeCommit,
      recordRuntime: () => debugEvidenceStore.recordRuntime(programRuntime.getSnapshot()),
      clearCurrentTelemetry: () => debugEvidenceStore.clearCurrentTelemetry(),
      getHostDiagnostics: () => localWebTransport.getHostDiagnostics(),
      getDebugResponse,
    });

  registerOperatorCommandRoutes(app, {
    originPolicy: localWebTransport.getOriginPolicy(),
    execute: (command) => {
      const result = programRuntime.executeOperatorCommand(command);
      projectionCoordinator.refresh(false, result.snapshot);
      programCueCoordinator.afterRuntimeMutation();
      return result;
    },
    getBindingState: () =>
      matchContextController?.getActiveBinding()
        ? {
            contextRevision: matchContextController.getActiveRevision(),
            operator: projectionCoordinator.getCurrent().operator,
            ownership: programRuntime.getExecutionOwnership(
              matchContextController.getActiveBinding()!.context.matchId,
            ),
          }
        : null,
  });

  registerCompanionShutdown(app, {
    stopDirector: stopProgramAutomation,
    stopObservation: () => runtimeObservation.close(),
    unsubscribePresentation: presentationUnsubscribe,
    unsubscribeObjectiveReference: objectiveReferenceUnsubscribe,
    closeCamera: () => media?.camera.close(),
    closeMusic: () => media?.music.close(),
    closeGameAudio: () => gameAudio?.close(),
    closeObs: () => obsAdapter?.close(),
    waitForObsExit: production.waitForObsExit,
    stopCstv: [() => cstvSources.program.stop(), () => cstvSources.lookahead.stop()],
    closeDeliveryConsumers: deliveryConsumers.map((consumer) => () => consumer.close()),
    closeProjection: () => projectionCoordinator.close(),
    closeCues: () => programCueCoordinator.close(),
    stopWebsiteDelivery: () => outputService.stopDelivery(),
    flushWebsiteDiagnostics: () => options.rivalhubConnection?.flushDiagnostics?.(),
    closeRuntime: () => programRuntime.close(),
    closeTransport: () => localWebTransport.close(),
    hudConfigStore,
    flushBroadcastReceipts: () => media?.broadcast?.flushConsumerReceipts(),
    currentRecorder,
    readBusinessJournal: () => businessJournal,
    closeSupport: support.close,
    closeWebsiteOutput: () =>
      closeWebsiteOutput(options.rivalhubConnection, outputService, (error) =>
        app.log.warn({ err: error }, '远端数据源收尾待重试'),
      ),
    unsubscribeMatchBinding,
    product: options.productRuntime,
  });

  return app;
}
