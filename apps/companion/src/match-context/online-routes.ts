import type { FastifyInstance } from 'fastify';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MatchContextController } from './controller.js';
import { createOnlineManifestSource, type OnlineManifestConfig } from './http-source.js';

export function registerOnlineManifestRoutes(
  app: FastifyInstance,
  options: {
    readonly controller: MatchContextController | null;
    readonly config?: OnlineManifestConfig;
    readonly originPolicy: LocalWebOriginPolicy;
  },
) {
  if (options.controller && options.config) {
    const controller = options.controller;
    const config = options.config;
    const timer = setInterval(() => {
      const active = controller.getActiveBinding();
      if (!active || !(active.origin === 'online' || active.cachedFrom === 'online')) return;
      try {
        const source = createOnlineManifestSource(active.context.matchId, config);
        void controller.stageOnlineMatch(active.context.matchId, source).catch(() => undefined);
      } catch {
        /* Invalid config is surfaced by explicit refresh. */
      }
    }, 60_000);
    timer.unref();
    app.addHook('onClose', () => clearInterval(timer));
  }
  app.get('/local/v1/match-context-source', (_request, reply) =>
    reply.header('cache-control', 'no-store').send({
      configured: options.config !== undefined,
      activeMatchId: options.controller?.getActiveBinding()?.context.matchId ?? null,
      pending:
        options.controller?.getPendingOnlineCandidate() === undefined
          ? null
          : {
              revision: options.controller.getPendingOnlineCandidate()!.revision,
              competition:
                options.controller.getPendingOnlineCandidate()!.binding.context.competition.name,
              entryA:
                options.controller.getPendingOnlineCandidate()!.binding.context.entrants.a.name,
              entryB:
                options.controller.getPendingOnlineCandidate()!.binding.context.entrants.b.name,
            },
    }),
  );
  app.post('/operator/match-context/refresh', { bodyLimit: 2048 }, async (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    if (!options.controller || !options.config)
      return reply
        .code(503)
        .send({ error: 'online_source_unavailable', message: 'RivalHub 在线比赛来源尚未配置。' });
    const body = request.body as Record<string, unknown> | null;
    if (typeof body?.matchId !== 'string')
      return reply.code(400).send({ error: 'invalid_match_id', message: '请输入有效的比赛标识。' });
    let source;
    try {
      source = createOnlineManifestSource(body.matchId, options.config);
    } catch {
      return reply
        .code(400)
        .send({ error: 'invalid_match_id', message: '比赛标识或来源配置有误。' });
    }
    const result = await options.controller.stageOnlineMatch(body.matchId, source);
    return result.ok
      ? { ok: true, message: '已取得 RivalHub 比赛候选，请核对双方后确认绑定。' }
      : reply.code(502).send({
          error: 'online_source_failed',
          message: '暂时无法取得该比赛，当前比赛保持不变。',
        });
  });
}
