import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { canonicalizeCs2MapName } from '@mizar/core/map-name';
import type { SeriesBindingView } from '@mizar/protocol/operator';
import type { OperatorProjection } from '../projections/operator-projection.js';
import type { OperatorCommand, SeriesProgress } from '@mizar/core/series-progress';

import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { SeriesOperatorCommandResult } from '../runtime/program-runtime.js';

export interface OperatorCommandControllerOptions {
  readonly originPolicy: LocalWebOriginPolicy;
  readonly execute: (command: OperatorCommand) => SeriesOperatorCommandResult;
  readonly getBindingState?: () => {
    readonly contextRevision: string;
    readonly operator: OperatorProjection;
    readonly ownership: SeriesBindingView['ownership'];
  } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function originForbidden(reply: FastifyReply): void {
  void reply.code(403).send({ error: 'operator_origin_forbidden' });
}

function mutationUnavailableOnLan(reply: FastifyReply): void {
  void reply.code(403).send({ error: 'operator_mutation_loopback_only' });
}

function commandResult(result: SeriesOperatorCommandResult): Record<string, unknown> {
  const progress = result.progress;
  return {
    ok: result.ok,
    code: result.code,
    series: progress === null ? null : seriesStatus(progress),
  };
}

function seriesStatus(progress: SeriesProgress): Record<string, unknown> {
  return {
    bindingState: progress.bindingState,
    currentMapOrder: progress.currentMapOrder,
    score: progress.score,
    issues: progress.issues.map((item) => ({ ...item })),
  };
}

export function registerOperatorCommandRoutes(
  app: FastifyInstance,
  options: OperatorCommandControllerOptions,
): void {
  const bindingView = (): SeriesBindingView | null => {
    const state = options.getBindingState?.();
    const operator = state?.operator;
    const progress = operator?.seriesProgress;
    const matchId = operator?.matchContext.summary?.matchId;
    if (!state || !operator || !progress || !matchId) return null;
    const mapName =
      operator.runtime.mapName === null ? null : canonicalizeCs2MapName(operator.runtime.mapName);
    const targets = progress.maps
      .filter(
        (map) => (map.status === 'pending' || map.status === 'current') && map.mapName === mapName,
      )
      .map((map) => ({ mapOrder: map.mapOrder, mapName: map.mapName }));
    const blockedReason =
      progress.score.a >= progress.requiredWins || progress.score.b >= progress.requiredWins
        ? ('series_completed' as const)
        : state.ownership.status === 'attention' && !state.ownership.canConfirm
          ? state.ownership.reason === 'previous_execution'
            ? 'execution_owned_elsewhere'
            : 'execution_unverified'
          : operator.runtime.telemetryFreshness !== 'fresh' || mapName === null
            ? ('awaiting_data' as const)
            : operator.identity.state !== 'matched'
              ? ('identity_unverified' as const)
              : targets.length === 0
                ? ('no_matching_map' as const)
                : null;
    // The review token changes with context, execution, target availability and proof,
    // not with every receive frame. No second state owner is introduced.
    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          contextRevision: state.contextRevision,
          matchId,
          mapName,
          sourceGeneration: operator.cursor.programSourceGeneration,
          mapEpoch: operator.cursor.mapEpoch,
          bindingState: progress.bindingState,
          score: progress.score,
          maps: progress.maps,
          blockedReason,
          ownership: state.ownership,
        }),
      )
      .digest('hex');
    return {
      revision,
      matchId,
      mapName,
      bindingState: progress.bindingState,
      ownership: state.ownership,
      canBind:
        blockedReason === null &&
        (state.ownership.canConfirm ||
          (state.ownership.status === 'associated' && progress.bindingState === 'needs_operator')),
      blockedReason,
      targets,
    };
  };
  app.get('/local/v1/series-binding', (_request, reply) =>
    reply.header('cache-control', 'no-store').send({ binding: bindingView() }),
  );
  app.post('/operator/series/bind', (request, reply) => {
    if (options.originPolicy.mode !== 'loopback') {
      mutationUnavailableOnLan(reply);
      return;
    }
    if (!checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed) {
      originForbidden(reply);
      return;
    }

    const body: unknown = request.body;
    const kind = isRecord(body) ? body.kind : undefined;
    const mapOrder = isRecord(body) ? body.mapOrder : undefined;
    const reason = isRecord(body) ? body.reason : undefined;
    if (
      kind !== 'bind-current-map-execution-to-series-map' ||
      !isPositiveInteger(mapOrder) ||
      mapOrder > 5 ||
      typeof reason !== 'string' ||
      reason.trim().length === 0 ||
      reason.length > 512
    ) {
      return reply.code(400).send({ error: 'invalid_operator_series_bind_command' });
    }

    if (options.getBindingState) {
      const view = bindingView();
      if (!view)
        return reply
          .code(409)
          .send({ ok: false, code: 'series_unbound', message: '请先选择比赛并等待游戏数据。' });
      const expectedRevision = isRecord(body) ? body.expectedRevision : undefined;
      if (typeof expectedRevision !== 'string' || expectedRevision !== view.revision)
        return reply.code(409).send({ message: '比赛或地图已变化，请重新核对当前图。' });
      if (!view.canBind || !view.targets.some((target) => target.mapOrder === mapOrder))
        return reply
          .code(409)
          .send({ message: '当前地图没有可确认的位置，或身份尚未核验。已有比分和记录保持不变。' });
    }
    const result = options.execute({
      kind,
      mapOrder,
      reason,
    });
    return reply.code(result.ok ? 200 : 409).send(commandResult(result));
  });
}
