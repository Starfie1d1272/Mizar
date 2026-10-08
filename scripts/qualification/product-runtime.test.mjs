import { validateArtifact } from './evidence/integrity.mjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import {
  verifyPayload,
  writableRoot,
  runProduct,
  stopProduct,
  PRODUCT_REPOSITORY,
} from './product-runtime.mjs';

const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture({ extraFiles = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'broadcast portable '));
  roots.push(root);
  const files = [
    'Mizar.exe',
    'resources/runtime/node.exe',
    'resources/app/dist/server.js',
    'resources/web/dist/index.html',
    'resources/scripts/product-runtime.mjs',
    'resources/scripts/product-logs.mjs',
    ...extraFiles,
  ];
  for (const name of files) {
    await mkdir(join(root, name, '..'), { recursive: true });
    await writeFile(join(root, name), 'fixture');
  }
  await mkdir(join(root, 'resources/metadata'), { recursive: true });
  const hash = (data) => createHash('sha256').update(data).digest('hex');
  const sums = files.sort().map((name) => `${hash('fixture')}  ${name}`);
  const artifact = {
    repository: PRODUCT_REPOSITORY,
    schemaVersion: 1,
    productSchemaVersion: 1,
    desktopHost: 'tauri2',
    platform: 'win32-x64',
    gitSha: 'a'.repeat(40),
    appVersion: '1.0.0-rc.27',
    artifactSha256: hash(files.map((name) => `${name}\0${hash('fixture')}\n`).join('')),
  };
  const json = JSON.stringify(artifact);
  await writeFile(join(root, 'resources/metadata/artifact.json'), json);
  sums.push(`${hash(json)}  resources/metadata/artifact.json`);
  await writeFile(join(root, 'resources/metadata/SHA256SUMS'), sums.join('\n'));
  return { root, artifact };
}
async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

describe('portable payload', () => {
  it('keeps installed user data outside replaceable payload while retaining explicit and portable roots', async () => {
    const { root } = await fixture();
    expect(writableRoot(root)).toBe(join(root, 'state'));
    const local = join(root, 'user-profile');
    vi.stubEnv('LOCALAPPDATA', local);
    await writeFile(join(root, 'installed.flag'), 'installed');
    expect(writableRoot(root)).toBe(join(local, 'Mizar'));
    expect(writableRoot(root, join(root, 'explicit-data'))).toBe(join(root, 'explicit-data'));
    vi.stubEnv('LOCALAPPDATA', undefined);
    expect(() => writableRoot(root)).toThrow('用户数据目录不可用');
    expect(writableRoot(root, join(root, 'explicit-data'))).toBe(join(root, 'explicit-data'));
  });

  it('checks complete content and excludes writable data', async () => {
    const { root, artifact } = await fixture();
    await mkdir(join(root, 'state'), { recursive: true });
    await writeFile(join(root, 'state', 'settings'), 'mutable');
    const progress = [];
    expect(await verifyPayload(root, { onProgress: (entry) => progress.push(entry) })).toEqual(
      artifact,
    );
    expect(progress[0]).toEqual({ completed: 0, total: 7 });
    expect(progress.at(-1)).toEqual({ completed: 7, total: 7 });
    await writeFile(join(root, 'resources/web/dist/index.html'), 'corrupt');
    await expect(verifyPayload(root)).rejects.toThrow('校验失败');
  });
  it('checks every batch and preserves the sorted content digest', async () => {
    const extraFiles = Array.from(
      { length: 20 },
      (_, index) => `resources/app/dist/extra-${index}.js`,
    );
    const { root, artifact } = await fixture({ extraFiles });
    const progress = [];
    expect(await verifyPayload(root, { onProgress: (entry) => progress.push(entry) })).toEqual(
      artifact,
    );
    expect(progress.at(-1)).toEqual({ completed: 27, total: 27 });
    await writeFile(join(root, 'resources/web/dist/index.html'), 'corrupt last batch');
    await expect(verifyPayload(root)).rejects.toThrow('resources/web/dist/index.html');
  });
  it('explains an incomplete extraction and preserves the missing-file cause', async () => {
    const { root } = await fixture();
    await rm(join(root, 'resources/app/dist/server.js'));
    const error = await verifyPayload(root).catch((failure) => failure);
    expect(error.message).toContain('程序包缺少文件：resources/app/dist/server.js');
    expect(error.message).toContain('解压');
    expect(error.cause.code).toBe('ENOENT');
  });
  it('rejects development artifacts and path traversal', async () => {
    expect(() => validateArtifact({ developmentOnly: true })).toThrow('开发结构包');
    const { root, artifact } = await fixture();
    await writeFile(
      join(root, 'resources/metadata/artifact.json'),
      JSON.stringify({ ...artifact, developmentOnly: true }),
    );
    await expect(verifyPayload(root)).rejects.toThrow('版本信息');
    await writeFile(join(root, 'resources/metadata/artifact.json'), JSON.stringify(artifact));
    await writeFile(join(root, 'resources/metadata/SHA256SUMS'), `${'a'.repeat(64)}  ../outside`);
    await expect(verifyPayload(root)).rejects.toThrow('路径无效');
  });
  it('refuses state inside payload or relative overrides', () => {
    expect(() => writableRoot(join(tmpdir(), 'product'), 'relative')).toThrow();
    expect(() =>
      writableRoot(join(tmpdir(), 'product'), join(tmpdir(), 'product/resources/data')),
    ).toThrow();
    expect(writableRoot(join(tmpdir(), 'product'), join(tmpdir(), 'external/data'))).toBe(
      join(tmpdir(), 'external/data'),
    );
  });
});

describe('portable process lifecycle', () => {
  it('reuses a healthy instance and rejects unrelated occupied ports', async () => {
    const { root, artifact } = await fixture();
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          product: {
            repository: PRODUCT_REPOSITORY,
            artifactSha256: artifact.artifactSha256,
            instanceId: 'other',
            mode: 'product',
          },
        }),
      );
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const port = server.address().port;
    try {
      expect(
        await runProduct({
          root,
          artifact,
          port,
          stateRoot: join(root, 'state'),
          nodePath: process.execPath,
          openBrowser: false,
        }),
      ).toEqual({ reused: true });
      await expect(
        runProduct({
          root,
          artifact: { ...artifact, artifactSha256: 'different' },
          port,
          stateRoot: join(root, 'state'),
          nodePath: process.execPath,
          openBrowser: false,
        }),
      ).rejects.toThrow('端口');
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
  it('starts a child, stops only its own identity, and preserves data across restart', async () => {
    const { root, artifact } = await fixture();
    const port = await freePort();
    const stateRoot = join(root, 'state');
    await writeFile(
      join(root, 'resources/app/dist/server.js'),
      `const http=require('node:http'); const env=process.env; const server=http.createServer((req,res)=>{if(req.url==='/health'){res.end(JSON.stringify({product:{repository:'${PRODUCT_REPOSITORY}',appVersion:env.MIZAR_APP_VERSION,artifactSha256:env.MIZAR_ARTIFACT_SHA256,instanceId:env.MIZAR_PRODUCT_INSTANCE,mode:'product'}}));}else if(req.headers['x-runtime-token']===env.MIZAR_RUNTIME_TOKEN){res.end('{}'); server.close();}else {res.statusCode=403;res.end();}});server.listen(Number(env.PORT),'127.0.0.1');`,
    );
    let previousToken;
    let previousInstance;
    for (let attempt = 0; attempt < 2; attempt++) {
      const running = runProduct({
        root,
        artifact,
        port,
        stateRoot,
        nodePath: process.execPath,
        openBrowser: false,
        sessionId: `restart-${attempt}`,
      });
      // Attach rejection immediately so a failed start cannot escape the test.
      running.catch(() => {});
      let ready = false;
      let state;
      for (let i = 0; i < 100; i++) {
        try {
          const response = await globalThis.fetch(`http://127.0.0.1:${port}/health`);
          if (response.ok) {
            // The child can bind before the supervisor finishes publishing its identity.
            state = JSON.parse(await readFile(join(stateRoot, 'data/runtime.json'), 'utf8'));
            if (state.startupSessionId !== `restart-${attempt}`) {
              await delay(30);
              continue;
            }
            ready = true;
            break;
          }
        } catch {
          /* Wait for both child health and the complete supervisor state file. */
        }
        await delay(30);
      }
      expect(ready).toBe(true);
      expect(
        (await (await globalThis.fetch(`http://127.0.0.1:${port}/health`)).json()).product
          .appVersion,
      ).toBe(artifact.appVersion);
      expect(state.startupSessionId).toBe(`restart-${attempt}`);
      expect(state.supervisorPid).toBe(process.pid);
      const token = await readFile(join(stateRoot, 'data/gsi-token.txt'), 'utf8');
      if (attempt) {
        expect(token).toBe(previousToken);
        expect(state.instanceId).not.toBe(previousInstance);
      }
      previousToken = token;
      previousInstance = state.instanceId;
      await stopProduct(root, { port, stateRoot });
      expect(await running).toEqual({ reused: false });
      await expect(readFile(join(stateRoot, 'data/runtime.json'))).rejects.toThrow();
    }
    const previousLog = await readFile(join(stateRoot, 'logs/companion.log.1'), 'utf8');
    expect(previousLog).toContain('restart-0');
    const stages = (await readFile(join(stateRoot, 'logs/supervisor.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(stages.filter((entry) => entry.stage === 'runtime_ready')).toHaveLength(2);
    expect(stages.filter((entry) => entry.stage === 'companion_exit')).toHaveLength(2);
  }, 15000);

  it('keeps startup stderr and exit evidence when Companion exits before health', async () => {
    const { root, artifact } = await fixture();
    await writeFile(
      join(root, 'resources/app/dist/server.js'),
      "console.error('fixture startup failure'); process.exitCode = 7;\n",
    );
    const stateRoot = join(root, 'state');
    await expect(
      runProduct({
        root,
        artifact,
        port: await freePort(),
        stateRoot,
        nodePath: process.execPath,
        openBrowser: false,
        sessionId: 'failed-start',
      }),
    ).rejects.toThrow('未能启动');
    expect(await readFile(join(stateRoot, 'logs/companion.stderr.log'), 'utf8')).toContain(
      'fixture startup failure',
    );
    const stages = (await readFile(join(stateRoot, 'logs/supervisor.ndjson'), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(stages).toContainEqual(
      expect.objectContaining({
        stage: 'companion_exit',
        code: 7,
        startupSessionId: 'failed-start',
      }),
    );
    await expect(readFile(join(stateRoot, 'data/runtime.json'))).rejects.toThrow();
  });
});
