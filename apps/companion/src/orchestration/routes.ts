import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { orchestrationPresetSchema, CAMERA_STAGES } from '@mizar/protocol/orchestration';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MusicStore } from '../music/store.js';
import type { CameraDirector } from './director.js';

const expectedSchema = z
  .object({ context: z.string().max(4000), connection: z.number().int() })
  .strict();
const commandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('audition'),
      expected: expectedSchema,
      stage: z.enum(['opening', 'round', ...CAMERA_STAGES]),
      index: z.number().int().min(0).max(63).optional(),
    })
    .strict(),
  z.object({ action: z.literal('configure'), preset: orchestrationPresetSchema }).strict(),
  z.object({ action: z.enum(['connect', 'disconnect', 'hold', 'skip']) }).strict(),
  z
    .object({
      action: z.literal('resume'),
      expected: expectedSchema,
    })
    .strict(),
]);
export function registerOrchestrationRoutes(
  app: FastifyInstance,
  director: CameraDirector,
  music: MusicStore,
  policy: LocalWebOriginPolicy,
) {
  const allowed = (origin: string | undefined) =>
    policy.mode === 'loopback' && checkLocalWebOrigin(policy, origin).allowed;
  const view = () => ({
    preset: director.store.preset,
    ready: director.store.ready,
    status: director.get(),
  });
  app.get('/local/v1/orchestration', (request, reply) => {
    if (
      policy.mode !== 'loopback' ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(request.hostname) ||
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && !allowed(request.headers.origin))
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    return reply.header('cache-control', 'no-store').send(view());
  });
  app.post('/operator/orchestration', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      const body = commandSchema.parse(request.body);
      if (body.action === 'audition') {
        const map = director.store.map(director.get().map);
        const shot =
          body.stage === 'opening'
            ? map?.opening
            : body.stage === 'round'
              ? map?.rounds[body.index ?? -1]
              : map?.stages[body.stage];
        if (!shot) throw new Error('camera_shot_missing');
        director.audition(shot, body.expected);
      } else if (body.action === 'configure') {
        for (const map of body.preset.maps)
          if (map.openingSound) await music.trackPath(map.openingSound.id);
        director.hold('预设已修改，请重新确认后启用自动。');
        await director.store.save(body.preset);
        // A resume submitted during persistence must not arm a different preset.
        director.hold('预设已保存，尚未启用自动。');
      } else
        await director.command(body.action, body.action === 'resume' ? body.expected : undefined);
      return view();
    } catch (error) {
      request.log.error(
        { stage: 'camera_operation', err: error, result: 'failure' },
        '运镜操作失败',
      );
      return reply.code(400).send({
        error: 'camera_operation_failed',
        message: '操作未完成，请核对当前地图、连接、预设与本机音频。',
        requestId: request.id,
      });
    }
  });
}
