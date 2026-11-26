import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boundedBytes, fetchHttps } from '../src/distribution/http.js';
import { getDistributionConfig, sourceOrder } from '../src/distribution/sources.js';
import { downloadVerifiedAsset, fetchVerifiedMetadata } from '../src/distribution/transfer.js';
import {
  extractMachineFile,
  fetchVerifiedResourceCarrier,
} from '../src/distribution/resource-transport.js';
import { makeMachineMetadata } from '@mizar/resource-pack-contract/transport';
import { diagnosticValue } from '../src/support/diagnostic-value.js';

test('sourceOrder supports >3 sources, filters text/html, and falls back on corrupt winner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-source-order-'));
  const originalFetch = globalThis.fetch;
  const bytes = Buffer.from('good-payload');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const config = getDistributionConfig();
  const requests: { host: string; range: string | null }[] = [];

  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    const range = headers.get('range');
    requests.push({ host: url.hostname, range });

    if (range) {
      if (url.hostname === new URL(config.githubReleaseProxies[0]!).hostname) {
        return new Response('<html>blocked</html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (url.hostname === 'github.com') {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return new Response(bytes, {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'content-range': `bytes 0-${bytes.length - 1}/${bytes.length}`,
        },
      });
    }

    const isFirstFullAttempt = requests.filter((r) => !r.range).length === 1;
    return new Response(isFirstFullAttempt ? Buffer.from('evil') : bytes, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }) as typeof fetch;

  try {
    const target = join(root, 'archive');
    await downloadVerifiedAsset({
      origin:
        'https://github.com/Starfie1d1272/Mizar/releases/download/v1.13.3/Mizar-v1.13.3-Windows-x64-Core-Setup.exe',
      target,
      bytes: bytes.length,
      sha256,
      signal: new AbortController().signal,
    });
    assert.deepEqual(await readFile(target), bytes);
    assert.ok(requests.some((r) => r.range === `bytes=0-${bytes.length - 1}`));
    assert.ok(requests.filter((r) => !r.range).length >= 2);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('sourceOrder accepts more than 3 candidates and uses 256 KiB sample', async () => {
  const config = getDistributionConfig();
  assert.equal(config.probe.sampleBytes, 262144);
  const delays = [40, 10, 30, 20];
  let observedRange = '';
  const order = await sourceOrder(
    512 * 1024,
    new AbortController().signal,
    delays.map((delay, idx) => async (_signal, end) => {
      if (idx === 0) observedRange = `0-${end}`;
      await new Promise((resolve) => setTimeout(resolve, delay));
      return new Response(Buffer.alloc(end + 1, idx), {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'content-range': `bytes 0-${end}/${512 * 1024}`,
        },
      });
    }),
  );
  assert.equal(observedRange, '0-262143');
  assert.deepEqual(order, [1, 3, 2, 0]);
});

test('fetchHttps follows valid HTTPS 302 redirects and strips Authorization cross-origin', async () => {
  const signal = new AbortController().signal;
  const boxApi = 'https://box.nju.edu.cn/api/v2.1/via-repo-token/download-link/';
  const externalTarget = 'https://cdn.example.com/files/opaque';
  const authSeen: { url: string; hasAuth: boolean }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const headers = new Headers(init?.headers);
    authSeen.push({ url, hasAuth: headers.has('authorization') });
    if (url === boxApi) {
      return new Response(null, { status: 302, headers: { location: externalTarget } });
    }
    return new Response('good', { status: 200 });
  };
  const response = await fetchHttps(boxApi, {
    signal,
    fetcher,
    headers: { Authorization: 'Token secret-value' },
  });
  assert.equal((await boundedBytes(response, 1024)).toString('utf8'), 'good');
  assert.deepEqual(authSeen, [
    { url: boxApi, hasAuth: true },
    { url: externalTarget, hasAuth: false },
  ]);
});

test('fetchHttps rejects non-HTTPS, credentials, localhost, and bare IP redirects', async () => {
  const signal = new AbortController().signal;
  for (const badLocation of [
    'http://example.com/insecure',
    'https://user@example.com/file',
    'https://localhost/secret',
    'https://sub.localhost/secret',
    'https://127.0.0.1/secret',
    'https://[::1]/secret',
  ]) {
    const fetcher: typeof fetch = async () =>
      new Response(null, { status: 302, headers: { location: badLocation } });
    await assert.rejects(
      fetchHttps('https://example.com/start', { signal, fetcher }),
      /distribution_url_forbidden/,
    );
  }
  await assert.rejects(
    fetchHttps('https://user:pass@example.com/file', { signal }),
    /distribution_url_forbidden/,
  );
});

test('fetchVerifiedMetadata tries official first, then races proxies and aborts losers', async () => {
  const signal = new AbortController().signal;
  const config = getDistributionConfig();
  assert.ok(config.githubReleaseProxies.length >= 2);
  let abortedSlowProxy = false;
  let officialTried = false;

  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.startsWith('https://github.com/')) {
      officialTried = true;
      return new Response('unavailable', { status: 503 });
    }
    const fastHost = new URL(config.githubReleaseProxies[1]!).hostname;
    if (url.includes(fastHost)) {
      return new Response(JSON.stringify({ valid: true, version: '1.13.3' }), { status: 200 });
    }
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          abortedSlowProxy = true;
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
  };

  const result = await fetchVerifiedMetadata({
    origin: 'https://github.com/Starfie1d1272/Mizar/releases/latest/download/machine-metadata.json',
    maxBytes: 64 * 1024,
    signal,
    fetcher,
    verify: (bytes) => {
      const parsed = JSON.parse(bytes.toString('utf8')) as { valid?: boolean; version?: string };
      if (!parsed.valid) throw new Error('metadata_signature_invalid');
      return parsed.version!;
    },
  });
  assert.equal(officialTried, true);
  assert.equal(result, '1.13.3');
  assert.equal(abortedSlowProxy, true);
});

test('fetchVerifiedResourceCarrier switches source when carrier signature verification fails', async () => {
  const signal = new AbortController().signal;
  const config = getDistributionConfig();
  const makeCarrier = (sig: string) =>
    makeMachineMetadata([['resource-catalog.json', Buffer.from(JSON.stringify({ sig }))]]);

  const badProxyHost = new URL(config.githubReleaseProxies[0]!).hostname;
  const fetcher: typeof fetch = async (input) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (url.startsWith('https://github.com/')) {
      return new Response('timeout', { status: 504 });
    }
    if (url.includes(badProxyHost)) {
      return new Response(makeCarrier('invalid-signature'), { status: 200 });
    }
    return new Response(makeCarrier('valid-signature'), { status: 200 });
  };

  const verified = await fetchVerifiedResourceCarrier({
    version: '1.13.3',
    signal,
    fetcher,
    verify: (carrier) => {
      const catalog = JSON.parse(
        extractMachineFile(carrier, 'resource-catalog.json', 65536).toString('utf8'),
      ) as { sig: string };
      if (catalog.sig !== 'valid-signature') throw new Error('resource_signature_invalid');
      return catalog.sig;
    },
  });
  assert.equal(verified, 'valid-signature');
});

test('downloadVerifiedAsset supports assets without preset bytes (e.g. 7zr.exe)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mizar-nobytes-'));
  const bytes = Buffer.from('7zr-binary-fixture');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const fetcher: typeof fetch = async () => new Response(bytes, { status: 200 });
  try {
    const target = join(root, '7zr.exe');
    await downloadVerifiedAsset({
      origin: 'https://github.com/ip7z/7zip/releases/download/26.04/7zr.exe',
      target,
      maxBytes: 1024 * 1024,
      sha256,
      fetcher,
      signal: new AbortController().signal,
    });
    assert.deepEqual(await readFile(target), bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnosticValue redacts explicit Box token secrets', () => {
  const secret = 'b88f62e59ca365d27ccb48f55dfef3a78965341f';
  const redacted = diagnosticValue(new Error(`failed with ${secret}`), '', new Set(), [secret]) as {
    message: string;
  };
  assert.equal(redacted.message.includes(secret), false);
  assert.equal(redacted.message.includes('[redacted]'), true);
});

test('C# web-installer enforces embedded config, local IO boundary, and success diagnostics', async () => {
  const [downloaderCs, windowCs] = await Promise.all([
    readFile(join(process.cwd(), '..', '..', 'scripts/web-installer/Downloader.cs'), 'utf8'),
    readFile(join(process.cwd(), '..', '..', 'scripts/web-installer/Window.cs'), 'utf8'),
  ]);
  assert.match(downloaderCs, /class LocalStorageException/);
  assert.match(downloaderCs, /catch \(LocalStorageException\)/);
  assert.match(downloaderCs, /缺少嵌入的分发配置 distribution\.json/);
  assert.match(windowCs, /SaveSuccessDiagnostic\(\)/);
});
