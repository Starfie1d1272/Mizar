import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT_REPOSITORY, main, readArtifactMetadata } from './product-runtime.mjs';

const ARTIFACT_SHA = 'a'.repeat(64);
const GIT_SHA = 'b'.repeat(40);
const INSTANCE_ID = '11111111-2222-4333-8444-555555555555';
const CONTROL_TOKEN = 'c'.repeat(64);

async function makeFixture(t, { includeArtifact = true, corruptSums = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mizar-product-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateRoot = join(root, 'state');
  await mkdir(join(root, 'resources/metadata'), { recursive: true });
  await mkdir(join(stateRoot, 'data'), { recursive: true });
  if (includeArtifact) {
    await writeFile(
      join(root, 'resources/metadata/artifact.json'),
      JSON.stringify({
        repository: PRODUCT_REPOSITORY,
        productSchemaVersion: 1,
        desktopHost: 'tauri2',
        platform: 'win32-x64',
        developmentOnly: false,
        gitSha: GIT_SHA,
        artifactSha256: ARTIFACT_SHA,
      }),
    );
  }
  if (corruptSums) {
    await writeFile(join(root, 'resources/metadata/SHA256SUMS'), 'corrupt-and-incomplete\n');
  }
  return { root, stateRoot };
}

async function startMockCompanion(t, stateRoot) {
  let stopRequested = false;
  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          product: {
            repository: PRODUCT_REPOSITORY,
            artifactSha256: ARTIFACT_SHA,
            mode: 'product',
            instanceId: INSTANCE_ID,
          },
        }),
      );
      return;
    }
    if (
      req.method === 'POST' &&
      req.url === '/operator/runtime/stop' &&
      req.headers['x-runtime-token'] === CONTROL_TOKEN
    ) {
      stopRequested = true;
      await writeFile(
        join(stateRoot, 'data', `runtime-exit-${INSTANCE_ID}.json`),
        JSON.stringify({
          instanceId: INSTANCE_ID,
          pid: process.pid,
          artifactSha256: ARTIFACT_SHA,
          code: 0,
          signal: null,
          error: false,
          localComplete: true,
        }),
      );
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise((done) => server.close(done)));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await writeFile(
    join(stateRoot, 'data/runtime.json'),
    JSON.stringify({
      repository: PRODUCT_REPOSITORY,
      artifactSha256: ARTIFACT_SHA,
      instanceId: INSTANCE_ID,
      controlToken: CONTROL_TOKEN,
      pid: process.pid,
    }),
  );
  return { port: address.port, wasStopRequested: () => stopRequested };
}

test('readArtifactMetadata validates artifact.json without reading SHA256SUMS', async (t) => {
  const { root } = await makeFixture(t, { includeArtifact: true, corruptSums: true });
  const artifact = await readArtifactMetadata(root);
  assert.equal(artifact.gitSha, GIT_SHA);
  assert.equal(artifact.artifactSha256, ARTIFACT_SHA);

  await writeFile(
    join(root, 'resources/metadata/artifact.json'),
    JSON.stringify({ repository: PRODUCT_REPOSITORY, developmentOnly: true }),
  );
  await assert.rejects(readArtifactMetadata(root), /程序版本信息不完整/);
});

test('main --stop stops running companion without SHA256SUMS or non-critical files', async (t) => {
  const { root, stateRoot } = await makeFixture(t, { includeArtifact: true, corruptSums: true });
  const companion = await startMockCompanion(t, stateRoot);

  await main({
    root,
    argv: ['--stop'],
    env: {
      MIZAR_STATE_ROOT: stateRoot,
      MIZAR_STARTUP_SESSION_ID: 'stop-session-1',
    },
    platform: 'win32',
    arch: 'x64',
    port: companion.port,
  });

  assert.equal(companion.wasStopRequested(), true);
  const supervisorLog = await readFile(join(stateRoot, 'logs/supervisor.ndjson'), 'utf8');
  assert.doesNotMatch(supervisorLog, /artifact_verify_/);
  assert.match(supervisorLog, /"stage":"product_stopped"/);
});

test('main --stop with MIZAR_EXPECTED_RUNTIME_INSTANCE does not even require artifact.json', async (t) => {
  const { root, stateRoot } = await makeFixture(t, { includeArtifact: false, corruptSums: false });
  const companion = await startMockCompanion(t, stateRoot);

  await main({
    root,
    argv: ['--stop'],
    env: {
      MIZAR_STATE_ROOT: stateRoot,
      MIZAR_EXPECTED_RUNTIME_INSTANCE: INSTANCE_ID,
      MIZAR_STARTUP_SESSION_ID: 'stop-session-2',
    },
    platform: 'win32',
    arch: 'x64',
    port: companion.port,
  });

  assert.equal(companion.wasStopRequested(), true);
});

test('main startup path validates only artifact.json metadata and skips payload hashing', async (t) => {
  const { root, stateRoot } = await makeFixture(t, { includeArtifact: true, corruptSums: true });
  const companion = await startMockCompanion(t, stateRoot);

  await main({
    root,
    argv: ['--no-browser', '--reuse-only'],
    env: {
      MIZAR_STATE_ROOT: stateRoot,
      MIZAR_STARTUP_SESSION_ID: 'start-session-1',
    },
    platform: 'win32',
    arch: 'x64',
    port: companion.port,
  });

  const supervisorLog = await readFile(join(stateRoot, 'logs/supervisor.ndjson'), 'utf8');
  assert.doesNotMatch(supervisorLog, /artifact_verify_/);
  assert.match(supervisorLog, /"stage":"runtime_reused"/);
});
