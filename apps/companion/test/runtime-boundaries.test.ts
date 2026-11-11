import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { buildApp } from '../src/app.js';
import type { RivalHubConnection } from '../src/match-context/rivalhub-connection.js';
import { ReliableOutbox } from '../src/output/reliable-outbox.js';

const host = '127.0.0.1:3000';
const origin = `http://${host}`;

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
    url: '/operator/local-asset',
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
