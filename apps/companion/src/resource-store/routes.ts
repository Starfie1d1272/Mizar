import { diagnosticValue } from '../support/session-journal.js';
import type { FastifyInstance } from 'fastify';
import { ResourceStoreError } from './contract.js';
import type { ResourceStore } from './store.js';
import type { ResourceCatalogCorePin } from '@mizar/resource-pack-contract/runtime';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import { prepareCurrentResource } from './recovery.js';
import { PACK_ID } from './runtime-adapter.js';

/** Register on the existing local service. No listener and no renderer-controlled download/path API. */
export function registerResourceRoutes(
  app: FastifyInstance,
  source: ResourceStore | (() => ResourceStore | undefined),
  recovery?: {
    core: ResourceCatalogCorePin;
    root: string;
    originPolicy: () => LocalWebOriginPolicy;
  },
): void {
  const current = () => {
    const store = typeof source === 'function' ? source() : source;
    if (!store) throw new ResourceStoreError('resource_store_unavailable');
    return store;
  };
  if (recovery) {
    for (const action of ['repair', 'activate'] as const) {
      app.post<{ Params: { packId: string } }>(
        `/local/v1/resources/:packId/${action}`,
        async (request, reply) => {
          const policy = recovery.originPolicy();
          if (
            policy.mode !== 'loopback' ||
            !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(request.hostname) ||
            request.headers['sec-fetch-site'] === 'cross-site' ||
            (request.headers.origin && !checkLocalWebOrigin(policy, request.headers.origin).allowed)
          )
            return reply.code(403).send({ error: 'operator_origin_forbidden' });
          if (request.params.packId !== PACK_ID)
            return reply.code(404).send({ error: 'resource_pack_unknown' });
          try {
            const store = current();
            if (action === 'activate' && !store.getStatus(PACK_ID).preparedVersion)
              return reply
                .code(409)
                .send({
                  error: 'resource_not_ready',
                  message: '尚无已准备素材，请先准备当前素材。',
                });
            if (action === 'repair')
              await store.repair(PACK_ID, prepareCurrentResource(recovery.core, recovery.root));
            else if (!(await store.activatePrepared(PACK_ID)))
              return reply.code(409).send({ message: '素材已准备；结束制作后可启用。' });
            const status = store.getStatus(PACK_ID);
            app.log.info(
              {
                event: 'resource',
                stage: 'resource_cache_verify',
                packId: PACK_ID,
                action,
                result: 'success',
                activeVersion: status.activeVersion,
                preparedVersion: status.preparedVersion,
              },
              '官方素材恢复完成。',
            );
            return reply.header('cache-control', 'no-store').send(status);
          } catch (error) {
            app.log.warn(
              {
                event: 'resource',
                stage: 'resource_cache_verify',
                packId: PACK_ID,
                action,
                result: 'failure',
                diagnostic: { error: diagnosticValue(error) },
              },
              '官方素材恢复失败。',
            );
            return reply.code(409).send({
              error: error instanceof ResourceStoreError ? error.code : 'resource_io_failed',
              message: '素材恢复未完成；原资源保留，请查看当前原因后重试。',
            });
          }
        },
      );
    }
  }
  app.get('/local/v1/resources', async (_request, reply) => {
    try {
      return reply.header('cache-control', 'no-store').send({ resources: current().list() });
    } catch (error) {
      app.log.warn(
        { stage: 'control_failure', error: diagnosticValue(error) },
        'Product control failed',
      );
      return reply.code(503).send({ error: 'resource_store_unavailable' });
    }
  });
  app.get<{ Params: { packId: string } }>('/local/v1/resources/:packId', async (request, reply) => {
    try {
      return reply
        .header('cache-control', 'no-store')
        .send(current().getStatus(request.params.packId));
    } catch (error) {
      app.log.warn(
        { stage: 'control_failure', error: diagnosticValue(error) },
        'Product control failed',
      );
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
        app.log.warn(
          { stage: 'control_failure', error: diagnosticValue(error) },
          'Product control failed',
        );
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
