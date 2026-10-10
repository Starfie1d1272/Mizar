import { errorEvidence } from './updates/diagnostics.js';
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
import { registerLocalAssetRoutes } from './match-context/local-assets.js';
import { dirname, join } from 'node:path';
import { toMatchDocumentV1 } from '@mizar/rivalhub';
import { isStandaloneLocalMatch } from './match-context/lkg-store.js';
import { OutputService, type OutputServiceOptions } from './output/service.js';
import { ReliableOutbox } from './output/reliable-outbox.js';
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
import { registerObsRoutes } from './obs/routes.js';
import { ProgramSceneController, registerProgramSceneRoutes } from './program-scenes/controller.js';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import Fastify, { type FastifyInstance } from 'fastify';

import { DebugEvidenceStore, type DebugRuntimeClock } from './runtime/debug-state.js';
import { registerSupportRoutes } from './support/routes.js';
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
    readonly policy?: ResourceTrustPolicy;
    readonly cacheHistory?: readonly ResourceTrustPolicy[];
  };
  readonly updates?: UpdateManager;
  readonly steamAvatars?: SteamAvatars;
  readonly supportLogsDirectory?: string;
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
  readonly onAcceptedRaw?: AcceptedRawSink;
  readonly onObservation?: ObservationSink;
  readonly onGsiDiagnostics?: GsiDiagnosticsSink;
  readonly clock?: GsiClock;
  readonly qualificationMode?: boolean;
  readonly qualificationControlToken?: string;
  readonly hudConfigPath?: string;
  readonly hudConfigStore?: HudConfigStore;
  readonly obsConfigPath?: string;
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
  const debugEvidenceStore =
    options.debugEvidenceStore ?? new DebugEvidenceStore(programRuntime.getSnapshot());
  debugEvidenceStore.recordRuntime(programRuntime.getSnapshot());
  const debugClock = options.debugClock ?? { nowMonotonicMs: () => performance.now() };
  const deliveryConsumers = options.deliveryConsumers ?? [];
  let outputBinding = options.matchContextBinding;
  const outputService: OutputService = new OutputService({
    ...(options.reliableOutboxPath === undefined
      ? {}
      : {
          outbox: new ReliableOutbox(options.reliableOutboxPath),
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
  });
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
    logController: new Fastify.LogController({ disableRequestLogging: true }),
    requestTimeout: GSI_REQUEST_TIMEOUT_MS,
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
      ...(options.steamAvatars ? { avatars: options.steamAvatars } : {}),
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
      onProjection: (bundle) => outputService.setCurrent(bundle, outputBinding),
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
  const sceneController = new ProgramSceneController(
    projectionCoordinator,
    bpSession,
    obsAdapter === undefined ? undefined : (id, options) => obsAdapter.switchScene(id, options),
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
  const dispatchObservation = (
    observation: TelemetryObservation,
    sampleStageBinding?: { mapOrder: number },
  ): void => {
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
  if (localTournamentStore !== null && matchContextController !== null) {
    registerLocalTournamentRoutes(app, {
      store: localTournamentStore,
      projections: projectionCoordinator,
      controller: matchContextController,
      originPolicy: localWebTransport.getOriginPolicy(),
    });
    registerLocalAssetRoutes(app, {
      directory: join(dirname(options.localTournamentPath!), 'local-assets'),
      originPolicy: localWebTransport.getOriginPolicy(),
    });
  }
  const production = registerProductionRoutes(app, {
    originPolicy: localWebTransport.getOriginPolicy(),
    hasContext: () =>
      matchContextController?.getActiveBinding() !== undefined &&
      matchContextController?.getActiveBinding() != null,
    scenes: sceneController,
    release: async () => {
      await options.rivalhubConnection?.release();
    },
  });
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
                diagnostic: { error: errorEvidence(error) },
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
            diagnostic: { error: errorEvidence(error) },
          },
          '官方素材缓存不可用；保留原 Full 资源路径。',
        );
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
    const schedule =
      envelope?.source === 'local' && document?.competition
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
  sceneController.attachDirector(director);
  const directorTimer = setInterval(() => {
    void director.tick().catch(() => director.hold());
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
      canClaim: () => production.get().mode === 'live',
      canUpdatePlan: () => programRuntime.canUpdateSeriesPlan(),
      controller: matchContextController,
      currentSnapshot: () => outputService.current(true),
      originPolicy: localWebTransport.getOriginPolicy(),
    });
  if (matchContextController !== null) {
    app.addHook('onReady', async () => {
      await localTournamentStore?.load();
      const restored = await matchContextController.restoreLatest();
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
        matchContextController.activateLocalDocument(selected);
      } else if (restored !== undefined && isStandaloneLocalMatch(restored)) {
        const migrated = await localTournamentStore.importLegacyMatch(
          toMatchDocumentV1(restored.manifest),
        );
        matchContextController.activateLocalDocument(migrated);
      }
    });
  }
  app.addHook('onReady', async () => {
    outputService.setCurrent(projectionCoordinator.getCurrent(), outputBinding);
    await outputService.start();
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

  app.get('/debug/hosts', () => localWebTransport.getHostDiagnostics());

  registerSupportRoutes(app, {
    originPolicy: localWebTransport.getOriginPolicy(),
    ...(options.supportLogsDirectory === undefined
      ? {}
      : { logsDirectory: options.supportLogsDirectory }),
    ...(options.productRuntime === undefined ? {} : { artifact: options.productRuntime }),
    runtimeSummary: () => debugEvidenceStore.getSupportSummary(debugClock.nowMonotonicMs()),
    recorder: () => currentRecorder().getHealth(),
    delivery: () => deliveryConsumers.map((consumer) => consumer.getHealth()),
    hosts: () => localWebTransport.getHostDiagnostics(),
    obs: async () => obsAdapter?.status(),
    gsiConfigured: options.gsiToken !== undefined,
  });

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
        dispatchObservation(observation);
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
  });

  app.addHook('onClose', async () => {
    clearInterval(directorTimer);
    presentationUnsubscribe();
    objectiveReferenceUnsubscribe?.();
    await obsAdapter?.close();
    await Promise.all([
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
  });

  return app;
}
