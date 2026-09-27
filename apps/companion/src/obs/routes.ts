import type { FastifyInstance } from 'fastify';
import type { ProgramSceneId } from '@rivalhub-broadcast/protocol/program-scenes';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import { ObsAdapter } from './adapter.js';
import { ObsConfigStore, validateObsConfig } from './config.js';
import { obsSceneName } from './desired-state.js';

export function registerObsRoutes(
  app: FastifyInstance,
  options: {
    readonly adapter: ObsAdapter;
    readonly configStore: ObsConfigStore;
    readonly originPolicy: LocalWebOriginPolicy;
    readonly activeScene: () => ProgramSceneId;
  },
) {
  const allowed = (origin: string | undefined) =>
    options.originPolicy.mode === 'loopback' &&
    checkLocalWebOrigin(options.originPolicy, origin).allowed;
  app.get('/local/v1/obs', async (_request, reply) => {
    const status = await options.adapter.status();
    return reply.header('cache-control', 'no-store').send({
      ...status,
      sceneAligned:
        status.connection === 'connected'
          ? status.currentScene === obsSceneName(options.activeScene())
          : null,
    });
  });
  app.post('/operator/obs/configure', { bodyLimit: 4096 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      const value = request.body as Record<string, unknown> | null;
      const old = await options.configStore.read();
      const config = validateObsConfig({
        executablePath:
          value?.executablePath === undefined ? old.executablePath : value.executablePath,
        host: '127.0.0.1',
        port: value?.port === undefined ? old.port : value.port,
        password: value?.password === undefined ? old.password : value.password,
      });
      await options.configStore.save(config);
      return { ok: true, passwordConfigured: Boolean(config.password) };
    } catch {
      return reply.code(400).send({ error: 'obs_config_invalid', message: 'OBS 配置格式有误。' });
    }
  });
  for (const action of ['check', 'repair', 'open'] as const) {
    app.post(`/operator/obs/${action}`, { bodyLimit: 2048 }, async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      try {
        if (action === 'check') return { ok: true, findings: await options.adapter.check() };
        if (action === 'repair') {
          const findings = await options.adapter.repair(options.activeScene);
          return { ok: true, findings };
        }
        if (action === 'open') {
          await options.adapter.open();
          return { ok: true };
        }
      } catch (error: unknown) {
        const message =
          error instanceof Error && error.message.startsWith('OBS 正在输出')
            ? error.message
            : 'OBS 操作未完成，请检查连接与配置。';
        return reply.code(409).send({ error: 'obs_action_failed', message });
      }
    });
  }
}
