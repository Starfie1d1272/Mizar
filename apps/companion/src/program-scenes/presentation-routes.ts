import type { FastifyInstance } from 'fastify';
import type { ScheduleWindow } from '@mizar/core/match-context';
import type { MatchContextBinding, MatchContextController } from '../match-context/index.js';
import type { RivalHubConnection } from '../match-context/rivalhub-connection.js';
import {
  registerBroadcastStatsRoutes,
  registerHistoricalStatsProgramRoute,
  registerHistoricalStatsPresentationRoute,
} from '../match-context/rivalhub-routes.js';
import type {
  ProjectionBundle,
  ProjectionCoordinator,
} from '../projections/projection-coordinator.js';
import type { ProgramSceneController } from './controller.js';
import { ProductionGuidanceStore, registerProductionGuidance } from './guidance.js';
import { ProgramPresentationStore } from './presentation.js';

export function registerProgramPresentation(
  app: FastifyInstance,
  options: {
    projections: Pick<ProjectionCoordinator, 'getCurrent' | 'subscribePresentation'>;
    readBinding: () => MatchContextBinding | undefined;
    readDocument: () => ReturnType<MatchContextController['getActiveDocumentEnvelope']> | undefined;
    readLocalSchedule: (competitionId: string) => ScheduleWindow | null | undefined;
    readTrialActive: () => boolean;
    connection: RivalHubConnection | undefined;
    readScene: () => ReturnType<ProgramSceneController['get']>['active'];
    recordProjection: (bundle: ProjectionBundle, binding: MatchContextBinding | undefined) => void;
  },
) {
  const { projections, readBinding, connection } = options;
  const guidance = new ProductionGuidanceStore();
  registerProductionGuidance(app, guidance, {
    getBinding: readBinding,
    getProjection: () => projections.getCurrent(),
  });
  const presentation = new ProgramPresentationStore();
  const unsubscribe = projections.subscribePresentation((bundle) => {
    const binding = readBinding();
    options.recordProjection(bundle, binding);
    guidance.update(bundle, binding);
    presentation.update(bundle.program, binding?.manifest.revision ?? 'initial');
  });
  const getProgram = () => {
    const envelope = options.readDocument();
    const document = envelope?.freshness === 'fresh' ? envelope.document : null;
    const schedule = options.readTrialActive()
      ? undefined
      : envelope?.source === 'local' && document?.competition
        ? options.readLocalSchedule(document.competition.competitionId)
        : connection?.getSchedule();
    return presentation.get(document, schedule);
  };
  app.get('/local/v1/program-presentation', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(getProgram()),
  );
  registerHistoricalStatsPresentationRoute(app, { connection, getBinding: readBinding });
  registerHistoricalStatsProgramRoute(app, {
    connection,
    getBinding: readBinding,
    getProgram,
    getScene: options.readScene,
  });
  registerBroadcastStatsRoutes(app, { connection, getBinding: readBinding });
  return { presentation, unsubscribe };
}
