import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { displayConfig, parseBroadcastPreset, parseModuleRecord } from '@mizar/broadcast-config';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { BroadcastConfigStore } from './store.js';

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

export function registerBroadcastConfigRoutes(
  app: FastifyInstance,
  store: BroadcastConfigStore,
  originPolicy: LocalWebOriginPolicy,
  isReady: () => boolean = () => true,
): void {
  const authorized = (origin: string | undefined) =>
    originPolicy.mode === 'loopback' && checkLocalWebOrigin(originPolicy, origin).allowed;
  app.get('/local/v1/broadcast-display-config', (_request, reply) => {
    if (!isReady()) return reply.code(503).send({ error: 'broadcast_config_unavailable' });
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
  const failure = (error: unknown) => {
    if (error instanceof ZodError) return { status: 400, code: 'invalid_request' };
    const code = error instanceof Error ? error.message : '';
    if (['revision_conflict', 'request_conflict', 'production_busy'].includes(code))
      return { status: 409, code };
    if (['preset_missing', 'module_missing'].includes(code)) return { status: 404, code };
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
            return reply
              .code(503)
              .send({
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
