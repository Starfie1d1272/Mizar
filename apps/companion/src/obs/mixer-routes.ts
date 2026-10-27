import type { FastifyInstance } from 'fastify';
import {
  mixerCommandSchema,
  type MixerChannelStatus,
  type MixerStatus,
} from '@mizar/protocol/mixer';
import { checkLocalWebOrigin, type LocalWebOriginPolicy } from '../local-web/origin-policy.js';
import type { MusicDirector } from '../music/director.js';
import type { ObsAdapter } from './adapter.js';
import type { GameAudioController } from './audio-policy-controller.js';

export function registerMixerRoutes(
  app: FastifyInstance,
  adapter: ObsAdapter,
  director: MusicDirector,
  game: GameAudioController | undefined,
  policy: LocalWebOriginPolicy,
) {
  let musicQueue: Promise<unknown> = Promise.resolve();
  let musicSequence = 0;
  const channelQueues = new Map<string, Promise<unknown>>();
  const channelSequences = new Map<string, number>();
  const allowed = (origin: string | undefined) =>
    policy.mode === 'loopback' && checkLocalWebOrigin(policy, origin).allowed;
  app.get('/local/v1/mixer', async (request, reply) => {
    if (
      policy.mode !== 'loopback' ||
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(request.hostname) ||
      request.headers['sec-fetch-site'] === 'cross-site' ||
      (request.headers.origin && !allowed(request.headers.origin))
    )
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const unknown = (name: string): MixerChannelStatus => ({
      name,
      volume: null,
      muted: null,
      control: 'unknown',
    });
    const obs = await adapter.mixerRead().catch(() => null);
    const music = director.get();
    const state = director.store.state;
    const result: MixerStatus = {
      revision: obs?.revision ?? 'unavailable',
      channels: {
        game: obs?.channels.game ?? unknown('游戏'),
        remoteCommentary: obs?.channels.remoteCommentary ?? unknown('远端解说'),
        microphone: obs?.channels.microphone ?? unknown('麦克风'),
        music: {
          name: '音乐',
          volume: director.store.ready ? state.master : null,
          muted: director.store.ready ? state.muted : null,
          control: !director.store.ready
            ? 'unknown'
            : music.held
              ? 'held'
              : music.connection === 'unavailable'
                ? 'unknown'
                : 'available',
        },
      },
    };
    return reply.header('cache-control', 'no-store').send(result);
  });
  app.post('/operator/mixer', { bodyLimit: 2048 }, async (request, reply) => {
    if (!allowed(request.headers.origin))
      return reply.code(403).send({ error: 'operator_origin_forbidden' });
    const parsed = mixerCommandSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ status: 'rejected', message: '混音参数无效。' });
    if (parsed.data.channel === 'music') {
      const sequence = ++musicSequence;
      const command = parsed.data;
      const task = musicQueue.then(async () => {
        if (sequence !== musicSequence)
          return { status: 'rejected' as const, message: '操作已被较新的请求替代。' };
        const before = await adapter.mixerRead().catch(() => null);
        if (!before) return { status: 'unknown' as const, message: 'OBS 连接未确认。' };
        if (before.revision !== command.revision)
          return { status: 'rejected' as const, message: '音频绑定已变化，请刷新。' };
        if (sequence !== musicSequence)
          return { status: 'rejected' as const, message: '操作已被较新的请求替代。' };
        try {
          const confirmed = await director.setMixer(command.volume, command.muted);
          const after = await adapter.mixerRead().catch(() => null);
          return confirmed && after?.revision === command.revision
            ? { status: 'confirmed' as const }
            : { status: 'unknown' as const, message: '音乐设置已保存，应用状态未确认。' };
        } catch {
          return { status: 'unknown' as const, message: '音乐操作未确认，请刷新。' };
        }
      });
      musicQueue = task.catch(() => undefined);
      return task;
    }
    const command = parsed.data;
    const sequence = (channelSequences.get(command.channel) ?? 0) + 1;
    channelSequences.set(command.channel, sequence);
    const task = (channelQueues.get(command.channel) ?? Promise.resolve()).then(() => {
      if (channelSequences.get(command.channel) !== sequence)
        return { status: 'rejected' as const, message: '操作已被较新的请求替代。' };
      return adapter.mixerWrite(command, game);
    });
    channelQueues.set(
      command.channel,
      task.catch(() => undefined),
    );
    return task;
  });
}
