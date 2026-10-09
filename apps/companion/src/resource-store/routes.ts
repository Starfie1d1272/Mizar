import type { FastifyInstance } from 'fastify';
import { ResourceStoreError } from './contract.js';
import type { ResourceStore } from './store.js';

/** Register on the existing local service. No listener and no renderer-controlled download/path API. */
export function registerResourceRoutes(
  app: FastifyInstance,
  source: ResourceStore | (() => ResourceStore | undefined),
): void {
  const current = () => {
    const store = typeof source === 'function' ? source() : source;
    if (!store) throw new ResourceStoreError('resource_store_unavailable');
    return store;
  };
  app.get('/local/v1/resources', async (_request, reply) => {
    try {
      return reply.header('cache-control', 'no-store').send({ resources: current().list() });
    } catch {
      return reply.code(503).send({ error: 'resource_store_unavailable' });
    }
  });
  app.get<{ Params: { packId: string } }>('/local/v1/resources/:packId', async (request, reply) => {
    try {
      return reply
        .header('cache-control', 'no-store')
        .send(current().getStatus(request.params.packId));
    } catch (error) {
      if (error instanceof ResourceStoreError && error.code === 'resource_store_unavailable')
        return reply.code(503).send({ error: error.code });
      return reply.code(404).send({ error: 'resource_pack_unknown' });
    }
  });
  app.get<{ Params: { packId: string; '*': string } }>(
    '/local/v1/resources/:packId/files/*',
    async (request, reply) => {
      try {
        const result = await current().read(
          request.params.packId,
          request.params['*'],
          request.method === 'GET' ? request.headers.range : undefined,
        );
        reply
          .header('content-type', result.contentType)
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .header('cache-control', 'no-store')
          .header('accept-ranges', 'bytes')
          .header('content-length', result.bytes.length);
        if (result.partial)
          reply
            .code(206)
            .header('content-range', `bytes ${result.start}-${result.end}/${result.totalBytes}`);
        return reply.send(result.bytes);
      } catch (error) {
        const code = error instanceof ResourceStoreError ? error.code : 'resource_io_failed';
        if (code === 'resource_range_invalid') {
          if (error instanceof ResourceStoreError && error.totalBytes !== undefined)
            reply.header('content-range', `bytes */${error.totalBytes}`);
          return reply.code(416).send({ error: code });
        }
        if (code === 'resource_operation_conflict' || code === 'resource_store_unavailable')
          return reply.code(503).send({ error: code });
        if (
          code === 'resource_file_unknown' ||
          code === 'resource_pack_unknown' ||
          code === 'resource_not_ready'
        )
          return reply.code(404).send({ error: code });
        return reply.code(409).send({ error: code });
      }
    },
  );
}
