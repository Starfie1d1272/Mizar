import { obsOutputCommandSchema } from '@mizar/protocol/obs';
import { ObsOutputError } from './outputs.js';
import type { FastifyInstance } from 'fastify';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import { ObsAdapter, obsFailureKind, obsErrorEvidence } from './adapter.js';
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
  app.get('/local/v1/obs/outputs', async (_request, reply) =>
    reply.header('cache-control', 'no-store').send(await options.adapter.outputStatus()),
  );
  app.post('/operator/obs/output', { bodyLimit: 2048 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const parsed = obsOutputCommandSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'obs_output_invalid', message: 'OBS 操作格式有误。' });
    try {
      return { ok: true, outputs: await options.adapter.outputCommand(parsed.data) };
    } catch (error) {
      if (error instanceof ObsOutputError)
        return reply.code(409).send({ error: error.code, message: error.message });
      return reply
        .code(409)
        .send({ error: 'obs_output_failed', message: 'OBS 操作未完成，请重新核对状态。' });
    }
  });
  app.get('/local/v1/obs/confidence', async (_request, reply) =>
    reply
      .header('cache-control', 'no-store')
      .send({ preview: await options.adapter.confidencePreview() }),
  );
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
      await options.adapter.configure(config);
      return { ok: true, passwordConfigured: Boolean(config.password) };
    } catch (error) {
      if (error instanceof ObsOutputError)
        return reply.code(409).send({ error: error.code, message: error.message });
      return reply.code(400).send({ error: 'obs_config_invalid', message: 'OBS 配置格式有误。' });
    }
  });
  for (const action of [
    'check',
    'ensure',
    'audio-setup',
    'repair',
    'open',
    'launch-target',
  ] as const) {
    app.post(`/operator/obs/${action}`, { bodyLimit: 2048 }, async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      try {
        if (action === 'ensure' || action === 'repair' || action === 'check') {
          request.log.info(
            { event: 'obs', stage: 'obs_preparation_start', action },
            'OBS preparation started',
          );
          const findings =
            action === 'ensure'
              ? await options.adapter.ensure()
              : action === 'repair'
                ? await options.adapter.repair(options.activeScene)
                : await options.adapter.check();
          request.log.info(
            {
              event: 'obs',
              stage: 'obs_preparation_result',
              action,
              findings: findings.map((item) => item.code.split(':')[0]),
            },
            'OBS preparation checked',
          );
          return { ok: true, findings };
        }
        if (action === 'audio-setup') {
          await options.adapter.setupAudio();
          return { ok: true };
        }
        if (action === 'open') {
          await options.adapter.open();
          return { ok: true };
        }
        if (action === 'launch-target') {
          return { ok: true, executablePath: await options.adapter.launchTarget() };
        }
      } catch (error: unknown) {
        if (error instanceof ObsOutputError)
          return reply.code(409).send({ error: error.code, message: error.message });
        const password = (await options.configStore.read().catch(() => undefined))?.password;
        request.log.error(
          {
            event: 'obs',
            stage: 'obs_operator_action',
            action,
            diagnostic: { error: obsErrorEvidence(error, password) },
          },
          'OBS operation failed',
        );
        const kind = obsFailureKind(error);
        const message =
          kind === 'unknown' &&
          error instanceof Error &&
          (action === 'audio-setup' ||
            error.message.startsWith('OBS 正在输出') ||
            ((action === 'open' || action === 'launch-target') &&
              ['未找到 OBS，请在设置中选择 obs64.exe。', 'OBS 程序未能打开。'].includes(
                error.message,
              )))
            ? error.message
            : kind === 'authentication'
              ? 'OBS 密码验证失败，尚未连接。请重新复制 WebSocket 密码，粘贴后保存并测试连接。'
              : kind === 'refused'
                ? 'OBS 拒绝连接。请打开 OBS，启用 WebSocket 服务器并核对端口，再保存并测试连接。'
                : kind === 'timeout'
                  ? '等待 OBS 响应超时。请确认 OBS 正常响应并核对 WebSocket 设置，再测试连接。'
                  : action === 'check'
                    ? 'OBS 场景检查失败，具体原因未确认。请查看诊断后重新检查。'
                    : 'OBS 操作失败，具体原因未确认。请查看诊断后处理。';
        return reply.code(409).send({ error: 'obs_action_failed', message });
      }
    });
  }
}
