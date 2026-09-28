import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ProgramSceneController } from './controller.js';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';

/** Presentation lifecycle only. Match and series facts remain with their existing owners. */
export function registerProductionRoutes(
  app: FastifyInstance,
  options: {
    originPolicy: LocalWebOriginPolicy;
    hasContext: () => boolean;
    scenes: ProgramSceneController;
    release: () => Promise<void>;
  },
) {
  let mode: 'preparation' | 'live' | 'hidden' = 'preparation';
  let revision = randomUUID();
  let busy = false;
  const view = () => ({ mode, revision, canEnter: options.hasContext() });
  app.get('/local/v1/production', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(view()),
  );
  app.post('/operator/production', { bodyLimit: 1024 }, async (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = request.body as { action?: unknown; expectedRevision?: unknown } | null;
    if (busy || body?.expectedRevision !== revision)
      return reply.code(409).send({ message: '制作状态已变化，请刷新后重试。' });
    if (!['enter', 'hide', 'finish'].includes(String(body?.action)))
      return reply.code(400).send({ message: '制作操作无法识别。' });
    busy = true;
    try {
      if (body?.action === 'enter') {
        if (!options.hasContext()) return reply.code(409).send({ message: '请先选择或创建比赛。' });
        mode = 'live';
      } else if (body?.action === 'hide') {
        if (mode === 'live') mode = 'hidden';
      } else {
        await options.release();
        const result = await options.scenes.select('waiting', options.scenes.get().revision);
        if (!result.ok) return reply.code(409).send({ message: result.message });
        mode = 'preparation';
      }
      revision = randomUUID();
      return view();
    } catch {
      return reply.code(409).send({ message: '结束制作未完成，请检查赛事连接后重试。' });
    } finally {
      busy = false;
    }
  });
  return { get: view };
}
