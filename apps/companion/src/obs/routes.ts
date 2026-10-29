import { z } from 'zod';
import { createObsCaptureDiagnosticReader } from './capture-diagnostic.js';
import {
  obsAudioBindCommandSchema,
  obsGameAudioPolicyCommandSchema,
  obsGameAudioReleaseSchema,
  obsOutputCommandSchema,
} from '@mizar/protocol/obs';
import type { GameAudioController } from './audio-policy-controller.js';
import type { MusicDirector } from '../music/director.js';
import { ObsOutputError } from './outputs.js';
import { ObsActionError, obsActionMessage } from './action-error.js';
import type { ObsNativeEvidence } from './native-evidence.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ProgramSceneId } from '@mizar/protocol/program-scenes';
import {
  checkLocalWebOrigin,
  isLoopbackBindHost,
  type LocalWebOriginPolicy,
} from '../local-web/origin-policy.js';
import { ObsAdapter, obsFailureKind, obsErrorEvidence } from './adapter.js';
import { ObsConfigStore, validateObsConfig } from './config.js';
import { obsSceneName } from './desired-state.js';

const outputMessages: Record<ObsOutputError['code'], string> = {
  obs_output_busy: 'OBS 正在处理操作，请等待状态确认后重试。',
  obs_output_stale: 'OBS 状态已变化，请核对后重新操作。',
  obs_output_unavailable: 'OBS 输出状态无法确认，请等待重新连接。',
  obs_output_disabled: 'OBS 输出未启用，请先在 OBS 完成相应直播或录像配置。',
  obs_output_failed: 'OBS 操作未完成，请检查 OBS 配置与版本，再查看诊断。',
  obs_output_unconfirmed: '操作结果尚未确认，请等待 OBS 重新连接后核对，勿重复操作。',
};
function outputFailure(error: ObsOutputError) {
  const code = Object.hasOwn(outputMessages, error.code) ? error.code : 'obs_output_failed';
  return { error: code, message: outputMessages[code] };
}

export function registerObsRoutes(
  app: FastifyInstance,
  options: {
    readonly adapter: ObsAdapter;
    readonly configStore: ObsConfigStore;
    readonly originPolicy: LocalWebOriginPolicy;
    readonly activeScene: () => ProgramSceneId;
    readonly gameAudio?: GameAudioController;
    readonly musicDirector?: () => MusicDirector | undefined;
    readonly readCaptureEvidence?: () => Promise<ObsNativeEvidence>;
  },
) {
  const captureDiagnostic = createObsCaptureDiagnosticReader(options.readCaptureEvidence);
  const allowed = (origin: string | undefined) =>
    options.originPolicy.mode === 'loopback' &&
    checkLocalWebOrigin(options.originPolicy, origin).allowed;
  const allowedRead = (request: FastifyRequest) => {
    if (request.headers.origin !== undefined) return allowed(request.headers.origin);
    // Browser GETs omit Origin. Require same-origin Fetch Metadata and a local
    // referrer, socket and Host; absence alone never authorizes native reads.
    if (
      options.originPolicy.mode !== 'loopback' ||
      request.headers['sec-fetch-site'] !== 'same-origin' ||
      !isLoopbackBindHost(request.ip) ||
      !isLoopbackBindHost(request.hostname)
    )
      return false;
    try {
      return allowed(new URL(request.headers.referer ?? '').origin);
    } catch {
      return false;
    }
  };
  app.get('/local/v1/obs/game-audio-policy', async (request, reply) => {
    if (!allowedRead(request)) return reply.code(403).send({ error: 'operator_origin_forbidden' });
    return reply
      .header('cache-control', 'no-store')
      .send(
        options.gameAudio
          ? { ...options.gameAudio.status(), desktopMix: await options.gameAudio.desktopMix() }
          : { ready: false },
      );
  });
  app.post('/operator/obs/game-audio-policy', { bodyLimit: 2048 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const parsed = obsGameAudioPolicyCommandSchema.safeParse(request.body);
    if (!parsed.success || !options.gameAudio)
      return reply.code(400).send({ error: 'audio_policy_invalid' });
    try {
      await options.gameAudio.configure(parsed.data.policy, parsed.data.revision);
      return options.gameAudio.status();
    } catch {
      return reply
        .code(409)
        .send({ error: 'audio_policy_unavailable', message: '设置未确认，请稍后重新核对。' });
    }
  });
  app.post('/operator/obs/game-audio-release', { bodyLimit: 2048 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      const parsed = obsGameAudioReleaseSchema.parse(request.body);
      if (!options.gameAudio) throw new Error('unavailable');
      await options.gameAudio.releaseHeld(parsed.revision);
      return options.gameAudio.status();
    } catch {
      return reply
        .code(409)
        .send({ error: 'audio_policy_unavailable', message: '控制权未恢复，请稍后核对。' });
    }
  });
  app.get('/local/v1/obs/remote-commentary', async (request, reply) => {
    if (!allowedRead(request)) return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      return reply.header('cache-control', 'no-store').send(await options.adapter.readCommentary());
    } catch {
      return reply.code(409).send({ error: 'commentary_unavailable' });
    }
  });
  app.post('/operator/obs/remote-commentary', { bodyLimit: 2048 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const result = z
      .object({ revision: z.string().uuid(), mode: z.enum(['autoTeamspeak', 'disabled']) })
      .strict()
      .safeParse(request.body);
    if (!result.success) return reply.code(400).send({ error: 'commentary_invalid' });
    try {
      return await options.adapter.setCommentaryMode(result.data.mode, result.data.revision);
    } catch {
      return reply.code(409).send({ error: 'commentary_changed' });
    }
  });
  app.post(
    '/operator/obs/remote-commentary/applications',
    { bodyLimit: 2048 },
    async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      try {
        return await options.adapter.listCommentaryApplications();
      } catch {
        return reply.code(409).send({ error: 'commentary_candidates_unavailable' });
      }
    },
  );
  app.post(
    '/operator/obs/remote-commentary/application',
    { bodyLimit: 2048 },
    async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      const parsed = z
        .object({ revision: z.string().uuid(), selectionId: z.string().uuid() })
        .strict()
        .safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'commentary_invalid' });
      try {
        return await options.adapter.selectCommentaryApplication(
          parsed.data.selectionId,
          parsed.data.revision,
        );
      } catch {
        return reply.code(409).send({ error: 'commentary_changed' });
      }
    },
  );
  app.post('/operator/obs/audio-mode', { bodyLimit: 2048 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const parsed = z
      .object({ revision: z.string().uuid(), selectionId: z.string().uuid().nullable() })
      .strict()
      .safeParse(request.body);
    if (!parsed.success || !options.gameAudio)
      return reply.code(400).send({ error: 'audio_mode_invalid' });
    try {
      const music = options.musicDirector?.();
      if (!music) throw new Error('music_unavailable');
      await options.gameAudio.switchMode(() =>
        options.adapter.switchAudioMode(
          parsed.data.revision,
          parsed.data.selectionId,
          (obs, same, apply) => music.prepareDesktopMix(obs, same, apply),
        ),
      );
      return { ok: true };
    } catch (error) {
      return reply.code(409).send({
        error: 'audio_mode_unavailable',
        message:
          error instanceof Error && error.message === 'audio_monitor_device_unknown'
            ? '请在 OBS 中将桌面音频与监听设备都设为默认设备，或都选为同一个具体设备，再重试。'
            : error instanceof Error && error.message === 'audio_microphone_monitor'
              ? '麦克风监听会回到桌面混音；请在 OBS 关闭麦克风监听后重试。'
              : error instanceof Error && error.message === 'audio_video_binding'
                ? '游戏或解说音频绑定在画面来源上；请先改为独立音频来源，避免关闭画面。'
                : error instanceof Error && error.message === 'audio_global_path_unresolved'
                  ? '请在 OBS 设置 → 音频关闭全局音频来源，再切换。'
                  : '切换未确认，请检查 OBS 音频、停止输出并重新读取来源。',
      });
    }
  });
  app.get('/local/v1/obs/audio-routing', async (request, reply) => {
    if (!allowedRead(request)) return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      return reply
        .header('cache-control', 'no-store')
        .send(await options.adapter.readAudioRouting());
    } catch {
      return reply.code(409).send({ error: 'audio_routing_unavailable' });
    }
  });
  app.post('/operator/obs/audio-routing', { bodyLimit: 2048 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const parsed = obsAudioBindCommandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'audio_binding_invalid' });
    try {
      await options.adapter.bindAudio(parsed.data);
      return { ok: true };
    } catch {
      return reply.code(409).send({
        error: 'audio_binding_changed',
        message: '绑定结果未确认，请刷新 OBS 来源后核对。',
      });
    }
  });
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
      if (error instanceof ObsOutputError) return reply.code(409).send(outputFailure(error));
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
    const diagnostic = allowedRead(_request) ? captureDiagnostic() : Promise.resolve(null);
    const status = await options.adapter.status();
    return reply.header('cache-control', 'no-store').send({
      ...status,
      captureDiagnostic: await diagnostic,
      expectedScene: obsSceneName(options.activeScene()),
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
      if (error instanceof ObsOutputError) return reply.code(409).send(outputFailure(error));
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
              ? await options.adapter.ensure(options.activeScene)
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
          return { ok: true, findings, captureDiagnostic: await captureDiagnostic(true) };
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
        if (error instanceof ObsOutputError) return reply.code(409).send(outputFailure(error));
        if (error instanceof ObsActionError)
          return reply.code(409).send({
            error: 'obs_action_failed',
            message: obsActionMessage(error.code) ?? 'OBS 操作失败，请查看诊断后处理。',
          });
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
          kind === 'authentication'
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
