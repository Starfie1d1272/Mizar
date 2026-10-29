import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PACK_LIMITS } from '@mizar/broadcast-pack';
import {
  assetRefSchema,
  boundModules,
  type ModuleRecord,
  type ResourceRef,
} from '@mizar/broadcast-config';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MusicStore } from '../music/store.js';
import type { BroadcastConfigStore } from './store.js';
import type { MusicPackResources } from './music-pack-resources.js';
import { exportMusicPack, importMusicPack } from './music-pack.js';
import { exportPresetPack, importPresetPack, inspectPresetPack } from './preset-pack.js';

const exportRequest = z.strictObject({
  moduleId: z.string().uuid(),
  expectedRevision: z.string().min(1).max(200),
});
const presetExportRequest = z.strictObject({
  presetId: z.string().uuid(),
  expectedRevision: z.string().min(1).max(200),
  expectedModuleRevisions: z.strictObject({
    hud: z.string().optional(),
    program: z.string().optional(),
    music: z.string().optional(),
    camera: z.string().optional(),
  }),
});
export function registerBroadcastAssetRoutes(
  app: FastifyInstance,
  resources: MusicPackResources,
): void {
  app.get('/local/v1/broadcast-assets', async (request, reply) => {
    const query = z
      .strictObject({
        resourceId: z.string(),
        version: z.string(),
        digest: z.string(),
        fileId: z.string(),
      })
      .safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_request' });
    const { resourceId, version, digest, fileId } = query.data;
    const ref = assetRefSchema.safeParse({ resource: { id: resourceId, version, digest }, fileId });
    if (!ref.success) return reply.code(400).send({ error: 'invalid_request' });
    try {
      const asset = await resources.readAsset(ref.data);
      return reply
        .header('content-type', asset.mediaType)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(asset.bytes);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'resource_unsupported') return reply.code(415).send({ error: code });
      if (code === 'resource_damaged') return reply.code(422).send({ error: code });
      return reply.code(404).send({ error: 'resource_missing' });
    }
  });
}
export function registerMusicPackRoutes(
  app: FastifyInstance,
  store: BroadcastConfigStore,
  music: MusicStore,
  resources: MusicPackResources,
  origin: LocalWebOriginPolicy,
  ready: () => boolean,
  availability?: (module: ModuleRecord, source: ResourceRef) => Promise<void>,
): void {
  const allowed = (value: string | undefined) =>
    origin.mode === 'loopback' && checkLocalWebOrigin(origin, value).allowed;
  app.addContentTypeParser(
    'application/x-mizarpack',
    { parseAs: 'buffer', bodyLimit: PACK_LIMITS.total },
    (_request, body, done) => done(null, body),
  );
  app.post(
    '/operator/resource-library/check-pack',
    { bodyLimit: PACK_LIMITS.total },
    async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      if (!ready()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
      try {
        if (!Buffer.isBuffer(request.body)) throw new Error('package_invalid');
        const { prepare: _prepare, ...result } = await inspectPresetPack({
          zip: request.body,
          store,
          ...(availability ? { availability } : {}),
        });
        return result;
      } catch {
        return reply.code(400).send({ error: 'package_invalid' });
      }
    },
  );
  app.post(
    '/operator/resource-library/import-pack',
    { bodyLimit: PACK_LIMITS.total },
    async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      if (!ready()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
      try {
        if (!Buffer.isBuffer(request.body)) throw new Error('package_invalid');
        const query = z
          .strictObject({
            selection: z.string().max(16384).optional(),
            digest: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .parse(request.query);
        const selection =
          query.selection === undefined
            ? undefined
            : z
                .strictObject({
                  modules: z.array(z.string().max(128)).max(128),
                  presets: z.array(z.string().max(128)).max(32),
                })
                .parse(JSON.parse(query.selection));
        return await importPresetPack({
          zip: request.body,
          store,
          resources,
          ...(selection ? { selection } : {}),
          ...(query.digest ? { expectedDigest: query.digest } : {}),
          ...(availability ? { availability } : {}),
        });
      } catch (error) {
        if (error instanceof Error && error.message === 'identity_conflict')
          return reply.code(409).send({ error: 'identity_conflict' });
        return reply.code(400).send({ error: 'package_invalid' });
      }
    },
  );
  app.post(
    '/operator/resource-library/export-pack',
    { bodyLimit: 32 * 1024 },
    async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      if (!ready()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
      const parsed = z
        .strictObject({
          modules: z.array(exportRequest).max(128),
          presets: z.array(presetExportRequest).max(32),
        })
        .safeParse(request.body);
      if (
        !parsed.success ||
        (!parsed.data.modules.length && !parsed.data.presets.length) ||
        new Set(parsed.data.modules.map((item) => item.moduleId)).size !==
          parsed.data.modules.length ||
        new Set(parsed.data.presets.map((item) => item.presetId)).size !==
          parsed.data.presets.length
      )
        return reply.code(400).send({ error: 'invalid_request' });
      const document = store.snapshot;
      try {
        const modules = parsed.data.modules.map((item) => {
          const module = document.modules.find((value) => value.id === item.moduleId);
          if (!module) throw new Error('module_missing');
          if (module.revision !== item.expectedRevision) throw new Error('revision_conflict');
          return module;
        });
        const presets = parsed.data.presets.map((item) => {
          const preset = document.presets.find((value) => value.id === item.presetId);
          if (!preset) throw new Error('preset_missing');
          if (preset.revision !== item.expectedRevision) throw new Error('revision_conflict');
          const bound = boundModules(preset, document.modules);
          for (const [kind, module] of bound)
            if (module && item.expectedModuleRevisions[kind] !== module.revision)
              throw new Error('revision_conflict');
          return { preset, bound };
        });
        const zip = await exportPresetPack({
          document,
          moduleIds: modules.map((item) => item.id),
          presetIds: presets.map(({ preset }) => preset.id),
          music,
          resources,
          metadata: {
            packageId: randomUUID(),
            version: '1.0.0',
            name: presets[0]?.preset.name ?? modules[0]!.name,
            author: '',
          },
        });
        const current = store.snapshot;
        if (
          modules.some(
            (item) => current.modules.find((m) => m.id === item.id)?.revision !== item.revision,
          ) ||
          presets.some(
            ({ preset, bound }) =>
              current.presets.find((p) => p.id === preset.id)?.revision !== preset.revision ||
              [...bound.values()].some(
                (item) =>
                  item && current.modules.find((m) => m.id === item.id)?.revision !== item.revision,
              ),
          )
        )
          throw new Error('revision_conflict');
        return reply
          .header('cache-control', 'no-store')
          .header('content-disposition', 'attachment; filename="resource.mizarpack"')
          .type('application/x-mizarpack')
          .send(zip);
      } catch (error) {
        if (error instanceof Error && error.message === 'revision_conflict')
          return reply.code(409).send({ error: 'revision_conflict' });
        if (error instanceof Error && ['module_missing', 'preset_missing'].includes(error.message))
          return reply.code(404).send({ error: error.message });
        return reply.code(422).send({ error: 'export_failed' });
      }
    },
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
  app.post(
    '/operator/resource-library/import-preset-pack',
    { bodyLimit: PACK_LIMITS.total },
    async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      if (!ready()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
      try {
        if (!Buffer.isBuffer(request.body)) throw new Error('package_invalid');
        return await importPresetPack({ zip: request.body, store, resources });
      } catch (error) {
        if (error instanceof Error && error.message === 'identity_conflict')
          return reply.code(409).send({ error: 'identity_conflict' });
        return reply.code(400).send({ error: 'package_invalid' });
      }
    },
  );
  app.post(
    '/operator/resource-library/export-preset-pack',
    { bodyLimit: 4096 },
    async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      if (!ready()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
      const parsed = presetExportRequest.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
      const document = store.snapshot;
      const preset = document.presets.find((item) => item.id === parsed.data.presetId);
      if (!preset) return reply.code(404).send({ error: 'preset_missing' });
      if (preset.revision !== parsed.data.expectedRevision)
        return reply.code(409).send({ error: 'revision_conflict' });
      try {
        const bound = boundModules(preset, document.modules);
        for (const [kind, module] of bound)
          if (module && parsed.data.expectedModuleRevisions[kind] !== module.revision)
            return reply.code(409).send({ error: 'revision_conflict' });
        const zip = await exportPresetPack({
          document,
          presetId: preset.id,
          music,
          resources,
          metadata: { packageId: randomUUID(), version: '1.0.0', name: preset.name, author: '' },
        });
        const current = store.snapshot;
        const latest = current.presets.find((item) => item.id === preset.id);
        if (
          !latest ||
          latest.revision !== preset.revision ||
          [...bound.values()].some(
            (item) =>
              item && current.modules.find((m) => m.id === item.id)?.revision !== item.revision,
          )
        )
          return reply.code(409).send({ error: 'revision_conflict' });
        return reply
          .header('cache-control', 'no-store')
          .header('content-disposition', 'attachment; filename="broadcast.mizarpack"')
          .type('application/x-mizarpack')
          .send(zip);
      } catch {
        return reply.code(422).send({ error: 'export_failed' });
      }
    },
  );
  app.post(
    '/operator/resource-library/export-preset-bundle',
    { bodyLimit: 32 * 1024 },
    async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      if (!ready()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
      const parsed = z
        .strictObject({ presets: z.array(presetExportRequest).min(1).max(32) })
        .safeParse(request.body);
      if (
        !parsed.success ||
        new Set(parsed.data.presets.map((item) => item.presetId)).size !==
          parsed.data.presets.length
      )
        return reply.code(400).send({ error: 'invalid_request' });
      const document = store.snapshot;
      try {
        const selected = parsed.data.presets.map((item) => {
          const preset = document.presets.find((value) => value.id === item.presetId);
          if (!preset) throw new Error('preset_missing');
          if (preset.revision !== item.expectedRevision) throw new Error('revision_conflict');
          const bound = boundModules(preset, document.modules);
          for (const [kind, module] of bound)
            if (module && item.expectedModuleRevisions[kind] !== module.revision)
              throw new Error('revision_conflict');
          return { preset, bound };
        });
        const zip = await exportPresetPack({
          document,
          presetId: selected[0]!.preset.id,
          presetIds: selected.map((item) => item.preset.id),
          music,
          resources,
          metadata: {
            packageId: randomUUID(),
            version: '1.0.0',
            name: selected.length === 1 ? selected[0]!.preset.name : '播出方案',
            author: '',
          },
        });
        const current = store.snapshot;
        if (
          selected.some(
            ({ preset, bound }) =>
              current.presets.find((item) => item.id === preset.id)?.revision !== preset.revision ||
              [...bound.values()].some(
                (module) =>
                  module &&
                  current.modules.find((item) => item.id === module.id)?.revision !==
                    module.revision,
              ),
          )
        )
          throw new Error('revision_conflict');
        return reply
          .header('cache-control', 'no-store')
          .header('content-disposition', 'attachment; filename="broadcast.mizarpack"')
          .type('application/x-mizarpack')
          .send(zip);
      } catch (error) {
        if (error instanceof Error && error.message === 'revision_conflict')
          return reply.code(409).send({ error: 'revision_conflict' });
        if (error instanceof Error && error.message === 'preset_missing')
          return reply.code(404).send({ error: 'preset_missing' });
        return reply.code(422).send({ error: 'export_failed' });
      }
    },
  );
}
