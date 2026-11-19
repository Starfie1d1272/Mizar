import type { FastifyInstance } from 'fastify';
import type { ReliableOutbox } from './reliable-outbox.js';
import type { OutputService } from './service.js';

export function registerOutputRoutes(
  app: FastifyInstance,
  outputService: OutputService,
  outbox: Pick<ReliableOutbox, 'getCaptureCapacity' | 'getWorkerFailure'> | undefined,
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
  app.get('/local/v1/reliable-output-status', async (_request, reply) => {
    const capacity = await outbox?.getCaptureCapacity()?.catch(() => undefined);
    return reply.header('cache-control', 'no-store').send({
      available: outputService.isReliableAvailable(),
      workerFailure: outbox?.getWorkerFailure() ?? null,
      capacity: capacity ?? null,
      recovery: outputService.getReliableRecovery() ?? null,
      revokedIsolation: outputService.getRevokedIsolationSummary() ?? null,
      records: !outputService.isReliableAvailable()
        ? null
        : outputService.getReliableRecords().map((record) => ({
            idempotencyKey: record.event.idempotencyKey,
            kind: record.event.kind,
            status: record.status,
            attempts: record.attempts,
            updatedAt: record.updatedAt,
          })),
    });
  });
}
