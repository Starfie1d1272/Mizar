import { lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { DemoTestController } from '../demo-test/controller.js';
import type { HudConfigStore } from '../hud-config/store.js';
import type { LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { ObsAdapter } from '../obs/adapter.js';
import type { ObsRpc } from '../obs/reconcile.js';
import type { ObsAudioRouting } from '../obs/audio-routing.js';
import type { GameAudioController } from '../obs/audio-policy-controller.js';
import type { ObsConfigStore } from '../obs/config.js';
import type { ProgramSceneController } from '../program-scenes/controller.js';
import type { ProgramPresentationStore } from '../program-scenes/presentation.js';
import type { createProduction } from '../program-scenes/production.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import { PACK_ID } from '../resource-store/runtime-adapter.js';
import type { ResourceStore } from '../resource-store/store.js';
import type { UpdateManager } from '../updates/manager.js';
import { CameraConfigResolver } from './camera.js';
import { MusicPackResources } from './music-pack-resources.js';
import { registerBroadcastAssetRoutes, registerMusicPackRoutes } from './music-pack-routes.js';
import {
  createProductionBroadcastDependencies,
  withOfficialBroadcastResources,
} from './production.js';
import { createBroadcastRuntime, type BroadcastRuntimeDependencies } from './runtime.js';
import { createBroadcastResolver } from './resolver.js';
import { registerBroadcastConfigRoutes } from './routes.js';
import { verifyIsolatedPack } from '../orchestration/isolated-pack.js';
import { CameraDirector } from '../orchestration/director.js';
import { MulnxTool } from '../orchestration/tool.js';
import { OrchestrationStore } from '../orchestration/store.js';
import { MulnxProvider } from '../orchestration/provider.js';
import { MulnxProgramClock } from '../orchestration/mulnx-clock.js';
import { registerOrchestrationRoutes } from '../orchestration/routes.js';
import { MusicStore } from '../music/store.js';
import { MusicDirector } from '../music/director.js';
import { ObsMusicProvider } from '../obs/music-device.js';
import { registerMusicRoutes } from '../music/routes.js';
import { registerMixerRoutes } from '../obs/mixer-routes.js';

export function registerBroadcastOwners(
  app: FastifyInstance,
  options: {
    configPath: string;
    hudConfigPath: string | undefined;
    builtinMusicPack: string | undefined;
    mulnxBundle: string | undefined;
    mulnxCamPacksRoot: string | undefined;
    controlToken: string | undefined;
    productMode: boolean;
    originPolicy: LocalWebOriginPolicy;
    baseUrl: string;
    obsConfigStore: ObsConfigStore;
    obsAudioRouting: ObsAudioRouting | undefined;
    obsAdapter: ObsAdapter | undefined;
    gameAudio: GameAudioController | undefined;
    hudConfigStore: HudConfigStore;
    broadcastConfig: BroadcastRuntimeDependencies | undefined;
    readResources: () => ResourceStore | undefined;
    projectionCoordinator: ProjectionCoordinator;
    sceneController: ProgramSceneController;
    presentation: ProgramPresentationStore;
    production: ReturnType<typeof createProduction>;
    readMapConfirmed: () => boolean;
    readDemo: () => DemoTestController;
    updates: UpdateManager | undefined;
    record: (stage: string, evidence: unknown) => void;
  },
) {
  const {
    obsConfigStore,
    obsAudioRouting,
    obsAdapter,
    gameAudio,
    hudConfigStore,
    projectionCoordinator,
    sceneController,
    presentation,
    production,
  } = options;
  let catalogToolLoaded = false;
  let clockState = '';
  const musicStore = new MusicStore(
    join(dirname(options.configPath), 'music'),
    (stage, evidence) => options.record(stage, evidence),
    options.builtinMusicPack,
  );
  const musicProvider = new ObsMusicProvider(
    obsConfigStore,
    (stage, evidence) => options.record(stage, evidence),
    () => music.noteMonitorSettingsChanged(),
    {
      routing: obsAudioRouting,
      sources: () => musicStore.state.sources,
      baseUrl: options.baseUrl,
    },
  );
  const music = new MusicDirector(
    musicStore,
    musicProvider,
    () => ({
      program: projectionCoordinator.getCurrent().program,
      active: sceneController.get().active,
      presentation: presentation.get(),
      production:
        production.automaticAllowed() &&
        projectionCoordinator.getCurrent().operator.matchContext.origin !== 'fixture',
    }),
    Date.now,
    Math.random,
    () => obsAudioRouting?.modePending() ?? Promise.resolve(false),
  );
  registerMusicRoutes(app, musicStore, music, options.originPolicy);
  if (obsAdapter) registerMixerRoutes(app, obsAdapter, music, gameAudio, options.originPolicy);
  const cameraStore = new OrchestrationStore(
    join(dirname(options.configPath), 'orchestration'),
    (stage, evidence) => options.record(stage, evidence),
  );
  const cameraEvidence = (stage: string, evidence: unknown) => options.record(stage, evidence);
  const mulnxTool = options.mulnxBundle
    ? new MulnxTool(join(dirname(options.configPath), 'mulnx'), options.mulnxBundle, cameraEvidence)
    : undefined;
  // This checks the fixed upstream adapter, not whether a game is connected.
  // Actual PackStatus readiness is checked by the existing camera director.
  const cameraResolver = mulnxTool
    ? new CameraConfigResolver(mulnxTool, musicStore, (tool) =>
        Promise.resolve(
          tool.kind === 'upstream' && tool.release.repository === 'Co1Swet/MulNX_CS2',
        ),
      )
    : undefined;
  const supportsMusicPacks = !options.broadcastConfig;
  const musicPacks = new MusicPackResources(join(dirname(options.configPath), 'music-packs'));
  registerBroadcastAssetRoutes(app, musicPacks);
  const broadcastConfig =
    options.broadcastConfig ??
    createProductionBroadcastDependencies(
      dirname(options.configPath),
      musicStore,
      async (ref) => {
        const resources = options.readResources();
        if (ref.resource.id !== PACK_ID || !resources) throw new Error('dependency_missing');
        await resources.readExact(ref.resource, ref.fileId);
      },
      musicPacks,
      cameraResolver,
    );
  const runtime = createBroadcastRuntime({
    hud: hudConfigStore,
    music: musicStore,
    camera: cameraStore,
    dependencies: withOfficialBroadcastResources(
      broadcastConfig,
      options.readResources,
      options.hudConfigPath,
    ),
    withApplyGuard: (operation) => production.configureBroadcast(operation),
    canApplyCamera: () => camera.canChangeConfiguration(),
    diagnostic: (error) =>
      app.log.error({ stage: 'broadcast_owner_sync', err: error }, '播出配置同步失败'),
  });
  if (supportsMusicPacks)
    registerMusicPackRoutes(
      app,
      runtime.store,
      musicStore,
      musicPacks,
      options.originPolicy,
      () => runtime.ready,
      async (module, source) => {
        const resolver = createBroadcastResolver({
          ...broadcastConfig.resolve,
          asset: (ref) =>
            ref.resource.id === source.id &&
            ref.resource.version === source.version &&
            ref.resource.digest === source.digest
              ? Promise.resolve()
              : broadcastConfig.resolve.asset(ref),
        });
        await resolver.resolveModule(module);
      },
    );
  registerBroadcastConfigRoutes(
    app,
    runtime.store,
    options.originPolicy,
    () => runtime.ready,
    () => runtime.restoreLegacyCamera(),
    (module) => runtime.moduleAvailability(module),
    () => runtime.displayAvailable,
    () => runtime.ensureBuiltinMusic(),
  );
  const mulnxProvider = new MulnxProvider(cameraEvidence);
  const mulnxClock = new MulnxProgramClock(mulnxProvider);
  app.addHook('onClose', () => mulnxClock.close());
  const camera = new CameraDirector(
    cameraStore,
    mulnxProvider,
    () => ({
      program: projectionCoordinator.getCurrent().program,
      active: sceneController.get().active,
      production:
        production.sessionAllowed() &&
        options.readMapConfirmed() &&
        projectionCoordinator.getCurrent().operator.matchContext.origin !== 'fixture',
      mapConfirmed: options.readMapConfirmed(),
      demoAudition: options.readDemo().get().active
        ? options.readDemo().canUseCamera('audition')
        : undefined,
    }),
    cameraEvidence,
    undefined,
    undefined,
    (pack) => verifyIsolatedPack(options.mulnxCamPacksRoot ?? mulnxTool?.camPacksRoot, pack),
    options.productMode,
    (map, pack) => {
      if (!cameraStore.hasPersistence) return Promise.resolve(true);
      return runtime.verifyCameraPack(map, pack);
    },
  );
  app.addHook('onReady', async () => {
    if (mulnxTool) {
      try {
        await mulnxTool.load();
        catalogToolLoaded = true;
        options.updates?.registerCompanionCheck(async (force) => {
          if (force) mulnxTool.resetNotification();
          if (mulnxTool.view().busy) return mulnxTool.view().phase === 'checking';
          await mulnxTool.check().catch(() => undefined);
          return true;
        });
      } catch (error) {
        app.log.error({ stage: 'mulnx_load', err: error }, 'MulNX 加载失败');
      }
    }
    const broadcastStoreExists = await lstat(broadcastConfig.path).then(
      () => true,
      (error: NodeJS.ErrnoException) => error.code !== 'ENOENT',
    );
    if (!broadcastStoreExists)
      await cameraStore
        .load()
        .catch((error) =>
          app.log.error(
            { stage: 'camera_load', err: error, result: 'failure' },
            '运镜预设加载失败',
          ),
        );
  });
  app.addHook('onReady', () => runtime.initialize());
  registerOrchestrationRoutes(
    app,
    camera,
    musicStore,
    options.originPolicy,
    {
      controlToken: options.controlToken,
      configure: production.configureCameraSession,
      configureDemo: (requestId, commit) =>
        options.readDemo().configureCameraSession(requestId, commit),
      canPrepare: production.canPrepareMulnx,
      canCleanup: production.canCleanupMulnx,
      withSelection: production.withMulnxSelection,
      reconcileSelection: async () => {
        if (!cameraStore.hasPersistence) return true;
        return runtime.reconcileCameraSelection();
      },
    },
    mulnxTool,
  );
  return {
    config: broadcastConfig,
    broadcast: runtime,
    music,
    camera,
    getCatalogTool: () => (catalogToolLoaded ? mulnxTool : undefined),
    prepareMusic: (valid: () => boolean, guard: (obs: ObsRpc) => ObsRpc) =>
      music.prepare(valid, (run) => musicProvider.session(run, guard)),
    tick: () => {
      void music.tick();
      camera.tick();
      const state = mulnxClock.current(performance.now()).state;
      if (state && state !== clockState) {
        clockState = state;
        options.record('program_clock', { state });
      }
    },
  };
}
