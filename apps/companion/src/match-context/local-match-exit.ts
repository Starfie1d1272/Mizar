import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MatchContextController } from './controller.js';
import type { ProgramRuntime } from '../runtime/program-runtime.js';

const qualificationSchema = z.strictObject({
  ticket: z.uuid(),
  matchId: z.string().min(1).max(128),
  contextRevision: z.string().min(1).max(256),
});
const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('prepare') }),
  z.strictObject({ action: z.literal('invalidate') }),
  z.strictObject({ action: z.literal('confirm'), qualification: qualificationSchema }),
]);

interface ExitWitness {
  readonly matchId: string;
  readonly contextRevision: string;
  readonly productionRevision: string;
  readonly sourceGeneration: number;
  readonly receiveSequence: number | null;
  readonly receivedMonotonicMs: number | null;
}

/** Per-run Host authorization only; this is not a second source of game or match state. */
export function registerLocalMatchExitRoutes(
  app: FastifyInstance,
  options: {
    readonly controlToken: string | undefined;
    readonly loopback: boolean;
    readonly controller: MatchContextController;
    readonly runtime: ProgramRuntime;
    readonly isPreparationWaiting: () => boolean;
    readonly productionRevision: () => string;
  },
) {
  let hostConfirmationRequired = false;
  let pending: { readonly ticket: string; readonly witness: ExitWitness } | undefined;
  let confirmed: ExitWitness | undefined;
  const witness = (): ExitWitness | undefined => {
    const binding = options.controller.getActiveBinding();
    if (
      !options.isPreparationWaiting() ||
      binding?.origin !== 'local' ||
      binding.localAuthoringMode !== 'standalone'
    )
      return undefined;
    const source = options.runtime.getSnapshot().current.programSource;
    return {
      matchId: binding.context.matchId,
      contextRevision: options.controller.getActiveRevision(),
      productionRevision: options.productionRevision(),
      sourceGeneration: source.generation,
      receiveSequence: source.lastAccepted?.sequence ?? null,
      receivedMonotonicMs: source.lastAccepted?.receivedMonotonicMs ?? null,
    };
  };
  const matches = (expected: ExitWitness, current: ExitWitness | undefined) =>
    current !== undefined &&
    expected.matchId === current.matchId &&
    expected.contextRevision === current.contextRevision &&
    expected.productionRevision === current.productionRevision &&
    expected.sourceGeneration === current.sourceGeneration &&
    expected.receiveSequence === current.receiveSequence &&
    expected.receivedMonotonicMs === current.receivedMonotonicMs;
  const requireHostConfirmation = () => {
    hostConfirmationRequired = true;
    pending = undefined;
    confirmed = undefined;
  };

  app.post('/operator/runtime/local-match-exit', { bodyLimit: 2048 }, (request, reply) => {
    const expected = Buffer.from(options.controlToken ?? '');
    const token = request.headers['x-runtime-token'];
    const supplied = Buffer.from(typeof token === 'string' ? token : '');
    if (
      !options.loopback ||
      request.headers.origin !== undefined ||
      expected.length === 0 ||
      supplied.length !== expected.length ||
      !timingSafeEqual(expected, supplied)
    )
      return reply.code(403).send({ error: 'runtime-control-denied' });
    const parsed = commandSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ message: '游戏退出确认请求无效，请通过桌面重新确认。' });
    const body = parsed.data;
    if (body.action === 'invalidate') {
      requireHostConfirmation();
      return { ok: true };
    }
    if (body.action === 'prepare') {
      const current = witness();
      requireHostConfirmation();
      if (!current) return { qualification: null };
      pending = { ticket: randomUUID(), witness: current };
      return {
        qualification: {
          ticket: pending.ticket,
          matchId: current.matchId,
          contextRevision: current.contextRevision,
        },
      };
    }
    if (
      !pending ||
      body.qualification.ticket !== pending.ticket ||
      body.qualification.matchId !== pending.witness.matchId ||
      body.qualification.contextRevision !== pending.witness.contextRevision ||
      !matches(pending.witness, witness())
    )
      return reply
        .code(409)
        .send({ message: '比赛或制作状态已变化，退出资格未确认。请通过桌面重新关闭游戏并确认。' });
    confirmed = pending.witness;
    pending = undefined;
    return { ok: true };
  });

  return {
    requireHostConfirmation,
    canConfirmLocalExit: () => Boolean(options.controlToken) && witness() !== undefined,
    canReleaseLocalSelection: () => {
      const current = witness();
      if (!current) return false;
      return (
        (confirmed !== undefined && matches(confirmed, current)) ||
        (!hostConfirmationRequired && current.receiveSequence === null)
      );
    },
  };
}
