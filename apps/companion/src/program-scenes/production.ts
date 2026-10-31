import {
  cancellationResponseSchema,
  lifecycleErrors,
  productionViewSchema,
} from '../match-context/lifecycle-contract.js';
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
    previousObsExitUnconfirmed?: boolean;
    recordObsExit?:
      | ((state: 'pending' | 'confirmed' | 'unconfirmed', valid?: () => boolean) => Promise<void>)
      | undefined;
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
  let sessionId = randomUUID();
  let lastEnteredId: string | null = null;
  let releaseHandoffState: 'idle' | 'pending' | 'recorded' | 'confirmed' | 'unconfirmed' = 'idle';
  let releaseGeneration = 0;
  let handoffStarted = false;
  let handoffPromise: Promise<void> | undefined;
  let obsExitState: 'idle' | 'pending' | 'confirmed' | 'unconfirmed' =
    options.previousObsExitUnconfirmed ? 'unconfirmed' : 'idle';
  let obsExitGeneration = 0;
  let exitFrozen = false;
  let obsExitStatusWrite: Promise<void> | undefined;
  let obsExitTask:
    | {
        generation: number;
        valid: () => boolean;
        sceneRequired: boolean;
        promise: Promise<void> | undefined;
        completed: boolean;
      }
    | undefined;
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
    let task = obsExitTask;
    if (!task) {
      const generation = ++obsExitGeneration;
      task = {
        generation,
        valid: () => generation === obsExitGeneration && controlValid(),
        sceneRequired,
        promise: undefined,
        completed: false,
      };
      obsExitTask = task;
    }
    if (task.promise || task.completed) return;
    const { generation, valid } = task;
    sceneRequired = task.sceneRequired;
    if (sceneRequired) obsExitState = 'pending';
    const current = task;
    task.promise = (async () => {
      if (!valid()) throw new Error('OBS 播出状态已变化。');
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
      if (!valid()) throw new Error('OBS 播出状态已变化。');
    })()
      .then(
        async () => {
          if (valid()) {
            current.completed = true;
            if (sceneRequired) obsExitState = 'confirmed';
            if (sceneRequired)
              await options.recordObsExit?.('confirmed', valid).catch((error: unknown) => {
                if (valid()) {
                  current.completed = false;
                  obsExitState = 'unconfirmed';
                }
                app.log.warn({ err: error }, 'OBS exit status not saved');
              });
          }
        },
        async (error: unknown) => {
          if (generation === obsExitGeneration) {
            obsExitState = 'unconfirmed';
            if (sceneRequired)
              await options
                .recordObsExit?.('unconfirmed', () => generation === obsExitGeneration)
                .catch((error: unknown) =>
                  app.log.warn({ err: error }, 'OBS exit status not saved'),
                );
          }
          app.log.warn(
            { stage: 'production_safe_scene', err: error },
            'OBS exit state unconfirmed',
          );
        },
      )
      .finally(() => {
        current.promise = undefined;
      });
  }
  function invalidateObsExit() {
    const task = obsExitTask;
    if (!task || task.valid() || !task.sceneRequired) return;
    obsExitState = 'unconfirmed';
    const pending = Promise.resolve(
      options.recordObsExit?.('unconfirmed', () => task.generation === obsExitGeneration),
    ).catch((error: unknown) => app.log.warn({ err: error }, 'OBS exit status not saved'));
    obsExitStatusWrite = pending;
  }
  const view = () => {
    const current = {
      mode,
      revision,
      releaseHandoffState,
      obsExitState,
      canEnter: !trialPending && !shuttingDown && !updatePending && options.hasContext(),
    };
    productionViewSchema.parse(current);
    return current;
  };
  app.get('/local/v1/production', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(view()),
  );
  app.get('/local/v1/preparation-status', (request, reply) => {
    const id = (request.query as { preparationId?: unknown }).preparationId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id))
      return reply
        .code(lifecycleErrors.preparationIdInvalid.status)
        .send(lifecycleErrors.preparationIdInvalid);
    return reply.header('cache-control', 'no-store').send(
      cancellationResponseSchema.parse({
        entered: lastEnteredId === id && mode !== 'preparation',
      }),
    );
  });
  async function change(
    body: { action?: unknown; expectedRevision?: unknown; preparationId?: unknown } | null,
  ) {
    const entryId = typeof body?.preparationId === 'string' ? body.preparationId : null;
    if (entryId && preparationCancelled(entryId))
      return {
        code: lifecycleErrors.preparationCancelled.status,
        value: { ...lifecycleErrors.preparationCancelled, message: '准备已取消。' },
      };
    // A lost response must not turn an already committed entry into a new entry.
    if (body?.action === 'enter' && entryId && lastEnteredId === entryId && mode !== 'preparation')
      return { code: 200, value: view() };
    if (body?.action === 'enter') {
      try {
        await options.waitForBroadcast?.();
      } catch (error) {
        app.log.error({ stage: 'broadcast_owner_sync', err: error }, '播出配置同步失败');
        return {
          code: lifecycleErrors.broadcastSyncFailure.status,
          value: {
            ...lifecycleErrors.broadcastSyncFailure,
            message: '播出配置同步失败，请重试使用方案。',
          },
        };
      }
    }
    if (entryId && preparationCancelled(entryId))
      return {
        code: lifecycleErrors.preparationCancelled.status,
        value: { ...lifecycleErrors.preparationCancelled, message: '准备已取消。' },
      };
    if (
      body?.expectedRevision === revision &&
      !exitFrozen &&
      ['finish', 'shutdown', 'begin-exit'].includes(String(body.action))
    ) {
      exitFrozen = true;
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
        return {
          code: lifecycleErrors.handoffUnconfirmed.status,
          value: {
            ...view(),
            ...lifecycleErrors.handoffUnconfirmed,
            message: '数据源本地交接未确认。',
          },
        };
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
      return {
        code: lifecycleErrors.productionConflict.status,
        value: { ...lifecycleErrors.productionConflict, message: '制作状态已变化，请刷新后重试。' },
      };
    if (!['enter', 'hide', 'finish', 'shutdown'].includes(String(body?.action)))
      return {
        code: lifecycleErrors.productionActionInvalid.status,
        value: { ...lifecycleErrors.productionActionInvalid, message: '制作操作无法识别。' },
      };
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
        if (!options.hasContext())
          return {
            code: lifecycleErrors.contextMissing.status,
            value: { ...lifecycleErrors.contextMissing, message: '请先选择或创建比赛。' },
          };
        options.beforeEnter?.();
        obsExitGeneration++;
        obsExitTask = undefined;
        exitFrozen = false;
        if (mode === 'preparation') {
          sessionId = randomUUID();
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
        if (shutdown && options.handoffRelease) {
          stage = 'production_release';
          await startHandoff();
        } else if (!shutdown) void startHandoff().catch(() => {});
        if (!trialPending && options.handoffRelease) {
          if (obsExitTask && !obsExitTask.valid()) {
            if (body?.action === 'finish') {
              const required = obsExitTask.sceneRequired;
              obsExitGeneration++;
              obsExitTask = undefined;
              if (required) obsExitState = 'unconfirmed';
            } else if (obsExitTask.sceneRequired) {
              invalidateObsExit();
            }
          }
          if (
            body?.action === 'finish' &&
            obsExitState === 'unconfirmed' &&
            obsExitTask?.completed &&
            !obsExitTask.sceneRequired
          ) {
            obsExitTask = undefined;
          }
          const sceneRequired =
            obsExitTask?.sceneRequired ??
            (mode !== 'preparation' ||
              (body?.action === 'finish' && obsExitState === 'unconfirmed'));
          if (sceneRequired && !obsExitTask?.promise && !obsExitTask?.completed) {
            const pendingSession = sessionId;
            try {
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  options.recordObsExit?.('pending', () => sessionId === pendingSession),
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('OBS exit status timeout')), 2000);
                  }),
                ]);
              } finally {
                if (timer) clearTimeout(timer);
              }
            } catch (error) {
              app.log.warn({ err: error }, 'OBS exit status not saved');
            }
          }
          scheduleObsExit(controlValid, sceneRequired);
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
              return {
                code: lifecycleErrors.obsStateChanged.status,
                value: {
                  ...lifecycleErrors.obsStateChanged,
                  message: 'OBS 播出状态已变化，请核对后重试。',
                },
              };
            await options.release();
            if (!controlValid())
              return {
                code: lifecycleErrors.obsStateChanged.status,
                value: {
                  ...lifecycleErrors.obsStateChanged,
                  message: 'OBS 播出状态已变化，请核对后重试。',
                },
              };
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
      // Hiding the workspace while preparing changes no production state and
      // must not invalidate the preparation owner's in-flight operations.
      if (body?.action !== 'hide' || mode !== 'preparation') revision = randomUUID();
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
      const failure =
        error instanceof Error && error.message === 'camera_settings_saving'
          ? lifecycleErrors.cameraSettingsBusy
          : stage === 'production_release'
            ? lifecycleErrors.releaseUnconfirmed
            : stage === 'production_safe_scene'
              ? lifecycleErrors.safeSceneUnconfirmed
              : lifecycleErrors.productionFailure;
      return { code: failure.status, value: { ...failure, message } };
    } finally {
      if (shutdown && !committed) shuttingDown = false;
      busy = false;
    }
  }
  let activeExitChange: Promise<Awaited<ReturnType<typeof change>>> | undefined;
  async function dispatchChange(body: Parameters<typeof change>[0]) {
    const isExit = body?.action === 'finish' || body?.action === 'shutdown';
    if (!isExit) return change(body);
    if (activeExitChange) {
      if (body?.expectedRevision !== revision) return change(body);
      const originalSession = sessionId;
      const prior = await activeExitChange;
      if (prior.code !== 200) return prior;
      if (sessionId !== originalSession)
        return {
          code: lifecycleErrors.productionConflict.status,
          value: {
            ...lifecycleErrors.productionConflict,
            message: '制作状态已变化，请刷新后重试。',
          },
        };
      return dispatchChange({ ...body, expectedRevision: revision });
    }
    const pending = change(body);
    activeExitChange = pending;
    try {
      return await pending;
    } finally {
      if (activeExitChange === pending) activeExitChange = undefined;
    }
  }
  app.post('/operator/preparation-cancel', { bodyLimit: 1024 }, async (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply
        .code(lifecycleErrors.operatorForbidden.status)
        .send(lifecycleErrors.operatorForbidden);
    const id = (request.body as { preparationId?: unknown } | null)?.preparationId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id))
      return reply
        .code(lifecycleErrors.preparationIdInvalid.status)
        .send({ ...lifecycleErrors.preparationIdInvalid, message: '启动事务标识无效。' });
    cancelPreparation(id);
    return reply.send(
      cancellationResponseSchema.parse({ entered: lastEnteredId === id && mode !== 'preparation' }),
    );
  });
  app.post('/operator/production', { bodyLimit: 1024 }, async (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply
        .code(lifecycleErrors.operatorForbidden.status)
        .send(lifecycleErrors.operatorForbidden);
    const result = await dispatchChange(
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
    // Closing the service can join this task without making OBS a condition
    // for the Host's local game cleanup or for accepting the exit command.
    waitForObsExit: async () => {
      await obsExitTask?.promise;
      await obsExitStatusWrite;
      return obsExitState;
    },
    invalidateObsExit,
    sessionId: () => sessionId,
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
      obsExitGeneration++;
      obsExitTask = undefined;
      exitFrozen = false;
      sessionId = randomUUID();
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
    shutdown: () => dispatchChange({ action: 'shutdown', expectedRevision: revision }),
  };
}
