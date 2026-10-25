import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { DEFAULT_OBSERVER_SETTINGS } from '@mizar/protocol/assist';
import {
  ObserverSettingsStore,
  registerObserverSettings,
} from '../src/telemetry/observer-settings.js';
it('persists operator timing and keeps per-match connection credentials in memory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-observer-settings-'));
  try {
    const path = join(directory, 'observer-assist.json'),
      store = new ObserverSettingsStore(path);
    await store.load();
    expect(store.settings).toEqual(DEFAULT_OBSERVER_SETTINGS);
    await store.configure({ ...store.settings, enabled: true, leadSeconds: 8 });
    await store.configureGame({ autoConnect: false, hideGameHud: false });
    const preferences = new ObserverSettingsStore(path);
    await preferences.load();
    expect(preferences.settings.leadSeconds).toBe(8);
    expect(preferences.gameAutomation).toEqual({ autoConnect: false, hideGameHud: false });
    store.setConnection({
      earlyEndpoint: '127.0.0.1:27025',
      programEndpoint: '127.0.0.1:27026',
      password: 'synthetic-secret',
    });
    expect(store.configured()?.password).toBe('synthetic-secret');
    expect(JSON.stringify(store.view())).not.toContain('synthetic-secret');
    expect(await readFile(path, 'utf8')).not.toMatch(/password|127\.0\.0\.1/);
    await writeFile(path, JSON.stringify({ ...store.settings, displaySeconds: 10 }));
    const restart = new ObserverSettingsStore(path);
    await restart.load();
    expect(restart.settings.leadSeconds).toBe(8);
    expect(restart.settings).not.toHaveProperty('displaySeconds');
    expect(restart.configured()).toBeUndefined();
    store.clearConnection();
    expect(store.view().connection).toBeNull();
    await store.configure({ ...store.settings, enabled: false });
    expect(store.configured()?.earlyEndpoint).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it('applies origin and payload validation to private settings writes', async () => {
  const app = Fastify(),
    store = new ObserverSettingsStore();
  registerObserverSettings(app, store, {
    mode: 'loopback',
    bindHost: '127.0.0.1',
    allowedOrigins: [],
  });
  try {
    const body = { action: 'configure', settings: { ...DEFAULT_OBSERVER_SETTINGS, enabled: true } };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/operator/observer-assist',
          headers: { origin: 'https://example.org' },
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
    const response = await app.inject({
      method: 'POST',
      url: '/operator/observer-assist',
      headers: { origin: 'http://127.0.0.1:31337' },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(store.settings.enabled).toBe(true);
  } finally {
    await app.close();
  }
});
