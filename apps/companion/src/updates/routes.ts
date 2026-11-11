import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { ObsStatus } from '../obs/adapter.js';
import { isObsProcessRunning } from '../obs/config.js';
import { diagnosticValue } from '../support/session-journal.js';
import type { ProgramSceneController } from '../program-scenes/controller.js';
import type { createProduction } from '../program-scenes/production.js';
import { UpdateManager, safeCode, updateFailure } from './manager.js';
import type { MulnxTool } from '../orchestration/tool.js';

export function installBlockReason(
  production: { mode: string },
  scenes: ReturnType<ProgramSceneController['get']>,
  obs: ObsStatus | undefined,
  obsProcessAbsent?: boolean,
): string | null {
  if (production.mode !== 'preparation') return '结束制作后可更新。';
  if (scenes.preparing || scenes.active !== 'waiting' || scenes.director?.mode === 'manual')
    return '结束节目制作后可更新。';
  return outputBlockReason(obs, obsProcessAbsent);
}

function outputBlockReason(obs: ObsStatus | undefined, obsProcessAbsent?: boolean): string | null {
  if (obs?.streaming || obs?.recording) return '停止 OBS 推流或录制后可更新。';
  if (
    obs?.connection === 'connected' &&
    (obs.streaming !== false ||
      obs.recording !== false ||
      obs.streamPhase !== 'idle' ||
      obs.recordPhase !== 'idle' ||
      obs.outputPending !== false)
  )
    return 'OBS 推流或录制状态尚未确认或正在变化，请在 OBS 核对后重试。';
  if ((!obs || obs.connection !== 'connected') && !obsProcessAbsent)
    return obsProcessAbsent === false
      ? 'OBS 正在运行但未连接，请关闭 OBS，或连接后核对推流与录制再更新。'
      : 'OBS 进程状态检测未完成，升级尚未启动。请查看诊断、核对 OBS 已关闭后重试；再次失败时从正式发布页下载。';
  return null;
}
export function registerUpdateRoutes(
  app: FastifyInstance,
  options: {
    manager: UpdateManager;
    originPolicy: LocalWebOriginPolicy;
    controlToken: string;
    production: ReturnType<typeof createProduction>;
    scenes: ProgramSceneController;
    obs: () => Promise<ObsStatus | undefined>;
    obsEpoch?: () => number | undefined;
    obsProcessRunning?: () => Promise<boolean>;
    mulnx?: () => MulnxTool | undefined;
  },
) {
  const { manager, production, scenes } = options;
  let updateOwner: string | undefined;
  let updatePreparing = false;
  let updateReserved = false;
  let updateObservation: number | undefined;
  let updateRevision: string | undefined;
  const releaseOwner = (owner: string) => {
    if (updateOwner !== owner) return;
    updateOwner = undefined;
    updateObservation = undefined;
    updateRevision = undefined;
    manager.release();
    if (updateReserved) {
      updateReserved = false;
      production.releaseUpdate();
      scenes.setUpdatePending(false);
    }
  };
  const assess = async (exiting = false) => {
    const obs = await options.obs().catch(() => undefined);
    const reason = exiting
      ? outputBlockReason(obs)
      : installBlockReason(production.get(), scenes.get(), obs);
    if (
      !reason ||
      (!exiting &&
        (production.get().mode !== 'preparation' ||
          scenes.get().preparing ||
          scenes.get().active !== 'waiting' ||
          scenes.get().director?.mode === 'manual')) ||
      obs?.connection === 'connected' ||
      obs?.streaming ||
      obs?.recording
    )
      return reason;
    try {
      const running = await (options.obsProcessRunning ?? isObsProcessRunning)();
      // Read production/scene state again after the asynchronous process probe.
      return exiting
        ? outputBlockReason(obs, !running)
        : installBlockReason(production.get(), scenes.get(), obs, !running);
    } catch (error) {
      app.log.warn(
        {
          event: 'update',
          stage: 'install_plan',
          code: 'update_obs_process_probe_failed',
          result: 'failure',
          diagnostic: { error: diagnosticValue(error) },
        },
        'OBS process state could not be confirmed',
      );
      return exiting
        ? outputBlockReason(obs)
        : installBlockReason(production.get(), scenes.get(), obs);
    }
  };
  const publicView = async () => {
    const status = manager.status();
    const tool = options.mulnx?.()?.view();
    const reminderPhase = ['available', 'manual', 'ready'].includes(status.phase);
    const mulnxPending = Boolean(
      tool?.notificationIdentity && tool.notificationIdentity !== tool.notifiedIdentity,
    );
    const blocked =
      status.phase === 'ready' || reminderPhase || mulnxPending ? await assess() : null;
    const installBlockedReason = status.phase === 'ready' ? blocked : null;
    const scene = scenes.get();
    return {
      ...status,
      mulnx: tool ?? null,
      mulnxNotificationPending: mulnxPending,
      productionRevision: production.get().revision,
      installBlockedReason,
      notificationSafe: status.automatic && (reminderPhase || mulnxPending) && blocked === null,
      canResumeAutomatic:
        production.get().mode === 'preparation' &&
        scene.active === 'waiting' &&
        !scene.preparing &&
        scene.director?.mode === 'manual',
    };
  };
  app.get('/local/v1/updates', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send(await publicView()),
  );
  app.post('/operator/updates', { bodyLimit: 1024 }, async (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = request.body as {
      action?: unknown;
      enabled?: unknown;
      version?: unknown;
      identity?: unknown;
    } | null;
    try {
      if (body?.action === 'check' || body?.action === 'entry-check') {
        if (body.action === 'check' || manager.status().automatic)
          await Promise.allSettled([
            manager.check(),
            options.mulnx?.()?.check() ?? Promise.resolve(),
          ]);
      } else if (body?.action === 'download') await manager.download();
      else if (body?.action === 'cancel') await manager.cancel();
      else if (body?.action === 'automatic' && typeof body.enabled === 'boolean')
        await manager.setAutomatic(body.enabled);
      else if (body?.action === 'notify' && typeof body.version === 'string') {
        const notification = (await assess()) === null ? manager.notification(body.version) : null;
        return { ...(await publicView()), notification };
      } else if (body?.action === 'dismiss-notification' && typeof body.version === 'string') {
        manager.dismissNotification(body.version);
      } else if (
        body?.action === 'dismiss-mulnx-notification' &&
        typeof body.identity === 'string'
      ) {
        options.mulnx?.()?.dismissNotification(body.identity);
      } else if (body?.action === 'resume') {
        const scene = scenes.get();
        if (
          production.get().mode !== 'preparation' ||
          scene.active !== 'waiting' ||
          scene.preparing ||
          !scenes.resumeAutomatic(scene.revision)
        )
          throw new Error('update_production_busy');
      } else return reply.code(400).send({ error: 'update_action_invalid' });
      return await publicView();
    } catch (e) {
      manager.failure('operator_action', e);
      return reply
        .code(409)
        .send({ error: safeCode(e), failureDetails: manager.status().failureDetails });
    }
  });
  // Only the Host holds the per-launch capability. Renderer-supplied paths,
  // download URLs and executable arguments never cross this boundary.
  app.post('/operator/updates/install-plan', { bodyLimit: 1024 }, async (request, reply) => {
    const expected = Buffer.from(options.controlToken),
      token = request.headers['x-runtime-token'];
    const supplied = Buffer.from(typeof token === 'string' ? token : '');
    if (
      request.headers.origin !== undefined ||
      !expected.length ||
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      return reply.code(403).send({ error: 'update_host_required' });
    const body = request.body as {
      action?: unknown;
      sessionId?: unknown;
      attemptId?: unknown;
    } | null;
    const action = body?.action;
    if (action === 'startup') {
      if (
        typeof body?.sessionId !== 'string' ||
        !/^(?:[a-f0-9]{32}-[a-f0-9]{8}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(
          body.sessionId,
        )
      )
        return reply.code(400).send({ error: 'update_action_invalid' });
      manager.desktopStartup(body.sessionId);
      return { accepted: true };
    }
    if (action === 'recover') return { attemptId: updateOwner ?? null };
    if (!['prepare', 'commit', 'recheck', 'release'].includes(String(action)))
      return reply.code(400).send({ error: 'update_action_invalid' });
    const owner = body?.attemptId;
    if (typeof owner !== 'string' || !/^[a-f0-9-]{32,96}$/.test(owner))
      return reply.code(400).send({ error: 'update_action_invalid' });
    const release = () => releaseOwner(owner);
    if (action === 'prepare') {
      if (updateOwner || updatePreparing)
        return reply.code(409).send({ message: '更新已经在准备，请稍候。' });
      updateOwner = owner;
      updateRevision = production.get().revision;
      updatePreparing = true;
    } else if (action === 'release' && updateOwner === undefined) {
      // An earlier response can be lost after release has already committed.
      return { released: true };
    } else if (updateOwner !== owner) {
      return reply.code(409).send({ message: '更新准备状态已变化，请重新尝试。' });
    }
    if (action === 'release') {
      release();
      return { released: true };
    }
    let blockedReason: string | null = null;
    const current = () => updateOwner === owner && !request.raw.aborted && !reply.raw.destroyed;
    try {
      if (action === 'prepare') {
        // Authentication and Host staging do not reserve production or OBS output.
        blockedReason = await assess();
        if (blockedReason) throw new Error(blockedReason);
        updateObservation = options.obsEpoch?.();
        if (!current() || production.get().revision !== updateRevision)
          throw new Error('制作状态已变化，本次更新已取消，请重新尝试。');
        const plan = await manager.prepare();
        if (
          !current() ||
          production.get().revision !== updateRevision ||
          options.obsEpoch?.() !== updateObservation
        )
          throw new Error('制作或 OBS 状态已变化，本次更新已取消，请重新尝试。');
        return plan;
      }
      if (manager.status().phase !== 'installing')
        throw new Error('更新准备状态已变化，请重新尝试。');
      if (action === 'commit') {
        if (
          updateReserved ||
          production.get().revision !== updateRevision ||
          options.obsEpoch?.() !== updateObservation ||
          !production.reserveUpdate()
        ) {
          blockedReason = '制作状态已变化，请结束制作后重试。';
          throw new Error(blockedReason);
        }
        updateReserved = true;
        scenes.setUpdatePending(true);
      } else if (!updateReserved) {
        throw new Error('更新准备状态已变化，请重新尝试。');
      }
      blockedReason = await assess(action === 'recheck');
      if (blockedReason) throw new Error(blockedReason);
      if (!current()) throw new Error('更新准备已取消，请重新尝试。');
      if (options.obsEpoch?.() !== updateObservation) {
        blockedReason = 'OBS 输出状态已变化，本次更新已取消，请核对后重试。';
        throw new Error(blockedReason);
      }
      return { accepted: true };
    } catch (e) {
      const reason =
        e instanceof Error && e.message === 'update_recheck_required' && e.cause instanceof Error
          ? e.cause
          : e;
      manager.failure('install_plan', reason);
      const failure = updateFailure('install_plan', reason, '');
      release();
      // A cancelled prepare can finish after release, but no newer prepare may
      // enter while this one is still running.
      if (action === 'prepare' && updateOwner === undefined) manager.release();
      return reply.code(409).send({
        message: blockedReason ?? `${failure.summary} ${failure.nextStep}`,
      });
    } finally {
      if (action === 'prepare') updatePreparing = false;
    }
  });
  app.addHook('onListen', () => {
    manager.start();
    return Promise.resolve();
  });
  app.addHook('onClose', () => manager.close());
  return {
    // The Host has already completed normal cleanup when the runtime is stopped.
    // Recheck outputs, not the preparation scene changed by that cleanup.
    beforeStop: async () => {
      if (!updateReserved) return null;
      const owner = updateOwner;
      const reason = await assess(true);
      const blocked =
        reason ??
        (updateOwner !== owner || !updateReserved || options.obsEpoch?.() !== updateObservation
          ? 'OBS 输出或更新状态已变化，本次更新已取消，请核对后重试。'
          : null);
      if (blocked && owner) releaseOwner(owner);
      return blocked;
    },
  };
}
