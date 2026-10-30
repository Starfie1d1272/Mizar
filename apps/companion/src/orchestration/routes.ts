import { timingSafeEqual } from 'node:crypto';
import { win32 } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { orchestrationPresetSchema, CAMERA_STAGES } from '@mizar/protocol/orchestration';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MusicStore } from '../music/store.js';
import type { MulnxTool } from './tool.js';
import type { CameraDirector } from './director.js';

export const nativeCs2PathSchema = z
  .string()
  .min(1)
  .max(2048)
  .transform((path) => win32.normalize(path.startsWith('\\\\?\\') ? path.slice(4) : path))
  .pipe(z.string().regex(/^[A-Za-z]:\\.*\\cs2\.exe$/i));

const expectedSchema = z
  .object({ context: z.string().max(4000), connection: z.number().int() })
  .strict();
const commandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('check-tool') }),
  z.strictObject({ action: z.literal('set-automatic'), enabled: z.boolean() }),
  z.strictObject({ action: z.literal('browser'), expectedRevision: z.string().max(128) }),
  z
    .object({
      action: z.literal('audition'),
      expected: expectedSchema,
      stage: z.enum(['opening', 'round', ...CAMERA_STAGES]),
      index: z.number().int().min(0).max(63).optional(),
    })
    .strict(),
  z.object({ action: z.literal('configure'), preset: orchestrationPresetSchema }).strict(),
  z.strictObject({ action: z.literal('create-preset'), sourceId: z.uuid().optional() }),
  z.strictObject({
    action: z.literal('save-preset'),
    id: z.uuid(),
    preset: orchestrationPresetSchema,
  }),
  z.strictObject({ action: z.literal('activate-preset'), id: z.uuid() }),
  z.object({ action: z.enum(['connect', 'disconnect', 'hold', 'skip']) }).strict(),
  z
    .object({
      action: z.literal('resume'),
      expected: expectedSchema,
    })
    .strict(),
]);
const host = z.string().min(1).max(80);
const nativeSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('host-start'), host }),
  z.strictObject({ action: z.literal('begin'), host, expectedRevision: z.string().max(128) }),
  z.strictObject({ action: z.literal('begin-demo'), host, requestId: z.uuid() }),
  z.strictObject({ action: z.enum(['pulse', 'invalidate']), host, lease: z.uuid() }),
]);
export function registerOrchestrationRoutes(
  app: FastifyInstance,
  director: CameraDirector,
  music: MusicStore,
  policy: LocalWebOriginPolicy,
  session?: {
    controlToken: string | undefined;
    configure: (revision: string, commit: () => void) => void;
    configureDemo?: (requestId: string, commit: () => void) => void;
    canPrepare?: () => boolean;
    withSelection?: (commit: () => Promise<void>) => Promise<boolean>;
    reconcileSelection?: () => Promise<boolean>;
  },
  tool?: MulnxTool,
) {
  const allowed = (origin: string | undefined) =>
    policy.mode === 'loopback' && checkLocalWebOrigin(policy, origin).allowed;
  const view = () => ({
    preset: director.store.preset,
    activePresetId: director.store.activePresetId,
    presets: director.store.presets,
    automaticEnabled: director.store.automaticEnabled,
    ready: director.store.ready,
    status: director.get(),
    ...(tool ? { tool: tool.view() } : {}),
  });
  app.get('/local/v1/orchestration', (request, reply) => {
    if (
      policy.mode !== 'loopback' ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(request.hostname) ||
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && !allowed(request.headers.origin))
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    return reply.header('cache-control', 'no-store').send(view());
  });
  app.get('/local/v1/mulnx-releases', async (request, reply) => {
    if (
      policy.mode !== 'loopback' ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(request.hostname) ||
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && !allowed(request.headers.origin))
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    if (!tool) return reply.code(503).send({ error: 'mulnx_bundle_unavailable' });
    try {
      return reply
        .header('cache-control', 'no-store')
        .send({ releases: await tool.listPreparedReleases() });
    } catch (error) {
      request.log.error({ stage: 'mulnx_list_releases', err: error }, 'MulNX 版本读取失败');
      return reply.code(503).send({ error: 'mulnx_list_unavailable' });
    }
  });
  app.post('/operator/runtime/camera-session', { bodyLimit: 2048 }, (request, reply) => {
    const expected = Buffer.from(session?.controlToken ?? '');
    const token = request.headers['x-runtime-token'];
    const supplied = Buffer.from(typeof token === 'string' ? token : '');
    if (
      policy.mode !== 'loopback' ||
      request.headers.origin !== undefined ||
      !expected.length ||
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      return reply.code(403).send({ error: 'runtime-control-denied' });
    try {
      const body = nativeSchema.parse(request.body);
      let lease: string | undefined;
      if (body.action === 'host-start') director.hostStarted(body.host);
      else if (body.action === 'begin')
        session!.configure(body.expectedRevision, () => {
          lease = director.beginNative(body.host);
        });
      else if (body.action === 'begin-demo') {
        if (!session?.configureDemo) throw new Error('demo_camera_unavailable');
        session.configureDemo(body.requestId, () => {
          lease = director.beginNative(body.host);
        });
      } else if (body.action === 'pulse') director.pulseNative(body.host, body.lease);
      else director.revokeNative(body.host, body.lease);
      return { ok: true, ...(lease ? { lease } : {}) };
    } catch (error) {
      request.log.error(
        { stage: 'camera_host_session', err: error, result: 'failure' },
        '原生运镜会话未确认',
      );
      return reply.code(409).send({ error: 'camera_native_session_invalid' });
    }
  });
  app.post(
    '/operator/runtime/mulnx-prepare-release',
    { bodyLimit: 1024 },
    async (request, reply) => {
      const expected = Buffer.from(session?.controlToken ?? '');
      const token = request.headers['x-runtime-token'];
      const supplied = Buffer.from(typeof token === 'string' ? token : '');
      if (
        policy.mode !== 'loopback' ||
        request.headers.origin !== undefined ||
        !expected.length ||
        expected.length !== supplied.length ||
        !timingSafeEqual(expected, supplied)
      )
        return reply.code(403).send({ error: 'runtime-control-denied' });
      try {
        z.strictObject({}).parse(request.body);
        if (!tool) throw new Error('mulnx_bundle_unavailable');
        const result = await tool.prepareRelease();
        return {
          preparedId: result.preparedId,
          tag: result.release.tag,
          archiveSha256: result.release.sha256,
        };
      } catch (error) {
        request.log.error(
          { stage: 'mulnx_prepare_release', err: error, result: 'failure' },
          'MulNX 下载失败',
        );
        return reply.code(409).send({
          error: 'mulnx_prepare_failed',
          message: 'MulNX 下载或校验失败，请检查网络后重试。',
          requestId: request.id,
        });
      }
    },
  );
  app.post('/operator/runtime/mulnx-select', { bodyLimit: 4096 }, async (request, reply) => {
    const expected = Buffer.from(session?.controlToken ?? '');
    const token = request.headers['x-runtime-token'];
    const supplied = Buffer.from(typeof token === 'string' ? token : '');
    if (
      policy.mode !== 'loopback' ||
      request.headers.origin !== undefined ||
      !expected.length ||
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      return reply.code(403).send({ error: 'runtime-control-denied' });
    try {
      const body = z
        .discriminatedUnion('action', [
          z.strictObject({
            action: z.literal('stage'),
            preparedId: z.string().regex(/^prepared-[a-f0-9]{64}-[a-f0-9-]{36}$/),
          }),
          z.strictObject({ action: z.literal('commit'), id: z.uuid() }),
        ])
        .parse(request.body);
      if (!tool) throw new Error('mulnx_bundle_unavailable');
      if (body.action === 'stage') return await tool.stageSelection(body.preparedId);
      let result: { version: string; cameraReady?: boolean } | undefined;
      if (
        !session?.withSelection ||
        !(await session.withSelection(async () => {
          result = await tool.commitSelection(body.id);
          director.invalidatePreparation('MulNX 版本已切换，请重新准备运镜。');
          if (session.reconcileSelection) {
            const cameraReady = await session.reconcileSelection().catch(() => false);
            result = { ...result, cameraReady };
            if (!cameraReady)
              director.invalidatePreparation('镜头资源已变化，请重新选择或使用方案。');
          }
        }))
      )
        throw new Error('mulnx_preparation_required');
      return result;
    } catch (error) {
      request.log.error({ stage: 'mulnx_select', err: error, result: 'failure' }, 'MulNX 切换失败');
      return reply.code(409).send({
        error: 'mulnx_select_failed',
        message: 'MulNX 版本切换未确认，请刷新并检查制作和游戏状态。',
        requestId: request.id,
      });
    }
  });
  app.post('/operator/runtime/mulnx-prepare', { bodyLimit: 4096 }, async (request, reply) => {
    const expected = Buffer.from(session?.controlToken ?? '');
    const supplied = Buffer.from(
      typeof request.headers['x-runtime-token'] === 'string'
        ? request.headers['x-runtime-token']
        : '',
    );
    if (
      policy.mode !== 'loopback' ||
      request.headers.origin !== undefined ||
      !expected.length ||
      expected.length !== supplied.length ||
      !timingSafeEqual(expected, supplied)
    )
      return reply.code(403).send({ error: 'runtime-control-denied' });
    try {
      if (!tool || !session?.canPrepare?.()) throw new Error('mulnx_preparation_required');
      const body = z
        .strictObject({
          cs2Path: nativeCs2PathSchema,
          consoleCapture: z.boolean().default(false),
          update: z.boolean().default(false),
          spectatorCfg: z.boolean().default(false),
          demoCfg: z
            .string()
            .regex(/^mizar_demo_[0-9a-f-]{36}\.cfg$/i)
            .nullable()
            .optional(),
        })
        .parse(request.body);
      director.hold('正在准备 MulNX');
      const previous = tool.selectionId;
      const result = await tool.prepare(
        body.cs2Path,
        body.consoleCapture,
        body.update,
        body.spectatorCfg,
        body.demoCfg ?? undefined,
      );
      if (previous !== tool.selectionId) {
        director.invalidatePreparation('MulNX 版本已切换，请重新准备运镜。');
        if (session.reconcileSelection && !(await session.reconcileSelection().catch(() => false)))
          director.invalidatePreparation('镜头资源已变化，请重新选择或使用方案。');
      }
      return result;
    } catch (error) {
      request.log.error(
        { stage: 'mulnx_prepare', err: error, result: 'failure' },
        'MulNX 准备失败',
      );
      return reply.code(409).send({
        error: 'mulnx_prepare_failed',
        message:
          error instanceof z.ZodError
            ? 'CS2 安装位置无效，请重新检查游戏安装位置。'
            : error instanceof Error
              ? error.message
              : 'MulNX 准备失败',
        requestId: request.id,
      });
    }
  });
  app.post('/operator/orchestration', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    let checkingTool = false;
    try {
      const body = commandSchema.parse(request.body);
      let createdPresetId: string | undefined;
      if (body.action === 'create-preset') {
        createdPresetId = await director.store.createPreset(body.sourceId);
      } else if (body.action === 'save-preset') {
        await director.store.savePreset(body.id, body.preset);
      } else if (body.action === 'activate-preset') {
        director.invalidatePreparation('正在启用预设。');
        try {
          await director.store.activatePreset(body.id, async (preset) => {
            for (const map of preset.maps)
              if (map.openingSound) await music.trackPath(map.openingSound.id);
          });
        } finally {
          director.invalidatePreparation('正在准备运镜。');
        }
      } else if (body.action === 'set-automatic') {
        if (!session?.canPrepare?.()) throw new Error('camera_settings_preparation_required');
        await director.store.saveAutomaticEnabled(body.enabled);
      } else if (body.action === 'check-tool') {
        checkingTool = true;
        if (!tool) throw new Error('mulnx_bundle_unavailable');
        await tool.check();
      } else if (body.action === 'browser') {
        if (!session) throw new Error('camera_production_unavailable');
        session.configure(body.expectedRevision, () => director.useBrowser());
      } else if (body.action === 'audition') {
        const map = director.store.map(director.get().map);
        const shot =
          body.stage === 'opening'
            ? map?.opening
            : body.stage === 'round'
              ? map?.rounds[body.index ?? -1]
              : (body.stage === 'tactical' || body.stage === 'technical') &&
                  body.index !== undefined
                ? map?.pauseCandidates[body.stage][body.index]
                : map?.stages[body.stage];
        if (!shot) throw new Error('camera_shot_missing');
        await director.audition(shot, body.expected);
      } else if (body.action === 'configure') {
        for (const map of body.preset.maps)
          if (map.openingSound) await music.trackPath(map.openingSound.id);
        director.invalidatePreparation('预设正在保存。');
        await director.store.save(body.preset);
        // A resume submitted during persistence must not arm a different preset.
        director.invalidatePreparation('预设已保存，正在准备运镜。');
      } else
        await director.command(body.action, body.action === 'resume' ? body.expected : undefined);
      return { ...view(), ...(createdPresetId ? { createdPresetId } : {}) };
    } catch (error) {
      request.log.error(
        { stage: 'camera_operation', err: error, result: 'failure' },
        '运镜操作失败',
      );
      return reply.code(400).send({
        error: 'camera_operation_failed',
        message: checkingTool
          ? error instanceof Error && /^mulnx_metadata_http_(403|429)$/.test(error.message)
            ? '无法检查 MulNX 更新：GitHub 拒绝了请求，可能已达到请求次数限制。请稍后重试。'
            : '无法检查 MulNX 更新，请检查网络后重试。'
          : error instanceof Error && error.message === 'camera_settings_preparation_required'
            ? '请先结束制作，再修改自动运镜设置。'
            : error instanceof Error && error.message === 'camera_source_changed'
              ? '镜头资源已变化，请重新选择或使用方案。'
              : error instanceof Error && error.message === 'camera_audition_unavailable'
                ? '镜头暂不能播放，请先停止当前镜头并检查连接。'
                : error instanceof Error && error.message === 'camera_stop_unconfirmed'
                  ? '停止未确认，请检查游戏连接后重试。'
                  : error instanceof Error && error.message === 'camera_status_unsupported'
                    ? '当前运镜工具版本不支持此功能，请更新至支持的版本。'
                    : error instanceof Error && error.message === 'camera_status_unconfirmed'
                      ? '无法确认运镜状态，请检查游戏连接和工具版本。'
                      : error instanceof Error && error.message === 'camera_pack_apply_unconfirmed'
                        ? '运镜准备失败，请检查游戏连接后重试。'
                        : error instanceof Error && error.message === 'camera_pack_unconfirmed'
                          ? '运镜准备未完成，请检查当前地图和预设后重试。'
                          : error instanceof Error && error.message === 'camera_prepare_unavailable'
                            ? '暂不能准备运镜，请检查游戏连接和当前地图。'
                            : '操作未完成，请检查当前地图、连接、预设与本机音频。',
        requestId: request.id,
      });
    }
  });
}
