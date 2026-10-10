import { errorEvidence } from '../updates/diagnostics.js';
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
    beforeEnter?: () => void;
    finishTrial?: () => Promise<void>;
  },
) {
  let mode: 'preparation' | 'live' | 'hidden' = 'preparation';
  let revision = randomUUID();
  let busy = false;
  let shuttingDown = false;
  let updatePending = false;
  let trialPending = false;
  const view = () => ({
    mode,
    revision,
    canEnter: !trialPending && !shuttingDown && !updatePending && options.hasContext(),
  });
  app.get('/local/v1/production', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(view()),
  );
  async function change(body: { action?: unknown; expectedRevision?: unknown } | null) {
    if (
      busy ||
      (trialPending && !['finish', 'shutdown'].includes(String(body?.action))) ||
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
    let stage = 'production_context';
    const operationId = randomUUID();
    try {
      if (body?.action === 'enter') {
        if (!options.hasContext()) return { code: 409, value: { message: '请先选择或创建比赛。' } };
        options.beforeEnter?.();
        mode = 'live';
      } else if (body?.action === 'hide') {
        if (mode === 'live') mode = 'hidden';
      } else {
        if (trialPending) {
          stage = 'production_safe_scene';
          await options.finishTrial?.();
        }
        // Both normal exit paths use this same safe-scene/release transaction.
        // An idle Host can quit without requiring an OBS connection.
        if (mode !== 'preparation' || options.scenes.get().active !== 'waiting' || !shutdown) {
          stage = 'production_safe_scene';
          const result = await options.scenes.select('waiting', options.scenes.get().revision);
          if (!result.ok) return { code: 409, value: { message: result.message } };
        }
        stage = 'production_release';
        await options.release();
        mode = 'preparation';
      }
      committed = true;
      revision = randomUUID();
      return { code: 200, value: view() };
    } catch (error) {
      app.log.error(
        {
          event: 'production',
          stage,
          result: 'failure',
          action: body?.action,
          diagnostic: { operationId, error: errorEvidence(error) },
        },
        'Production operation failed',
      );
      const message =
        stage === 'production_release'
          ? '等待画面已保留，但数据源释放失败，制作状态仍保留。请查看诊断，处理记录的问题后再结束制作。'
          : stage === 'production_safe_scene'
            ? '切换等待画面失败，制作尚未结束。请查看诊断，处理记录的问题后再结束制作。'
            : '比赛状态读取失败，当前状态和具体原因未确认。请复制诊断信息后排查。';
      return { code: 409, value: { message } };
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
    isTrialPending: () => trialPending,
    reserveTrialOperation: (allowShutdownCleanup = false) => {
      if (!trialPending || busy || (shuttingDown && !allowShutdownCleanup) || updatePending)
        return false;
      busy = true;
      return true;
    },
    releaseTrialOperation: () => {
      busy = false;
    },
    setTrialPlaying: () => {
      mode = 'live';
      revision = randomUUID();
    },
    setTrialPreparation: () => {
      mode = 'preparation';
      revision = randomUUID();
    },
    prepareTrial: async (commit: () => Promise<void>): Promise<boolean> => {
      if (
        mode !== 'preparation' ||
        busy ||
        shuttingDown ||
        updatePending ||
        trialPending ||
        options.scenes.get().preparing !== undefined
      )
        return false;
      trialPending = true;
      busy = true;
      try {
        await commit();
        return true;
      } finally {
        busy = false;
      }
    },
    setTrialPending: (value: boolean) => {
      trialPending = value;
    },

    withResourceActivation: async (commit: () => Promise<void>): Promise<boolean> => {
      if (
        trialPending ||
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
      options.scenes.setResourceActivationPending(true);
      try {
        await commit();
        return true;
      } finally {
        options.scenes.setResourceActivationPending(false);
        busy = false;
      }
    },
    reserveUpdate: () => {
      if (trialPending || mode !== 'preparation' || busy || shuttingDown || updatePending)
        return false;
      updatePending = true;
      return true;
    },
    releaseUpdate: () => {
      updatePending = false;
    },
    shutdown: () => change({ action: 'shutdown', expectedRevision: revision }),
  };
}
