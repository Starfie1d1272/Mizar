import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import {
  displayConfig,
  parseBroadcastPreset,
  parseModuleRecord,
  type ModuleRecord,
} from '@mizar/broadcast-config';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { BroadcastConfigStore } from './store.js';
import { isBuiltinModuleId } from './builtin-modules.js';

const revision = z.string().min(1).max(200);
const moduleRevisions = z.strictObject({
  hud: revision.optional(),
  program: revision.optional(),
  music: revision.optional(),
  camera: revision.optional(),
});
const apply = z.strictObject({
  presetId: z.string().uuid(),
  expectedRevision: revision,
  expectedModuleRevisions: moduleRevisions,
  expectedActiveRevision: revision,
  requestId: z.string().uuid(),
});
const clone = z.strictObject({
  sourceId: z.string().uuid(),
  expectedRevision: revision,
  expectedModuleRevisions: moduleRevisions,
  name: z.string().trim().min(1).max(120),
});
const save = z.strictObject({
  preset: z.unknown(),
  expectedPresetRevision: revision.nullable(),
  modules: z
    .array(z.strictObject({ value: z.unknown(), expectedRevision: revision.nullable() }))
    .max(128),
});
const moduleSave = z.strictObject({ value: z.unknown(), expectedRevision: revision.nullable() });
const moduleClone = z.strictObject({
  moduleId: z.string().uuid(),
  expectedRevision: revision,
  name: z.string().trim().min(1).max(120),
});
const moduleDelete = z.strictObject({
  moduleId: z.string().uuid(),
  expectedRevision: revision,
  replacement: z
    .strictObject({
      moduleId: z.string().uuid().nullable(),
      expectedPresetRevisions: z.record(z.string().uuid(), revision),
    })
    .optional(),
});
const presetDelete = z.strictObject({ presetId: z.string().uuid(), expectedRevision: revision });
const moduleApply = z.strictObject({
  moduleId: z.string().uuid(),
  expectedRevision: revision,
  expectedActiveRevision: revision,
  requestId: z.string().uuid(),
});

export function registerBroadcastConfigRoutes(
  app: FastifyInstance,
  store: BroadcastConfigStore,
  originPolicy: LocalWebOriginPolicy,
  isReady: () => boolean = () => true,
  restoreLegacyCamera?: () => Promise<
    Array<{ legacyId: string; moduleId: string; activeSnapshot: boolean }>
  >,
  moduleAvailability?: (
    module: ModuleRecord,
  ) => Promise<{ state: 'ready' | 'dependency_missing'; reason?: string }>,
  displayAvailable: () => boolean = () => true,
  builtinMusicAvailable?: () => boolean,
): void {
  const authorized = (origin: string | undefined) =>
    originPolicy.mode === 'loopback' && checkLocalWebOrigin(originPolicy, origin).allowed;
  app.get('/local/v1/broadcast-display-config', (_request, reply) => {
    if (!isReady()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
    if (!displayAvailable()) reply.header('x-mizar-program-status', 'dependency_missing');
    return reply.header('cache-control', 'no-store').send(displayConfig(store.snapshot.active));
  });
  app.get('/local/v1/broadcast-presets', (request, reply) => {
    if (
      originPolicy.mode !== 'loopback' ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(request.hostname) ||
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && !authorized(request.headers.origin))
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    if (!isReady()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
    return reply.header('cache-control', 'no-store').send(store.snapshot);
  });
  app.get('/local/v1/broadcast-modules', async (request, reply) => {
    if (
      originPolicy.mode !== 'loopback' ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(request.hostname) ||
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && !authorized(request.headers.origin))
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    if (!isReady()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
    return reply.header('cache-control', 'no-store').send({
      ...(builtinMusicAvailable ? { builtinMusicAvailable: builtinMusicAvailable() } : {}),
      modules: await Promise.all(
        store.snapshot.modules.map(async (module) => ({
          ...((request.query as { view?: string }).view === 'metadata'
            ? { id: module.id, revision: module.revision }
            : { module }),
          builtin: isBuiltinModuleId(module.id),
          ...(moduleAvailability ? { availability: await moduleAvailability(module) } : {}),
        })),
      ),
    });
  });
  app.get('/local/v1/broadcast-config/pending-camera', (request, reply) => {
    if (
      originPolicy.mode !== 'loopback' ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(request.hostname) ||
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && !authorized(request.headers.origin))
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    if (!isReady()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
    return reply
      .header('cache-control', 'no-store')
      .send({ pending: store.pendingLegacyCamera ?? null });
  });
  for (const action of ['restore', 'delete'] as const) {
    app.post(
      `/operator/broadcast-config/pending-camera/${action}`,
      { bodyLimit: 1024 },
      async (request, reply) => {
        if (!authorized(request.headers.origin))
          return reply.code(403).send({ error: 'operator_forbidden' });
        if (!isReady()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
        if (!z.strictObject({}).safeParse(request.body).success)
          return reply.code(400).send({ error: 'invalid_request' });
        try {
          if (action === 'delete') {
            await store.deletePendingLegacyCamera();
            return { ok: true };
          }
          if (!restoreLegacyCamera) throw new Error('camera_identity_unavailable');
          return { restored: await restoreLegacyCamera() };
        } catch (error) {
          if (error instanceof Error && error.message === 'pending_camera_missing')
            return reply.code(404).send({ error: 'pending_camera_missing' });
          return reply.code(503).send({
            error: 'camera_identity_unavailable',
            message: '原运镜配置已保留，请准备 MulNX 后重试。',
          });
        }
      },
    );
  }
  const failure = (error: unknown) => {
    if (error instanceof ZodError) return { status: 400, code: 'invalid_request' };
    const code = error instanceof Error ? error.message : '';
    if (
      [
        'revision_conflict',
        'request_conflict',
        'production_busy',
        'builtin_immutable',
        'module_active',
        'module_referenced',
        'preset_active',
        'hud_resource_conflict',
      ].includes(code)
    )
      return { status: 409, code };
    if (['preset_missing', 'module_missing'].includes(code)) return { status: 404, code };
    if (code === 'capability_unsupported') return { status: 422, code };
    if (code === 'broadcast_owner_sync_failed') return { status: 503, code };
    if (
      [
        'incomplete_preset',
        'duplicate_module_kind',
        'required_module_off',
        'duplicate_module',
        'invalid_request',
      ].includes(code)
    )
      return { status: 400, code: 'invalid_request' };
    return { status: 503, code: 'provider_unavailable' };
  };
  for (const action of ['save', 'clone', 'delete', 'apply'] as const) {
    app.post(
      `/operator/broadcast-modules/${action}`,
      { bodyLimit: 1024 * 1024 },
      async (request, reply) => {
        if (!authorized(request.headers.origin))
          return reply.code(403).send({
            error: {
              code: 'operator_forbidden',
              message: '请求来源不可用',
              requestId: request.id,
            },
          });
        if (!isReady()) {
          const retry = action === 'apply' ? moduleApply.safeParse(request.body) : null;
          if (!retry?.success || !store.hasReceipt(retry.data.requestId))
            return reply.code(503).send({
              error: {
                code: 'broadcast_config_unavailable',
                message: '播出配置尚未就绪。',
                requestId: request.id,
              },
            });
        }
        try {
          if (action === 'save') {
            const input = moduleSave.parse(request.body);
            return await store.saveModule(parseModuleRecord(input.value), input.expectedRevision);
          }
          if (action === 'clone') {
            const input = moduleClone.parse(request.body);
            return await store.cloneModule(input.moduleId, input.expectedRevision, input.name);
          }
          if (action === 'apply') return await store.applyModule(moduleApply.parse(request.body));
          const input = moduleDelete.parse(request.body);
          await store.deleteModule(input.moduleId, input.expectedRevision, input.replacement);
          return { ok: true };
        } catch (error) {
          const { status, code } = failure(error);
          return reply.code(status).send({
            error: {
              code,
              message:
                code === 'capability_unsupported'
                  ? '该配置包含尚不支持的场景槽位或素材类型，请修改后重试。'
                  : status === 409
                    ? '配置正在使用或已变化，请先替换引用后重试。'
                    : '配置暂时不可用。',
              requestId: request.id,
            },
          });
        }
      },
    );
  }
  app.post('/operator/broadcast-presets/delete', async (request, reply) => {
    if (!authorized(request.headers.origin))
      return reply.code(403).send({ error: 'operator_forbidden' });
    if (!isReady()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
    try {
      const input = presetDelete.parse(request.body);
      await store.deletePreset(input.presetId, input.expectedRevision);
      return { ok: true };
    } catch (error) {
      const { status, code } = failure(error);
      return reply.code(status).send({
        error: { code, message: '方案正在使用或已变化，请刷新后重试。', requestId: request.id },
      });
    }
  });
  for (const action of ['save', 'clone', 'preview', 'apply'] as const) {
    app.post(
      `/operator/broadcast-presets/${action}`,
      { bodyLimit: 1024 * 1024 },
      async (request, reply) => {
        if (!authorized(request.headers.origin))
          return reply.code(403).send({
            error: {
              code: 'operator_forbidden',
              message: '请求来源不可用',
              requestId: request.id,
            },
          });
        if (!isReady()) {
          const parsed = action === 'apply' ? apply.safeParse(request.body) : null;
          if (!parsed?.success || !store.hasReceipt(parsed.data.requestId))
            return reply.code(503).send({
              error: {
                code: 'broadcast_config_unavailable',
                message: '播出配置尚未就绪。',
                requestId: request.id,
              },
            });
        }
        try {
          if (action === 'clone') return await store.clone(clone.parse(request.body));
          if (action === 'preview') return await store.preview(apply.parse(request.body));
          if (action === 'apply') return await store.apply(apply.parse(request.body));
          const input = save.parse(request.body);
          return await store.save({
            preset: parseBroadcastPreset(input.preset),
            expectedPresetRevision: input.expectedPresetRevision,
            modules: input.modules.map((entry) => ({
              value: parseModuleRecord(entry.value),
              expectedRevision: entry.expectedRevision,
            })),
          });
        } catch (error) {
          const { status, code } = failure(error);
          return reply.code(status).send({
            error: {
              code,
              message:
                status === 409
                  ? '配置已变化或当前无法切换，请刷新后重试。'
                  : status === 404
                    ? '方案或模块不存在。'
                    : status === 400
                      ? '配置内容无效。'
                      : '配置暂时不可用。',
              requestId: request.id,
            },
          });
        }
      },
    );
  }
}
