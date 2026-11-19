import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { renewalDiagnostics } from './repeated-diagnostic.js';
import { diagnosticValue, type SessionJournal } from './session-journal.js';

type ControlState = {
  production: unknown;
  program: unknown;
  runtime: unknown;
  hud: unknown;
  match: unknown;
};

export function registerOperationDiagnostics(
  app: FastifyInstance,
  sessionJournal: SessionJournal | undefined,
  readState: () => ControlState,
): () => void {
  const browserOperationId = (value: unknown): string | null =>
    typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value)
      ? value
      : null;
  const requestEvidence = (request: FastifyRequest) => ({
    requestId: request.id,
    browserOperationId: browserOperationId(request.headers['x-mizar-operation-id']),
    method: request.method,
    route: request.routeOptions.url,
  });
  app.addHook('onRequest', (request, _reply, done) => {
    if (sessionJournal)
      sessionJournal.withRequest(
        {
          requestId: request.id,
          browserOperationId: browserOperationId(request.headers['x-mizar-operation-id']),
          taskId: browserOperationId(request.headers['x-mizar-task-id']),
          parentOperationId: browserOperationId(request.headers['x-mizar-parent-operation-id']),
          attemptId: browserOperationId(request.headers['x-mizar-attempt-id']),
          trigger:
            request.headers['x-mizar-trigger'] === 'user'
              ? 'user'
              : request.headers['x-mizar-trigger'] === 'system'
                ? 'system'
                : 'unattributed',
        },
        done,
      );
    else done();
  });
  const isControl = (request: FastifyRequest) =>
    request.method !== 'GET' &&
    /^(?:\/operator\/|\/runtime\/)/.test(request.routeOptions.url ?? '');
  const renewalRoutes = ['/operator/runtime/observer', '/operator/runtime/camera-session'];
  const renewalRoute = (request: FastifyRequest) =>
    request.method === 'POST' && renewalRoutes.includes(request.routeOptions.url ?? '');
  // Body parsing happens after onRequest. Keep the original state in memory so
  // rejected commands and failed renewals retain their complete before/after evidence.
  const renewalRequests = new WeakMap<
    FastifyRequest,
    {
      before: ReturnType<typeof readState>;
      startedAt: number;
      receivedAt: string;
      compact: boolean;
      beforeRecorded: boolean;
      handlerStartedAt: string | null;
      identity?: string;
    }
  >();
  const renewalContext = (state: ReturnType<typeof readState>) =>
    JSON.stringify({
      production: state.production,
      program: state.program,
      hud: state.hud,
      match: state.match,
    });
  const renewalObservations = renewalDiagnostics(renewalRoutes, sessionJournal);
  const recordRenewalStart = (request: FastifyRequest, deferredUntilResult = false) => {
    const renewal = renewalRequests.get(request);
    if (!renewal || renewal.beforeRecorded) return;
    sessionJournal?.record('operation_received', {
      ...requestEvidence(request),
      before: renewal.before,
      receivedAt: renewal.receivedAt,
      ...(deferredUntilResult ? { deferredUntilResult: true } : {}),
    });
    if (renewal.handlerStartedAt)
      sessionJournal?.record('operation_begin', {
        ...requestEvidence(request),
        parameters: diagnosticValue(request.body),
        startedAt: renewal.handlerStartedAt,
        ...(deferredUntilResult ? { deferredUntilResult: true } : {}),
      });
    renewal.beforeRecorded = true;
  };
  app.addHook('onRequest', (request, _reply, done) => {
    if (sessionJournal && isControl(request)) {
      const before = readState();
      if (renewalRoute(request))
        renewalRequests.set(request, {
          before: structuredClone(before),
          startedAt: performance.now(),
          receivedAt: new Date().toISOString(),
          compact: false,
          beforeRecorded: false,
          handlerStartedAt: null,
        });
      else
        sessionJournal?.record('operation_received', {
          ...requestEvidence(request),
          before,
        });
    }
    done();
  });
  app.addHook('preHandler', (request, _reply, done) => {
    if (isControl(request)) {
      const renewal = renewalRequests.get(request);
      if (renewal) {
        renewal.handlerStartedAt = new Date().toISOString();
        // Only uncorrelated system pulses are observations. User/task commands,
        // new identities and changed control contexts keep the full start chain.
        if (
          (request.body as { action?: unknown } | null)?.action === 'pulse' &&
          !['operation-id', 'task-id', 'parent-operation-id', 'attempt-id', 'trigger'].some(
            (field) => request.headers[`x-mizar-${field}`] !== undefined,
          )
        ) {
          renewal.identity = createHash('sha256')
            .update(JSON.stringify([request.body, renewalContext(renewal.before)]))
            .digest('hex');
          if (renewalObservations.get(request.routeOptions.url!)?.identity === renewal.identity)
            return done();
        }
        recordRenewalStart(request);
        return done();
      }
      sessionJournal?.record('operation_begin', {
        ...requestEvidence(request),
        parameters: diagnosticValue(request.body),
        filename: request.headers['x-mizar-filename'],
      });
    }
    done();
  });
  app.addHook('onSend', (request, reply, payload, done) => {
    if (sessionJournal && isControl(request)) {
      let result: unknown = payload;
      if (typeof payload === 'string') {
        try {
          result = JSON.parse(payload);
        } catch {
          result = { bytes: Buffer.byteLength(payload) };
        }
      }
      const renewal = renewalRequests.get(request);
      const after = readState();
      const outcome = result as { ok?: unknown; failed?: unknown } | null;
      const compact = Boolean(
        renewal &&
        renewal.identity &&
        reply.statusCode >= 200 &&
        reply.statusCode < 300 &&
        outcome?.ok === true &&
        outcome.failed !== true &&
        renewalContext(renewal.before) === renewalContext(after),
      );
      if (renewal) renewal.compact = compact;
      const evidence = {
        ...requestEvidence(request),
        httpStatus: reply.statusCode,
        result,
        ...(renewal ? { durationMs: performance.now() - renewal.startedAt } : {}),
        ...(compact
          ? { renewal: true, controlContextUnchanged: true }
          : { ...(renewal && !renewal.beforeRecorded ? { before: renewal.before } : {}) }),
        after,
      };
      const observation = renewalObservations.get(request.routeOptions.url ?? '');
      if (compact && observation) {
        const key = createHash('sha256')
          .update(JSON.stringify([renewal!.identity, result]))
          .digest('hex');
        if (observation.key !== key) recordRenewalStart(request, true);
        observation.identity = renewal!.identity!;
        observation.key = key;
        observation.repeated.record('runtime_renewal', key, {
          ...evidence,
          parameters: diagnosticValue(request.body),
          renewalIdentity: renewal!.identity,
        });
      } else {
        if (observation) {
          observation.clear();
          recordRenewalStart(request, true);
        }
        sessionJournal.record('operation_result', evidence);
      }
    }
    done(null, payload);
  });
  app.addHook('onResponse', async (request, reply) => {
    if (
      reply.statusCode >= 400 ||
      (request.method !== 'GET' &&
        request.routeOptions.url?.startsWith('/operator/') &&
        !renewalRequests.get(request)?.compact)
    )
      request.log.info(
        {
          method: request.method,
          route: request.routeOptions.url,
          res: { statusCode: reply.statusCode },
        },
        'Local operation completed',
      );
  });
  app.addHook('onError', async (request, _reply, error) => {
    sessionJournal?.record('request_error', {
      ...requestEvidence(request),
      error,
    });
    request.log.error({ err: error, route: request.routeOptions.url }, 'Local operation failed');
  });
  return renewalObservations.clear;
}
