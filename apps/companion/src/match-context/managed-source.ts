import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { seriesCheckpointIdentity } from '@mizar/core/series-progress';
import { preparationCancelled } from '../program-scenes/preparation-cancellation.js';
import type { MatchContextController } from './controller.js';
import type { ProgramRuntime, ProgramRuntimeSnapshot } from '../runtime/program-runtime.js';

const identitySchema = z.strictObject({
  pid: z.number().int().positive(),
  created: z.string().regex(/^\d+$/),
  executable: z.string().min(1).max(32768),
});
const sourceRequest = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('prepare'),
    requestId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9_-]+$/),
    preparationId: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({
    action: z.literal('commit'),
    ticket: z.string().uuid(),
    managedSessionIdentity: identitySchema,
  }),
  z.strictObject({
    action: z.literal('resume'),
    ticket: z.string().uuid(),
    sourceId: z.string().uuid(),
    managedSessionIdentity: identitySchema,
  }),
  z.strictObject({
    action: z.literal('rebind'),
    ticket: z.string().uuid(),
    sourceId: z.string().uuid(),
    managedSessionIdentity: identitySchema,
  }),
  z.strictObject({
    action: z.literal('cancel'),
    ticket: z.string().uuid().optional(),
    requestId: z.string().min(1).max(128).optional(),
  }),
  z.strictObject({
    action: z.literal('retire'),
    phase: z.enum(['prepare', 'settle', 'confirm', 'abort']),
    ticket: z.string().uuid().optional(),
    expectedSourceId: z.string().uuid().optional(),
  }),
]);

type Prepared = {
  ticket: string;
  sourceId: string;
  requestId: string;
  matchId: string | null;
  productionSession: string;
  plan: string | null;
  preparationId?: string;
  identity?: string;
};
type Retirement = {
  ticket: string;
  sourceId: string | null;
  productionSession: string;
  generation: number;
  sequence: number | null;
  settled: boolean;
  expectedSourceId?: string;
};

/** Host-authenticated source lifecycle; the GSI installation token remains the authenticator. */
export function registerManagedSourceRoutes(
  app: FastifyInstance,
  options: {
    controlToken: string | undefined;
    loopback: boolean;
    controller: MatchContextController | null;
    runtime: ProgramRuntime;
    productionSession: () => string;
    onRuntimeCommit: (snapshot: ProgramRuntimeSnapshot) => void;
  },
) {
  let pending: Prepared | undefined;
  let active: Prepared | undefined;
  let retirement: Retirement | undefined;
  let completedRetirement: string | undefined;
  const retiredSources = new Set<string>();
  let retired = false;
  let activated = false;
  const binding = () => options.controller?.getActiveBinding();
  const source = () => options.runtime.getCurrentState().programSource;
  const plan = () =>
    binding() ? JSON.stringify(seriesCheckpointIdentity(binding()!.context)) : null;
  const sameOwnerPlan = (item: Prepared) =>
    (binding()?.context.matchId ?? null) === item.matchId && plan() === item.plan;
  const sameSelection = (item: Prepared) =>
    sameOwnerPlan(item) &&
    options.productionSession() === item.productionSession &&
    (!item.preparationId || !preparationCancelled(item.preparationId));
  app.post('/operator/runtime/managed-source', { bodyLimit: 65536 }, (request, reply) => {
    const expected = Buffer.from(options.controlToken ?? '');
    const supplied = Buffer.from(
      typeof request.headers['x-runtime-token'] === 'string'
        ? request.headers['x-runtime-token']
        : '',
    );
    if (
      !options.loopback ||
      request.headers.origin !== undefined ||
      expected.length === 0 ||
      supplied.length !== expected.length ||
      !timingSafeEqual(expected, supplied)
    )
      return reply.code(403).send({ error: 'runtime_control_denied' });
    const parsed = sourceRequest.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'managed_source_invalid' });
    const body = parsed.data;
    const clearDanglingRetirement = () => {
      if (retirement && retirement.sourceId === null && !active) retirement = undefined;
    };
    const conflictContext = () => ({
      ...(active ? { activeSourceId: active.sourceId } : {}),
      ...(retirement
        ? { retirementTicket: retirement.ticket, retirementSourceId: retirement.sourceId }
        : {}),
    });
    const activateEntry = (
      ticket: string,
      sourceId: string,
      requestId: string,
      identity?: string,
    ): Prepared => ({
      ticket,
      sourceId,
      requestId,
      matchId: binding()?.context.matchId ?? null,
      productionSession: options.productionSession(),
      plan: plan(),
      ...(identity !== undefined ? { identity } : {}),
    });
    if (body.action === 'prepare') {
      clearDanglingRetirement();
      if (active || retirement)
        return reply.code(409).send({ error: 'managed_source_not_retired', ...conflictContext() });
      if (pending && pending.requestId !== body.requestId)
        return reply.code(409).send({ error: 'managed_source_pending' });
      pending ??= {
        ...activateEntry(randomUUID(), randomUUID(), body.requestId),
        ...(body.preparationId ? { preparationId: body.preparationId } : {}),
      };
      if (!sameSelection(pending))
        return reply.code(409).send({ error: 'managed_source_selection_changed' });
      return {
        ticket: pending.ticket,
        sourceId: pending.sourceId,
        gsiUri: `http://127.0.0.1:3000/gsi?source=${pending.sourceId}`,
      };
    }
    if (body.action === 'resume') {
      const currentMatch = binding()?.context.matchId ?? null;
      const identity = JSON.stringify(body.managedSessionIdentity);
      if (active) {
        if (
          active.ticket === body.ticket &&
          active.sourceId === body.sourceId &&
          active.identity === identity &&
          active.matchId === currentMatch
        )
          return { ok: true };
        return reply.code(409).send({ error: 'managed_source_identity_changed' });
      }
      if (pending || retirement || retiredSources.has(body.sourceId))
        return reply
          .code(409)
          .send({ error: 'managed_source_resume_unavailable', ...conflictContext() });
      // The authenticated Host independently verifies PID, creation time, executable and CFG.
      // Map continuity qualifies result restoration, not whether fresh input may be received.
      const execution = options.runtime.resumeManagedSource(body.sourceId, currentMatch);
      active = activateEntry(body.ticket, body.sourceId, '', identity);
      activated = true;
      retired = false;
      options.onRuntimeCommit(execution.snapshot);
      return { ok: true, executionRestored: execution.restored };
    }
    if (body.action === 'rebind') {
      clearDanglingRetirement();
      if (retirement)
        return reply
          .code(409)
          .send({ error: 'managed_retirement_in_progress', ...conflictContext() });
      if (retiredSources.has(body.sourceId))
        return reply.code(409).send({ error: 'managed_source_already_retired' });
      const identity = JSON.stringify(body.managedSessionIdentity);
      if (
        active &&
        (active.sourceId !== body.sourceId || (active.identity && active.identity !== identity))
      )
        return reply
          .code(409)
          .send({ error: 'managed_source_identity_changed', ...conflictContext() });
      if (pending && pending.sourceId !== body.sourceId)
        return reply.code(409).send({ error: 'managed_source_pending' });
      const previous = active;
      const next = activateEntry(
        body.ticket,
        body.sourceId,
        (active ?? pending)?.requestId ?? '',
        identity,
      );
      const reconcilesRuntime =
        activated &&
        Boolean(previous) &&
        (previous!.matchId !== next.matchId || previous!.plan !== next.plan);
      const execution = reconcilesRuntime
        ? options.runtime.resumeManagedSource(body.sourceId, next.matchId)
        : undefined;
      active = next;
      pending = undefined;
      retired = false;
      if (execution) options.onRuntimeCommit(execution.snapshot);
      return execution ? { ok: true, executionRestored: execution.restored } : { ok: true };
    }
    if (body.action === 'commit') {
      if (retirement)
        return reply
          .code(409)
          .send({ error: 'managed_retirement_in_progress', ...conflictContext() });
      const item = active?.ticket === body.ticket ? active : pending;
      if (!item || item.ticket !== body.ticket || !sameSelection(item))
        return reply.code(409).send({ error: 'managed_source_selection_changed' });
      const identity = JSON.stringify(body.managedSessionIdentity);
      if (item.identity && item.identity !== identity)
        return reply.code(409).send({ error: 'managed_source_identity_changed' });
      item.identity = identity;
      active = item;
      pending = undefined;
      retired = false;
      return { ok: true };
    }
    if (body.action === 'cancel') {
      if (!body.ticket && !body.requestId)
        return reply.code(400).send({ error: 'managed_source_invalid' });
      if (pending && (pending.ticket === body.ticket || pending.requestId === body.requestId))
        pending = undefined;
      else if (active && (active.ticket === body.ticket || active.requestId === body.requestId))
        return reply.code(409).send({ error: 'managed_source_already_active' });
      return { ok: true };
    }
    if (body.phase === 'prepare') {
      if (
        body.expectedSourceId &&
        (active?.sourceId ?? pending?.sourceId ?? body.expectedSourceId) !== body.expectedSourceId
      )
        return reply.code(409).send({ error: 'managed_retirement_changed' });
      if (retirement) {
        const currentSource = active?.sourceId ?? null;
        if (
          retirement.productionSession === options.productionSession() &&
          retirement.sourceId === currentSource
        ) {
          if (
            body.expectedSourceId &&
            retirement.expectedSourceId &&
            retirement.expectedSourceId !== body.expectedSourceId
          )
            return reply.code(409).send({ error: 'managed_retirement_changed' });
          const current = source();
          if (current.generation !== retirement.generation)
            retirement = {
              ...retirement,
              generation: current.generation,
              sequence: current.lastAccepted?.sequence ?? null,
              settled: false,
            };
          if (body.expectedSourceId) retirement.expectedSourceId ??= body.expectedSourceId;
          return { ticket: retirement.ticket };
        }
      }
      const current = source();
      retirement = {
        ticket: randomUUID(),
        sourceId: active?.sourceId ?? null,
        productionSession: options.productionSession(),
        generation: current.generation,
        sequence: current.lastAccepted?.sequence ?? null,
        settled: false,
        ...(body.expectedSourceId ? { expectedSourceId: body.expectedSourceId } : {}),
      };
      return { ticket: retirement.ticket };
    }
    if (body.phase === 'abort') {
      if (!body.ticket) return reply.code(400).send({ error: 'managed_source_invalid' });
      if (body.ticket === completedRetirement) return { ok: true };
      if (retirement && retirement.ticket !== body.ticket)
        return reply.code(409).send({ error: 'managed_retirement_changed' });
      retirement = undefined;
      return { ok: true };
    }
    if (body.ticket && body.ticket === completedRetirement) return { ok: true };
    if (
      !retirement ||
      retirement.ticket !== body.ticket ||
      retirement.productionSession !== options.productionSession() ||
      retirement.sourceId !== (active?.sourceId ?? null)
    )
      return reply.code(409).send({ error: 'managed_retirement_changed' });
    const current = source();
    if (body.phase === 'settle') {
      retirement = {
        ...retirement,
        generation: current.generation,
        sequence: current.lastAccepted?.sequence ?? null,
        settled: true,
      };
      return { ok: true };
    }
    if (
      !retirement.settled ||
      retirement.generation !== current.generation ||
      retirement.sequence !== (current.lastAccepted?.sequence ?? null)
    )
      return reply.code(409).send({ error: 'managed_retirement_changed' });
    const retiredId = active?.sourceId ?? retirement.sourceId;
    if (retiredId) retiredSources.add(retiredId);
    const committed = options.runtime.retireManagedSource();
    active = undefined;
    pending = undefined;
    retirement = undefined;
    retired = true;
    activated = false;
    completedRetirement = body.ticket;
    options.onRuntimeCommit(committed);
    return { ok: true };
  });
  return {
    classify(sourceId: string | undefined): 'managed' | 'external' | 'drop' {
      if (sourceId !== undefined) return active?.sourceId === sourceId ? 'managed' : 'drop';
      return active ? 'drop' : 'external';
    },
    ownerForFirstObservation(
      sourceId: string | undefined,
    ): { matchId: string; origin: 'fixture' | 'production' } | undefined {
      if (
        !active ||
        active.sourceId !== sourceId ||
        activated ||
        !sameOwnerPlan(active) ||
        (active.preparationId && preparationCancelled(active.preparationId)) ||
        !active.matchId
      )
        return undefined;
      return {
        matchId: active.matchId,
        origin: binding()?.origin === 'fixture' ? 'fixture' : 'production',
      };
    },
    confirmFirstObservation(sourceId: string): void {
      if (active?.sourceId === sourceId) activated = true;
    },
    sourceMatchesSelection(sourceId: string): boolean {
      return Boolean(
        active?.sourceId === sourceId &&
        active.matchId &&
        sameOwnerPlan(active) &&
        (activated || !active.preparationId || !preparationCancelled(active.preparationId)),
      );
    },
    unverifiedExternal: () => retired || pending !== undefined,
  };
}
