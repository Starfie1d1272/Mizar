import { sourceErrorEvidence } from './source-error.js';
import { bindHistoricalStats, projectHistoricalStats } from '../projections/historical-stats.js';
import { projectHistoricalProgram } from '../projections/historical-program.js';
import type { ProgramPresentation, ProgramSceneId } from '@mizar/protocol/program-scenes';
import type { FastifyInstance } from 'fastify';
import type { LiveSnapshotV1, ReliableEventV1 } from '@mizar/protocol/output';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MatchContextController } from './controller.js';
import {
  OFFICIAL_RIVALHUB_URL,
  statsTarget,
  type RivalHubConnection,
} from './rivalhub-connection.js';
import { isStandaloneLocalMatch } from './lkg-store.js';
import type { LiveSnapshotStatus } from '../output/service.js';

export function registerRivalHubConnectionRoutes(
  app: FastifyInstance,
  options: {
    connection: RivalHubConnection;
    canClaim?: () => boolean;
    canUpdatePlan?: () => boolean;
    canFetchStats?: () => boolean;
    controller: MatchContextController | null;
    currentSnapshot: () => LiveSnapshotV1 | null;
    currentSnapshotStatus?: () => LiveSnapshotStatus;
    retryOutputPersistence?: () => Promise<boolean>;
    setContextRecoveryHandler?: (
      handler: (event: ReliableEventV1, authority: string) => Promise<boolean>,
    ) => void;
    originPolicy: LocalWebOriginPolicy;
  },
) {
  options.connection.setDiagnosticHandler?.((operation, error) => {
    if (operation === 'live_recovered')
      app.log.info(
        { operation, event: 'rivalhub_live', stage: 'accepted', result: 'success' },
        'RivalHub LIVE delivery recovered',
      );
    else if (operation === 'live') {
      const failure =
        error instanceof Error
          ? (error.cause as { stage?: unknown; error?: unknown } | undefined)
          : undefined;
      app.log.error(
        {
          err: error,
          operation,
          event: 'rivalhub_live',
          stage: failure?.stage ?? 'acceptance',
          result: 'failure',
          diagnostic: { error: failure?.error },
        },
        'RivalHub LIVE sustained delivery failure',
      );
    } else app.log.error({ err: error, operation }, 'RivalHub upstream request failed');
  });
  const allowed = (origin: string | undefined) =>
    options.originPolicy.mode === 'loopback' &&
    checkLocalWebOrigin(options.originPolicy, origin).allowed;
  let lastRefreshAt: string | null = null;
  let refreshError: string | null = null;
  let refreshing: Promise<{ ok: boolean; pending: boolean; message: string }> | null = null;
  const linkedBinding = () => {
    const binding = options.controller?.getActiveBinding();
    return binding &&
      !isStandaloneLocalMatch(binding) &&
      binding.origin !== 'fixture' &&
      binding.manifest.match.competition?.competitionId ===
        options.connection.view().competitionId &&
      binding.context.competition?.competitionId === options.connection.view().competitionId
      ? binding
      : undefined;
  };
  app.post('/operator/rivalhub/stats/refresh', { bodyLimit: 64 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    const binding = linkedBinding();
    if (!binding) return reply.code(409).send({ message: '请先加载网站比赛资料。' });
    const target = statsTarget(binding.context);
    const value = await options.connection.stats(target, true);
    const current = linkedBinding();
    if (
      !value ||
      !current ||
      options.connection.getStatsSnapshot(statsTarget(current.context)) !== value
    ) {
      const retained = await options.connection.getStats(target);
      return reply.code(502).send({
        message: retained ? '统计刷新失败，保留本场已有快照。' : '统计刷新失败，当前没有可用快照。',
      });
    }
    return { ok: true };
  });
  const sourceFor = (matchId: string, fresh = true) => {
    const source = options.connection.matchSource(matchId, fresh);
    return {
      ...source,
      load: async () => {
        try {
          return await source.load();
        } catch (error) {
          app.log.error(
            { diagnostic: sourceErrorEvidence(error), matchId },
            'RivalHub manifest fetch failed',
          );
          throw error;
        }
      },
    };
  };
  const refresh = (fresh = true) => {
    if (refreshing) return refreshing;
    const binding = linkedBinding();
    if (!binding || !options.controller) throw new Error('请先选择并确认加载赛事比赛。');
    // A pending different match belongs to an explicit operator selection.
    const candidate = options.controller.getPendingOnlineCandidate();
    if (candidate && candidate.binding.context.matchId !== binding.context.matchId)
      throw new Error('请先确认或重新选择待加载的比赛。');
    const controller = options.controller;
    refreshing = controller
      .refreshOnlineMatch(sourceFor(binding.context.matchId, fresh), options.canUpdatePlan)
      .then((result) => {
        if (!result.ok) {
          app.log.warn(
            { diagnostics: result.diagnostics, matchId: binding.context.matchId },
            'RivalHub manifest refresh rejected',
          );
          throw new Error(result.diagnostics.map((item) => item.message).join('；'));
        }
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
  const timer = setInterval(() => {
    const statsBinding = linkedBinding();
    if (
      options.canFetchStats?.() &&
      statsBinding &&
      (statsBinding.origin === 'online' ||
        (statsBinding.origin === 'cache' && statsBinding.cachedFrom === 'online'))
    )
      void options.connection.stats(statsTarget(statsBinding.context));
    if (linkedBinding() && !options.controller?.isOnlineCandidateLoading())
      void Promise.resolve()
        .then(() => refresh(false))
        .catch(() => undefined);
  }, 10_000);
  timer.unref();
  const libraryTimer = setInterval(() => {
    if (options.connection.view().paired) void options.connection.library().catch(() => undefined);
  }, 60_000);
  libraryTimer.unref();
  app.addHook('onClose', () => clearInterval(libraryTimer));
  app.addHook('onClose', () => {
    clearInterval(timer);
    options.connection.clearStats();
  });
  const currentSnapshotStatus = (): LiveSnapshotStatus =>
    options.currentSnapshotStatus?.() ?? {
      snapshot: options.currentSnapshot(),
      blockedReason: null,
    };
  const snapshotBlock = (status: LiveSnapshotStatus) => {
    const block = (
      code: string,
      message: string,
      action:
        | 'connection'
        | 'match'
        | 'roster'
        | 'refresh'
        | 'diagnostics'
        | 'production'
        | 'output-retry',
    ) => ({ code, message, action });
    if (status.blockedReason === 'output_unavailable')
      return block(
        'output_unavailable',
        '网站同步记录无法读取。请保留原数据并导出诊断，修复后重启 Mizar。',
        'diagnostics',
      );
    if (status.localPersistencePending || status.blockedReason === 'output_persistence_pending')
      return block(
        'output_persistence_pending',
        '网站同步记录尚未确认，正在自动重试。本机画面不受影响；请保持 Mizar 运行，持续失败请导出诊断核对。',
        'output-retry',
      );
    const snapshot = status.snapshot;
    if (!snapshot) {
      switch (status.blockedReason) {
        case 'telemetry_unavailable':
          return block(status.blockedReason, '尚未收到当前游戏数据。', 'connection');
        case 'telemetry_stale':
          return block(
            status.blockedReason,
            '当前游戏数据已中断，网站同步正在等待新数据。',
            'connection',
          );
        case 'binding_missing':
        case 'competition_missing':
          return block(status.blockedReason, '当前没有可同步的网站比赛。', 'match');
        case 'binding_stale':
        case 'context_stale':
          return block(status.blockedReason, '当前比赛资料已过期，请刷新后继续。', 'refresh');
        case 'identity_mismatch':
          return block(
            status.blockedReason,
            '游戏身份与本场比赛不符，请核对队伍与名单。',
            'roster',
          );
        case 'snapshot_match_mismatch':
          return block(
            status.blockedReason,
            '当前游戏数据尚未归属本场比赛，请核对比赛绑定。',
            'match',
          );
        case 'output_quarantined':
          return block(
            status.blockedReason,
            '实时发布已被安全隔离，请查看诊断后处理。',
            'diagnostics',
          );
        case 'snapshot_projection_failed':
          return block(status.blockedReason, '实时数据生成失败，请导出诊断。', 'diagnostics');
        default:
          return block(
            status.blockedReason ?? 'snapshot_unavailable',
            '尚无可发布的实时数据，请查看诊断。',
            'diagnostics',
          );
      }
    }
    if (snapshot.matchId !== linkedBinding()?.context.matchId)
      return block(
        'snapshot_match_mismatch',
        '当前游戏数据尚未归属本场比赛，请核对比赛绑定。',
        'match',
      );
    if (!snapshot.capability.telemetryFresh)
      return block('telemetry_stale', '当前游戏数据已中断，网站同步正在等待新数据。', 'connection');
    if (!snapshot.capability.contextFresh)
      return block('context_stale', '当前比赛资料已过期，请刷新后继续。', 'refresh');
    if (
      snapshot.capability.identity !== 'matched' &&
      !(
        snapshot.capability.identity === 'degraded' &&
        snapshot.capability.lineupMismatchOnly === true
      )
    )
      return block('identity_unconfirmed', '游戏身份尚未与本场确认，请核对队伍与名单。', 'roster');
    if (!snapshot.cursor.liveSessionId)
      return block('session_unavailable', '当前游戏会话尚未确认，请检查游戏连接。', 'connection');
    const players = snapshot.players.filter((player) => player.lineupEvidence === 'current');
    if (
      players.length !== 10 ||
      players.some((player) => !/^\d{17}$/.test(player.sourcePlayerId)) ||
      new Set(players.map((player) => player.sourcePlayerId)).size !== 10
    )
      return block(
        'lineup_incomplete',
        '尚未收到完整的当前十人名单，请检查观战连接与名单。',
        'roster',
      );
    return null;
  };
  const observedLineupReady = () => snapshotBlock(currentSnapshotStatus()) === null;
  const sourceStatus = () => {
    const status = currentSnapshotStatus();
    // Local persistence repair does not require website authorization or publishing readiness.
    const localRecovery =
      status.localPersistencePending || status.blockedReason === 'output_persistence_pending';
    const unavailable = status.blockedReason === 'output_unavailable';
    const binding =
      localRecovery || unavailable ? options.controller?.getActiveBinding() : linkedBinding();
    const view = options.connection.view();
    const blocked =
      unavailable || (localRecovery && binding)
        ? snapshotBlock(status)
        : !view.paired
          ? { code: 'not_paired', message: '尚未连接网站。', action: 'authorization' }
          : view.sourceState === 'unavailable'
            ? {
                code: 'source_state_unavailable',
                message: '本机来源记录不可用，请查看诊断后处理。',
                action: 'diagnostics',
              }
            : !binding
              ? {
                  code: 'binding_missing',
                  message: '请先选择并确认加载网站比赛。',
                  action: 'match',
                }
              : binding.origin !== 'online'
                ? {
                    code: 'online_context_unconfirmed',
                    message: '当前资料尚未与网站一致，请核对并确认网站版本。',
                    action: 'match',
                  }
                : options.canClaim && !options.canClaim()
                  ? {
                      code: 'production_inactive',
                      message: '进入现场后可开启本场网站同步。',
                      action: 'production',
                    }
                  : snapshotBlock(status);
    return { ...status, binding, blocked };
  };
  const rejectSource = (state: ReturnType<typeof sourceStatus>, operation: string) => {
    app.log.info(
      {
        event: 'rivalhub_live',
        stage: operation,
        result: 'blocked',
        diagnostic: {
          reason: state.blocked?.code,
          outputBlockedReason: state.blockedReason,
          matchId: state.binding?.context.matchId ?? null,
          snapshotMatchId: state.snapshot?.matchId ?? null,
        },
      },
      'Website sync command blocked by current prerequisites',
    );
    return { error: state.blocked?.code, message: state.blocked?.message };
  };
  const targetMatches = (body: unknown, binding: ReturnType<typeof linkedBinding>) => {
    const target = body as { matchId?: unknown; contextRevision?: unknown } | null;
    return Boolean(
      binding &&
      target?.matchId === binding.context.matchId &&
      target.contextRevision === binding.manifest.revision,
    );
  };
  const sourceStillCurrent = (state: ReturnType<typeof sourceStatus>) => () => {
    const next = sourceStatus();
    const before = state.snapshot;
    const after = next.snapshot;
    return Boolean(
      !next.blocked &&
      before &&
      after &&
      next.binding?.manifest.revision === state.binding?.manifest.revision &&
      next.binding?.context.matchId === state.binding?.context.matchId &&
      after.matchId === before.matchId &&
      after.cursor.producerInstanceId === before.cursor.producerInstanceId &&
      after.cursor.liveSessionId === before.cursor.liveSessionId &&
      after.cursor.programSourceGeneration === before.cursor.programSourceGeneration &&
      after.cursor.mapEpoch === before.cursor.mapEpoch,
    );
  };
  const syncExpected = () => Boolean(linkedBinding() && (!options.canClaim || options.canClaim()));
  let sourceCommand: Promise<unknown> | null = null;
  options.setContextRecoveryHandler?.(async (event, authority) => {
    const sameExecution = () => {
      const snapshot = options.currentSnapshot();
      const view = options.connection.view();
      const c = snapshot?.cursor;
      const original = event.cursor;
      return (
        syncExpected() &&
        options.connection.reliableAuthorityScope() === authority &&
        view.stoppedMatchId !== event.matchId &&
        !view.activeDeviceName &&
        view.activeSourceMatchId === event.matchId &&
        !sourceCommand &&
        linkedBinding()?.origin === 'online' &&
        snapshot?.matchId === event.matchId &&
        snapshot.map.phase === 'live' &&
        snapshot.map.name === event.mapName &&
        c?.producerInstanceId === original.producerInstanceId &&
        c.liveSessionId === original.liveSessionId &&
        c.programSourceGeneration === original.programSourceGeneration &&
        c.mapEpoch === original.mapEpoch &&
        snapshot.capability.identity === 'matched' &&
        observedLineupReady()
      );
    };
    if (!sameExecution()) return false;
    options.connection.setContextRecoveryProgress(event, authority, 'context_refreshing');
    try {
      // An older background refresh cannot prove it started after this refusal.
      if (refreshing) await refreshing.catch(() => undefined);
      if (!sameExecution()) {
        options.connection.setContextRecoveryProgress(event, authority, 'context_recovery_blocked');
        return false;
      }
      const result = await refresh(true);
      const valid = !result.pending && sameExecution();
      options.connection.setContextRecoveryProgress(
        event,
        authority,
        valid ? 'context_reconfirming' : 'context_recovery_blocked',
      );
      return valid;
    } catch {
      options.connection.setContextRecoveryProgress(event, authority, 'context_recovery_blocked');
      return false;
    }
  });

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
  let lastSyncEvidence = '';
  app.get('/local/v1/rivalhub-connection', (_request, reply) => {
    const state = sourceStatus();
    const snapshot = state.snapshot;
    const expected = syncExpected();
    const syncHealth = options.connection.syncHealth(
      snapshot,
      expected,
      linkedBinding()?.context.matchId ?? null,
    );
    const evidence = {
      expected,
      syncHealth,
      linkedMatchId: linkedBinding()?.context.matchId ?? null,
      snapshotAvailable: snapshot !== null,
      outputBlockedReason: state.blockedReason,
      sourceBlockedCode: state.blocked?.code ?? null,
      snapshotMatchId: snapshot?.matchId ?? null,
      identity: snapshot?.capability.identity ?? null,
      telemetryFresh: snapshot?.capability.telemetryFresh ?? null,
      contextFresh: snapshot?.capability.contextFresh ?? null,
      phase: snapshot?.map.phase ?? null,
      mapId: snapshot?.map.mapId ?? null,
      liveSessionId: snapshot?.cursor.liveSessionId ?? null,
      canonicalTeams: snapshot?.capability.canonicalTeams ?? null,
      lineupComplete: snapshot?.capability.lineupComplete ?? null,
      observedLineupReady: snapshotBlock(state) === null,
      receiptScope: 'ingestion acceptance only; website viewer validation/render is not observed',
    };
    const signature = JSON.stringify(evidence);
    if (signature !== lastSyncEvidence) {
      lastSyncEvidence = signature;
      app.log.info({ diagnostic: evidence }, 'Website sync prerequisites and health changed');
    }
    return reply.header('cache-control', 'no-store').send({
      ...options.connection.view(),
      sourceCleanup:
        options.connection.view().sourceState === 'ready'
          ? options.connection.view().sourceCleanup
          : null,
      syncHealth,
      activeMatchId: state.binding?.context.matchId ?? null,
      activeMatchTitle: state.binding
        ? `${state.binding.context.entrants.a.name} 对阵 ${state.binding.context.entrants.b.name}`
        : null,
      contextRevision: state.binding?.manifest.revision ?? null,
      activeDeviceName:
        options.connection.view().activeDeviceMatchId === linkedBinding()?.context.matchId
          ? options.connection.view().activeDeviceName
          : null,
      sourceReady: state.blocked === null,
      sourceCommandPending: sourceCommand !== null,
      sourceBlockedCode: state.blocked?.code ?? null,
      sourceBlockedAction: state.blocked?.action ?? null,
      sourceBlockedReason: state.blocked?.message ?? null,
      lastRefreshAt,
      refreshError,
      websiteUrl: linkedBinding()?.manifest.match.competition?.slug
        ? `${OFFICIAL_RIVALHUB_URL}/admin/${encodeURIComponent(linkedBinding()!.manifest.match.competition!.slug)}/matches/${encodeURIComponent(linkedBinding()!.context.matchId)}`
        : null,
    });
  });
  app.get('/local/v1/rivalhub-schedule', async (request, reply) => {
    if (!options.connection.view().paired)
      return reply.code(404).send({ message: '尚未连接赛事。' });
    try {
      return reply.header('cache-control', 'no-store').send(await options.connection.library());
    } catch (error) {
      request.log.error({ err: error }, 'RivalHub operation failed');
      return reply.code(502).send({ message: '赛事赛程暂时无法获取。' });
    }
  });
  app.get<{ Params: { matchId: string }; Querystring: { fresh?: string } }>(
    '/local/v1/rivalhub-library/:matchId',
    async (request, reply) => {
      if (!options.connection.view().paired)
        return reply.code(404).send({ message: '尚未连接赛事。' });
      try {
        return reply
          .header('cache-control', 'no-store')
          .send(
            await options.connection.libraryDetail(
              request.params.matchId,
              request.query.fresh !== '0',
            ),
          );
      } catch {
        return reply.code(502).send({ message: '完整资料暂时无法获取，请重试。' });
      }
    },
  );
  app.post('/operator/rivalhub/disconnect', async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    try {
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
    const body = request.body as { matchId?: unknown; activate?: unknown };
    if (!options.controller || typeof body?.matchId !== 'string')
      return reply.code(400).send({ message: '请选择一场比赛。' });
    try {
      const source = sourceFor(body.matchId);
      const outcome =
        body.activate === true
          ? await options.controller.loadOnlineMatch(body.matchId, source)
          : await options.controller.stageOnlineMatch(body.matchId, source);
      if (outcome.ok)
        return body.activate === true
          ? { loaded: true, matchId: outcome.binding.context.matchId }
          : { pending: true };
      if (body.activate === true) {
        const persistenceFailed = outcome.diagnostics.some(
          (item) => item.code === 'lkg_persistence_failed',
        );
        const stale = outcome.diagnostics.some((item) => item.code === 'selection_stale');
        if (persistenceFailed || stale)
          return reply.code(persistenceFailed ? 500 : 409).send({
            message: persistenceFailed
              ? '比赛保存失败，当前本场保持不变，请重试。'
              : '本场或候选资料已变化，尚未载入，请重新选择。',
          });
      }
      // Diagnostics contain contract paths/codes only, never rejected input values.
      request.log.warn({ diagnostics: outcome.diagnostics }, 'RivalHub manifest selection failed');
      const fields = outcome.diagnostics
        .flatMap((item) => item.diagnostics ?? [])
        .map((item) => item.path);
      return reply.code(502).send({
        stage: outcome.diagnostics.some((item) => item.stage === 'match_document')
          ? 'match_document'
          : 'manifest',
        message: fields.length
          ? `比赛资料字段无法使用：${[...new Set(fields)].slice(0, 8).join('、')}。请在网站修正字段格式或网址后重试。`
          : '比赛资料暂时无法获取。',
      });
    } catch (error) {
      request.log.error({ err: error }, 'RivalHub operation failed');
      return reply.code(400).send({ message: '比赛资料无法使用。' });
    }
  });
  app.post('/operator/rivalhub/output/retry', { bodyLimit: 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    const binding = options.controller?.getActiveBinding();
    if (!binding || !targetMatches(request.body, binding))
      return reply.code(409).send({ message: '比赛已变化，请重新打开本场网站同步。' });
    if (!options.retryOutputPersistence)
      return reply.code(503).send({ message: '本机发送记录恢复暂不可用，请查看诊断。' });
    const unavailable = snapshotBlock(currentSnapshotStatus());
    if (unavailable?.code === 'output_unavailable')
      return reply.code(503).send({ error: unavailable.code, message: unavailable.message });
    const confirmed = await options.retryOutputPersistence();
    const current = options.controller?.getActiveBinding();
    if (!current || !targetMatches(request.body, current))
      return reply.code(409).send({ message: '比赛已变化，请核对当前本场的同步状态。' });
    const status = currentSnapshotStatus();
    if (
      !confirmed ||
      status.blockedReason === 'output_unavailable' ||
      status.blockedReason === 'output_persistence_pending' ||
      status.blockedReason === 'output_quarantined'
    )
      return reply.code(409).send({
        message:
          status.blockedReason === 'output_persistence_pending'
            ? '原同步记录仍未确认。请保持 Mizar 运行，修复诊断中报告的问题后重试，不要删除原数据。'
            : '连续性记录仍无法确认，请保留原数据并导出诊断核对。',
      });
    return { ok: true, message: '本机同步记录已核对，网站同步仍需等待当前数据和网站接收确认。' };
  });
  app.post('/operator/rivalhub/source/claim', { bodyLimit: 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    const state = sourceStatus();
    const { binding, snapshot } = state;
    if (state.blocked || !binding || !snapshot)
      return reply
        .code(
          ['source_state_unavailable', 'output_unavailable'].includes(state.blocked?.code ?? '')
            ? 503
            : 409,
        )
        .send(rejectSource(state, 'claim'));
    if (!targetMatches(request.body, binding))
      return reply.code(409).send({ message: '比赛已变化，请重新打开本场网站同步。' });
    if (sourceCommand) return reply.code(409).send({ message: '数据源操作正在进行，请稍候。' });
    try {
      sourceCommand = options.connection.claim(
        snapshot,
        binding.manifest.revision,
        (request.body as { takeover?: boolean } | null)?.takeover === true,
        sourceStillCurrent(state),
      );
      return await sourceCommand;
    } catch (error) {
      request.log.error({ err: error }, 'RivalHub operation failed');
      return reply
        .code(409)
        .send({ message: error instanceof Error ? error.message : '数据源切换未完成。' });
    } finally {
      sourceCommand = null;
    }
  });
  app.post('/operator/rivalhub/source/resume', { bodyLimit: 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    const state = sourceStatus();
    const { binding, snapshot } = state;
    if (state.blocked || !binding || !snapshot)
      return reply
        .code(
          ['source_state_unavailable', 'output_unavailable'].includes(state.blocked?.code ?? '')
            ? 503
            : 409,
        )
        .send(rejectSource(state, 'resume'));
    const body = request.body as { matchId?: unknown; contextRevision?: unknown } | null;
    if (
      body?.matchId !== binding.context.matchId ||
      body.contextRevision !== binding.manifest.revision
    )
      return reply.code(409).send({ message: '比赛或制作状态已变化，请核对本场后恢复网站同步。' });
    if (sourceCommand) return reply.code(409).send({ message: '网站同步操作正在进行，请稍候。' });
    const current = sourceStillCurrent(state);
    try {
      sourceCommand = options.connection.resumeSync(snapshot, binding.manifest.revision, current);
      return await sourceCommand;
    } catch (error) {
      request.log.error({ err: error }, 'Website sync recovery unconfirmed');
      return reply
        .code(409)
        .send({ message: error instanceof Error ? error.message : '网站同步恢复尚未确认。' });
    } finally {
      sourceCommand = null;
    }
  });
  app.post('/operator/rivalhub/source/retry', { bodyLimit: 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    const state = sourceStatus();
    const { snapshot, binding } = state;
    if (state.blocked || !binding || !snapshot)
      return reply
        .code(
          ['source_state_unavailable', 'output_unavailable'].includes(state.blocked?.code ?? '')
            ? 503
            : 409,
        )
        .send(rejectSource(state, 'retry'));
    const view = options.connection.view();
    if (
      !syncExpected() ||
      !snapshot ||
      view.stoppedMatchId === snapshot.matchId ||
      view.activeDeviceName ||
      view.activeSourceMatchId !== snapshot.matchId
    )
      return reply.code(409).send({ message: '请先明确认领本场数据源。' });
    if (!targetMatches(request.body, binding))
      return reply.code(409).send({ message: '比赛已变化，请重新打开本场网站同步。' });
    if (sourceCommand) return reply.code(409).send({ message: '数据源操作正在进行，请稍候。' });
    if (!options.connection.hasCurrentStart(snapshot)) {
      try {
        sourceCommand = options.connection.claim(
          snapshot,
          binding.manifest.revision,
          false,
          sourceStillCurrent(state),
        );
        await sourceCommand;
      } catch (error) {
        return reply
          .code(409)
          .send({ message: error instanceof Error ? error.message : '重试未完成。' });
      } finally {
        sourceCommand = null;
      }
    }
    options.connection.retryLive();
    return { ok: true, message: '已请求重试；等待当前比赛的新数据确认网站接收。' };
  });
  app.post(
    '/operator/rivalhub/source/retry-handoff',
    { bodyLimit: 1024 },
    async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ message: '本机页面来源无效。' });
      if (options.connection.view().sourceState === 'unavailable')
        return reply.code(503).send({ error: 'rivalhub_source_state_unavailable' });
      if (!options.connection.view().sourceCleanup?.handoffPending)
        return reply.code(409).send({ message: '数据源交接状态已变化，请重新检查。' });
      if (sourceCommand) return reply.code(409).send({ message: '数据源操作正在进行，请稍候。' });
      try {
        sourceCommand = options.connection.retryExitHandoffs();
        await sourceCommand;
        return { pending: true, message: '本地交接已记录，正在核对网站数据源释放。' };
      } catch (error) {
        request.log.error({ err: error }, 'RivalHub handoff retry failed');
        return reply.code(502).send({ message: '数据源交接仍未确认，请稍后再试。' });
      } finally {
        sourceCommand = null;
      }
    },
  );
  app.post('/operator/rivalhub/source/release', { bodyLimit: 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ message: '本机页面来源无效。' });
    if (options.connection.view().sourceState === 'unavailable')
      return reply.code(503).send({ error: 'rivalhub_source_state_unavailable' });
    if (!targetMatches(request.body, linkedBinding()))
      return reply.code(409).send({ message: '比赛已变化，请重新打开本场网站同步。' });
    if (sourceCommand) return reply.code(409).send({ message: '数据源操作正在进行，请稍候。' });
    try {
      options.connection.stopSync(linkedBinding()?.context.matchId ?? null);
      sourceCommand = options.connection.release();
      await sourceCommand;
      return options.connection.view();
    } catch (error) {
      request.log.error({ err: error }, 'RivalHub operation failed');
      return reply.code(502).send({
        message: '数据源停止未确认，请稍后再试。',
        sourceCleanup: options.connection.view().sourceCleanup,
      });
    } finally {
      sourceCommand = null;
    }
  });
}

/** Local, read-only historical presentation. The raw statistics endpoint remains unchanged. */
export function registerHistoricalStatsPresentationRoute(
  app: FastifyInstance,
  options: {
    connection: RivalHubConnection | undefined;
    getBinding: () => import('./lkg-store.js').MatchContextBinding | undefined;
  },
) {
  app.get('/local/v1/broadcast-stats-presentation', async (_request, reply) => {
    const binding = options.getBinding();
    const connection = options.connection;
    if (
      !binding ||
      !connection ||
      (binding.origin !== 'online' &&
        !(binding.origin === 'cache' && binding.cachedFrom === 'online'))
    )
      return reply.header('cache-control', 'no-store').send(null);
    const value = await connection.getStats(statsTarget(binding.context));
    if (
      options.getBinding() !== binding ||
      !value ||
      value.matchId !== binding.context.matchId ||
      value.competitionId !== binding.context.competition?.competitionId
    )
      return reply.header('cache-control', 'no-store').send(null);
    const bound = bindHistoricalStats(value, binding.manifest);
    return reply
      .header('cache-control', 'no-store')
      .send(bound ? projectHistoricalStats(bound) : null);
  });
}

/** Fixed program-insert facts, including identity when no historical snapshot exists. */
export function registerHistoricalStatsProgramRoute(
  app: FastifyInstance,
  options: {
    connection: RivalHubConnection | undefined;
    getBinding: () => import('./lkg-store.js').MatchContextBinding | undefined;
    getProgram: () => ProgramPresentation | null;
    getScene: () => ProgramSceneId;
  },
) {
  app.get('/local/v1/broadcast-stats-program', (_request, reply) => {
    const binding = options.getBinding();
    if (!binding) return reply.header('cache-control', 'no-store').send(null);
    const online =
      binding.origin === 'online' ||
      (binding.origin === 'cache' && binding.cachedFrom === 'online');
    const snapshot = online
      ? (options.connection?.getStatsSnapshot(statsTarget(binding.context)) ?? null)
      : null;
    return reply
      .header('cache-control', 'no-store')
      .send(projectHistoricalProgram(binding, snapshot, options.getProgram(), options.getScene()));
  });
}
