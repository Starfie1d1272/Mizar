import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerObsRoutes } from '../src/obs/routes.js';
import { ObsActionError } from '../src/obs/action-error.js';
import { ObsOutputError } from '../src/obs/outputs.js';
import type { ObsAdapter } from '../src/obs/adapter.js';
import type { ObsConfigStore } from '../src/obs/config.js';

describe('OBS operator error responses', () => {
  it('does not expose arbitrary error text and retains trusted actionable guidance', async () => {
    const app = Fastify();
    let failure: Error = new Error('OBS 正在输出 fake-password fake-token /private/path');
    const fail = () => Promise.reject(failure);
    registerObsRoutes(app, {
      adapter: {
        setupAudio: fail,
        ensure: fail,
        check: fail,
        repair: fail,
        outputCommand: fail,
        configure: fail,
      } as unknown as ObsAdapter,
      configStore: {
        read: () => Promise.resolve({ password: 'fake-password' }),
      } as unknown as ObsConfigStore,
      originPolicy: { mode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: [] },
      activeScene: () => 'waiting',
    });
    try {
      for (const action of ['audio-setup', 'ensure', 'check', 'repair']) {
        const response = await app.inject({
          method: 'POST',
          url: `/operator/obs/${action}`,
          headers: { origin: 'http://127.0.0.1:3000' },
          payload: {},
        });
        expect(response.statusCode).toBe(409);
        expect(response.body).not.toMatch(/fake-password|fake-token|\/private\/path|OBS 正在输出/);
        expect(response.json<{ message: string }>().message).toMatch(/请查看诊断/);
      }
      failure = new ObsActionError('output_active_audio');
      const known = await app.inject({
        method: 'POST',
        url: '/operator/obs/audio-setup',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: {},
      });
      expect(known.json<{ message: string }>().message).toBe(
        'OBS 正在输出；停止推流和录制后配置音频。',
      );
      failure = new ObsOutputError('obs_output_busy', 'fake-password fake-token /private/path');
      const output = await app.inject({
        method: 'POST',
        url: '/operator/obs/output',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: {
          output: 'stream',
          action: 'start',
          expectedRevision: '00000000-0000-4000-8000-000000000001',
        },
      });
      expect(output.statusCode).toBe(409);
      expect(output.body).not.toMatch(/fake-password|fake-token|\/private\/path/);
      expect(output.json<{ message: string }>().message).toContain('等待状态确认');
    } finally {
      await app.close();
    }
  });
});
