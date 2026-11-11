import { audioDeviceCommandSchema } from './audio-device-settings.js';
import { preparationCancelled } from '../program-scenes/preparation-cancellation.js';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { createObsCaptureDiagnosticReader } from './capture-diagnostic.js';
import {
  obsAudioBindCommandSchema,
  obsGameAudioPolicyCommandSchema,
  obsGameAudioReleaseSchema,
  obsOutputCommandSchema,
} from '@mizar/protocol/obs';
import type { GameAudioController } from './audio-policy-controller.js';
import type { MusicAudioMode } from '../music/device.js';
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
import {
  ObsAdapter,
  obsFailureKind,
  obsErrorEvidence,
  obsAudioModeFailureEvidence,
} from './adapter.js';
import { ObsConfigStore, validateObsConfig } from './config.js';
import { ObsVideoError } from './video-transaction.js';
import type { ObsRpc } from './reconcile.js';
import { ObsCaptureWarmupError } from './capture-warmup.js';
import { obsSceneName } from './desired-state.js';
import { obsFindingReadiness } from './prepare-readiness.js';
import { obsReadiness } from '../program-scenes/readiness.js';

const outputMessages: Record<ObsOutputError['code'], string> = {
  obs_output_busy: 'OBS 正在处理操作，请等待状态确认后重试。',
  obs_output_stale: 'OBS 状态已变化，请核对后重新操作。',
  obs_output_unavailable: 'OBS 输出状态无法确认，请等待重新连接。',
  obs_output_disabled: 'OBS 输出未启用，请先在 OBS 完成相应直播或录像配置。',
  obs_output_failed: 'OBS 操作未完成，请检查 OBS 配置与版本，再查看诊断。',
  obs_output_unconfirmed: '操作结果尚未确认，请等待 OBS 重新连接后核对，勿重复操作。',
};
const commentaryRecoveryMessage =
  '上次解说来源切换结果未确认，Mizar 暂不能更改解说选择。请在 OBS 核对音源和电平、录制试听，并保存诊断包排查。';
function outputFailure(error: ObsOutputError) {
  const code = Object.hasOwn(outputMessages, error.code) ? error.code : 'obs_output_failed';
  return { error: code, message: error.message || outputMessages[code] };
}

export function registerObsRoutes(
  app: FastifyInstance,
  options: {
    readonly adapter: ObsAdapter;
    readonly configStore: ObsConfigStore;
    readonly originPolicy: LocalWebOriginPolicy;
    readonly activeScene: () => ProgramSceneId;
    readonly preparationValid: (revision: unknown) => () => boolean;
    readonly canStartOutput?: () => boolean;
    readonly runtimeControlToken?: string;
    readonly gameAudio?: GameAudioController;
    readonly musicAudio?: () => MusicAudioMode | undefined;
    readonly prepareMusic?: (valid: () => boolean, guard: (obs: ObsRpc) => ObsRpc) => Promise<void>;
    readonly readCaptureEvidence?: () => Promise<ObsNativeEvidence>;
  },
) {
  app.post('/operator/runtime/obs-entry-permit', { bodyLimit: 1024 }, async (request, reply) => {
    const token = request.headers['x-runtime-token'];
    const expected = Buffer.from(options.runtimeControlToken ?? '');
    const supplied = Buffer.from(typeof token === 'string' ? token : '');
    if (
      options.originPolicy.mode !== 'loopback' ||
      request.headers.origin !== undefined ||
      expected.length === 0 ||
      supplied.length !== expected.length ||
      !timingSafeEqual(expected, supplied)
    )
      return reply.code(403).send({ error: 'runtime-control-denied' });
    const body = z.object({ preparationId: z.string().uuid() }).strict().safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'preparation_invalid' });
    try {
      await options.adapter.verifyEntryPermit(body.data.preparationId);
      return { ok: true };
    } catch (error) {
      return reply.code(409).send({
        message: error instanceof ObsVideoError ? error.message : 'OBS 启动准备未确认，请重试。',
      });
    }
  });
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
  app.post('/operator/obs/commentary-prepare', { bodyLimit: 2048 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      return { ok: true, findings: await options.adapter.prepareCommentaryAudio() };
    } catch (error) {
      request.log.error(
        {
          event: 'obs',
          stage: 'commentary_prepare',
          diagnostic: {
            error: obsErrorEvidence(
              error,
              (await options.configStore.read().catch(() => undefined))?.password,
            ),
          },
        },
        'OBS commentary preparation failed',
      );
      return reply.code(409).send({
        error: 'commentary_prepare_unavailable',
        message:
          error instanceof Error && error.message === 'audio_video_requires_full_preparation'
            ? '音频绑定包含画面来源或已失效，请在 OBS 核对，或停止输出后使用完整场景准备。'
            : error instanceof Error && error.message === 'audio_bindings_required'
              ? '旧配置尚未登记音频分路，请在声音设置中手动绑定游戏、解说和麦克风来源。'
              : error instanceof ObsVideoError && error.code === 'video_output_active'
                ? 'OBS 视频输出正在运行，请停止对应输出后重试。'
                : error instanceof ObsVideoError && error.code === 'outputs_unknown'
                  ? '无法确认 OBS 输出状态，请检查连接后重试。'
                  : '解说音频准备未确认，请检查 OBS 来源和诊断后重试。',
      });
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
    } catch (error) {
      return reply.code(409).send({
        error: 'commentary_changed',
        message:
          error instanceof Error &&
          error.message === 'commentary_binding_change_requires_independent'
            ? '已有解说来源与此选择不一致，请先在 OBS 核对；桌面声音保持不变。'
            : error instanceof Error && error.message === 'commentary_switch_recovery_required'
              ? commentaryRecoveryMessage
              : '设置未确认，请核对后重试。',
      });
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
      } catch (error) {
        return reply.code(409).send({
          error: 'commentary_changed',
          message:
            error instanceof Error &&
            error.message === 'commentary_binding_change_requires_independent'
              ? '已有解说来源与此选择不一致，请先在 OBS 核对；桌面声音保持不变。'
              : error instanceof Error && error.message === 'commentary_switch_recovery_required'
                ? commentaryRecoveryMessage
                : '设置未确认，请重新读取应用并核对。',
        });
      }
    },
  );
  app.post('/operator/obs/audio-mode', { bodyLimit: 2048 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const parsed = z
      .discriminatedUnion('mode', [
        z
          .object({
            revision: z.string().uuid(),
            mode: z.literal('desktop'),
            selectionId: z.string().uuid().optional(),
          })
          .strict(),
        z.object({ revision: z.string().uuid(), mode: z.literal('independent') }).strict(),
        z.object({ revision: z.string().uuid(), mode: z.literal('cancel') }).strict(),
        z.object({ revision: z.string().uuid(), mode: z.literal('recover') }).strict(),
      ])
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'audio_mode_invalid' });
    try {
      if (parsed.data.mode === 'cancel')
        return { ok: true, ...(await options.adapter.cancelAudioWait(parsed.data.revision)) };
      if (!options.gameAudio) throw new Error('audio_policy_unavailable');
      const command = parsed.data;
      const music = options.musicAudio?.();
      if (!music) throw new Error('music_unavailable');
      const result = await options.gameAudio.switchMode(() =>
        command.mode === 'recover'
          ? options.adapter.recoverAudioMode(music, undefined, command.revision).then(() => ({}))
          : command.mode === 'independent'
            ? options.adapter.requestIndependentMode(command.revision, music)
            : options.adapter.switchAudioMode(
                command.revision,
                'desktop',
                command.selectionId,
                music,
              ),
      );
      return { ok: true, ...result };
    } catch (error) {
      try {
        // Request summaries are separate from detailed connection evidence and
        // contain only safe classifications, including for pre-connection failures.
        request.log.error(
          {
            event: 'obs',
            stage: 'audio_mode_request',
            diagnostic: { mode: parsed.data.mode, summary: obsAudioModeFailureEvidence(error) },
          },
          'OBS audio mode request failed',
        );
      } catch {
        // Diagnostic failures must not replace the operation's result.
      }
      return reply.code(409).send({
        error:
          error instanceof Error && error.message === 'audio_desktop_choice_required'
            ? 'audio_desktop_choice_required'
            : 'audio_mode_unavailable',
        message:
          error instanceof Error && error.message === 'audio_desktop_choice_required'
            ? '检测到多个 OBS 桌面音频来源，请选择来源并在 OBS 核对其播放设备。'
            : error instanceof Error && error.message === 'audio_commentary_unavailable'
              ? '解说来源尚未就绪，桌面混音仍可用。'
              : error instanceof Error &&
                  (error.message.startsWith('audio_nested_shared_path:') ||
                    error.message.startsWith('audio_video_path_unresolved:'))
                ? `来源“${decodeURIComponent(error.message.split(':')[1] ?? '')}”也用于场景“${decodeURIComponent(error.message.split(':')[2] ?? '')}”；请为 Mizar 单独设置该来源后重试。`
                : error instanceof Error && error.message.startsWith('audio_monitor_shared:')
                  ? `来源“${error.message.slice('audio_monitor_shared:'.length)}”也用于其他场景或全局音频；请为 Mizar 单独设置该来源后重试。`
                  : error instanceof Error &&
                      error.message.startsWith('audio_global_path_unresolved:')
                    ? `OBS 全局音频来源“${error.message.slice('audio_global_path_unresolved:'.length)}”与目标重复，请在 OBS 停用该来源后重试。`
                    : parsed.data.mode === 'recover'
                      ? '音频恢复尚未确认。请核对 OBS 连接和当前场景集合后重试；原恢复记录已保留。'
                      : '切换结果未确认，请立即在 OBS 核对直播电平和当前音源；如无声，请手动恢复可用来源，勿反复切换。',
      });
    }
  });
  app.post('/operator/obs/audio-meter', { bodyLimit: 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      return await options.adapter.sampleAudioMeters(
        () => !request.raw.aborted && !reply.raw.destroyed,
      );
    } catch {
      return reply.code(409).send({
        error: 'audio_meter_unavailable',
        message: '电平检查未完成。请核对 OBS 连接与专用集合后重新检查。',
      });
    }
  });
  app.get('/local/v1/obs/audio-devices', async (request, reply) => {
    if (!allowedRead(request)) return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      return reply
        .header('cache-control', 'no-store')
        .send(await options.adapter.readAudioDevices());
    } catch {
      return reply.code(409).send({
        error: 'audio_devices_unavailable',
        message: '设备设置未确认，请重新读取后核对。',
      });
    }
  });
  app.post('/operator/obs/audio-device', { bodyLimit: 4096 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const parsed = audioDeviceCommandSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'audio_device_invalid' });
    try {
      await options.adapter.setAudioDevice(parsed.data);
      return { ok: true };
    } catch (error) {
      const code =
        error instanceof ObsVideoError ? error.code : error instanceof Error ? error.message : '';
      const messages: Record<string, string> = {
        audio_device_monitor_conflict:
          '新设备会改变当前监听回采路径。请先在 OBS 中核对相关音源的监听与节目输出，再更换设备。',
        audio_device_monitor_unknown: '无法确认当前监听回采路径，请在 OBS 中核对后重试。',
        audio_mode_pending: '请先完成或恢复当前音频切换，再更换设备。',
        audio_devices_changed: '设备或音频配置已变化，请重新读取设备后选择。',
        audio_devices_prepare_required: '固定音源身份未确认，请先修复场景与音频，再重新读取设备。',
        video_output_active: 'OBS 正在输出，请停止直播与录像后再更换设备。',
      };
      const known = Object.hasOwn(messages, code);
      const detail = error as { stage?: unknown; inputKind?: unknown } | null;
      const inputKind =
        detail?.stage === 'GetInputAudioMonitorType' &&
        typeof detail.inputKind === 'string' &&
        /^[a-z0-9_-]{1,64}$/i.test(detail.inputKind)
          ? detail.inputKind
          : null;
      const message = known ? messages[code] : '设备设置未确认，请重新读取后核对。';
      return reply.code(409).send({
        error: known ? code : 'audio_device_unconfirmed',
        message: inputKind ? `${message}监听探测音源类型：${inputKind}。` : message,
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
    } catch (error) {
      return reply.code(409).send({
        error: 'audio_binding_changed',
        message:
          error instanceof Error && error.message === 'commentary_switch_recovery_required'
            ? commentaryRecoveryMessage
            : '绑定结果未确认，请刷新 OBS 来源后核对。',
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
    if (parsed.data.action === 'start' && options.canStartOutput?.() === false)
      return reply.code(409).send({
        error: 'obs_output_busy',
        message: '更新正在退出，请等待更新完成或取消后开始 OBS 输出。',
      });
    try {
      return {
        ok: true,
        outputs: await options.adapter.outputCommand(
          parsed.data,
          () =>
            !request.raw.aborted &&
            !reply.raw.destroyed &&
            (parsed.data.action !== 'start' || options.canStartOutput?.() !== false),
        ),
      };
    } catch (error) {
      if (error instanceof ObsOutputError)
        return reply
          .code(409)
          .send({ ...outputFailure(error), outputs: await options.adapter.outputStatus() });
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
    const status = await options.adapter.status().catch((error: unknown) => {
      if (!(error instanceof ObsVideoError) || error.code !== 'obs_observation_changed')
        throw error;
      return null;
    });
    if (!status)
      return reply
        .code(409)
        .send({ error: 'obs_observation_changed', message: 'OBS 状态已变化，请重新检查。' });
    return reply.header('cache-control', 'no-store').send({
      ...status,
      readiness: obsReadiness(status, options.activeScene()),
      captureDiagnostic: await diagnostic,
      expectedScene: obsSceneName(options.activeScene()),
      sceneAligned:
        status.connection === 'connected'
          ? status.currentScene === obsSceneName(options.activeScene())
          : null,
    });
  });
  app.post('/operator/obs/capture-initialization', { bodyLimit: 2048 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = z
      .object({
        expectedRevision: z.unknown(),
        since: z.number().finite(),
        transactionId: z.string().uuid().nullable(),
      })
      .strict()
      .safeParse(request.body);
    const now = Date.now();
    if (!body.success || body.data.since > now || body.data.since < now - 600_000)
      return reply.code(400).send({ error: 'capture_check_invalid' });
    const valid = options.preparationValid(body.data.expectedRevision);
    if (!valid()) return reply.code(409).send({ error: 'preparation_changed' });
    if (
      body.data.transactionId !== null &&
      !(await options.adapter.captureWarmupMatches(body.data.transactionId, body.data.since))
    )
      return reply
        .code(409)
        .send({ error: 'capture_warmup_changed', message: 'OBS 游戏画面检查已中断，请重新检查。' });
    // A read-only recheck has no new warmup boundary: retain current-session failures.
    const diagnostic = await captureDiagnostic(
      true,
      body.data.transactionId === null ? 0 : body.data.since,
    );
    try {
      const status = await options.adapter.captureInitialization(
        diagnostic,
        body.data.transactionId,
      );
      if (!valid() || request.raw.aborted || reply.raw.destroyed)
        return reply.code(409).send({ error: 'preparation_changed' });
      return reply.header('cache-control', 'no-store').send(status);
    } catch (error) {
      if (error instanceof ObsCaptureWarmupError || error instanceof ObsVideoError)
        return reply.code(409).send({ error: error.code, message: error.message });
      return reply.header('cache-control', 'no-store').send({
        state: 'unknown',
        reason: 'evidence_unknown',
        captureDiagnostic: diagnostic,
      });
    }
  });
  for (const action of ['capture-warmup', 'capture-warmup-release'] as const) {
    app.post(`/operator/obs/${action}`, { bodyLimit: 2048 }, async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      const body = request.body as {
        expectedRevision?: unknown;
        preparationId?: unknown;
        transactionId?: unknown;
      } | null;
      const valid = options.preparationValid(body?.expectedRevision);
      const connected = () => !request.raw.aborted && !reply.raw.destroyed;
      let id: string | undefined;
      let finished = false;
      reply.raw.once('finish', () => {
        finished = true;
      });
      reply.raw.once('close', () => {
        if (!finished && id) void options.adapter.releaseCaptureWarmup(id).catch(() => {});
      });
      try {
        if (action === 'capture-warmup-release') {
          const parsed = z.string().uuid().safeParse(body?.transactionId);
          if (!parsed.success) return reply.code(400).send({ error: 'capture_warmup_invalid' });
          await options.adapter.releaseCaptureWarmup(parsed.data);
          return { ok: true };
        }
        const parsed = z.string().uuid().safeParse(body?.preparationId);
        if (!parsed.success) return reply.code(400).send({ error: 'capture_warmup_invalid' });
        const current = () => valid() && connected() && !preparationCancelled(parsed.data);
        if (!current())
          return reply
            .code(409)
            .send({ error: 'preparation_changed', message: '制作状态已变化，请重试。' });
        const result = await options.adapter.beginCaptureWarmup(parsed.data, current);
        if ('transactionId' in result && result.transactionId) id = result.transactionId;
        if (!current()) {
          if (id) await options.adapter.releaseCaptureWarmup(id);
          return reply
            .code(409)
            .send({ error: 'preparation_changed', message: '制作状态已变化，请重试。' });
        }
        return result;
      } catch (error) {
        if (
          error instanceof ObsCaptureWarmupError ||
          error instanceof ObsVideoError ||
          error instanceof ObsOutputError
        )
          return reply.code(409).send({ error: error.code, message: error.message });
        request.log.error(
          {
            event: 'obs',
            stage: action,
            diagnostic: {
              error: obsErrorEvidence(
                error,
                (await options.configStore.read().catch(() => undefined))?.password,
              ),
            },
          },
          'OBS capture warmup failed',
        );
        return reply.code(409).send({
          error: 'capture_warmup_failed',
          message: 'OBS 游戏画面检查未完成，请重新检查；仍失败时导出诊断。',
        });
      }
    });
  }
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
  for (const action of ['video-preflight', 'video-prepare', 'video-restore'] as const) {
    app.post(`/operator/obs/${action}`, { bodyLimit: 2048 }, async (request, reply) => {
      if (!allowed(request.headers.origin))
        return reply.code(403).send({ error: 'operator_origin_forbidden' });
      const body = request.body as { expectedRevision?: unknown; transactionId?: unknown } | null;
      const valid = options.preparationValid(body?.expectedRevision);
      const connected = () => !request.raw.aborted && !reply.raw.destroyed;
      let preparedId: string | null = null;
      let responseFinished = false;
      if (action === 'video-prepare') {
        reply.raw.once('finish', () => {
          responseFinished = true;
        });
        reply.raw.once('close', () => {
          if (!responseFinished && preparedId)
            void options.adapter.restoreVideo(preparedId).catch(async (error: unknown) => {
              const password = (await options.configStore.read().catch(() => undefined))?.password;
              request.log.error(
                {
                  event: 'obs',
                  stage: 'video_disconnect_restore',
                  diagnostic: { error: obsErrorEvidence(error, password) },
                },
                'OBS video restore pending',
              );
            });
        });
      }
      try {
        if (action === 'video-restore') {
          if (!z.string().uuid().safeParse(body?.transactionId).success)
            return reply.code(400).send({ error: 'obs_video_transaction_invalid' });
          await options.adapter.restoreVideo(body!.transactionId as string);
          return { ok: true };
        }
        if (!valid() || !connected())
          return reply
            .code(409)
            .send({ error: 'preparation_changed', message: '制作状态已变化，请重试。' });
        if (action === 'video-preflight') {
          await options.adapter.videoPreflight(() => valid() && connected());
          return { ok: true };
        }
        const transactionId = await options.adapter.prepareVideo(() => valid() && connected());
        preparedId = transactionId;
        if (!valid() || !connected()) {
          if (transactionId) await options.adapter.restoreVideo(transactionId);
          return reply
            .code(409)
            .send({ error: 'preparation_changed', message: '制作状态已变化，请重试。' });
        }
        return { ok: true, transactionId };
      } catch (error) {
        const password = (await options.configStore.read().catch(() => undefined))?.password;
        request.log.error(
          { event: 'obs', stage: action, diagnostic: { error: obsErrorEvidence(error, password) } },
          'OBS video preparation failed',
        );
        if (error instanceof ObsVideoError)
          return reply.code(409).send({ error: error.code, message: error.message });
        return reply.code(409).send({
          error: 'obs_video_unavailable',
          message: 'OBS 视频设置未确认，请检查连接后重试。',
        });
      }
    });
  }
  for (const action of [
    'check',
    'capture-recover',
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
        if (['ensure', 'repair', 'check', 'capture-recover'].includes(action)) {
          request.log.info(
            { event: 'obs', stage: 'obs_preparation_start', action },
            'OBS preparation started',
          );
          const body = request.body as {
            expectedRevision?: unknown;
            preparationId?: unknown;
          } | null;
          const entryId =
            body?.preparationId === undefined
              ? undefined
              : z.string().uuid().safeParse(body.preparationId);
          if (entryId && !entryId.success)
            return reply.code(400).send({ error: 'preparation_invalid' });
          const productionValid = options.preparationValid(body?.expectedRevision);
          const valid = () =>
            productionValid() && !(entryId?.success && preparationCancelled(entryId.data));
          const connected = () => !request.raw.aborted && !reply.raw.destroyed;
          if (action !== 'check' && (!valid() || !connected()))
            return reply.code(409).send({ message: '制作状态已变化，请刷新后重试。' });
          const prepareMusic = options.prepareMusic
            ? (current: () => boolean, guard: (obs: ObsRpc) => ObsRpc) =>
                options.prepareMusic!(() => current() && valid() && connected(), guard)
            : undefined;
          const findings =
            action === 'ensure'
              ? await options.adapter.ensure(
                  options.activeScene,
                  () => valid() && connected(),
                  entryId?.success ? { id: entryId.data, valid } : undefined,
                  prepareMusic,
                )
              : action === 'repair'
                ? await options.adapter.repair(
                    options.activeScene,
                    () => valid() && connected(),
                    prepareMusic,
                  )
                : action === 'capture-recover'
                  ? await options.adapter.recoverCaptureWarmup(() => valid() && connected())
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
          const readiness = obsFindingReadiness(findings);
          const diagnostic = await captureDiagnostic(true);
          if (action === 'ensure' && entryId?.success) {
            if (readiness.blockingFindings.length)
              return reply.code(409).send({ message: readiness.blockingFindings[0]!.message });
            await options.adapter.verifyEntryPermit(entryId.data);
            if (!valid() || !connected())
              return reply.code(409).send({ message: '制作状态已变化，请刷新后重试。' });
          }
          const outputs =
            action === 'capture-recover' ? await options.adapter.outputStatus() : undefined;
          if (action === 'capture-recover' && (!valid() || !connected()))
            return reply.code(409).send({ message: '制作状态已变化，请重新检查。' });
          return {
            ok: true,
            findings,
            ...readiness,
            captureDiagnostic: diagnostic,
            ...(outputs ? { outputs } : {}),
          };
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
        if (error instanceof ObsVideoError || error instanceof ObsCaptureWarmupError)
          return reply.code(409).send({ error: error.code, message: error.message });
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
