import { cancelPreparation, preparationCancelled } from './preparation-cancellation.js';
import { diagnosticValue } from '../support/session-journal.js';
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
    handoffRelease?: () => Promise<void>;
    beforeEnter?: () => void;
    waitForBroadcast?: () => Promise<void>;
    onEnter?: () => void;
    onEntered?: () => void;
    onFinish?: () => void;
    beforeFinish?: () => void | Promise<void>;
    afterSafeScene?: (valid?: () => boolean) => void | Promise<void>;
    beforeExit?: () => void;
    finishTrial?: () => Promise<void>;
  },
) {
  let mode: 'preparation' | 'live' | 'hidden' = 'preparation';
  let revision = randomUUID();
  let busy = false;
  let shuttingDown = false;
  let updatePending = false;
  let trialPending = false;
  let preparationGeneration = 0;
  let sessionGeneration = 0;
  let lastEnteredId: string | null = null;
  let releaseHandoffState: 'idle' | 'pending' | 'recorded' | 'confirmed' | 'unconfirmed' = 'idle';
  let releaseGeneration = 0;
  let handoffStarted = false;
  let handoffPromise: Promise<void> | undefined;
  let obsExitState: 'idle' | 'pending' | 'confirmed' | 'unconfirmed' = 'idle';
  let obsExitGeneration = 0;
  function startHandoff(): Promise<void> {
    if (!options.handoffRelease) return Promise.resolve();
    if (handoffPromise) return handoffPromise;
    if (handoffStarted) return Promise.resolve();
    handoffStarted = true;
    releaseHandoffState = 'pending';
    const generation = ++releaseGeneration;
    try {
      const pending = options.handoffRelease();
      handoffPromise = pending.then(
        () => {
          if (generation === releaseGeneration) releaseHandoffState = 'recorded';
        },
        (error: unknown) => {
          if (generation === releaseGeneration) {
            releaseHandoffState = 'unconfirmed';
            handoffStarted = false;
            handoffPromise = undefined;
          }
          app.log.warn({ stage: 'production_release', err: error }, 'Source handoff unconfirmed');
          throw error;
        },
      );
      return handoffPromise;
    } catch (error) {
      handoffStarted = false;
      releaseHandoffState = 'unconfirmed';
      app.log.warn({ stage: 'production_release', err: error }, 'Source handoff unconfirmed');
      return Promise.reject(error);
    }
  }
  function scheduleObsExit(controlValid: () => boolean, sceneRequired: boolean) {
    const generation = ++obsExitGeneration;
    const valid = () => generation === obsExitGeneration && controlValid();
    obsExitState = sceneRequired ? 'pending' : 'idle';
    void (async () => {
      await options.beforeFinish?.();
      if (!valid()) throw new Error('OBS 播出状态已变化。');
      if (sceneRequired) {
        const result = await options.scenes.selectWaitingForExit(
          options.scenes.get().revision,
          valid,
        );
        if (!result.ok) throw new Error(result.message);
      }
      if (!valid()) throw new Error('OBS 播出状态已变化。');
      await options.afterSafeScene?.(valid);
    })().then(
      () => {
        if (valid()) obsExitState = sceneRequired ? 'confirmed' : 'idle';
      },
      (error: unknown) => {
        if (generation === obsExitGeneration) obsExitState = 'unconfirmed';
        app.log.warn({ stage: 'production_safe_scene', err: error }, 'OBS exit state unconfirmed');
      },
    );
  }
  const view = () => ({
    mode,
    revision,
    releaseHandoffState,
    obsExitState,
    canEnter: !trialPending && !shuttingDown && !updatePending && options.hasContext(),
  });
  app.get('/local/v1/production', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(view()),
  );
  async function change(
    body: { action?: unknown; expectedRevision?: unknown; preparationId?: unknown } | null,
  ) {
    const entryId = typeof body?.preparationId === 'string' ? body.preparationId : null;
    if (entryId && preparationCancelled(entryId))
      return { code: 409, value: { message: '准备已取消。' } };
    if (body?.action === 'enter') {
      try {
        await options.waitForBroadcast?.();
      } catch (error) {
        app.log.error({ stage: 'broadcast_owner_sync', err: error }, '播出配置同步失败');
        return { code: 409, value: { message: '播出配置同步失败，请重试使用方案。' } };
      }
    }
    if (entryId && preparationCancelled(entryId))
      return { code: 409, value: { message: '准备已取消。' } };
    if (
      body?.expectedRevision === revision &&
      ['finish', 'shutdown', 'begin-exit'].includes(String(body.action))
    ) {
      preparationGeneration++;
      sessionGeneration++;
      options.scenes.holdAutomatic();
      options.beforeExit?.();
    }
    if (body?.expectedRevision === revision && body.action === 'begin-exit') {
      shuttingDown = true;
      try {
        await startHandoff();
        return { code: 200, value: view() };
      } catch {
        return { code: 503, value: { ...view(), message: '数据源本地交接未确认。' } };
      }
    }
    if (body?.expectedRevision === revision && body.action === 'cancel-exit') {
      shuttingDown = false;
      return { code: 200, value: view() };
    }
    if (
      busy ||
      (trialPending && !['finish', 'shutdown'].includes(String(body?.action))) ||
      (updatePending && body?.action !== 'shutdown') ||
      (shuttingDown && !['shutdown', 'finish'].includes(String(body?.action))) ||
      body?.expectedRevision !== revision
    )
      return { code: 409, value: { message: '制作状态已变化，请刷新后重试。' } };
    if (!['enter', 'hide', 'finish', 'shutdown'].includes(String(body?.action)))
      return { code: 400, value: { message: '制作操作无法识别。' } };
    busy = true;
    const shutdown = body?.action === 'shutdown';
    if (shutdown) shuttingDown = true;
    let committed = false;
    const entering = body?.action === 'enter' && mode === 'preparation';
    let stage = 'production_context';
    const operationId = randomUUID();
    const controlValid = options.scenes.controlValid();
    try {
      if (body?.action === 'enter') {
        if (!options.hasContext()) return { code: 409, value: { message: '请先选择或创建比赛。' } };
        options.beforeEnter?.();
        obsExitGeneration++;
        if (mode === 'preparation') {
          handoffStarted = false;
          handoffPromise = undefined;
          releaseGeneration++;
          options.onEnter?.();
        }
        mode = 'live';
        if (entering) lastEnteredId = entryId;
      } else if (body?.action === 'hide') {
        if (mode === 'live') mode = 'hidden';
      } else {
        if (!shutdown) void startHandoff().catch(() => {});
        if (!shutdown && !trialPending && options.handoffRelease) {
          scheduleObsExit(controlValid, mode !== 'preparation');
          mode = 'preparation';
          options.onFinish?.();
        } else {
          // Local cleanup must continue if an OBS operation cannot be confirmed.
          // Shutdown keeps its synchronous contract because the service is about to stop.
          let safeScene = true;
          const sceneRequired = mode !== 'preparation';
          try {
            await options.beforeFinish?.();
            if (!controlValid()) throw new Error('OBS 播出状态已变化。');
            if (trialPending) {
              stage = 'production_safe_scene';
              await options.finishTrial?.();
            }
            if (mode !== 'preparation') {
              stage = 'production_safe_scene';
              const result = await options.scenes.selectWaitingForExit(
                options.scenes.get().revision,
                controlValid,
              );
              if (!result.ok) throw new Error(result.message);
            }
          } catch (error) {
            if (shutdown || trialPending) throw error;
            safeScene = false;
            app.log.warn({ stage, err: error }, 'OBS exit state unconfirmed');
          }
          obsExitState = safeScene ? (sceneRequired ? 'confirmed' : 'idle') : 'unconfirmed';
          if (safeScene) {
            stage = 'production_video_restore';
            try {
              await options.afterSafeScene?.();
            } catch (error) {
              app.log.warn(
                {
                  event: 'production',
                  stage,
                  diagnostic: { operationId, error: diagnosticValue(error) },
                },
                'OBS video restoration deferred',
              );
            }
          }
          stage = 'production_release';
          if (shutdown) {
            if (!controlValid())
              return { code: 409, value: { message: 'OBS 播出状态已变化，请核对后重试。' } };
            await options.release();
            if (!controlValid())
              return { code: 409, value: { message: 'OBS 播出状态已变化，请核对后重试。' } };
            releaseHandoffState = 'confirmed';
          } else if (!options.handoffRelease) {
            await options.release();
            releaseHandoffState = 'confirmed';
          }
          mode = 'preparation';
          options.onFinish?.();
        }
      }
      committed = true;
      revision = randomUUID();
      if (entering) {
        sessionGeneration++;
        options.onEntered?.();
      }
      return { code: 200, value: view() };
    } catch (error) {
      app.log.error(
        {
          event: 'production',
          stage,
          result: 'failure',
          action: body?.action,
          diagnostic: { operationId, error: diagnosticValue(error) },
        },
        'Production operation failed',
      );
      const message =
        error instanceof Error && error.message === 'camera_settings_saving'
          ? '运镜设置正在保存，请稍后重试。'
          : stage === 'production_release'
            ? error instanceof Error && /数据源释放待重试|可靠事件仍待确认/.test(error.message)
              ? '等待画面已保留，数据源释放尚未确认，记录待重试或核对；制作状态仍保留。'
              : '等待画面已保留，但数据源释放失败，制作状态仍保留。请查看诊断，处理记录的问题后再结束制作。'
            : stage === 'production_safe_scene'
              ? '切换等待画面失败，制作尚未结束。请查看诊断，处理记录的问题后再结束制作。'
              : '比赛状态读取失败，当前状态和具体原因未确认。请复制诊断信息后排查。';
      return { code: 409, value: { message } };
    } finally {
      if (shutdown && !committed) shuttingDown = false;
      busy = false;
    }
  }
  app.post('/operator/preparation-cancel', { bodyLimit: 1024 }, async (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const id = (request.body as { preparationId?: unknown } | null)?.preparationId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id))
      return reply.code(400).send({ message: '启动事务标识无效。' });
    cancelPreparation(id);
    return reply.send({ entered: lastEnteredId === id && mode !== 'preparation' });
  });
  app.post('/operator/production', { bodyLimit: 1024 }, async (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const result = await change(
      request.body as {
        action?: unknown;
        expectedRevision?: unknown;
        preparationId?: unknown;
      } | null,
    );
    return reply.code(result.code).send(result.value);
  });
  return {
    get: view,
    sessionValid: () => {
      const generation = sessionGeneration;
      return () => generation === sessionGeneration && mode !== 'preparation' && !shuttingDown;
    },
    canControl: () => !busy && !shuttingDown,
    automaticAllowed: () => mode !== 'preparation' && !busy && !shuttingDown,
    preparationValid: (expectedRevision: unknown) => {
      const generation = preparationGeneration;
      return () =>
        expectedRevision === revision &&
        generation === preparationGeneration &&
        !busy &&
        !shuttingDown &&
        !updatePending &&
        !trialPending;
    },
    configureCameraSession: (expectedRevision: string, commit: () => void) => {
      if (
        expectedRevision !== revision ||
        busy ||
        shuttingDown ||
        updatePending ||
        trialPending ||
        options.scenes.get().preparing !== undefined
      )
        throw new Error('camera_production_changed');
      // Synchronous commit shares this lifecycle owner; no separate preparation authority.
      commit();
    },
    configureBroadcast: async <T>(commit: (canCommit: () => boolean) => Promise<T>): Promise<T> => {
      if (shuttingDown || updatePending) throw new Error('production_busy');
      const generation = sessionGeneration;
      return commit(() => generation === sessionGeneration && !shuttingDown && !updatePending);
    },
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
