import type { FastifyInstance } from 'fastify';
import type { LiveSnapshotV1 } from '@mizar/protocol/output';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MatchContextController } from './controller.js';
import type { RivalHubConnection } from './rivalhub-connection.js';

export function registerRivalHubConnectionRoutes(
  app: FastifyInstance,
  options: {
    connection: RivalHubConnection;
    canClaim?: () => boolean;
    controller: MatchContextController | null;
    currentSnapshot: () => LiveSnapshotV1 | null;
    originPolicy: LocalWebOriginPolicy;
  },
) {
  const allowed = (origin: string | undefined) =>
    options.originPolicy.mode === 'loopback' &&
    checkLocalWebOrigin(options.originPolicy, origin).allowed;
  app.get('/local/v1/rivalhub-connection', (_request, reply) =>
    reply.header('cache-control', 'no-store').send({
      ...options.connection.view(),
      activeMatchId:
        options.controller?.getActiveBinding()?.origin === 'online'
          ? options.controller.getActiveBinding()?.context.matchId
          : null,
    }),
  );
  app.get('/local/v1/rivalhub-schedule', async (_request, reply) => {
    if (!options.connection.view().paired)
      return reply.code(404).send({ message: '尚未连接赛事。' });
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const to = new Date(now.getTime() + 14 * 24 * 3600_000).toISOString();
    try {
      return reply
        .header('cache-control', 'no-store')
        .send(await options.connection.schedule(from, to));
    } catch {
      return reply.code(502).send({ message: '赛事赛程暂时无法获取。' });
    }
  });
  app.post('/operator/rivalhub/disconnect', async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    try {
      await options.connection.disconnect();
      return options.connection.view();
    } catch {
      return reply.code(409).send({ message: '断开未完成，请重试。' });
    }
  });
  app.post('/operator/rivalhub/pairing/start', { bodyLimit: 64 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    try {
      return reply
        .header('cache-control', 'no-store')
        .send(await options.connection.startPairing());
    } catch (error) {
      return reply
        .code(502)
        .send({ message: error instanceof Error ? error.message : '连接失败。' });
    }
  });
  app.post('/operator/rivalhub/pairing/poll', { bodyLimit: 64 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    try {
      const status = await options.connection.pollPairing();
      return reply
        .header('cache-control', 'no-store')
        .send({ status, connection: options.connection.view() });
    } catch (error) {
      return reply
        .code(502)
        .send({ message: error instanceof Error ? error.message : '授权状态暂时无法获取。' });
    }
  });
  app.post('/operator/rivalhub/select', { bodyLimit: 256 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    const body = request.body as { matchId?: unknown };
    if (!options.controller || typeof body?.matchId !== 'string')
      return reply.code(400).send({ message: '请选择一场比赛。' });
    try {
      const source = options.connection.matchSource(body.matchId);
      const outcome = await options.controller.stageOnlineMatch(body.matchId, source);
      return outcome.ok
        ? { pending: true }
        : reply.code(502).send({ message: '比赛资料暂时无法获取。' });
    } catch {
      return reply.code(400).send({ message: '比赛资料无法使用。' });
    }
  });
  app.post('/operator/rivalhub/source/claim', { bodyLimit: 128 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    if (options.canClaim && !options.canClaim())
      return reply.code(409).send({ message: '请先进入现场。' });
    const binding = options.controller?.getActiveBinding();
    const snapshot = options.currentSnapshot();
    if (
      !binding ||
      binding.origin !== 'online' ||
      !snapshot ||
      snapshot.matchId !== binding.context.matchId
    )
      return reply.code(409).send({ message: '请先在工作区加载赛事比赛。' });
    try {
      return await options.connection.claim(
        snapshot,
        binding.manifest.revision,
        (request.body as { takeover?: boolean } | null)?.takeover === true,
      );
    } catch (error) {
      return reply
        .code(409)
        .send({ message: error instanceof Error ? error.message : '数据源切换未完成。' });
    }
  });
  app.post('/operator/rivalhub/source/release', { bodyLimit: 64 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    try {
      await options.connection.release();
      return options.connection.view();
    } catch {
      return reply.code(502).send({ message: '数据源停止未确认，请稍后再试。' });
    }
  });
}
