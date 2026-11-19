import type { FastifyInstance } from 'fastify';
import type { DemoTestController } from './controller.js';

export function createDemoMutationGuard() {
  const formalMutations = new Set<string>();
  return {
    canBegin: () => formalMutations.size === 0,
    register(
      app: FastifyInstance,
      demoTest: DemoTestController,
      isTrialPending: () => boolean,
    ): void {
      app.addHook('preParsing', async (request, reply) => {
        if (['GET', 'HEAD'].includes(request.method)) return;
        const path = request.routeOptions.url;
        if (!path?.startsWith('/operator/')) return;
        if (!isTrialPending() && demoTest.get().active !== true) {
          if (!path.startsWith('/operator/runtime/')) formalMutations.add(request.id);
          return;
        }
        if (
          [
            '/operator/runtime/demo-test',
            '/operator/runtime/camera-session',
            '/operator/runtime/mulnx-prepare',
            '/operator/runtime/observer',
            '/operator/runtime/stop',
            '/operator/production',
            '/operator/program-scene',
            // Local evidence capture does not mutate trial or formal match state.
            '/operator/diagnostics/report',
          ].includes(path)
        )
          return;
        if (path === '/operator/orchestration') return;
        // Trial presentation is manual. Keep all match, platform, update and resource mutations excluded.
        return reply
          .code(409)
          .send({ error: 'demo_test_active', message: '请先结束试播并完成 CS2 恢复。' });
      });
      app.addHook('preHandler', async (request, reply) => {
        if (
          (isTrialPending() || demoTest.get().active) &&
          request.routeOptions.url === '/operator/orchestration' &&
          !demoTest.canUseCamera((request.body as { action?: unknown } | null)?.action)
        )
          return reply
            .code(409)
            .send({ error: 'demo_camera_manual_only', message: '请在 Demo 试播中手动试播运镜。' });
        if (
          demoTest.get().active !== true ||
          request.routeOptions.url !== '/operator/program-scene'
        )
          return;
        const body = request.body as { sceneId?: unknown } | null;
        if (body?.sceneId === 'waiting') return;
        if (demoTest.get().phase !== 'playing' || !demoTest.get().dataReady)
          return reply
            .code(409)
            .send({ error: 'demo_test_not_ready', message: '请等待有效的 Demo 观察数据。' });
      });
      app.addHook('onResponse', (request, _reply, done) => {
        formalMutations.delete(request.id);
        done();
      });
    },
  };
}
