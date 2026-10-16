import type { FastifyInstance } from 'fastify';
import { musicConfigSchema, MUSIC_GROUPS, type MusicGroup } from '@mizar/protocol/music';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MusicStore } from './store.js';
import type { MusicDirector } from './director.js';
import { MUSIC_MAX_BYTES } from './archive.js';

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
    return reply
      .header('cache-control', 'no-store')
      .send({ config: store.state.config, status: director.get() });
  });
  app.post('/operator/music', { bodyLimit: 256 * 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const body = request.body as {
      action?: unknown;
      config?: unknown;
      group?: unknown;
      volume?: unknown;
    } | null;
    try {
      if (body?.action === 'configure') {
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
      } else if (body?.action === 'stop' || body?.action === 'resume' || body?.action === 'next')
        await director.command(body.action);
      else return reply.code(400).send({ error: 'music_command_invalid' });
      return { config: store.state.config, status: director.get() };
    } catch {
      return reply.code(400).send({
        error: 'music_operation_failed',
        message: '音乐操作未完成，原配置已保留。请检查文件后重试。',
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
      return { config: store.state.config, status: director.get() };
    } catch {
      return reply.code(400).send({
        error: 'music_import_failed',
        message: '音乐包未导入，原配置已保留。请检查清单、音频格式及 ZIP 安全限制。',
      });
    }
  });
  app.post('/operator/music/track', { bodyLimit: 32 * 1024 * 1024 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    try {
      const name = decodeURIComponent(String(request.headers['x-mizar-filename'] ?? ''));
      if (!Buffer.isBuffer(request.body) || !name || /[\\/]/.test(name))
        throw new Error('music_track_invalid');
      return await store.add(name, request.body);
    } catch {
      return reply.code(400).send({
        error: 'music_track_invalid',
        message: '曲目未添加，请选择有效的本地音频（最大 32 MiB）。',
      });
    }
  });
}
