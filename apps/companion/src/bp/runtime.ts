import type { FastifyInstance } from 'fastify';
import type { LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { ProjectionCoordinator } from '../projections/projection-coordinator.js';
import { registerBpRoutes } from './controller.js';
import { registerBpDemoRoute } from './demo-controller.js';
import { getBpDemoProjection } from './demo-projection.js';
import { BpDemoStateController } from './demo-state.js';

export function registerBpRuntime(
  app: FastifyInstance,
  options: {
    originPolicy: LocalWebOriginPolicy;
    now: (() => number) | undefined;
    getProjection: ProjectionCoordinator['getBpProjection'];
  },
) {
  const bpDemoState = new BpDemoStateController();
  const bpSession = registerBpRoutes(app, {
    originPolicy: options.originPolicy,
    ...(options.now === undefined ? {} : { now: options.now }),
    getProjection: () => bpDemoState.getProjection(options.getProjection, getBpDemoProjection),
  });
  registerBpDemoRoute(app, {
    originPolicy: options.originPolicy,
    session: bpSession,
    state: bpDemoState,
  });
  return { bpDemoState, bpSession };
}
