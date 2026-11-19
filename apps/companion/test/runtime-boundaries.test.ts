import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import fastify from 'fastify';
import { buildApp } from '../src/app.js';
import type { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
import { ReliableOutbox } from '../src/output/reliable-outbox.js';
import { closeWebsiteOutput } from '../src/output/website-lifecycle.js';
import { DemoTestController, readDemoTestRecovery } from '../src/demo-test/controller.js';
import { createProgramRuntime } from '../src/runtime/program-runtime.js';
import { registerProductionReadiness } from '../src/program-scenes/readiness.js';
import { ObsVideoError } from '../src/obs/video-transaction.js';
import { registerUpdateRoutes } from '../src/updates/routes.js';
import { UpdateManager } from '../src/updates/manager.js';
import { updateManifestSchema } from '../src/updates/contract.js';

const host = '127.0.0.1:3000';
const origin = `http://${host}`;

test('readiness retains local facts when a concurrent OBS change invalidates its snapshot', async (t) => {
  const app = fastify();
  t.after(() => app.close());
  type Readers = Parameters<typeof registerProductionReadiness>[1];
  const projection = {
    operator: {
      matchContext: { summary: {} },
      identity: { state: 'matched' },
      runtime: { telemetryFreshness: 'fresh' },
    },
    radar: { telemetryFreshness: 'stale' },
  } as ReturnType<Readers['projection']>;
  const scenes = {
    active: 'waiting',
    available: ['waiting'],
    blocked: {},
  } as ReturnType<Readers['scenes']>;
  registerProductionReadiness(app, {
    projection: () => projection,
    scenes: () => scenes,
    obs: async () => {
      throw new ObsVideoError('obs_observation_changed', 'Discard the mixed OBS generation');
    },
  });
  const response = await app.inject('/local/v1/readiness');
  assert.equal(response.statusCode, 200);
  const items = response.json<{ id: string; ready: boolean; reason: string }[]>();
  assert.equal(items.find((item) => item.id === 'match')?.ready, true);
  assert.equal(items.find((item) => item.id === 'game-data')?.ready, true);
  assert.equal(items.find((item) => item.id === 'obs')?.ready, false);
  assert.equal(items.find((item) => item.id === 'obs')?.reason, '正在刷新 OBS 状态');
});

test('install reuses a recent authenticated candidate, rechecks stale trust and rejects changed bytes', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'mizar-update-install-'));
  const updates = join(stateRoot, 'updates');
  const directory = 'download-fixture';
  const bytes = Buffer.from('fixture bytes');
  const manifest = updateManifestSchema.parse({
    schemaVersion: 'mizar.update.v1',
    repository: 'Starfie1d1272/Mizar',
    channel: 'stable',
    version: '1.11.21',
    gitSha: 'a'.repeat(40),
    notes: 'Fixture',
    compatibility: { minimumVersion: '1.11.0', maximumVersionExclusive: '1.12.0' },
    installer: {
      platform: 'win32-x64',
      format: 'nsis-setup',
      name: 'Mizar-v1.11.21-Windows-x64-Setup.exe',
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      contentDigest: 'b'.repeat(64),
    },
  });
  const installer = join(updates, directory, manifest.installer.name);
  await mkdir(join(updates, directory), { recursive: true });
  await writeFile(installer, bytes);
  await writeFile(join(updates, 'ready.json'), JSON.stringify({ directory, manifest }));
  let now = 100_000;
  let checks = 0;
  let online = true;
  const manager = new UpdateManager({
    stateRoot,
    bundleRoot: stateRoot,
    currentContentDigest: 'c'.repeat(64),
    installed: true,
    version: '1.11.20',
    now: () => now,
    source: {
      latest: async () => {
        checks++;
        if (!online) throw new Error('update_network_failed');
        return manifest;
      },
    },
  });
  t.after(async () => {
    await manager.close();
    await rm(stateRoot, { recursive: true, force: true });
  });
  await manager.load();
  await manager.check();
  online = false;
  assert.equal((await manager.prepare()).version, manifest.version);
  assert.equal(checks, 1);
  manager.release();
  now += 60_001;
  await assert.rejects(
    manager.prepare(),
    (error) =>
      error instanceof Error &&
      error.message === 'update_recheck_required' &&
      error.cause instanceof Error &&
      error.cause.message === 'update_network_failed',
  );
  assert.equal(checks, 2);
  online = true;
  await manager.check();
  await writeFile(installer, Buffer.alloc(bytes.length));
  await assert.rejects(manager.prepare(), /update_download_corrupt/);
  assert.equal(checks, 3);
  assert.equal(manager.status().phase, 'available');
  await assert.rejects(readFile(installer), { code: 'ENOENT' });
});

test('update staging survives unavailable OBS and only a known active output blocks handoff', async (t) => {
  const app = fastify();
  t.after(() => app.close());
  type Options = Parameters<typeof registerUpdateRoutes>[1];
  let reserved = false;
  let active: boolean | null = true;
  const routes = registerUpdateRoutes(app, {
    manager: {
      prepare: async () => ({ version: '1.11.21' }),
      status: () => ({ phase: 'installing' }),
      release: () => {},
      close: () => {},
    } as unknown as Options['manager'],
    production: {
      reserveUpdate: () => {
        reserved = true;
        return true;
      },
      releaseUpdate: () => {
        reserved = false;
      },
    } as unknown as Options['production'],
    scenes: { setUpdatePending: () => {} } as unknown as Options['scenes'],
    controlToken: 'update-test-token',
    originPolicy: { mode: 'loopback' } as Options['originPolicy'],
    obs: async () => {
      const stream = {
        active,
        phase: active === true ? 'active' : 'unknown',
        pending: null,
        revision: 'stream',
      } as const;
      return { stream, record: { ...stream, active: null }, preparation: 'cleanup_pending' };
    },
  });
  const command = (action: string) =>
    app.inject({
      method: 'POST',
      url: '/operator/updates/install-plan',
      headers: { 'x-runtime-token': 'update-test-token' },
      payload: { action, attemptId: randomAttempt },
    });
  const randomAttempt = randomUUID();
  assert.equal((await command('prepare')).statusCode, 200);
  assert.equal(reserved, false);
  active = null;
  assert.equal((await command('commit')).statusCode, 200);
  assert.equal((await command('recheck')).statusCode, 200);
  assert.equal(await routes.beforeStop(), null);
  active = true;
  assert.match((await routes.beforeStop()) ?? '', /推流或录制/);
  assert.equal(reserved, false);
});

test('website shutdown cannot acknowledge a failed local source commit', async () => {
  const closed: string[] = [];
  await assert.rejects(
    closeWebsiteOutput(
      {
        prepareSourceShutdown: async () => {
          throw new Error('disk write failed');
        },
        shutdownSource: async () => {
          assert.fail('remote release must wait for the local commit');
        },
        closeSourceState: async () => {
          closed.push('source');
        },
      },
      {
        close: async () => {
          closed.push('outbox');
        },
      },
      () => assert.fail('local failure must reach the flush owner'),
    ),
    (error: AggregateError) => error.errors[0]?.message === 'disk write failed',
  );
  assert.deepEqual(closed.sort(), ['outbox', 'source']);
});

test('Demo recovery retains its marker and remains isolated until output restoration commits', async (t) => {
  const { directory } = await fixture(t);
  const markerPath = join(directory, 'demo-test.json');
  const requestId = randomUUID();
  const marker = { version: 'mizar.demo-test.v1', requestId, teamAName: 'A', teamBName: 'B' };
  await writeFile(markerPath, JSON.stringify(marker));
  let outputQuarantined = true;
  let failFormalRestore = true;
  let failOutputRestore = true;
  const stages: string[] = [];
  type Options = ConstructorParameters<typeof DemoTestController>[0];
  const open = () =>
    new DemoTestController({
      markerPath,
      recovery: readDemoTestRecovery(markerPath),
      dataReady: () => false,
      context: null,
      runtime: createProgramRuntime('demo-recovery-test'),
      obs: async () => undefined,
      scenes: {
        get: () => ({ revision: 'observed-scene' }),
        selectWaitingForExit: async () => ({ ok: false, message: 'OBS offline' }),
      } as unknown as Options['scenes'],
      production: {
        setTrialPreparation: () => {},
        setTrialPending: () => {},
        deferTrialObsExit: async () => {
          stages.push('obs_recovery_handoff');
        },
        reserveTrialOperation: () => true,
        releaseTrialOperation: () => {},
      } as unknown as Options['production'],
      diagnostic: (stage) => stages.push(stage),
      quarantineOutput(value) {
        if (!value && failOutputRestore) throw new Error('restore interrupted');
        outputQuarantined = value;
      },
      refresh: () => {},
      restoreFormal: async () => {
        if (failFormalRestore) throw new Error('formal restore interrupted');
      },
      hold: () => {},
    });
  let demo = open();
  assert.equal((await demo.command({ action: 'finish', requestId })).code, 200);
  assert.equal(demo.get().phase, 'recovery');
  assert.equal(demo.canAcceptGsi(), false);
  assert.equal((await demo.command({ action: 'complete', requestId })).code, 409);
  assert.deepEqual(readDemoTestRecovery(markerPath), { ...marker, localRestored: true });
  assert.equal(demo.get().active, true);
  assert.ok(stages.includes('obs_recovery_handoff'));
  assert.ok(stages.includes('formal_restore'));
  failFormalRestore = false;
  assert.equal((await demo.command({ action: 'complete', requestId })).code, 409);
  assert.deepEqual(readDemoTestRecovery(markerPath), { ...marker, localRestored: true });
  assert.equal(outputQuarantined, true);
  assert.ok(stages.includes('formal_output_restore'));
  failOutputRestore = false;
  demo = open();
  assert.equal((await demo.command({ action: 'complete', requestId })).code, 200);
  await assert.rejects(readFile(markerPath), { code: 'ENOENT' });
  assert.equal(outputQuarantined, false);
  assert.equal(demo.canAcceptGsi(), false);
  demo.openFormalBoundary();
  assert.equal(demo.canAcceptGsi(), true);
});

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-runtime-boundaries-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const webRoot = join(directory, 'web');
  await mkdir(webRoot);
  await writeFile(join(webRoot, 'index.html'), '<html><main>Mizar</main></html>');
  return {
    directory,
    options: {
      webRoot,
      matchManifestPath: join(directory, 'match-context.json'),
      localTournamentPath: join(directory, 'local-tournament.json'),
    },
  };
}

test('private production routes require a loopback Host and remain private in LAN mode', async (t) => {
  const { options } = await fixture(t);
  const app = buildApp(options);
  const lan = buildApp({
    ...options,
    host: '0.0.0.0',
    localWebLanMode: true,
    localWebAllowedOrigins: ['http://studio.test:3000'],
  });
  t.after(async () => {
    await app.close();
    await lan.close();
  });

  const privatePaths = [
    '/debug/runtime',
    '/local/v1/tournament',
    '/local/v1/resource-library',
    '/resources',
    '/workspace/review',
    '/workspace/connection',
    '/workspace/game-picture',
  ];
  for (const url of privatePaths) {
    const trusted = await app.inject({ url, headers: { host: '[::1]:3000' } });
    assert.equal(trusted.statusCode, 200, url);
    const foreign = await app.inject({
      url,
      headers: {
        host: 'foreign.example:3000',
        'sec-fetch-site': 'same-origin',
        'x-forwarded-host': host,
      },
    });
    assert.equal(foreign.statusCode, 403, url);
    assert.equal((await lan.inject({ url, headers: { host } })).statusCode, 403, url);
  }

  const encodedPrivate = '/lo%63al/v1/tournament';
  assert.equal(
    (await app.inject({ url: encodedPrivate, headers: { host: 'foreign.example:3000' } }))
      .statusCode,
    403,
  );
  assert.equal((await lan.inject({ url: encodedPrivate, headers: { host } })).statusCode, 403);

  const publicProgram = await lan.inject({
    url: '/program',
    headers: { host: 'studio.test:3000' },
  });
  assert.equal(publicProgram.statusCode, 200);
  const unknown = await app.inject({
    url: '/workspace/not-a-page',
    headers: { host, accept: 'text/html' },
  });
  assert.equal(unknown.statusCode, 404);
  const write = await app.inject({
    method: 'POST',
    url: '/operator/diagnostics/%63onsent',
    headers: { host, origin: 'https://foreign.example' },
    payload: {},
  });
  assert.equal(write.statusCode, 403);
});

test('image retry replaces a corrupt asset and concurrent retries publish the same bytes', async (t) => {
  const { directory, options } = await fixture(t);
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j+1EAAAAASUVORK5CYII=',
    'base64',
  );
  const digest = createHash('sha256').update(image).digest('hex');
  const filename = `${digest}.png`;
  const assets = join(directory, 'local-assets');
  await mkdir(assets);
  await writeFile(join(assets, filename), image.subarray(0, 8));

  const app = buildApp(options);
  t.after(() => app.close());
  const url = `/local/v1/local-assets/${filename}`;
  assert.equal((await app.inject(url)).statusCode, 404);
  const upload = () =>
    app.inject({
      method: 'POST',
      url: '/operator/local-asset',
      headers: { host, origin },
      payload: { mimeType: 'image/png', base64: image.toString('base64') },
    });
  for (const reply of await Promise.all([upload(), upload()])) {
    assert.equal(reply.statusCode, 200);
    assert.deepEqual(reply.json(), { url });
  }
  assert.deepEqual(await readFile(join(assets, filename)), image);
  const reopened = buildApp(options);
  t.after(() => reopened.close());
  const reply = await reopened.inject(url);
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(reply.rawPayload, image);
});

test('an overdue website shutdown releases the real SQLite writer before the local receipt', async (t) => {
  const { directory, options } = await fixture(t);
  const instanceId = randomUUID();
  const artifactSha256 = 'a'.repeat(64);
  const state = join(directory, 'data');
  const path = join(state, 'reliable-outbox.json');
  await mkdir(state);
  const receipt = join(state, `runtime-flush-${instanceId}.json`);
  for (const [key, value] of Object.entries({
    MIZAR_STATE_ROOT: directory,
    MIZAR_PRODUCT_INSTANCE: instanceId,
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  let resolveRemote!: () => void;
  const remote = new Promise<void>((resolve) => {
    resolveRemote = resolve;
  });
  let enterShutdown!: (signal: AbortSignal) => void;
  const entered = new Promise<AbortSignal>((resolve) => {
    enterShutdown = resolve;
  });
  t.after(() => resolveRemote());
  const app = buildApp({
    ...options,
    reliableOutboxPath: path,
    productRuntime: {
      instanceId,
      artifactSha256,
      appVersion: '1.11.5',
      gitSha: 'a'.repeat(40),
      controlToken: randomUUID(),
      stop: () => {},
    },
    rivalhubConnection: {
      view: () => ({ sourceState: 'ready', paired: false }),
      reliableAuthorityScope: () => undefined,
      reliableExactSource: () => undefined,
      clearStats: () => {},
      shutdownSource: (signal: AbortSignal) => {
        enterShutdown(signal);
        return remote;
      },
    } as unknown as RivalHubConnection,
  });
  t.after(() => app.close());
  await app.ready();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const closing = app.close();
  const signal = await entered;
  await assert.rejects(readFile(receipt), { code: 'ENOENT' });
  t.mock.timers.tick(9000);
  await closing;
  assert.equal(signal.aborted, true);
  assert.deepEqual(JSON.parse(await readFile(receipt, 'utf8')), {
    instanceId,
    artifactSha256,
    pid: process.pid,
  });
  const second = new ReliableOutbox(path);
  try {
    await second.load();
    resolveRemote();
  } finally {
    await second.close();
  }
});
