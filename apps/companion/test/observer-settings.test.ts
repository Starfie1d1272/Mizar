import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { createProjectionCoordinator } from '../src/projections/projection-coordinator.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { createCstvSourceManagers } from '../src/telemetry/cstv-source-manager.js';
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
    expect(store.settings.leadSeconds).toBe(5);
    await store.configure({ ...store.settings, enabled: true, leadSeconds: 7 });
    await store.configureGame({ autoConnect: false, hideGameHud: false });
    const preferences = new ObserverSettingsStore(path);
    await preferences.load();
    expect(preferences.settings.leadSeconds).toBe(7);
    expect(preferences.gameAutomation).toEqual({ autoConnect: false, hideGameHud: false });
    store.setConnection({
      earlyEndpoint: '127.0.0.1:27025',
      programEndpoint: '127.0.0.1:27026',
      password: 'synthetic-secret',
    });
    expect(store.configured()?.password).toBe('synthetic-secret');
    expect(JSON.stringify(store.view())).not.toContain('synthetic-secret');
    expect(await readFile(path, 'utf8')).not.toMatch(/password|127\.0\.0\.1/);
    await writeFile(
      path,
      JSON.stringify({
        enabled: false,
        leadSeconds: 7,
        expectedDelaySeconds: 120,
        displaySeconds: 10,
      }),
    );
    const restart = new ObserverSettingsStore(path);
    await restart.load();
    expect(restart.settings).toEqual({ enabled: false, nicknameSource: 'website', leadSeconds: 7 });
    expect(restart.settings).not.toHaveProperty('expectedDelaySeconds');
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
it('loads and saves main preferences without resetting the other settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-observer-compat-'));
  const path = join(directory, 'observer-assist.json');
  try {
    const saved = {
      settings: { enabled: false, nicknameSource: 'game', leadSeconds: 9 },
      gameAutomation: { autoConnect: false, hideGameHud: false },
    };
    await writeFile(path, JSON.stringify(saved));
    const store = new ObserverSettingsStore(path);
    await store.load();
    expect(store.view()).toMatchObject(saved);
    await store.configure({ ...store.settings, nicknameSource: 'website' });
    const restart = new ObserverSettingsStore(path);
    await restart.load();
    expect(restart.view()).toMatchObject({
      ...saved,
      settings: { ...saved.settings, nicknameSource: 'website' },
    });
    await restart.configure({ ...restart.settings, nicknameSource: 'game' });
    const gameRestart = new ObserverSettingsStore(path);
    await gameRestart.load();
    expect(gameRestart.view()).toMatchObject(saved);
    await writeFile(
      path,
      JSON.stringify({ ...saved, settings: { ...saved.settings, nicknameSource: 'invalid' } }),
    );
    await expect(new ObserverSettingsStore(path).load()).rejects.toThrow();
    await writeFile(
      path,
      JSON.stringify({ ...saved, settings: { enabled: false, leadSeconds: 9, unexpected: true } }),
    );
    await expect(new ObserverSettingsStore(path).load()).rejects.toThrow();
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

it('rejects a stale workbench draft after the current match connection changes', async () => {
  const app = Fastify();
  const store = new ObserverSettingsStore();
  registerObserverSettings(app, store, {
    mode: 'loopback',
    bindHost: '127.0.0.1',
    allowedOrigins: [],
  });
  const original = store.revision;
  const connection = {
    earlyEndpoint: '127.0.0.1:27025',
    programEndpoint: '127.0.0.1:27026',
    password: 'synthetic',
  };
  const write = (expectedRevision: string) =>
    app.inject({
      method: 'POST',
      url: '/operator/observer-assist',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: { action: 'connection', expectedRevision, connection },
    });
  try {
    expect((await write(original)).statusCode).toBe(200);
    const current = store.revision;
    expect((await write(current)).statusCode).toBe(200);
    expect(store.revision).toBe(current);
    store.clearConnection(); // Existing match-change cleanup invalidates the open draft.
    expect((await write(current)).statusCode).toBe(409);
    expect(store.configured()).toBeUndefined();
  } finally {
    await app.close();
  }
});

it('confirms a map with the saved private connection and keeps retries idempotent', async () => {
  const app = Fastify(),
    store = new ObserverSettingsStore();
  registerObserverSettings(app, store, {
    mode: 'loopback',
    bindHost: '127.0.0.1',
    allowedOrigins: [],
  });
  const connection = {
    earlyEndpoint: '127.0.0.1:27025',
    programEndpoint: '127.0.0.1:27026',
    password: 'synthetic',
  };
  store.setConnection(connection);
  const id = crypto.randomUUID();
  const write = (revision: string, mode: string, value?: typeof connection, nextMap = false) =>
    app.inject({
      method: 'POST',
      url: '/operator/observer-assist',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {
        action: 'map-connection',
        id,
        mode,
        nextMap,
        expectedRevision: revision,
        ...(value ? { connection: value } : {}),
      },
    });
  try {
    expect((await write(store.revision, 'connect')).statusCode).toBe(200);
    const revision = store.revision;
    expect((await write(revision, 'connect')).statusCode).toBe(200);
    expect(store.revision).toBe(revision);
    expect(
      (await write(revision, 'connect', { ...connection, password: 'changed' })).statusCode,
    ).toBe(409);
    expect((await write(revision, 'seamless')).statusCode).toBe(409);
    expect((await write(revision, 'connect', undefined, true)).statusCode).toBe(409);
    expect(store.configured()).toEqual(connection);
    const copy = (origin: string, expectedRevision: string) =>
      app.inject({
        method: 'POST',
        url: '/operator/observer-assist',
        headers: { origin },
        payload: { action: 'copy-connection', expectedRevision },
      });
    expect((await copy('https://example.org', revision)).statusCode).toBe(403);
    expect((await copy('http://127.0.0.1:3000', crypto.randomUUID())).statusCode).toBe(409);
    const copied = await copy('http://127.0.0.1:3000', revision);
    expect(copied.headers['cache-control']).toBe('no-store');
    expect(copied.json<{ command: string }>().command).toBe(
      'password "synthetic"; connect 127.0.0.1:27026',
    );
    expect(JSON.stringify((await app.inject('/local/v1/observer-assist')).json())).not.toContain(
      'synthetic',
    );
    expect(store.configured()).toEqual(connection);
  } finally {
    await app.close();
  }
});

it('waits for new map data and restores the private projection after the transition', async () => {
  const app = buildApp({ gsiToken: 'test-gsi-token' });
  const gsi = (name: string) =>
    app.inject({
      method: 'POST',
      url: '/gsi',
      payload: {
        auth: { token: 'test-gsi-token' },
        provider: { appid: 730 },
        map: { name, phase: 'live', round: 1 },
      },
    });
  const get = async () =>
    (await app.inject('/local/v1/observer-assist')).json<{
      revision: string;
      waitingForMap: boolean;
    }>();
  const confirm = async (nextMap: boolean) =>
    app.inject({
      method: 'POST',
      url: '/operator/observer-assist',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {
        action: 'map-connection',
        id: crypto.randomUUID(),
        mode: 'connect',
        nextMap,
        expectedRevision: (await get()).revision,
        connection: {
          earlyEndpoint: '127.0.0.1:27025',
          programEndpoint: '127.0.0.1:27026',
          password: 'synthetic',
        },
      },
    });
  try {
    expect((await gsi('de_ancient')).statusCode).toBe(204);
    expect((await confirm(false)).statusCode).toBe(200);
    expect((await confirm(true)).statusCode).toBe(200);
    expect((await get()).waitingForMap).toBe(true);
    expect((await gsi('de_ancient')).statusCode).toBe(204);
    expect((await get()).waitingForMap).toBe(true);
    expect((await gsi('de_mirage')).statusCode).toBe(204);
    expect((await get()).waitingForMap).toBe(false);
  } finally {
    await app.close();
  }
});

it('keeps equivalent saves idempotent and timing separate from Host preparation revisions', async () => {
  const store = new ObserverSettingsStore();
  const changes: string[] = [];
  store.subscribe((kind) => changes.push(kind));
  const revision = store.revision;
  await Promise.all([
    store.configure({ ...store.settings, leadSeconds: 10 }),
    store.configure({ ...store.settings, leadSeconds: 10 }),
    store.configureGame({ ...store.gameAutomation }),
  ]);
  expect(changes).toEqual(['lead']);
  expect(store.revision).toBe(revision);
  await store.configure({ ...store.settings, enabled: false });
  expect(store.revision).not.toBe(revision);
  const connection = {
    earlyEndpoint: '127.0.0.1:27025',
    programEndpoint: '127.0.0.1:27026',
    password: 'synthetic',
  };
  store.setConnection(connection);
  const connected = store.revision;
  store.setConnection({ ...connection });
  expect(store.revision).toBe(connected);
  expect(changes).toEqual(['lead', 'enabled', 'connection']);
  store.setConnection({ ...connection, password: 'changed' });
  expect(store.revision).not.toBe(connected);
  store.clearConnection();
  const cleared = store.revision;
  store.clearConnection();
  expect(store.revision).toBe(cleared);
});

it('refreshes the private projection for changed settings and connections', async () => {
  const coordinator = createProjectionCoordinator({
    programRuntime: createProgramRuntime('lead-settings-regression'),
    cstvSources: createCstvSourceManagers({}),
  });
  const refresh = vi.spyOn(coordinator, 'refreshAssist');
  const app = buildApp({ projectionCoordinator: coordinator });
  const save = (leadSeconds: number) =>
    app.inject({
      method: 'POST',
      url: '/operator/observer-assist',
      headers: { origin: 'http://127.0.0.1:3000' },
      payload: {
        action: 'configure',
        settings: { enabled: false, leadSeconds },
      },
    });
  try {
    await app.ready();
    refresh.mockClear();
    expect((await save(10)).statusCode).toBe(200);
    expect(refresh).toHaveBeenCalledTimes(1);
    await save(10);
    expect(refresh).toHaveBeenCalledTimes(1);
    const connection = {
      earlyEndpoint: '127.0.0.1:27025',
      programEndpoint: '127.0.0.1:27026',
      password: 'map-one',
    };
    const confirm = (value: typeof connection) =>
      app.inject({
        method: 'POST',
        url: '/operator/observer-assist',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: { action: 'connection', connection: value },
      });
    await confirm(connection);
    expect(refresh).toHaveBeenCalledTimes(2);
    await confirm(connection);
    expect(refresh).toHaveBeenCalledTimes(2);
    await confirm({
      earlyEndpoint: '127.0.0.2:27035',
      programEndpoint: '127.0.0.2:27036',
      password: 'map-two',
    });
    expect(refresh).toHaveBeenCalledTimes(3);
  } finally {
    await app.close();
  }
});
