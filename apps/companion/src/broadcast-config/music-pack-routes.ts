import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PACK_LIMITS } from '@mizar/broadcast-pack';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MusicStore } from '../music/store.js';
import type { BroadcastConfigStore } from './store.js';
import type { MusicPackResources } from './music-pack-resources.js';
import { exportMusicPack, importMusicPack } from './music-pack.js';

const exportRequest = z.strictObject({
  moduleId: z.string().uuid(),
  expectedRevision: z.string().min(1).max(200),
});
export function registerMusicPackRoutes(
  app: FastifyInstance,
  store: BroadcastConfigStore,
  music: MusicStore,
  resources: MusicPackResources,
  origin: LocalWebOriginPolicy,
  ready: () => boolean,
): void {
  const allowed = (value: string | undefined) =>
    origin.mode === 'loopback' && checkLocalWebOrigin(origin, value).allowed;
  app.addContentTypeParser(
    'application/x-mizarpack',
    { parseAs: 'buffer', bodyLimit: PACK_LIMITS.total },
    (_request, body, done) => done(null, body),
  );
  app.post(
    '/operator/resource-library/import-music-pack',
    { bodyLimit: PACK_LIMITS.total },
    async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      if (!ready()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
      try {
        if (!Buffer.isBuffer(request.body)) throw new Error('package_invalid');
        return await importMusicPack({ zip: request.body, store, resources });
      } catch (error) {
        if (error instanceof Error && error.message === 'identity_conflict')
          return reply.code(409).send({ error: 'identity_conflict' });
        return reply.code(400).send({ error: 'package_invalid' });
      }
    },
  );
  app.post(
    '/operator/resource-library/export-music-pack',
    { bodyLimit: 4096 },
    async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      if (!ready()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
      const input = exportRequest.safeParse(request.body);
      if (!input.success) return reply.code(400).send({ error: 'invalid_request' });
      const module = store.snapshot.modules.find((item) => item.id === input.data.moduleId);
      if (!module || module.kind !== 'music')
        return reply.code(404).send({ error: 'module_missing' });
      if (module.revision !== input.data.expectedRevision)
        return reply.code(409).send({ error: 'revision_conflict' });
      try {
        const zip = await exportMusicPack(music, resources, module, {
          packageId: randomUUID(),
          version: '1.0.0',
          name: module.name,
          author: '',
        });
        if (
          store.snapshot.modules.find((item) => item.id === module.id)?.revision !== module.revision
        )
          return reply.code(409).send({ error: 'revision_conflict' });
        return reply
          .header('cache-control', 'no-store')
          .header('content-disposition', 'attachment; filename="music.mizarpack"')
          .type('application/x-mizarpack')
          .send(zip);
      } catch {
        return reply.code(422).send({ error: 'export_failed' });
      }
    },
  );
}
