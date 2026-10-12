import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ObsConfigStore } from '../src/obs/config.js';

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
