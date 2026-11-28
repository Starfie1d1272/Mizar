import type { FastifyInstance } from 'fastify';
import type { OutputService } from './service.js';

export function registerOutputRoutes(
  app: FastifyInstance,
  outputService: OutputService,
  refreshProjection: () => void,
): void {
  app.get('/local/v1/live-snapshot', (request, reply) => {
    refreshProjection();
    const withRadar = (request.query as Record<string, unknown>).radar === '1';
    const current = outputService.current(withRadar);
    return current === null
      ? reply
          .code(503)
          .header('cache-control', 'no-store')
          .send({ error: 'live_snapshot_unavailable' })
      : reply.header('cache-control', 'no-store').send(current);
  });
  app.get('/local/v1/reliable-output-status', (_request, reply) => {
    return reply.header('cache-control', 'no-store').send({
      available: outputService.isReliableAvailable(),
      records: !outputService.isReliableAvailable()
        ? null
        : outputService.getReliableRecords().map((record) => ({
            idempotencyKey: record.event.idempotencyKey,
            kind: record.event.kind,
            status: record.status,
            attempts: record.attempts,
            updatedAt: record.updatedAt,
            lastError: record.lastError,
          })),
    });
  });
}
