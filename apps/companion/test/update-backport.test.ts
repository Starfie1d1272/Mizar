import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { UpdateManager } from '../src/updates/manager.js';
import { transfer } from '../src/distribution/transfer.js';
import { updateRequest, boundedBytes, githubMetadata } from '../src/updates/network.js';

test('preserves existing transfer targets and permits bounded gzip text only by explicit policy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-transfer-backport-'));
  const target = join(root, 'archive');
  const bytes = Buffer.from('good');
  try {
    await writeFile(target, bytes);
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

test('uses public fixed GitHub metadata and transport-only proxy fallback without API or Box', async () => {
  const { StableSource } = await import('../src/updates/source.js');
  const hosts: string[] = [];
  const urls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    hosts.push(url.hostname);
    urls.push(url.href);
    return new Response(null, { status: 503 });
  };
  const signal = new AbortController().signal;
  for (const path of ['releases', 'git/ref/tags/v1.2.0', 'attestations/sha256:abc']) {
    await assert.rejects(
      updateRequest('https://api.github.com/repos/Starfie1d1272/Mizar/' + path, signal, fetcher),
      /update_url_forbidden/,
    );
  }
  assert.deepEqual(hosts, []);
  const source = new StableSource('unused-trust-cache', fetcher);
  await assert.rejects(source.latest(signal), /update_network_failed/);
  await assert.rejects(source.authenticateVersion('1.10.1', signal), /update_network_failed/);
  assert.deepEqual(hosts, ['github.com', 'gh-proxy.com', 'github.com', 'gh-proxy.com']);
  assert.ok(urls[0]!.endsWith('/releases/latest/download/machine-metadata.json'));
  assert.ok(urls[2]!.endsWith('/releases/download/v1.10.1/machine-metadata.json'));
  const latest = urls[0]!;
  const fixed = urls[2]!;
  const seen: string[] = [];
  const redirected: typeof fetch = async (input, init) => {
    const url = input.toString();
    seen.push(url);
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    if (url === latest) return new Response(null, { status: 503 });
    if (url.startsWith('https://gh-proxy.com/'))
      return new Response(null, { status: 302, headers: { location: fixed } });
    assert.equal(url, fixed);
    return new Response('original bytes');
  };
  assert.equal((await githubMetadata(latest, signal, redirected)).toString(), 'original bytes');
  assert.equal(seen.length, 3);
  seen.length = 0;
  const corrupt = new StableSource('unused-trust-cache', async (input) => {
    seen.push(input.toString());
    return new Response('{}');
  });
  await assert.rejects(corrupt.latest(signal), /Invalid machine metadata structure/);
  assert.deepEqual(seen, [latest]);
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
    await manager.check();
    assert.equal(manager.status().phase, 'ready');
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
