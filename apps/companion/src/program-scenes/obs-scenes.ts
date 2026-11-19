import type { FastifyInstance } from 'fastify';
import type { BpSession } from '../bp/controller.js';
import type { BpPresentationMode } from '../bp/presentation-settings.js';
import type { registerBroadcastOwners } from '../broadcast-config/live-owners.js';
import type { LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import { createObsDisconnectCapture, type ObsNativeEvidence } from '../obs/native-evidence.js';
import { registerObsRoutes } from '../obs/routes.js';
import type { createObsRuntime } from '../obs/runtime.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import { diagnosticValue } from '../support/session-journal.js';
import { ProgramSceneController } from './controller.js';
import type { createProduction } from './production.js';

type ObsRuntime = ReturnType<typeof createObsRuntime>;

export function createProgramScenes(
  projections: ProjectionCoordinator,
  bpSession: BpSession,
  obs: ObsRuntime['adapter'],
  readBpPresentationMode: () => BpPresentationMode,
) {
  return new ProgramSceneController(
    projections,
    bpSession,
    obs && ((id, options) => obs.switchScene(id, options)),
    obs && ((options) => obs.switchToWaitingForExit(options)),
    obs && ((visible, valid) => obs.setBpCompactVisible(visible, valid)),
    readBpPresentationMode,
    () => obs?.gameBackgroundReady() ?? Promise.resolve(false),
  );
}

export function connectProgramScenes(
  app: FastifyInstance,
  options: {
    obsAdapter: ObsRuntime['adapter'];
    obsConfigStore: ObsRuntime['configStore'];
    gameAudio: ObsRuntime['gameAudio'];
    media: ReturnType<typeof registerBroadcastOwners> | undefined;
    sceneController: ProgramSceneController;
    production: ReturnType<typeof createProduction>;
    originPolicy: LocalWebOriginPolicy;
    consentTime: Parameters<typeof createObsDisconnectCapture>[0];
    recordDisconnect: Parameters<typeof createObsDisconnectCapture>[1];
    readObsCaptureEvidence: (() => Promise<ObsNativeEvidence>) | undefined;
    runtimeControlToken: string | undefined;
  },
) {
  const { obsAdapter, obsConfigStore, gameAudio, media, sceneController, production } = options;
  if (!obsAdapter || !obsConfigStore) return;
  if (media) {
    sceneController.onMatchupStarted((revision, mapName) => {
      media.music.opening(
        'opening:' + revision,
        media.camera.store.map(mapName)?.openingSound ?? undefined,
      );
      media.camera.opening();
    });
  }
  obsAdapter.onBpDisconnect(() =>
    sceneController.compactDisconnected(production.automaticAllowed()),
  );
  const captureDisconnect = createObsDisconnectCapture(
    options.consentTime,
    options.recordDisconnect,
    (error) => app.log.warn({ err: diagnosticValue(error) }, 'OBS 断连诊断采集未完成'),
  );
  obsAdapter.onProgramChanged((kind) => {
    sceneController.obsProgramChanged();
    production.invalidateObsExit();
    if (kind === 'disconnected') captureDisconnect();
  });
  app.addHook('onListen', () => {
    obsAdapter.startCommentaryRecovery(media?.music, () => production.automaticAllowed());
    return Promise.resolve();
  });
  registerObsRoutes(app, {
    originPolicy: options.originPolicy,
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
    ...(options.runtimeControlToken !== undefined
      ? { runtimeControlToken: options.runtimeControlToken }
      : {}),
  });
}
