import type { FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { parseBroadcastPreset, parseModuleRecord } from '@mizar/broadcast-config';
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
): void {
  app.get('/local/v1/broadcast-presets', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(store.snapshot),
  );
  const authorized = (origin: string | undefined) =>
    originPolicy.mode === 'loopback' && checkLocalWebOrigin(originPolicy, origin).allowed;
  const failure = (error: unknown) => {
    if (error instanceof ZodError) return { status: 400, code: 'invalid_request' };
    const code = error instanceof Error ? error.message : '';
    if (['revision_conflict', 'request_conflict', 'production_busy'].includes(code))
      return { status: 409, code };
    if (['preset_missing', 'module_missing'].includes(code)) return { status: 404, code };
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
          return reply
            .code(403)
            .send({
              error: {
                code: 'operator_forbidden',
                message: '请求来源不可用',
                requestId: request.id,
              },
            });
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
          return reply
            .code(status)
            .send({
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
