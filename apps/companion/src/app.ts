import type { FastifyInstance } from 'fastify';
import type { CompanionAppOptions } from './app-options.js';
import { registerBpPresentationRuntime } from './bp/presentation-settings.js';
import { registerBpRuntime } from './bp/runtime.js';
import { registerBpWorkspaceRoutes } from './bp/workspace-controller.js';
import {
  broadcastResourceReferences,
  registerBroadcastOwners,
} from './broadcast-config/live-owners.js';
import {
  DemoTestController,
  demoTelemetryReady,
  readDemoStartup,
  registerDemoTestRoutes,
} from './demo-test/controller.js';
import { createDemoMutationGuard } from './demo-test/mutation-guard.js';
import { createHudConfigRuntime, registerHudRuntimeRoutes } from './hud-config/runtime.js';
import { createLocalHttpHost } from './local-web/http-host.js';
import { registerLocalWebRuntime } from './local-web/runtime.js';
import { defaultWebRoot } from './local-web/static-host.js';
import { restoreMatchSelection } from './match-context/restore-selection.js';
import { registerMatchRehearsal } from './match-context/rivals-rehearsal.js';
import { subscribeRuntimeMatchBinding } from './match-context/runtime-binding.js';
import {
  createMatchContext,
  productionSource,
  registerMatchControl,
  registerMatchStores,
  registerOnlineMatchControl,
} from './match-context/runtime.js';
import { registerSteamAvatarRuntime } from './media/steam-avatars.js';
import { createObsExitStatus } from './obs/exit-status.js';
import { createObsRuntime } from './obs/runtime.js';
import { registerOperatorCommandRoutes } from './operator/controller.js';
import {
  closeWebsiteOutput,
  quarantineRecoveredTrial,
  createWebsiteOutput,
  registerWebsiteOutputRuntime,
} from './output/website-lifecycle.js';
import { registerNativeProgramChat } from './program-chat/native-input.js';
import { startProgramAutomation } from './program-scenes/automation.js';
import { registerProgramSceneRoutes } from './program-scenes/controller.js';
import { registerDesktopOverlayRuntime } from './program-scenes/desktop-overlay.js';
import { ProgramDirector } from './program-scenes/director.js';
import { connectProgramScenes, createProgramScenes } from './program-scenes/obs-scenes.js';
import { registerProgramPresentation } from './program-scenes/presentation-routes.js';
import { createProduction, registerProductionRoutes } from './program-scenes/production.js';
import { registerProductionReadiness } from './program-scenes/readiness.js';
import { ProgramChat } from './projections/program-chat.js';
import { createProgramCueCoordinator } from './projections/program-cue-coordinator.js';
import { createProjectionCoordinator } from './projections/projection-coordinator.js';
import { registerQualification } from './qualification/runtime.js';
import { registerResourceLibrary } from './resource-store/routes.js';
import { registerCompanionStaticWeb, registerResourceRuntime } from './resource-store/runtime.js';
import { createObservationCommit } from './runtime/observation-commit.js';
import { createObservationDriver } from './runtime/observation-driver.js';
import { registerProductStop, registerRuntimeHealth } from './runtime/product-runtime.js';
import {
  createCompanionProgramRuntime,
  runtimeProjectionClock,
} from './runtime/program-runtime.js';
import { registerCompanionShutdown } from './runtime/shutdown.js';
import {
  connectWebsiteBusinessEvidence,
  createBusinessJournal,
} from './support/business-journal.js';
import { registerOperationDiagnostics } from './support/operation-diagnostics.js';
import {
  createConfigurationEvidence,
  createRuntimeDiagnostics,
  createRuntimeEvidenceStore,
} from './support/runtime-evidence.js';
import { registerSupportRuntime } from './support/runtime.js';
import { createDisabledRecorder, type CaptureRecorder } from './telemetry/capture-recorder.js';
import { selectCstvSources } from './telemetry/cstv-source-manager.js';
import { subscribeObjectiveReference } from './telemetry/objective-reference.js';
import { createObserverRuntime } from './telemetry/observer-runtime.js';
import { registerProgramIngress } from './telemetry/program-ingress.js';
import { registerUpdateRoutes } from './updates/routes.js';

export type { CompanionAppOptions, DeliveryHealthSource } from './app-options.js';

export function buildApp(options: CompanionAppOptions = {}): FastifyInstance {
  const controlToken = options.productRuntime?.controlToken;
  const { markerPath: demoMarkerPath, recovery: demoRecovery } = readDemoStartup(
    options.localTournamentPath,
  );
  const demoMutationGuard = createDemoMutationGuard();
  let recorder = options.recorder ?? createDisabledRecorder('recorder_not_configured');
  const currentRecorder = (): CaptureRecorder => recorder;

  const programRuntime = createCompanionProgramRuntime({
    runtime: options.programRuntime,
    producerInstanceId: options.producerInstanceId,
    seriesProgressCheckpointStore: options.seriesProgressCheckpointStore,
    onSeriesProgressDiagnostic: options.onSeriesProgressDiagnostic,
    recoveringTrial: demoRecovery !== undefined,
  });
  const { debugEvidenceStore, debugClock } = createRuntimeEvidenceStore(
    programRuntime,
    options.debugEvidenceStore,
    options.debugClock,
  );
  const deliveryConsumers = options.deliveryConsumers ?? [];
  let outputBinding = options.matchContextBinding;
  const cstvSources = selectCstvSources(options.cstvSources, options.workspaceObserver?.source);
  const projectionNowMonotonicMs =
    options.projectionNowMonotonicMs ?? runtimeProjectionClock(programRuntime);
  const { app, sessionJournal, performanceContext } = createLocalHttpHost({
    logger: options.logger,
    supportJournal: options.supportJournal,
    supportLogsDirectory: options.supportLogsDirectory,
    product: options.productRuntime,
    debugClock,
  });
  const programChat = new ProgramChat();
  const observer = createObserverRuntime(app, options.observerSettingsPath);
  const { settings: observerSettings, assist: observerAssist } = observer;
  const nativeSource = registerNativeProgramChat(app, {
    directory: options.supportLogsDirectory,
    journal: sessionJournal,
    chat: programChat,
    refresh: () => projectionCoordinator.refresh(),
  });
  const businessJournal = createBusinessJournal(
    app.log,
    options.supportLogsDirectory,
    options.productRuntime?.appVersion,
    sessionJournal,
  );
  const runtimeDiagnostics = createRuntimeDiagnostics(
    app.log,
    debugEvidenceStore,
    debugClock,
    sessionJournal,
  );
  const { record: recordRuntimeDiagnostic } = runtimeDiagnostics;
  const {
    outbox,
    outputService,
    connectRuntime: connectWebsiteRuntime,
  } = createWebsiteOutput({
    reliableOutboxPath: options.reliableOutboxPath,
    connection: options.rivalhubConnection,
    reliableSink: options.reliableSink,
    liveSink: options.liveSink,
    readBinding: () => outputBinding,
    logger: app.log,
    journal: businessJournal,
    recordDiagnostic: (code) => recordRuntimeDiagnostic('output-' + code, 'projection', false),
    runtime: programRuntime,
  });
  if (demoRecovery) quarantineRecoveredTrial(app.log, outputService);

  const objectiveReferenceUnsubscribe = subscribeObjectiveReference(
    cstvSources.program,
    currentRecorder,
    options.objectiveReferenceSource,
  );
  const controlState = () => ({
    production: production.get(),
    program: sceneController.get(),
    runtime: debugEvidenceStore.getSupportSummary(debugClock.nowMonotonicMs()),
    hud: hudConfigStore.getState().document,
    match: matchContextController?.getActiveBinding() ?? null,
  });
  const flushOperationDiagnostics = registerOperationDiagnostics(app, sessionJournal, controlState);
  connectWebsiteBusinessEvidence(options.rivalhubConnection, businessJournal, sessionJournal);
  registerCompanionStaticWeb(app, options.webRoot, options.qualificationMode ?? false, () =>
    readResources(),
  );
  const hudConfigStore = createHudConfigRuntime(
    app.log,
    options.hudConfigStore,
    options.hudConfigPath,
  );
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
      onObserverDiagnostics: runtimeDiagnostics.recordObserver,
      ...(options.matchContextBinding === undefined || demoRecovery
        ? {}
        : { matchContextBinding: options.matchContextBinding }),
      ...(projectionNowMonotonicMs === undefined
        ? {}
        : { nowMonotonicMs: projectionNowMonotonicMs }),
      onDiagnostic: runtimeDiagnostics.recordProjection,
      onProjection: (bundle) => {
        observerAssist.observe(bundle.program);
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
  const { transport: localWebTransport, originPolicy } = registerLocalWebRuntime(app, {
    host: options.host,
    lanMode: options.localWebLanMode,
    allowedOrigins: options.localWebAllowedOrigins,
    sessionJournal,
    getPublisher: (channel) =>
      channel === 'program-cue'
        ? programCueCoordinator.getPublisher()
        : projectionCoordinator.getPublisher(channel),
  });
  registerHudRuntimeRoutes(app, {
    originPolicy,
    hudConfigStore,
    webRoot: options.webRoot,
    hasBroadcastConfig: Boolean(options.obsConfigPath),
    readBroadcast: () => media?.broadcast,
  });
  registerDesktopOverlayRuntime(app, options.localTournamentPath, originPolicy);
  const { bpDemoState, bpSession } = registerBpRuntime(app, {
    originPolicy,
    now: options.bpNowMonotonicMs,
    getProjection: () => projectionCoordinator.getBpProjection(),
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
  const bpPresentationSettings = registerBpPresentationRuntime(
    app,
    options.obsConfigPath,
    originPolicy,
  );
  const sceneController = createProgramScenes(
    projectionCoordinator,
    bpSession,
    obsAdapter,
    () => bpPresentationSettings.get().mode,
  );
  registerSteamAvatarRuntime(app, options.steamAvatars, originPolicy, () =>
    projectionCoordinator.refresh(),
  );
  registerProductionReadiness(app, {
    projection: () => projectionCoordinator.getCurrent(),
    scenes: () => sceneController.get(),
    obs: async () => obsAdapter?.status(),
  });
  registerProgramSceneRoutes(app, {
    originPolicy,
    controller: sceneController,
    canControl: () => production.canControl(),
    productionActive: () => production.presentationAllowed(),
  });
  const matchContextController = createMatchContext(
    options.matchManifestPath,
    options.matchContextBinding,
  );
  const refreshRuntimeProjection = (snapshot?: ReturnType<typeof programRuntime.getSnapshot>) => {
    projectionCoordinator.refresh(false, snapshot);
    programCueCoordinator.afterRuntimeMutation();
  };
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
    observe: (sequence, elapsedMs) => support.runtimeObservation.observation(sequence, elapsedMs),
  });

  const rehearsal = registerMatchRehearsal(app, {
    fixturePath: options.rehearsalFixturePath,
    controller: matchContextController,
    scenes: sceneController,
    dispatchObservation,
    runtime: programRuntime,
    refresh: () => projectionCoordinator.refresh(),
    connection: options.rivalhubConnection,
    originPolicy,
  });
  const localTournamentStore = registerMatchStores(
    app,
    matchContextController,
    options.localTournamentPath,
  );
  const production = createProduction({
    scenes: sceneController,
    obs: obsAdapter,
    music: () => media?.music,
    camera: () => media?.camera,
    demo: () => demoTest,
    observer: observerSettings,
    binding: () => matchContextController?.getActiveBinding() ?? options.matchContextBinding,
    source: productionSource(options.rivalhubConnection),
    waitForBroadcast: () => media?.broadcast?.waitForApply() ?? Promise.resolve(),
    obsExit: createObsExitStatus(options.obsConfigPath, (error) => {
      app.log.warn({ err: error }, 'OBS exit status not saved');
    }),
    onModeChange: (mode) => {
      if (mode === 'live') options.updates?.yieldAutoDownload();
      else if (mode === 'preparation') void options.updates?.resumeAutoDownload();
    },
    warn: (details, message) => app.log.warn(details, message),
    error: (details, message) => app.log.error(details, message),
  });
  obsAdapter?.setOnOutputActivity((busy) => {
    if (busy) options.updates?.yieldAutoDownload();
    else void options.updates?.resumeAutoDownload();
  });
  connectWebsiteRuntime({
    projections: projectionCoordinator,
    context: matchContextController,
    production,
  });
  registerProductionRoutes(app, { originPolicy, production });
  const { localMatchExit, managedSource } = registerMatchControl(app, {
    controller: matchContextController,
    store: localTournamentStore,
    production,
    runtime: programRuntime,
    projections: projectionCoordinator,
    originPolicy,
    controlToken,
    tournamentPath: options.localTournamentPath,
    onRuntimeCommit: refreshRuntimeProjection,
  });
  const readResources: ReturnType<typeof registerResourceRuntime> = options.resources
    ? registerResourceRuntime(app, {
        config: options.resources,
        product: options.productRuntime,
        originPolicy: () => originPolicy,
        activateWhenSafe: production.withResourceActivation,
        ...(options.obsConfigPath
          ? {
              references: broadcastResourceReferences(() => media, options.broadcastConfig),
            }
          : {}),
      })
    : () => undefined;
  const updateExit =
    options.updates && options.productRuntime
      ? registerUpdateRoutes(app, {
          manager: options.updates,
          controlToken: options.productRuntime.controlToken,
          originPolicy,
          production,
          scenes: sceneController,
          obs: async () => obsAdapter?.outputStatus(false),
          mulnx: () => media?.getCatalogTool(),
        })
      : undefined;
  const { presentation, unsubscribe: presentationUnsubscribe } = registerProgramPresentation(app, {
    projections: projectionCoordinator,
    readBinding: () => matchContextController?.getActiveBinding() ?? options.matchContextBinding,
    readDocument: () => matchContextController?.getActiveDocumentEnvelope(),
    readLocalSchedule: (competitionId) =>
      localTournamentStore?.getAvailability().available
        ? localTournamentStore.scheduleWindow(competitionId)
        : undefined,
    readTrialActive: () => demoTest.get().active,
    connection: options.rivalhubConnection,
    readScene: () => sceneController.get().active,
    recordProjection: (bundle, binding) =>
      businessJournal?.runtime(bundle, binding, programRuntime.getCurrentState().programTelemetry),
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
          controlToken,
          productMode: options.productRuntime !== undefined,
          originPolicy,
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
          readDemo: () => demoTest,
          updates: options.updates,
          record: (stage, evidence) => sessionJournal?.record(stage, evidence),
        })
      : undefined;
  registerResourceLibrary(app, {
    originPolicy: () => originPolicy,
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
    originPolicy,
    controller: matchContextController,
    projections: projectionCoordinator,
    demoState: bpDemoState,
    ...(localTournamentStore === null ? {} : { localTournamentStore }),
  });
  registerOnlineMatchControl(app, {
    controller: matchContextController,
    connection: options.rivalhubConnection,
    config: options.onlineManifestConfig,
    production,
    runtime: programRuntime,
    outputService,
    originPolicy,
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
    dataReady: () =>
      demoTelemetryReady(
        programRuntime,
        projectionCoordinator.getCurrent().operator.runtime.telemetryFreshness,
        projectionNowMonotonicMs,
      ),
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
  registerDemoTestRoutes(app, demoTest, controlToken);
  observer.connect({
    originPolicy,
    projectionCoordinator,
    workspaceObserver: options.workspaceObserver,
    controlToken,
    eligible: () =>
      production.sessionAllowed() && !production.isTrialPending() && !demoTest.get().active,
    readBinding: () => matchContextController?.getActiveBinding(),
    mapConnectionChanged: () =>
      media?.camera.invalidatePreparation('本图连接已变更，正在准备运镜。'),
  });
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
  const recordConfiguration = createConfigurationEvidence(
    sessionJournal,
    controlState,
    obsConfigStore,
  );
  registerWebsiteOutputRuntime(app, {
    connection: options.rivalhubConnection,
    outputService,
    outbox,
    businessJournal,
    sessionJournal,
    readBinding: () => outputBinding,
    readProjection: () => projectionCoordinator.getCurrent(),
    readTelemetry: () => programRuntime.getCurrentState().programTelemetry,
    recordConfiguration,
  });
  registerRuntimeHealth(app, {
    currentRecorder,
    cstvSources,
    runtimeDegraded: () => runtimeDiagnostics.degraded,
    product: options.productRuntime,
  });

  if (options.productRuntime)
    registerProductStop(app, options.productRuntime, {
      readTrial: () => demoTest.get(),
      shutdown: production.shutdown,
      beforeStop: () => updateExit?.beforeStop(),
    });

  const support = registerSupportRuntime(app, {
    evidence: {
      debugEvidenceStore,
      debugClock,
      currentRecorder,
      deliveryConsumers,
      cstvSources,
      latestInput,
      projectionCoordinator,
      readOutboxTiming: () => outbox?.takePersistenceTiming() ?? null,
      readResourceTiming: () => readResources()?.takeRangeTiming() ?? null,
      readHosts: () => localWebTransport.getHostDiagnostics(),
    },
    businessJournal,
    supportLogsDirectory: options.supportLogsDirectory,
    product: options.productRuntime,
    endpoint: options.diagnosticsEndpoint,
    endpointSource: options.diagnosticsEndpointSource,
    fetch: options.diagnosticsFetch,
    workspaceObserver: options.workspaceObserver,
    originPolicy,
    sessionJournal,
    performanceContext,
    flushOperationDiagnostics,
    recordConfiguration,
    nativeSource,
    obs: async () => obsAdapter?.status(),
    obsAudioDiagnostics: async () => obsAdapter?.audio.readAudioDeviceDiagnostics(),
    program: () => sceneController.get(),
    projection: () => projectionCoordinator.getCurrent(),
    gsiConfigured: options.gsiToken !== undefined,
  });

  connectProgramScenes(app, {
    obsAdapter,
    obsConfigStore,
    gameAudio,
    media,
    sceneController,
    production,
    originPolicy,
    consentTime: support.consentTime,
    recordDisconnect:
      sessionJournal && ((evidence) => sessionJournal.record('obs_native_disconnect', evidence)),
    readObsCaptureEvidence: options.readObsCaptureEvidence,
    runtimeControlToken: controlToken,
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
      runtimeObservation: support.runtimeObservation,
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
      getDebugResponse: support.getDebugResponse,
    });

  registerOperatorCommandRoutes(app, {
    originPolicy,
    execute: (command) => {
      const result = programRuntime.executeOperatorCommand(command);
      refreshRuntimeProjection(result.snapshot);
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
    stopObservation: () => support.runtimeObservation.close(),
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
