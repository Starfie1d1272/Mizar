import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { RivalHubLibrary } from '../src/match-context/rivalhub-library.js';
import { createProduction } from '../src/program-scenes/production.js';
import { registerCompanionShutdown } from '../src/runtime/shutdown.js';
import { BusinessJournal } from '../src/support/business-journal.js';

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
      failure: () => {},
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
  const command = (action?: string) =>
    app.inject({
      method: 'POST',
      url: '/operator/updates/install-plan',
      headers: { 'x-runtime-token': 'update-test-token' },
      payload: action ? { action } : {},
    });
  assert.equal((await command()).statusCode, 409);
  assert.equal(reserved, false);
  active = null;
  assert.equal((await command()).statusCode, 200);
  assert.equal(reserved, true);
  assert.equal(await routes.beforeStop(), null);
  active = true;
  assert.match((await routes.beforeStop()) ?? '', /推流或录制/);
  assert.equal(reserved, false);
});

test('rollback applier result notifies once across restarts and skips cancelled results', async (t) => {
  const stateRoot = await mkdtemp(join(tmpdir(), 'mizar-applier-result-'));
  const logsDir = join(stateRoot, 'logs');
  await mkdir(logsDir, { recursive: true });
  t.after(async () => {
    await rm(stateRoot, { recursive: true, force: true });
  });
  const resultPath = join(logsDir, 'last-applier-result.json');
  await writeFile(
    resultPath,
    JSON.stringify({
      status: 'rolled_back',
      version: '1.13.0',
      message: '新版启动失败，已自动回退到上一版本',
    }),
  );
  const makeManager = () =>
    new UpdateManager({
      stateRoot,
      bundleRoot: stateRoot,
      currentContentDigest: 'c'.repeat(64),
      installed: true,
      version: '1.12.0',
      source: { latest: async () => null },
    });

  const first = makeManager();
  t.after(() => first.close());
  await first.load();
  assert.equal(first.status().lastResult, 'restored');
  assert.equal(first.status().lastResultVersion, '1.13.0');
  assert.equal(first.status().lastResultNotificationPending, true);

  assert.equal(await first.dismissLastResult(), true);
  assert.equal(first.status().lastResultNotificationPending, false);
  assert.equal(await first.dismissLastResult(), false);

  const second = makeManager();
  t.after(() => second.close());
  await second.load();
  assert.equal(second.status().lastResult, 'restored');
  assert.equal(second.status().lastResultNotificationPending, false);

  await writeFile(resultPath, JSON.stringify({ status: 'cancelled', version: '1.13.0' }));
  const third = makeManager();
  t.after(() => third.close());
  await third.load();
  assert.equal(third.status().lastResult, 'cancelled');
  assert.equal(third.status().lastResultNotificationPending, false);
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

test('rehearsal binding reaches production projections, retires, and can be loaded again', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mizar-rehearsal-binding-'));
  const app = buildApp({
    matchManifestPath: join(directory, 'match.json'),
    obsConfigPath: join(directory, 'obs.json'),
    rehearsalFixturePath: fileURLToPath(
      new URL('../../../fixtures/epl-s24/rehearsal.generated.json', import.meta.url),
    ),
  });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const command = (path: string) =>
    app.inject({
      method: 'POST',
      url: `/operator/rivals-rehearsal/${path}`,
      headers: { host, origin },
    });
  const document = () => app.inject('/local/v1/match-document');
  assert.equal((await document()).statusCode, 404);
  for (let run = 0; run < 2; run++) {
    const loaded = await command('load');
    assert.equal(loaded.statusCode, 200, loaded.body);
    assert.equal(loaded.json().loaded, true);
    const selected = await document();
    assert.equal(selected.statusCode, 200);
    assert.equal(selected.json().source, 'fixture');
    const presentation = await app.inject('/local/v1/program-presentation');
    assert.equal(presentation.json().match?.matchId, loaded.json().selectedMatchId);
    const stopped = await command('stop');
    assert.equal(stopped.statusCode, 200, stopped.body);
    assert.equal(stopped.json().loaded, false);
    assert.equal((await document()).statusCode, 404);
    assert.equal((await app.inject('/local/v1/program-presentation')).json().match, null);
  }
});

function withEnv(t: TestContext, entries: Record<string, string>) {
  for (const [key, value] of Object.entries(entries)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

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

test('a failed consumer close still releases the local writer and withholds the receipt', async (t) => {
  const { directory, options } = await fixture(t);
  const instanceId = randomUUID();
  const outboxPath = join(directory, 'outbox.json');
  withEnv(t, { MIZAR_STATE_ROOT: directory, MIZAR_PRODUCT_INSTANCE: instanceId });
  const failure = new Error('consumer could not close');
  const app = buildApp({
    ...options,
    reliableOutboxPath: outboxPath,
    deliveryConsumers: [
      {
        getHealth: () => ({
          id: 'test-consumer',
          state: 'idle',
          inFlight: false,
          hasPendingLatest: false,
          offered: 0,
          sent: 0,
          coalesced: 0,
          failed: 0,
        }),
        close: async () => {
          throw failure;
        },
      },
    ],
    productRuntime: {
      instanceId,
      artifactSha256: 'a'.repeat(64),
      gitSha: 'a'.repeat(40),
      controlToken: randomUUID(),
      stop: () => {},
    },
  });
  await app.ready();
  await assert.rejects(
    app.close(),
    (error) => error instanceof AggregateError && error.errors.includes(failure),
  );
  await assert.rejects(readFile(join(directory, 'data', `runtime-flush-${instanceId}.json`)), {
    code: 'ENOENT',
  });
  const restarted = new ReliableOutbox(outboxPath);
  try {
    await restarted.load();
  } finally {
    await restarted.close();
  }
});

test('an overdue website shutdown releases the real SQLite writer before the local receipt', async (t) => {
  const { directory, options } = await fixture(t);
  const instanceId = randomUUID();
  const artifactSha256 = 'a'.repeat(64);
  const state = join(directory, 'data');
  const path = join(state, 'reliable-outbox.json');
  await mkdir(state);
  const receipt = join(state, `runtime-flush-${instanceId}.json`);
  withEnv(t, { MIZAR_STATE_ROOT: directory, MIZAR_PRODUCT_INSTANCE: instanceId });
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

test('RivalHubLibrary separates manual refresh from 60s background cooldown and reports cache persistence failures honestly', async (t) => {
  const { directory } = await fixture(t);
  let now = 100_000;
  let calls = 0;
  let online = true;
  const schedule = {
    schemaVersion: 'rivalhub.broadcast-schedule-window.v1' as const,
    revision: 'rev-1',
    competition: { competitionId: 'comp-1', slug: 'comp-1', name: 'Test Cup', themeColor: null },
    from: '2026-11-01T00:00:00.000Z',
    to: '2026-11-30T00:00:00.000Z',
    matches: [],
  };
  const validPath = join(directory, 'library.json');
  const library = new RivalHubLibrary(
    validPath,
    'comp-1',
    async () => {
      calls++;
      if (!online) throw new Error('network down');
      return schedule;
    },
    async () => ({}),
    () => now,
  );
  const first = await library.view();
  assert.equal(calls, 1);
  assert.equal(first.library.error, null);
  assert.ok(first.library.syncedAt);
  await new Promise((r) => setTimeout(r, 15));

  now += 61_000;
  online = false;
  await library.view();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 2);

  online = true;
  now += 5_000;
  const bg = await library.view(false);
  assert.equal(calls, 2);
  assert.match(bg.library.error ?? '', /网站暂时无法连接/);

  const manual = await library.view(true);
  assert.equal(calls, 3);
  assert.equal(manual.library.error, null);

  const blockedDir = join(directory, 'blocked-file');
  await writeFile(blockedDir, 'not-a-directory');
  const unwriteable = new RivalHubLibrary(
    join(blockedDir, 'library.json'),
    'comp-1',
    async () => schedule,
    async () => ({}),
    () => now,
  );
  const result = await unwriteable.view(true);
  assert.equal(result.matches.length, 0);
  assert.equal(result.library.syncedAt, null);
  assert.match(result.library.error ?? '', /本机缓存保存失败/);
});

test('entering workspace bounds broadcast wait and BusinessJournal failure does not block flush receipt', async (t) => {
  const { directory } = await fixture(t);
  const instanceId = randomUUID();
  const artifactSha256 = 'b'.repeat(64);
  const dataDir = join(directory, 'data');
  await mkdir(dataDir);
  withEnv(t, { MIZAR_STATE_ROOT: directory, MIZAR_PRODUCT_INSTANCE: instanceId });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const production = createProduction({
    scenes: {
      holdAutomatic: () => {},
      selectWaitingForExit: async () => ({ ok: true }),
      controlValid: () => () => true,
      get: () => ({ revision: 'rev-1' }),
      setResourceActivationPending: () => {},
    } as unknown as Parameters<typeof createProduction>[0]['scenes'],
    music: () => undefined,
    camera: () => undefined,
    demo: () => undefined,
    observer: { endProduction: () => {} },
    binding: () => undefined,
    waitForBroadcast: () => new Promise(() => {}),
    obsExit: { previousUnconfirmed: false, record: async () => {}, wait: async () => {} },
    warn: () => {},
    error: () => {},
  });
  const entering = production.change({
    action: 'enter',
    expectedRevision: production.get().revision,
    preparationId: randomUUID(),
  });
  await Promise.resolve();
  t.mock.timers.tick(2600);
  const entered = await entering;
  assert.equal(entered.ok, true);
  assert.equal(production.get().mode, 'live');

  const journal = new BusinessJournal(
    directory,
    () => {},
    '1.0.0',
    () => {
      throw new Error('disk full');
    },
  );
  journal.write('test_stage', { ok: true });
  assert.equal(journal.getStatus(), 'write_failed');
  const app = fastify();
  registerCompanionShutdown(app, {
    stopDirector: () => {},
    stopObservation: () => {},
    unsubscribePresentation: () => {},
    unsubscribeObjectiveReference: undefined,
    closeCamera: () => {},
    closeMusic: () => {},
    closeGameAudio: () => {},
    closeObs: () => {},
    waitForObsExit: async () => {},
    stopCstv: [],
    closeDeliveryConsumers: [],
    closeProjection: () => {},
    closeCues: () => {},
    stopWebsiteDelivery: () => {},
    flushWebsiteDiagnostics: () => {},
    closeRuntime: () => {},
    closeTransport: () => {},
    hudConfigStore: {
      flush: async () => {},
      getState: () => ({ persistenceError: null }),
    } as unknown as Parameters<typeof registerCompanionShutdown>[1]['hudConfigStore'],
    flushBroadcastReceipts: () => {},
    currentRecorder: () =>
      ({ finalize: async () => {} }) as unknown as ReturnType<
        Parameters<typeof registerCompanionShutdown>[1]['currentRecorder']
      >,
    readBusinessJournal: () => journal,
    closeSupport: async () => {},
    closeWebsiteOutput: () => {},
    unsubscribeMatchBinding: undefined,
    product: {
      instanceId,
      artifactSha256,
      gitSha: 'a'.repeat(40),
      controlToken: randomUUID(),
      stop: () => {},
    },
  });
  await app.close();
  assert.deepEqual(
    JSON.parse(await readFile(join(dataDir, `runtime-flush-${instanceId}.json`), 'utf8')),
    { instanceId, artifactSha256, pid: process.pid },
  );
});
