import { timingSafeEqual } from 'node:crypto';
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
  z.strictObject({ action: z.literal('browser'), expectedRevision: z.string().max(128) }),
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
const host = z.string().min(1).max(80);
const nativeSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('host-start'), host }),
  z.strictObject({ action: z.literal('begin'), host, expectedRevision: z.string().max(128) }),
  z.strictObject({ action: z.enum(['pulse', 'invalidate']), host, lease: z.uuid() }),
]);
export function registerOrchestrationRoutes(
  app: FastifyInstance,
  director: CameraDirector,
  music: MusicStore,
  policy: LocalWebOriginPolicy,
  session?: {
    controlToken: string | undefined;
    configure: (revision: string, commit: () => void) => void;
  },
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
  app.post('/operator/runtime/camera-session', { bodyLimit: 2048 }, (request, reply) => {
    const expected = Buffer.from(session?.controlToken ?? '');
    const token = request.headers['x-runtime-token'];
    const supplied = Buffer.from(typeof token === 'string' ? token : '');
    if (
      policy.mode !== 'loopback' ||
      request.headers.origin !== undefined ||
      !expected.length ||
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      return reply.code(403).send({ error: 'runtime-control-denied' });
    try {
      const body = nativeSchema.parse(request.body);
      let lease: string | undefined;
      if (body.action === 'host-start') director.hostStarted(body.host);
      else if (body.action === 'begin')
        session!.configure(body.expectedRevision, () => {
          lease = director.beginNative(body.host);
        });
      else if (body.action === 'pulse') director.pulseNative(body.host, body.lease);
      else director.revokeNative(body.host, body.lease);
      return { ok: true, ...(lease ? { lease } : {}) };
    } catch (error) {
      request.log.error(
        { stage: 'camera_host_session', err: error, result: 'failure' },
        '原生运镜会话未确认',
      );
      return reply.code(409).send({ error: 'camera_native_session_invalid' });
    }
  });
  app.post('/operator/orchestration', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      const body = commandSchema.parse(request.body);
      if (body.action === 'browser') {
        if (!session) throw new Error('camera_production_unavailable');
        session.configure(body.expectedRevision, () => director.useBrowser());
      } else if (body.action === 'audition') {
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
