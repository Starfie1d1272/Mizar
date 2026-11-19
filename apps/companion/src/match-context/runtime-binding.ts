import type { FastifyInstance } from 'fastify';
import type { MatchContextBinding } from './index.js';
import type { MatchContextController } from './controller.js';
import { statsTarget, type RivalHubConnection } from './rivalhub-connection.js';

export function subscribeRuntimeMatchBinding(
  controller: MatchContextController | null,
  options: {
    rehearseEnded: () => void;
    connection: RivalHubConnection | undefined;
    readStatsActive: () => boolean;
    publishBinding: (binding: MatchContextBinding | undefined) => void;
    refreshCues: () => void;
  },
): (() => void) | undefined {
  return controller?.subscribeBinding((binding, previous) => {
    options.connection?.bindingChanged?.(binding?.context.matchId ?? null);
    if (previous?.origin === 'fixture' && binding?.origin !== 'fixture') options.rehearseEnded();
    options.publishBinding(binding);
    if (
      options.readStatsActive() &&
      (binding?.origin === 'online' ||
        (binding?.origin === 'cache' && binding.cachedFrom === 'online'))
    )
      void options.connection?.stats(statsTarget(binding.context));
    else options.connection?.clearStats();
    options.refreshCues();
  });
}

export function registerMatchDocument(
  app: FastifyInstance,
  matchContextController: MatchContextController,
): void {
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
