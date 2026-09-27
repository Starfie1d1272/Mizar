import type { FastifyInstance } from 'fastify';
import { bpDemoCommandResultSchema, bpDemoCommandSchema } from '@rivalhub-broadcast/protocol/bp';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { BpSession } from './controller.js';
import type { BpDemoStateController } from './demo-state.js';

export function registerBpDemoRoute(
  app: FastifyInstance,
  options: {
    readonly originPolicy: LocalWebOriginPolicy;
    readonly session: BpSession;
    readonly state: BpDemoStateController;
  },
): void {
  app.post('/operator/bp-demo', { bodyLimit: 4096 }, (request, reply) => {
    if (
      options.originPolicy.mode !== 'loopback' ||
      !checkLocalWebOrigin(options.originPolicy, request.headers.origin).allowed
    ) {
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    }
    const command = bpDemoCommandSchema.safeParse(request.body);
    if (!command.success) return reply.code(400).send({ error: 'invalid_bp_demo_command' });
    if (!options.state.apply(command.data, options.session.get().state)) {
      return reply.code(409).send({
        error: 'bp_demo_session_visible',
        message: '请先收起当前 BP 场景。',
      });
    }
    return bpDemoCommandResultSchema.parse({
      ok: true,
      demo: { active: options.state.getState() },
    });
  });
}
