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

import type { ObsAdapter } from '../obs/adapter.js';
import type { CameraDirector } from '../orchestration/director.js';
import type { ObserverSettingsStore } from '../telemetry/observer-settings.js';
import type { DemoTestController } from '../demo-test/controller.js';
import type { MatchContextBinding } from '../match-context/index.js';
import { statsTarget, type RivalHubConnection } from '../match-context/rivalhub-connection.js';

export type ProductionDependencies = {
  scenes: Pick<
    ProgramSceneController,
    | 'holdAutomatic'
    | 'selectWaitingForExit'
    | 'controlValid'
    | 'get'
    | 'setResourceActivationPending'
  >;
  obs?:
    | Pick<
        ObsAdapter,
        | 'settleAutomatic'
        | 'restoreVideo'
        | 'pauseAutomatic'
        | 'resumeAutomatic'
        | 'startCommentaryRecovery'
        | 'hasCurrentPreparation'
        | 'startBrowserRecovery'
      >
    | undefined;
  music: () => Parameters<ObsAdapter['startCommentaryRecovery']>[0];
  gameAudio?: Parameters<ObsAdapter['startCommentaryRecovery']>[1];
  camera: () => Pick<CameraDirector, 'beginProduction' | 'finishProduction'> | undefined;
  demo: () => Pick<DemoTestController, 'openFormalBoundary' | 'finish'> | undefined;
  observer: Pick<ObserverSettingsStore, 'endProduction'>;
  source?:
    | (Pick<RivalHubConnection, 'handoffForExit' | 'release' | 'clearStats'> & {
        stats: (
          target: Parameters<RivalHubConnection['stats']>[0],
        ) => ReturnType<RivalHubConnection['stats']> | undefined;
      })
    | undefined;
  binding: () => MatchContextBinding | undefined;
  waitForBroadcast: () => Promise<void>;
  obsExit: {
    previousUnconfirmed: boolean;
    record: (
      state: 'pending' | 'confirmed' | 'unconfirmed',
      valid?: () => boolean,
    ) => Promise<void>;
    wait: () => Promise<void>;
  };
  warn: (details: object, message: string) => void;
  error: (details: object, message: string) => void;
};

type ProductionAction =
  'enter' | 'hide' | 'finish' | 'shutdown' | 'begin-exit' | 'cancel-exit' | 'invalid';
type ProductionCommand = {
  action: ProductionAction;
  expectedRevision: string | null;
  preparationId: string | null;
};

/** Owns presentation lifecycle, exclusion and exit recovery. */
export function createProduction(options: ProductionDependencies) {
  let statsActive = false;
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
  let obsExitState: 'idle' | 'pending' | 'confirmed' | 'unconfirmed' = options.obsExit
    .previousUnconfirmed
    ? 'unconfirmed'
    : 'idle';
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
    if (!options.source?.handoffForExit) return Promise.resolve();
    if (handoffPromise) return handoffPromise;
    if (handoffStarted) return Promise.resolve();
    handoffStarted = true;
    releaseHandoffState = 'pending';
    const generation = ++releaseGeneration;
    try {
      const pending = options.source?.handoffForExit();
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
          options.warn({ stage: 'production_release', err: error }, 'Source handoff unconfirmed');
          throw error;
        },
      );
      return handoffPromise;
    } catch (error) {
      handoffStarted = false;
      releaseHandoffState = 'unconfirmed';
      options.warn({ stage: 'production_release', err: error }, 'Source handoff unconfirmed');
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
      await options.obs?.settleAutomatic();
      if (!valid()) throw new Error('OBS 播出状态已变化。');
      if (sceneRequired) {
        const result = await options.scenes.selectWaitingForExit(
          options.scenes.get().revision,
          valid,
        );
        if (!result.ok) throw new Error(result.message);
      }
      if (!valid()) throw new Error('OBS 播出状态已变化。');
      await options.obs?.restoreVideo(undefined, valid);
      if (!valid()) throw new Error('OBS 播出状态已变化。');
    })()
      .then(
        async () => {
          if (valid()) {
            try {
              if (sceneRequired) await options.obsExit.record('confirmed', valid);
              if (valid()) {
                current.completed = true;
                if (sceneRequired) obsExitState = 'confirmed';
              }
            } catch (error) {
              if (valid()) obsExitState = 'unconfirmed';
              options.warn({ err: error }, 'OBS exit status not saved');
            }
          }
        },
        async (error: unknown) => {
          if (generation === obsExitGeneration) {
            obsExitState = 'unconfirmed';
            if (sceneRequired)
              await options.obsExit
                .record('unconfirmed', () => generation === obsExitGeneration)
                .catch((error: unknown) =>
                  options.warn({ err: error }, 'OBS exit status not saved'),
                );
          }
          options.warn(
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
    if (!task || task.valid() || !task.sceneRequired || obsExitState === 'unconfirmed') return;
    obsExitState = 'unconfirmed';
    const pending = Promise.resolve(
      options.obsExit.record('unconfirmed', () => task.generation === obsExitGeneration),
    ).catch((error: unknown) => options.warn({ err: error }, 'OBS exit status not saved'));
    obsExitStatusWrite = pending;
  }
  const view = () => {
    invalidateObsExit();
    const current = {
      mode,
      revision,
      sessionId,
      releaseHandoffState,
      obsExitState,
      canEnter: !trialPending && !shuttingDown && !updatePending,
    };
    productionViewSchema.parse(current);
    return current;
  };
  async function change(body: ProductionCommand) {
    const obsOnlyRetry =
      body?.action === 'finish' && mode === 'preparation' && obsExitState === 'unconfirmed';
    const entryId = body.preparationId;
    if (entryId && preparationCancelled(entryId))
      return {
        ok: false as const,
        failure: 'preparationCancelled' as const,
        message: '准备已取消。',
      };
    // A lost response must not turn an already committed entry into a new entry.
    if (body?.action === 'enter' && entryId && lastEnteredId === entryId && mode !== 'preparation')
      return { ok: true as const, value: view() };
    if (body?.action === 'enter') {
      try {
        await options.waitForBroadcast?.();
      } catch (error) {
        options.error({ stage: 'broadcast_owner_sync', err: error }, '播出配置同步失败');
        return {
          ok: false as const,
          failure: 'broadcastSyncFailure' as const,
          message: '播出配置同步失败，请重试使用方案。',
        };
      }
    }
    if (entryId && preparationCancelled(entryId))
      return {
        ok: false as const,
        failure: 'preparationCancelled' as const,
        message: '准备已取消。',
      };
    if (
      body?.expectedRevision === revision &&
      !exitFrozen &&
      !obsOnlyRetry &&
      ['finish', 'shutdown', 'begin-exit'].includes(String(body.action))
    ) {
      exitFrozen = true;
      preparationGeneration++;
      sessionGeneration++;
      options.scenes.holdAutomatic();
      options.obs?.pauseAutomatic();
      options.camera()?.finishProduction();
      options.observer.endProduction();
    }
    if (body?.expectedRevision === revision && body.action === 'begin-exit') {
      shuttingDown = true;
      try {
        await startHandoff();
        return { ok: true as const, value: view() };
      } catch {
        return {
          ok: false as const,
          failure: 'handoffUnconfirmed' as const,
          state: view(),
          message: '数据源本地交接未确认。',
        };
      }
    }
    if (body?.expectedRevision === revision && body.action === 'cancel-exit') {
      shuttingDown = false;
      return { ok: true as const, value: view() };
    }
    if (
      busy ||
      (trialPending && !['finish', 'shutdown'].includes(String(body?.action))) ||
      (updatePending && body?.action !== 'shutdown') ||
      (shuttingDown && !['shutdown', 'finish'].includes(String(body?.action))) ||
      body?.expectedRevision !== revision
    )
      return {
        ok: false as const,
        failure: 'productionConflict' as const,
        message: '制作状态已变化，请刷新后重试。',
      };
    if (!['enter', 'hide', 'finish', 'shutdown'].includes(String(body?.action)))
      return {
        ok: false as const,
        failure: 'productionActionInvalid' as const,
        message: '制作操作无法识别。',
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
        options.demo()?.openFormalBoundary();
        options.scenes.holdAutomatic();
        obsExitGeneration++;
        obsExitTask = undefined;
        exitFrozen = false;
        if (mode === 'preparation') {
          sessionId = randomUUID();
          handoffStarted = false;
          handoffPromise = undefined;
          releaseGeneration++;
          options.obs?.resumeAutomatic();
          options.obs?.startCommentaryRecovery(
            options.music(),
            options.gameAudio,
            () => production.automaticAllowed() && (options.obs?.hasCurrentPreparation() ?? false),
          );
          options.camera()?.beginProduction();
          statsActive = true;
          const binding = options.binding();
          if (
            binding?.origin === 'online' ||
            (binding?.origin === 'cache' && binding.cachedFrom === 'online')
          )
            void options.source?.stats(statsTarget(binding.context));
        }
        mode = 'live';
        if (entering) lastEnteredId = entryId;
      } else if (body?.action === 'hide') {
        if (mode === 'live') mode = 'hidden';
      } else {
        if (shutdown && options.source?.handoffForExit) {
          stage = 'production_release';
          await startHandoff();
        } else if (!shutdown && !obsOnlyRetry) void startHandoff().catch(() => {});
        if (!trialPending && options.source?.handoffForExit) {
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
                  options.obsExit.record('pending', () => sessionId === pendingSession),
                  new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('OBS exit status timeout')), 2000);
                  }),
                ]);
              } finally {
                if (timer) clearTimeout(timer);
              }
            } catch (error) {
              options.warn({ err: error }, 'OBS exit status not saved');
            }
          }
          scheduleObsExit(controlValid, sceneRequired);
          mode = 'preparation';
          if (!obsOnlyRetry) {
            statsActive = false;
            options.source?.clearStats();
          }
        } else {
          // Local cleanup must continue if an OBS operation cannot be confirmed.
          // Shutdown keeps its synchronous contract because the service is about to stop.
          let safeScene = true;
          const sceneRequired = mode !== 'preparation';
          try {
            await options.obs?.settleAutomatic();
            if (!controlValid()) throw new Error('OBS 播出状态已变化。');
            if (trialPending) {
              stage = 'production_safe_scene';
              await options.demo()?.finish();
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
            options.warn({ stage, err: error }, 'OBS exit state unconfirmed');
          }
          obsExitState = safeScene ? (sceneRequired ? 'confirmed' : 'idle') : 'unconfirmed';
          if (safeScene) {
            stage = 'production_video_restore';
            try {
              await options.obs?.restoreVideo();
            } catch (error) {
              options.warn(
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
                ok: false as const,
                failure: 'obsStateChanged' as const,
                message: 'OBS 播出状态已变化，请核对后重试。',
              };
            await options.source?.release();
            if (!controlValid())
              return {
                ok: false as const,
                failure: 'obsStateChanged' as const,
                message: 'OBS 播出状态已变化，请核对后重试。',
              };
            releaseHandoffState = 'confirmed';
          } else if (!options.source?.handoffForExit) {
            await options.source?.release();
            releaseHandoffState = 'confirmed';
          }
          mode = 'preparation';
          statsActive = false;
          options.source?.clearStats();
        }
      }
      committed = true;
      // Hiding the workspace while preparing changes no production state and
      // must not invalidate the preparation owner's in-flight operations.
      if (body?.action !== 'hide' || mode !== 'preparation') revision = randomUUID();
      if (entering) {
        sessionGeneration++;
        options.obs?.startBrowserRecovery(production.sessionValid());
      }
      return { ok: true as const, value: view() };
    } catch (error) {
      options.error(
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
          ? ('cameraSettingsBusy' as const)
          : stage === 'production_release'
            ? ('releaseUnconfirmed' as const)
            : stage === 'production_safe_scene'
              ? ('safeSceneUnconfirmed' as const)
              : ('productionFailure' as const);
      return { ok: false as const, failure, message };
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
      if (!prior.ok) return prior;
      if (sessionId !== originalSession)
        return {
          ok: false as const,
          failure: 'productionConflict' as const,
          message: '制作状态已变化，请刷新后重试。',
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
  const production = {
    get: view,
    statsActive: () => statsActive,
    entered: (id: string) => lastEnteredId === id && mode !== 'preparation',
    cancelPreparation: (id: string) => {
      cancelPreparation(id);
      return { entered: lastEnteredId === id && mode !== 'preparation' };
    },
    change: dispatchChange,
    // Closing the service can join this task without making OBS a condition
    // for the Host's local game cleanup or for accepting the exit command.
    waitForObsExit: async () => {
      invalidateObsExit();
      await obsExitTask?.promise;
      await obsExitStatusWrite;
      await options.obsExit.wait();
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
    shutdown: () =>
      dispatchChange({ action: 'shutdown', expectedRevision: revision, preparationId: null }),
  };
  return production;
}

export function productionHttpResponse(
  result: Awaited<ReturnType<ReturnType<typeof createProduction>['change']>>,
) {
  if (result.ok) return { code: 200, value: result.value };
  const failure = lifecycleErrors[result.failure];
  return {
    code: failure.status,
    value: { ...('state' in result ? result.state : {}), ...failure, message: result.message },
  };
}

export function registerProductionRoutes(
  app: FastifyInstance,
  options: { originPolicy: LocalWebOriginPolicy; production: ReturnType<typeof createProduction> },
) {
  const { production } = options;
  app.get('/local/v1/production', (_request, reply) =>
    reply.header('cache-control', 'no-store').send(production.get()),
  );
  app.get('/local/v1/preparation-status', (request, reply) => {
    const id = (request.query as { preparationId?: unknown }).preparationId;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,64}$/.test(id))
      return reply
        .code(lifecycleErrors.preparationIdInvalid.status)
        .send(lifecycleErrors.preparationIdInvalid);
    return reply.header('cache-control', 'no-store').send(
      cancellationResponseSchema.parse({
        entered: production.entered(id),
      }),
    );
  });
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
    return reply.send(cancellationResponseSchema.parse(production.cancelPreparation(id)));
  });
  app.post('/operator/production', { bodyLimit: 1024 }, async (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply
        .code(lifecycleErrors.operatorForbidden.status)
        .send(lifecycleErrors.operatorForbidden);
    const body = request.body as {
      action?: unknown;
      expectedRevision?: unknown;
      preparationId?: unknown;
    } | null;
    const action = body?.action;
    const validAction =
      action === 'enter' ||
      action === 'hide' ||
      action === 'finish' ||
      action === 'shutdown' ||
      action === 'begin-exit' ||
      action === 'cancel-exit';
    // Keep conflict and cancellation precedence for malformed actions.
    const result = await production.change({
      action: validAction ? action : 'invalid',
      expectedRevision: typeof body?.expectedRevision === 'string' ? body.expectedRevision : null,
      preparationId: typeof body?.preparationId === 'string' ? body.preparationId : null,
    });
    const response = productionHttpResponse(result);
    return reply.code(response.code).send(response.value);
  });
}
