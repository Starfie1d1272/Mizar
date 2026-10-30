import { readFile } from 'node:fs/promises';
import { diagnosticValue } from '../support/session-journal.js';
import type { FastifyInstance } from 'fastify';
import {
  musicConfigSchema,
  musicPreviewSchema,
  MUSIC_GROUPS,
  type MusicGroup,
} from '@mizar/protocol/music';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MusicStore } from './store.js';
import type { MusicDirector } from './director.js';
import { MUSIC_MAX_BYTES } from './archive.js';
import { portableMusicTrack } from '../broadcast-config/music-assets.js';

export function registerMusicRoutes(
  app: FastifyInstance,
  store: MusicStore,
  director: MusicDirector,
  policy: LocalWebOriginPolicy,
) {
  const allowed = (origin: string | undefined) =>
    policy.mode === 'loopback' && checkLocalWebOrigin(policy, origin).allowed;
  app.get('/local/v1/music', (request, reply) => {
    const host = request.hostname;
    if (
      policy.mode !== 'loopback' ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host) ||
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && !allowed(request.headers.origin))
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    return reply.header('cache-control', 'no-store').send({
      config: store.state.config,
      status: director.get(),
      storage: { ready: store.ready, failed: store.failure },
    });
  });
  app.post('/operator/music/preview', { bodyLimit: 16 * 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      await director.previewRequest(musicPreviewSchema.parse(request.body));
      return { status: director.get() };
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'music_preview_invalid';
      request.log.info({ stage: 'music_preview_failed', reason }, '音乐试听未执行');
      return reply.code(400).send({
        error: reason,
        message:
          reason === 'music_preview_storage'
            ? '音乐存储未就绪，请重新检查。'
            : reason === 'music_preview_channel_busy'
              ? '当前音乐正在播放或已人工接管，请先使用“停止音乐”停止当前音乐，再试听。'
              : reason === 'music_preview_busy'
                ? '音效通道或其他窗口正在使用试听，请先停止。'
                : '试听请求已失效或参数无效，请重新试听。',
      });
    }
  });
  app.post('/operator/music', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = request.body as {
      action?: unknown;
      config?: unknown;
      group?: unknown;
      volume?: unknown;
      trackId?: unknown;
      entryId?: unknown;
      cursorMs?: unknown;
      enabled?: unknown;
      playbackId?: unknown;
    } | null;
    try {
      if (body?.action === 'reload') {
        await store.load();
      } else if (body?.action === 'configure') {
        const config = musicConfigSchema.parse(body.config);
        director.invalidate();
        await store.configure(config);
      } else if (
        body?.action === 'volume' &&
        MUSIC_GROUPS.includes(body.group as MusicGroup) &&
        typeof body.volume === 'number' &&
        Number.isFinite(body.volume) &&
        body.volume >= 0 &&
        body.volume <= 1
      ) {
        await store.update((s) => {
          s.config.groups[body.group as MusicGroup].volume = body.volume as number;
        });
        director.invalidate();
      } else if (
        body?.action === 'play' &&
        MUSIC_GROUPS.includes(body.group as MusicGroup) &&
        (typeof body.trackId === 'string' || typeof body.entryId === 'string') &&
        (body.trackId === undefined || typeof body.trackId === 'string') &&
        (body.entryId === undefined || typeof body.entryId === 'string')
      )
        await director.manualPlay(body.group as MusicGroup, body.trackId, body.entryId);
      else if (
        body?.action === 'seek' &&
        typeof body.cursorMs === 'number' &&
        typeof body.playbackId === 'string'
      )
        await director.seek(body.cursorMs, body.playbackId);
      else if (body?.action === 'monitor' && typeof body.enabled === 'boolean')
        await director.monitor(body.enabled);
      else if (body?.action === 'pause' || body?.action === 'continue')
        await director.manualPause(body.action === 'pause');
      else if (body?.action === 'stop' || body?.action === 'resume' || body?.action === 'next')
        await director.command(body.action);
      else return reply.code(400).send({ error: 'music_command_invalid' });
      return {
        config: store.state.config,
        status: director.get(),
        storage: { ready: store.ready, failed: store.failure },
      };
    } catch (error) {
      request.log.error(
        {
          stage: 'music_operation',
          result: 'failure',
          reason: error instanceof Error ? error.message : 'music_unknown',
          error: diagnosticValue(error),
        },
        '音乐操作失败',
      );
      return reply.code(400).send({
        error: 'music_operation_failed',
        requestId: request.id,
        message:
          error instanceof Error && error.message === 'music_program_unsafe'
            ? '当前比赛数据未就绪或处于对战阶段，暂不能正式播放音乐。准备音乐时请使用曲目旁的“试听”。'
            : '音乐操作未完成，原配置已保留。请检查文件与 OBS 后重试。',
      });
    }
  });
  // Binary bytes travel only to the local Companion. They are never exposed by a download route.
  app.addContentTypeParser(
    'application/zip',
    { parseAs: 'buffer', bodyLimit: MUSIC_MAX_BYTES },
    (_request, body, done) => done(null, body),
  );
  app.addContentTypeParser(
    'application/x-mizar-audio',
    { parseAs: 'buffer', bodyLimit: 32 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );
  app.post('/operator/music/import', { bodyLimit: MUSIC_MAX_BYTES }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      if (!Buffer.isBuffer(request.body)) throw new Error('music_archive_invalid');
      await store.import(request.body);
      director.invalidate();
      return {
        config: store.state.config,
        status: director.get(),
        storage: { ready: store.ready, failed: store.failure },
      };
    } catch (error) {
      request.log.error(
        {
          stage: 'music_operation',
          result: 'failure',
          reason: error instanceof Error ? error.message : 'music_unknown',
          error: diagnosticValue(error),
        },
        '音乐操作失败',
      );
      return reply.code(400).send({
        error: 'music_import_failed',
        requestId: request.id,
        message: '音乐包未导入，原配置已保留。请检查清单、音频格式及 ZIP 安全限制。',
      });
    }
  });
  app.post('/operator/music/builtin', async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      if (!store.builtinPack) throw new Error('builtin_music_unavailable');
      await store.import(await readFile(store.builtinPack));
      director.invalidate();
      return { config: store.state.config };
    } catch (error) {
      request.log.error(
        { stage: 'music_builtin', error: diagnosticValue(error) },
        '内置音乐加载失败',
      );
      return reply.code(400).send({ message: '内置音乐未加载，原配置已保留。' });
    }
  });
  app.post('/operator/music/track', { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      const name = decodeURIComponent(String(request.headers['x-mizar-filename'] ?? ''));
      if (!Buffer.isBuffer(request.body) || !name || /[\\/]/.test(name))
        throw new Error('music_track_invalid');
      const track = await store.add(name, request.body);
      return { ...track, portable: await portableMusicTrack(store, track) };
    } catch (error) {
      request.log.error(
        {
          stage: 'music_operation',
          result: 'failure',
          reason: error instanceof Error ? error.message : 'music_unknown',
          error: diagnosticValue(error),
        },
        '音乐操作失败',
      );
      return reply.code(400).send({
        error: 'music_track_invalid',
        requestId: request.id,
        message:
          store.failure || !store.ready
            ? '音乐存储尚未就绪，请先重新检查音乐存储。'
            : (error as NodeJS.ErrnoException).code === 'EACCES' ||
                (error as NodeJS.ErrnoException).code === 'EPERM'
              ? '曲目未保存，请检查 Mizar 数据目录的写入权限。'
              : '曲目未添加，请选择有效的本地音频（最大 32 MiB）。',
      });
    }
  });
}
