import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { UpdateManager } from '../src/updates/manager.js';
import { transfer } from '../src/distribution/transfer.js';
import { updateRequest, boundedBytes } from '../src/updates/network.js';

test('shares a running update check and preserves a disabled preference', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-update-backport-'));
  let finish!: (value: null) => void;
  let calls = 0;
  const manager = new UpdateManager({
    stateRoot: root,
    bundleRoot: root,
    currentContentDigest: 'a'.repeat(64),
    version: '1.9.1',
    installed: true,
    source: {
      latest: () => {
        calls++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
      authenticate: async () => {
        throw new Error('unexpected');
      },
    },
  });
  try {
    await manager.load();
    const a = manager.check(),
      b = manager.check();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    finish(null);
    await Promise.all([a, b]);
    await manager.setAutomatic(false);
    manager.desktopStartup('new-host');
    assert.equal(manager.status().automatic, false);
    assert.equal(calls, 1);
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('retries corrupt source with verified bytes and permits bounded gzip text only by explicit policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-transfer-backport-'));
  const target = join(root, 'archive');
  const bytes = Buffer.from('good');
  try {
    await transfer({
      target,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      signal: new AbortController().signal,
      sources: [async () => new Response('evil'), async () => new Response(bytes)],
    });
    assert.deepEqual(await readFile(target), bytes);
    let retried = false;
    await assert.rejects(
      transfer({
        target,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        signal: new AbortController().signal,
        sources: [
          async () => new Response(bytes),
          async () => {
            retried = true;
            return new Response(bytes);
          },
        ],
      }),
      { code: 'EEXIST' },
    );
    assert.equal(retried, false);
    assert.deepEqual(await readFile(target), bytes);
    const fetcher = async () =>
      new Response(bytes, {
        headers: {
          'content-encoding': 'gzip',
          'content-type': 'text/plain; charset=gbk',
          'content-length': '100',
        },
      });
    const url = 'https://box.nju.edu.cn/seafhttp/files/opaque';
    const signal = new AbortController().signal;
    await assert.rejects(updateRequest(url, signal, fetcher), /update_encoding_invalid/);
    assert.deepEqual(
      await boundedBytes(
        await updateRequest(url, signal, fetcher, { allowCompressedBoxText: true }),
        4,
      ),
      bytes,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('shares an in-flight MulNX check rather than issuing a second request', async () => {
  const { MulnxTool } = await import('../src/orchestration/tool.js');
  const root = await mkdtemp(join(tmpdir(), 'mizar-mulnx-check-'));
  const previousFetch = globalThis.fetch;
  let githubCalls = 0;
  let finish!: (response: Response) => void;
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const address = new URL(input instanceof Request ? input.url : input.toString());
    if (address.hostname === 'box.nju.edu.cn')
      return Promise.resolve(new Response(null, { status: 503 }));
    githubCalls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  }) as typeof fetch;
  try {
    const tool = new MulnxTool(join(root, 'mulnx'), join(root, 'bundle'));
    await tool.load();
    const first = tool.check(),
      second = tool.check();
    assert.equal(first, second);
    assert.equal(githubCalls, 1);
    const tag = 'Fixture1';
    finish(
      new Response(
        JSON.stringify([
          {
            id: 1,
            draft: false,
            published_at: '2026-01-01T00:00:00Z',
            tag_name: tag,
            assets: [
              {
                id: 2,
                name: 'MulNX.7z',
                digest: 'sha256:' + 'a'.repeat(64),
                size: 1,
                browser_download_url: `https://github.com/Co1Swet/MulNX_CS2/releases/download/${tag}/MulNX.7z`,
              },
            ],
          },
        ]),
      ),
    );
    await Promise.all([first, second]);
    assert.equal(tool.view().latest, tag);
    assert.equal(githubCalls, 1);
  } finally {
    globalThis.fetch = previousFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('entry checks respect the saved preference while manual checks query both products', async () => {
  const { default: Fastify } = await import('fastify');
  const { registerUpdateRoutes } = await import('../src/updates/routes.js');
  const app = Fastify();
  let automatic = false,
    mizar = 0,
    mulnx = 0;
  const manager = {
    status: () => ({ phase: 'idle', automatic }),
    check: async () => {
      mizar++;
    },
    close: async () => {},
  };
  const tool = {
    view: () => ({ notificationIdentity: null, notifiedIdentity: null }),
    check: async () => {
      mulnx++;
    },
  };
  const options = {
    manager,
    originPolicy: { mode: 'loopback', bindHost: '127.0.0.1', allowedOrigins: [] },
    controlToken: 'fixture',
    production: { get: () => ({ mode: 'preparation', revision: '1' }) },
    scenes: { get: () => ({ active: 'waiting', preparing: false, director: null }) },
    obs: async () => undefined,
    mulnx: () => tool,
  } as unknown as Parameters<typeof registerUpdateRoutes>[1];
  registerUpdateRoutes(app, options);
  try {
    const request = (action: string) =>
      app.inject({
        method: 'POST',
        url: '/operator/updates',
        headers: { origin: 'http://127.0.0.1:3000' },
        payload: { action },
      });
    assert.equal((await request('entry-check')).statusCode, 200);
    assert.deepEqual([mizar, mulnx], [0, 0]);
    assert.equal((await request('check')).statusCode, 200);
    assert.deepEqual([mizar, mulnx], [1, 1]);
    automatic = true;
    assert.equal((await request('entry-check')).statusCode, 200);
    assert.deepEqual([mizar, mulnx], [2, 2]);
  } finally {
    await app.close();
  }
});

test('Mizar download sorts authenticated sources, labels fallback and verifies full bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-update-sources-'));
  const bytes = Buffer.from('good');
  const digest = createHash('sha256').update(bytes).digest('hex');
  const manifest = {
    schemaVersion: 'mizar.update.v1' as const,
    repository: 'Starfie1d1272/Mizar' as const,
    channel: 'stable' as const,
    version: '1.9.2',
    gitSha: 'a'.repeat(40),
    notes: 'test',
    compatibility: { minimumVersion: '1.0.0', maximumVersionExclusive: '2.0.0' },
    installer: {
      platform: 'win32-x64' as const,
      format: 'nsis-setup' as const,
      name: 'Mizar-v1.9.2-Windows-x64-Setup.exe',
      bytes: bytes.length,
      sha256: digest,
      contentDigest: 'b'.repeat(64),
    },
  };
  const full: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    if (url.hostname === 'box.nju.edu.cn') return new Response(null, { status: 503 });
    const range = headers.get('range');
    if (range && url.hostname === 'github.com')
      await new Promise((resolve) => setTimeout(resolve, 20));
    if (range)
      return new Response(bytes, { status: 206, headers: { 'content-range': 'bytes 0-3/4' } });
    full.push(url.hostname);
    return new Response(url.hostname === 'gh-proxy.com' ? 'evil' : bytes);
  };
  const manager = new UpdateManager({
    stateRoot: root,
    bundleRoot: root,
    currentContentDigest: 'c'.repeat(64),
    version: '1.9.1',
    installed: true,
    fetcher,
    source: { latest: async () => ({ tag_name: 'v1.9.2' }), authenticate: async () => manifest },
  });
  try {
    await manager.load();
    await manager.check();
    await manager.download();
    for (let i = 0; i < 100 && manager.status().phase === 'downloading'; i++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(manager.status().phase, 'ready');
    assert.equal(manager.status().downloadSource, 'GitHub');
    assert.deepEqual(full, ['gh-proxy.com', 'github.com']);
    const ready = JSON.parse(await readFile(join(root, 'updates', 'ready.json'), 'utf8')) as {
      directory: string;
    };
    assert.deepEqual(
      await readFile(join(root, 'updates', ready.directory, manifest.installer.name)),
      bytes,
    );
  } finally {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  }
});
