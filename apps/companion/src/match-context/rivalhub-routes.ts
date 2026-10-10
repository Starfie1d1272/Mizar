import type { FastifyInstance } from 'fastify';
import type { LiveSnapshotV1 } from '@mizar/protocol/output';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MatchContextController } from './controller.js';
import { OFFICIAL_RIVALHUB_URL, type RivalHubConnection } from './rivalhub-connection.js';
import { isStandaloneLocalMatch } from './lkg-store.js';

export function registerRivalHubConnectionRoutes(
  app: FastifyInstance,
  options: {
    connection: RivalHubConnection;
    canClaim?: () => boolean;
    canUpdatePlan?: () => boolean;
    controller: MatchContextController | null;
    currentSnapshot: () => LiveSnapshotV1 | null;
    originPolicy: LocalWebOriginPolicy;
  },
) {
  options.connection.setDiagnosticHandler?.((operation, error) => {
    app.log.error({ err: error, operation }, 'RivalHub upstream request failed');
  });
  const allowed = (origin: string | undefined) =>
    options.originPolicy.mode === 'loopback' &&
    checkLocalWebOrigin(options.originPolicy, origin).allowed;
  let lastRefreshAt: string | null = null;
  let refreshError: string | null = null;
  let refreshing: Promise<unknown> | null = null;
  const linkedBinding = () => {
    const binding = options.controller?.getActiveBinding();
    return binding &&
      !isStandaloneLocalMatch(binding) &&
      binding.origin !== 'fixture' &&
      binding.manifest.match.competition?.competitionId === options.connection.view().competitionId
      ? binding
      : undefined;
  };
  const sourceFor = (matchId: string) => {
    const source = options.connection.matchSource(matchId);
    return {
      ...source,
      load: async () => {
        try {
          return await source.load();
        } catch (error) {
          app.log.error({ err: error, matchId }, 'RivalHub manifest fetch failed');
          throw error;
        }
      },
    };
  };
  const refresh = () => {
    if (refreshing) return refreshing;
    const binding = linkedBinding();
    if (!binding || !options.controller) throw new Error('请先选择并确认加载赛事比赛。');
    // A pending different match belongs to an explicit operator selection.
    const candidate = options.controller.getPendingOnlineCandidate();
    if (candidate && candidate.binding.context.matchId !== binding.context.matchId)
      throw new Error('请先确认或重新选择待加载的比赛。');
    const controller = options.controller;
    refreshing = controller
      .refreshOnlineMatch(sourceFor(binding.context.matchId), options.canUpdatePlan)
      .then((result) => {
        if (!result.ok) throw new Error(result.diagnostics.map((item) => item.message).join('；'));
        lastRefreshAt = new Date().toISOString();
        refreshError = null;
        return {
          ok: true,
          pending: Boolean(controller.getPendingOnlineCandidate()),
          message: controller.getPendingOnlineCandidate()
            ? '资料已刷新；BP 有差异，请核对后确认加载网站版本。本地 BP 已保留。'
            : '比赛资料已同步，包括 BP、名单与解说信息。',
        };
      })
      .catch((error: unknown) => {
        refreshError = error instanceof Error ? error.message : '比赛资料刷新失败，请重试。';
        app.log.error({ err: error, matchId: binding.context.matchId }, 'RivalHub refresh failed');
        throw error;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  };
  let automaticMatchId: string | null = null;
  let automaticAttempts = 0;
  let automaticTask: Promise<void> | null = null;
  async function stopAutomaticClaim() {
    automaticMatchId = null;
    await automaticTask;
  }
  const timer = setInterval(() => {
    tryAutomaticClaim();
    if (linkedBinding() && !options.controller?.isOnlineCandidateLoading())
      void Promise.resolve()
        .then(refresh)
        .catch(() => undefined);
  }, 10_000);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
    await stopAutomaticClaim();
  });
  const observedLineupReady = () => {
    const snapshot = options.currentSnapshot();
    return (
      snapshot?.matchId === linkedBinding()?.context.matchId &&
      snapshot?.capability.identity === 'matched' &&
      snapshot.capability.telemetryFresh &&
      snapshot.capability.contextFresh &&
      Boolean(snapshot?.cursor.liveSessionId) &&
      new Set(
        snapshot?.players
          .filter(
            (player) =>
              player.lineupEvidence === 'current' && /^\d{17}$/.test(player.sourcePlayerId),
          )
          .map((player) => player.sourcePlayerId),
      ).size === 10
    );
  };
  // Only a newly started production arms this bounded, match-scoped request.
  // Reading, reconnecting and reopening the workspace never create intent.
  function tryAutomaticClaim() {
    if (!automaticMatchId || automaticTask) return;
    const binding = linkedBinding();
    const connection = options.connection.view();
    if (
      binding?.context.matchId !== automaticMatchId ||
      binding.origin !== 'online' ||
      !connection.paired ||
      connection.activeSourceMatchId ||
      connection.activeDeviceName ||
      automaticAttempts >= 5
    ) {
      automaticMatchId = null;
      return;
    }
    if ((options.canClaim && !options.canClaim()) || !observedLineupReady()) return;
    const snapshot = options.currentSnapshot();
    if (!snapshot || snapshot.matchId !== automaticMatchId) return;
    automaticAttempts++;
    automaticTask = options.connection
      .claim(snapshot, binding.manifest.revision, false)
      .then(async () => {
        const current = linkedBinding();
        if (current?.context.matchId !== snapshot.matchId || current.origin !== 'online')
          await options.connection.release();
        automaticMatchId = null;
      })
      .catch((error: unknown) => {
        app.log.error({ err: error }, 'RivalHub automatic source claim failed');
      })
      .finally(() => {
        automaticTask = null;
      });
  }
  app.post('/operator/rivalhub/refresh', { bodyLimit: 64 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    try {
      return await refresh();
    } catch (error) {
      return reply
        .code(409)
        .send({ message: error instanceof Error ? error.message : '刷新失败，请重试。' });
    }
  });
  app.get('/local/v1/rivalhub-connection', (_request, reply) =>
    reply.header('cache-control', 'no-store').send({
      ...options.connection.view(),
      activeMatchId: linkedBinding()?.context.matchId ?? null,
      sourceReady: Boolean(
        linkedBinding()?.origin === 'online' &&
        (!options.canClaim || options.canClaim()) &&
        observedLineupReady(),
      ),
      sourceBlockedReason: !linkedBinding()
        ? '请先选择并确认加载赛事比赛。'
        : linkedBinding()?.origin !== 'online'
          ? '本地 BP 尚未与网站一致，请刷新资料并确认加载网站版本后恢复推送。'
          : options.canClaim && !options.canClaim()
            ? '进入现场后可以成为本场数据源。'
            : !observedLineupReady()
              ? automaticMatchId
                ? '等待当前比赛的十人首发数据；新制作就绪后自动认领，也可手动重试。'
                : '等待当前比赛的十人首发数据；就绪后可明确恢复提供网站数据。'
              : null,
      lastRefreshAt,
      refreshError,
      websiteUrl: linkedBinding()?.manifest.match.competition?.slug
        ? `${OFFICIAL_RIVALHUB_URL}/admin/${encodeURIComponent(linkedBinding()!.manifest.match.competition!.slug)}/matches/${encodeURIComponent(linkedBinding()!.context.matchId)}`
        : null,
    }),
  );
  app.get('/local/v1/rivalhub-schedule', async (request, reply) => {
    if (!options.connection.view().paired)
      return reply.code(404).send({ message: '尚未连接赛事。' });
    const now = new Date();
    const from = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const to = new Date(now.getTime() + 14 * 24 * 3600_000).toISOString();
    try {
      return reply
        .header('cache-control', 'no-store')
        .send(await options.connection.schedule(from, to));
    } catch (error) {
      request.log.error({ err: error }, 'RivalHub operation failed');
      return reply.code(502).send({ message: '赛事赛程暂时无法获取。' });
    }
  });
  app.post('/operator/rivalhub/disconnect', async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    try {
      await stopAutomaticClaim();
      await options.connection.disconnect();
      return options.connection.view();
    } catch (error) {
      request.log.error({ err: error }, 'RivalHub operation failed');
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
      request.log.error({ err: error }, 'RivalHub operation failed');
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
      request.log.error({ err: error }, 'RivalHub operation failed');
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
      const source = sourceFor(body.matchId);
      const outcome = await options.controller.stageOnlineMatch(body.matchId, source);
      return outcome.ok
        ? { pending: true }
        : reply.code(502).send({ message: '比赛资料暂时无法获取。' });
    } catch (error) {
      request.log.error({ err: error }, 'RivalHub operation failed');
      return reply.code(400).send({ message: '比赛资料无法使用。' });
    }
  });
  app.post('/operator/rivalhub/source/claim', { bodyLimit: 128 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    await stopAutomaticClaim();
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
      request.log.error({ err: error }, 'RivalHub operation failed');
      return reply
        .code(409)
        .send({ message: error instanceof Error ? error.message : '数据源切换未完成。' });
    }
  });
  app.post('/operator/rivalhub/source/release', { bodyLimit: 64 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    try {
      await stopAutomaticClaim();
      await options.connection.release();
      return options.connection.view();
    } catch (error) {
      request.log.error({ err: error }, 'RivalHub operation failed');
      return reply.code(502).send({ message: '数据源停止未确认，请稍后再试。' });
    }
  });
  return {
    beginProduction: () => {
      const binding = linkedBinding();
      automaticMatchId = binding?.origin === 'online' ? binding.context.matchId : null;
      automaticAttempts = 0;
      tryAutomaticClaim();
    },
    stopAutomaticClaim,
  };
}
