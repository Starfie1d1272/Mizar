import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { ObsConfigStore } from '../src/obs/config.js';
import { ObsAdapter } from '../src/obs/adapter.js';

it('resolves a native OBS launch target only for the local operator without launching it', async () => {
  const target = vi
    .spyOn(ObsAdapter.prototype, 'launchTarget')
    .mockResolvedValue('D:\\OBS\\obs64.exe');
  const open = vi.spyOn(ObsAdapter.prototype, 'open');
  const root = await mkdtemp(join(tmpdir(), 'mizar-obs-target-'));
  const app = buildApp({ obsConfigPath: join(root, 'obs.json') });
  try {
    const forbidden = await app.inject({
      method: 'POST',
      url: '/operator/obs/launch-target',
      headers: { origin: 'https://example.test' },
      payload: {},
    });
    expect(forbidden.statusCode).toBe(403);
    expect(target).not.toHaveBeenCalled();
    const result = await app.inject({
      method: 'POST',
      url: '/operator/obs/launch-target',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {},
    });
    expect(result.json()).toEqual({ ok: true, executablePath: 'D:\\OBS\\obs64.exe' });
    expect(open).not.toHaveBeenCalled();
  } finally {
    await app.close();
    target.mockRestore();
    open.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ['未找到 OBS，请在设置中选择 obs64.exe。', '未找到 OBS，请在设置中选择 obs64.exe。'],
  ['OBS 程序未能打开。', 'OBS 程序未能打开。'],
  ['unexpected failure with private-password', 'OBS 操作未完成，请检查连接与配置。'],
])(
  'provides safe OBS startup recovery without exposing arbitrary errors: %s',
  async (failure, message) => {
    const open = vi.spyOn(ObsAdapter.prototype, 'open').mockRejectedValue(new Error(failure));
    const root = await mkdtemp(join(tmpdir(), 'mizar-obs-startup-'));
    const app = buildApp({ obsConfigPath: join(root, 'obs.json') });
    try {
      const result = await app.inject({
        method: 'POST',
        url: '/operator/obs/open',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: {},
      });
      expect(result.statusCode).toBe(409);
      expect(result.json()).toMatchObject({ message });
      expect(result.body).not.toContain('private-password');
    } finally {
      await app.close();
      open.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('keeps the OBS WebSocket password out of local status and refuses cross-origin mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rh-obs-routes-'));
  const configPath = join(root, 'obs.json');
  const store = new ObsConfigStore(configPath);
  await store.save({
    host: '127.0.0.1',
    port: 65534,
    password: 'secret-probe',
    executablePath: null,
  });
  const app = buildApp({ obsConfigPath: configPath });
  try {
    const status = await app.inject({ method: 'GET', url: '/local/v1/obs' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ connection: 'unavailable', passwordConfigured: true });
    expect(status.body).not.toContain('secret-probe');
    const mutation = await app.inject({
      method: 'POST',
      url: '/operator/obs/configure',
      headers: { origin: 'https://example.test' },
      payload: { password: 'attacker' },
    });
    expect(mutation.statusCode).toBe(403);
    expect((await store.read()).password).toBe('secret-probe');
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
