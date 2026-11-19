import type { FastifyBaseLogger } from 'fastify';
import { obsErrorEvidence } from '../obs/adapter.js';
import type { GameAudioController } from '../obs/audio-policy-controller.js';
import { gameAudioTruth } from '../obs/audio-policy-truth.js';
import type { ObsConfigStore } from '../obs/config.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import type { ProgramSceneController } from './controller.js';
import type { ProgramDirector } from './director.js';
import type { createProduction } from './production.js';

export function startProgramAutomation(
  log: FastifyBaseLogger,
  {
    director,
    sceneController,
    production,
    obsConfigStore,
    projectionCoordinator,
    gameAudio,
    tickMedia,
  }: {
    director: ProgramDirector;
    sceneController: ProgramSceneController;
    production: Pick<ReturnType<typeof createProduction>, 'sessionValid' | 'automaticAllowed'>;
    obsConfigStore: ObsConfigStore | undefined;
    projectionCoordinator: ProjectionCoordinator;
    gameAudio: GameAudioController | undefined;
    tickMedia: () => void;
  },
): () => void {
  sceneController.attachDirector(director);
  const directorTimer = setInterval(() => {
    const sessionValid = production.sessionValid();
    void sceneController
      .reconcileObs(() => sessionValid() && production.automaticAllowed())
      .catch(async (error: unknown) => {
        log.warn(
          {
            event: 'obs',
            stage: 'program_reconciliation',
            diagnostic: {
              error: obsErrorEvidence(
                error,
                (await obsConfigStore?.read().catch(() => undefined))?.password,
              ),
            },
          },
          'OBS program reconciliation pending',
        );
      });
    void director.tick().catch(() => director.hold());
    tickMedia();
    if (gameAudio) {
      const projection = projectionCoordinator.getCurrent();
      gameAudio.tick(
        gameAudioTruth(
          projection.program,
          sceneController.get().active,
          production.automaticAllowed() && projection.operator.matchContext.origin !== 'fixture',
        ),
      );
    }
  }, 100);
  directorTimer.unref();
  return () => clearInterval(directorTimer);
}
