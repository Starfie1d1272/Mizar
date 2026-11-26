import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { ObsOutputsStatus } from '@mizar/protocol/obs';
import type { ProgramSceneController } from '../program-scenes/controller.js';
import type { createProduction } from '../program-scenes/production.js';
import { UpdateManager, safeCode, updateFailure } from './manager.js';
import type { MulnxTool } from '../orchestration/tool.js';

function outputBlockReason(obs: ObsOutputsStatus | undefined): string | null {
  const outputs = obs ? [obs.stream, obs.record] : [];
  if (outputs.some((output) => output.active === true)) return '停止 OBS 推流或录制后可更新。';
  if (outputs.some((output) => output.pending || output.phase === 'starting'))
    return 'OBS 正在启动或停止输出，请等这次操作结束后安装。';
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
    obs: () => Promise<ObsOutputsStatus | undefined>;
    mulnx?: () => MulnxTool | undefined;
  },
) {
  const { manager, production, scenes } = options;
  let updateReserved = false;
  const releaseUpdate = () => {
    manager.release();
    if (updateReserved) {
      updateReserved = false;
      production.releaseUpdate();
      scenes.setUpdatePending(false);
    }
  };
  const assess = async () => outputBlockReason(await options.obs().catch(() => undefined));
  manager.setCanAutoDownload(async () => {
    if (production.get().mode !== 'preparation') return false;
    return (await assess()) === null;
  });
  const publicView = async () => {
    const status = manager.status();
    const tool = options.mulnx?.()?.view();
    const installBlockedReason = status.staged !== null ? await assess() : null;
    return {
      ...status,
      mulnx: tool ?? null,
      installBlockedReason,
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
    } | null;
    try {
      if (body?.action === 'check') {
        await Promise.allSettled([
          manager.check('manual', 'manual'),
          options.mulnx?.()?.check() ?? Promise.resolve(),
        ]);
      } else if (body?.action === 'download') await manager.download();
      else if (body?.action === 'cancel') await manager.cancel();
      else if (body?.action === 'automatic' && typeof body.enabled === 'boolean')
        await manager.setAutomatic(body.enabled);
      else return reply.code(400).send({ error: 'update_action_invalid' });
      return await publicView();
    } catch (e) {
      manager.failure('operator_action', e);
      return reply
        .code(409)
        .send({ error: safeCode(e), failureDetails: manager.status().failureDetails });
    }
  });
  // Single install-plan endpoint: checks OBS gating and returns the verified package plan.
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
    const body = request.body as { action?: unknown; sessionId?: unknown } | null;
    if (body?.action === 'startup') {
      if (
        typeof body.sessionId !== 'string' ||
        !/^(?:[a-f0-9]{32}-[a-f0-9]{8}|[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(
          body.sessionId,
        )
      )
        return reply.code(400).send({ error: 'update_action_invalid' });
      manager.desktopStartup(body.sessionId);
      return { accepted: true };
    }
    if (body?.action === 'release') {
      releaseUpdate();
      return { released: true };
    }
    let blockedReason: string | null = null;
    try {
      blockedReason = await assess();
      if (blockedReason) throw new Error(blockedReason);
      const plan = await manager.prepare();
      if (!production.reserveUpdate()) {
        blockedReason = '应用正在退出，请等当前操作结束。';
        throw new Error(blockedReason);
      }
      updateReserved = true;
      scenes.setUpdatePending(true);
      return plan;
    } catch (e) {
      manager.failure('install_plan', e);
      const failure = updateFailure('install_plan', e, '');
      releaseUpdate();
      return reply.code(409).send({
        message: blockedReason ?? `${failure.summary} ${failure.nextStep}`,
      });
    }
  });
  app.addHook('onListen', () => {
    manager.start();
    return Promise.resolve();
  });
  app.addHook('onClose', () => manager.close());
  return {
    beforeStop: async () => {
      if (!updateReserved) return null;
      const reason = await assess();
      if (reason) releaseUpdate();
      return reason;
    },
  };
}
