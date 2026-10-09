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
  let shuttingDown = false;
  let updatePending = false;
  const view = () => ({
    mode,
    revision,
    canEnter: !shuttingDown && !updatePending && options.hasContext(),
  });
  app.get('/local/v1/production', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(view()),
  );
  async function change(body: { action?: unknown; expectedRevision?: unknown } | null) {
    if (
      busy ||
      (updatePending && body?.action !== 'shutdown') ||
      (shuttingDown && body?.action !== 'shutdown') ||
      body?.expectedRevision !== revision
    )
      return { code: 409, value: { message: '制作状态已变化，请刷新后重试。' } };
    if (!['enter', 'hide', 'finish', 'shutdown'].includes(String(body?.action)))
      return { code: 400, value: { message: '制作操作无法识别。' } };
    busy = true;
    const shutdown = body?.action === 'shutdown';
    if (shutdown) shuttingDown = true;
    let committed = false;
    try {
      if (body?.action === 'enter') {
        if (!options.hasContext()) return { code: 409, value: { message: '请先选择或创建比赛。' } };
        mode = 'live';
      } else if (body?.action === 'hide') {
        if (mode === 'live') mode = 'hidden';
      } else {
        // Both normal exit paths use this same safe-scene/release transaction.
        // An idle Host can quit without requiring an OBS connection.
        if (mode !== 'preparation' || options.scenes.get().active !== 'waiting' || !shutdown) {
          const result = await options.scenes.select('waiting', options.scenes.get().revision);
          if (!result.ok) return { code: 409, value: { message: result.message } };
        }
        await options.release();
        mode = 'preparation';
      }
      committed = true;
      revision = randomUUID();
      return { code: 200, value: view() };
    } catch {
      return { code: 409, value: { message: '结束制作未完成，请检查赛事连接后重试。' } };
    } finally {
      if (shutdown && !committed) shuttingDown = false;
      busy = false;
    }
  }
  app.post('/operator/production', { bodyLimit: 1024 }, async (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const result = await change(
      request.body as { action?: unknown; expectedRevision?: unknown } | null,
    );
    return reply.code(result.code).send(result.value);
  });
  return {
    get: view,
    withResourceActivation: async (commit: () => Promise<void>): Promise<boolean> => {
      if (
        mode !== 'preparation' ||
        busy ||
        shuttingDown ||
        updatePending ||
        options.scenes.get().active !== 'waiting' ||
        options.scenes.get().preparing !== undefined
      )
        return false;
      // Share the same lifecycle exclusion as enter/hide/finish/shutdown and Host updates.
      busy = true;
      options.scenes.setUpdatePending(true);
      try {
        await commit();
        return true;
      } finally {
        options.scenes.setUpdatePending(false);
        busy = false;
      }
    },
    reserveUpdate: () => {
      if (mode !== 'preparation' || busy || shuttingDown || updatePending) return false;
      updatePending = true;
      return true;
    },
    releaseUpdate: () => {
      updatePending = false;
    },
    shutdown: () => change({ action: 'shutdown', expectedRevision: revision }),
  };
}
