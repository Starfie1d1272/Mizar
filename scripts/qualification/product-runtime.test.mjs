import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { writableRoot, runProduct, stopProduct, PRODUCT_REPOSITORY } from './product-runtime.mjs';

import { verifyPromotion } from './verify-promotion.mjs';

const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture({ extraFiles = [], appVersion = '1.0.0-rc.27' } = {}) {
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
    appVersion,
    desktopBuildProfile: 'release',
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
});

it.each(['alpha.1', 'beta.2', 'rc.3'])(
  'promotion keeps exact tag/source/payload/binary identity for %s',
  async (suffix) => {
    const appVersion = `2.0.0-${suffix}`;
    const { root, artifact } = await fixture({ appVersion });
    const product = await mkdtemp(join(tmpdir(), 'mizar-promotion-'));
    roots.push(product);
    const extracted = join(product, 'extracted');
    await mkdir(extracted);
    const { rename } = await import('node:fs/promises');
    await rename(root, join(extracted, 'payload'));
    const archive = `Mizar-v${appVersion}-Windows-x64.zip`;
    // Structural fixture only: verifyPromotion receives an already extracted payload.
    const bytes = 'fixture archive';
    const digest = createHash('sha256').update(bytes).digest('hex');
    const manifest = {
      appVersion,
      gitSha: artifact.gitSha,
      archive,
      archiveSha256: digest,
      contentDigest: artifact.artifactSha256,
      desktopBuildProfile: 'release',
      developmentOnly: false,
    };
    await writeFile(join(product, 'release-manifest.json'), JSON.stringify(manifest));
    await writeFile(join(product, archive), bytes);
    await writeFile(join(product, `${archive}.sha256`), `${digest}  ${archive}`);
    const input = {
      product,
      extracted,
      tag: `v${appVersion}`,
      sourceSha: artifact.gitSha,
      binaryVersion: appVersion,
    };
    expect((await verifyPromotion(input)).appVersion).toBe(appVersion);
    await expect(verifyPromotion({ ...input, tag: 'v2.0.0' })).rejects.toThrow('标签');
    await expect(verifyPromotion({ ...input, sourceSha: 'b'.repeat(40) })).rejects.toThrow('来源');
    await expect(verifyPromotion({ ...input, binaryVersion: '2.0.0' })).rejects.toThrow('EXE');
    await writeFile(join(extracted, 'payload/Mizar.exe'), 'changed');
    await expect(verifyPromotion(input)).rejects.toThrow('校验失败');
  },
);
