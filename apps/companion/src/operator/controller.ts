import type { FastifyInstance, FastifyReply } from 'fastify';
import type { OperatorCommand, SeriesProgress } from '@mizar/core/series-progress';

import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { SeriesOperatorCommandResult } from '../runtime/program-runtime.js';

export interface OperatorCommandControllerOptions {
  readonly originPolicy: LocalWebOriginPolicy;
  readonly execute: (command: OperatorCommand) => SeriesOperatorCommandResult;
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

    const result = options.execute({
      kind,
      mapOrder,
      reason,
    });
    return reply.code(result.ok ? 200 : 409).send(commandResult(result));
  });
}
