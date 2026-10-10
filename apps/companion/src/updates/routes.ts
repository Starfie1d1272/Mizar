import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { ObsStatus } from '../obs/adapter.js';
import type { ProgramSceneController } from '../program-scenes/controller.js';
import type { registerProductionRoutes } from '../program-scenes/production.js';
import { UpdateManager, safeCode } from './manager.js';

export function installBlockReason(
  production: { mode: string },
  scenes: ReturnType<ProgramSceneController['get']>,
  obs: ObsStatus | undefined,
): string | null {
  if (production.mode !== 'preparation') return '结束制作后可更新。';
  if (scenes.preparing || scenes.active !== 'waiting' || scenes.director?.mode === 'manual')
    return '结束节目制作后可更新。';
  if (!obs || obs.connection !== 'connected') return '请先连接 OBS。';
  if (obs.streaming || obs.recording) return '停止 OBS 推流或录制后可更新。';
  return null;
}
export function registerUpdateRoutes(
  app: FastifyInstance,
  options: {
    manager: UpdateManager;
    originPolicy: LocalWebOriginPolicy;
    controlToken: string;
    production: ReturnType<typeof registerProductionRoutes>;
    scenes: ProgramSceneController;
    obs: () => Promise<ObsStatus | undefined>;
  },
) {
  const { manager, production, scenes } = options;
  const assess = async () => {
    const obs = await options.obs().catch(() => undefined);
    return installBlockReason(production.get(), scenes.get(), obs);
  };
  const publicView = async () => {
    const status = manager.status();
    const installBlockedReason = status.phase === 'ready' ? await assess() : null;
    const scene = scenes.get();
    return {
      ...status,
      productionRevision: production.get().revision,
      installBlockedReason,
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
    const body = request.body as { action?: unknown; enabled?: unknown } | null;
    try {
      if (body?.action === 'check') await manager.check();
      else if (body?.action === 'download') await manager.download();
      else if (body?.action === 'cancel') await manager.cancel();
      else if (body?.action === 'automatic' && typeof body.enabled === 'boolean')
        await manager.setAutomatic(body.enabled);
      else if (body?.action === 'resume') {
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
      return reply.code(409).send({ error: safeCode(e) });
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
    const action = (request.body as { action?: unknown } | null)?.action;
    if (action === 'release') {
      manager.release();
      production.releaseUpdate();
      scenes.setUpdatePending(false);
      return { released: true };
    }
    if (action !== 'prepare') return reply.code(400).send({ error: 'update_action_invalid' });
    try {
      const plan = await manager.prepare();
      const reason = await assess();
      if (reason) throw new Error(reason);
      if (!production.reserveUpdate()) throw new Error('制作状态已变化，请结束制作后重试。');
      scenes.setUpdatePending(true);
      return plan;
    } catch (e) {
      manager.failure('install_plan', e);
      manager.release();
      production.releaseUpdate();
      scenes.setUpdatePending(false);
      return reply.code(409).send({
        message:
          e instanceof Error && !e.message.startsWith('update_')
            ? e.message
            : '更新尚未通过重新验证，请检查更新后重试。',
      });
    }
  });
  app.addHook('onListen', () => {
    manager.start();
    return Promise.resolve();
  });
  app.addHook('onClose', () => manager.close());
}
