import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sourceOrder } from '../src/distribution/sources.js';

function response(delay: number, status = 206) {
  return async (_signal: AbortSignal, end: number) => {
    await new Promise((resolve) => setTimeout(resolve, delay));
    return new Response(Buffer.alloc(end + 1), {
      status,
      headers: {
        'content-range': `bytes 0-${end}/65536`,
        'content-type': 'application/octet-stream',
      },
    });
  };
}
test('ranks actual bounded samples and reuses a short-lived result for the same identity', async () => {
  let calls = 0;
  const probes = [response(20), response(1)].map(
    (probe) => async (signal: AbortSignal, end: number) => {
      calls++;
      return probe(signal, end);
    },
  );
  const signal = new AbortController().signal;
  assert.deepEqual(await sourceOrder('fixture-ordered', 65536, signal, probes), [1, 0]);
  assert.deepEqual(await sourceOrder('fixture-ordered', 65536, signal, probes), [1, 0]);
  assert.equal(calls, 2);
});
test('ignores HTML and incomplete samples; abort does not select another source', async () => {
  const signal = new AbortController().signal;
  const html = async () => new Response('<html>', { headers: { 'content-type': 'text/html' } });
  assert.deepEqual(
    await sourceOrder('fixture-invalid', 65536, signal, [html, response(1)]),
    [1, 0],
  );
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(sourceOrder('fixture-cancelled', 65536, abort.signal, [response(1)]));
});

test('falls back in fixed order after failed probes and bounds a server ignoring Range', async () => {
  const signal = new AbortController().signal;
  const fail = async () => new Response('failed', { status: 503 });
  assert.deepEqual(
    await sourceOrder('fixture-all-fail', 131072, signal, [fail, fail, fail]),
    [0, 1, 2],
  );
  let stopped = false;
  const ignoresRange = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(65536));
        },
        cancel() {
          stopped = true;
        },
      }),
      { headers: { 'content-type': 'application/octet-stream', 'content-length': '131072' } },
    );
  assert.deepEqual(
    await sourceOrder('fixture-range-ignored', 131072, signal, [ignoresRange, fail]),
    [0, 1],
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(stopped, true);
});

test('bounds a stalled probe and stops when cancelled during probing', async () => {
  const blocked = async () => new Promise<Response>(() => {});
  const started = Date.now();
  const order = await sourceOrder('fixture-stall', 65536, new AbortController().signal, [
    blocked,
    response(1),
  ]);
  assert.deepEqual(order, [1, 0]);
  assert.ok(Date.now() - started < 4500);
  const abort = new AbortController();
  const pending = sourceOrder('fixture-abort', 65536, abort.signal, [blocked]);
  abort.abort();
  await assert.rejects(pending);
});

test('proxy probes and full transfers send no credentials, and a corrupt winner falls back', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { downloadVerified } = await import('../src/orchestration/tool-release.js');
  const root = await mkdtemp(join(tmpdir(), 'mizar-source-order-'));
  const originalFetch = globalThis.fetch;
  const bytes = Buffer.from('good');
  const requests: { host: string; range: string | null }[] = [];
  const labels: string[] = [];
  const progress: Array<[string, number]> = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    const range = headers.get('range');
    requests.push({ host: url.hostname, range });
    if (url.hostname === 'github.com' && range)
      await new Promise((resolve) => setTimeout(resolve, 20));
    return range
      ? new Response(bytes, { status: 206, headers: { 'content-range': 'bytes 0-3/4' } })
      : new Response(url.hostname === 'gh-proxy.com' ? Buffer.from('evil') : bytes);
  }) as typeof fetch;
  try {
    await downloadVerified(
      'https://github.com/Co1Swet/MulNX_CS2/releases/download/Fixture/MulNX.7z',
      join(root, 'archive'),
      createHash('sha256').update(bytes).digest('hex'),
      bytes.length,
      new AbortController().signal,
      (count, _source, name) => {
        labels.push(name);
        progress.push([name, count]);
      },
      undefined,
      undefined,
      undefined,
      true,
    );
    assert.deepEqual(await readFile(join(root, 'archive')), bytes);
    assert.deepEqual(
      requests.filter((entry) => !entry.range).map((entry) => entry.host),
      ['gh-proxy.com', 'github.com'],
    );
    assert.deepEqual([...new Set(labels)], ['GitHub 加速', 'GitHub']);
    assert.ok(progress.some(([name, count]) => name === 'GitHub' && count === 0));
    assert.equal(requests.filter((entry) => entry.range).length, 2);
    const beforeRetry = requests.length;
    await downloadVerified(
      'https://github.com/Co1Swet/MulNX_CS2/releases/download/Fixture/MulNX.7z',
      join(root, 'retry'),
      createHash('sha256').update(bytes).digest('hex'),
      bytes.length,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    assert.equal(requests.slice(beforeRetry).filter((entry) => entry.range).length, 2);
    const beforeScript = requests.length;
    await downloadVerified(
      'https://github.com/Co1Swet/MulNX_CS2/releases/download/Fixture/MulNX.7z',
      join(root, 'bundle-script'),
      createHash('sha256').update(bytes).digest('hex'),
      bytes.length,
    );
    assert.deepEqual(requests.slice(beforeScript), [{ host: 'github.com', range: null }]);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('Mizar proxy policy accepts only the authenticated public asset and does not forward credentials', async () => {
  const { updateRequest } = await import('../src/updates/network.js');
  const origin =
    'https://github.com/Starfie1d1272/Mizar/releases/download/v1.9.2/Mizar-v1.9.2-Windows-x64-Core-Setup.exe';
  const proxy = `https://gh-proxy.com/${origin}`;
  const signal = new AbortController().signal;
  const fetcher: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('range'), 'bytes=0-3');
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    return new Response('good', { status: 206, headers: { 'content-range': 'bytes 0-3/4' } });
  };
  const result = await updateRequest(proxy, signal, fetcher, { proxyAsset: origin, rangeEnd: 3 });
  assert.equal(result.status, 206);
  await result.body?.cancel();
  const boxFile = await updateRequest(
    'https://box.nju.edu.cn/seafhttp/files/opaque',
    signal,
    fetcher,
    { rangeEnd: 3 },
  );
  await boxFile.body?.cancel();
  await assert.rejects(
    updateRequest(
      'https://gh-proxy.com/https://github.com/other/private/releases/download/v1/x',
      signal,
      fetcher,
      { proxyAsset: origin, rangeEnd: 3 },
    ),
    /update_url_forbidden/,
  );
  const redirect: typeof fetch = async () =>
    new Response(null, { status: 302, headers: { location: 'https://example.com/untrusted' } });
  await assert.rejects(
    updateRequest(proxy, signal, redirect, { proxyAsset: origin }),
    /update_url_forbidden/,
  );
});

test('all failed probes still attempt the original full asset first', async () => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { downloadVerified } = await import('../src/orchestration/tool-release.js');
  const root = await mkdtemp(join(tmpdir(), 'mizar-all-probes-'));
  const originalFetch = globalThis.fetch;
  const bytes = Buffer.from('good');
  const full: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const host = new URL(input instanceof Request ? input.url : input.toString()).hostname;
    if (new Headers(init?.headers).has('range')) return new Response(null, { status: 503 });
    full.push(host);
    return new Response(bytes);
  }) as typeof fetch;
  try {
    const target = join(root, 'archive');
    await downloadVerified(
      'https://github.com/Co1Swet/MulNX_CS2/releases/download/FailProbe/MulNX.7z',
      target,
      createHash('sha256').update(bytes).digest('hex'),
      bytes.length,
      new AbortController().signal,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    assert.deepEqual(full, ['github.com']);
    assert.deepEqual(await readFile(target), bytes);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('cancellation during probing never starts a full transfer', async () => {
  const { mkdtemp, rm, access } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { downloadVerified } = await import('../src/orchestration/tool-release.js');
  const root = await mkdtemp(join(tmpdir(), 'mizar-probe-cancel-'));
  const previous = globalThis.fetch;
  const requests: (string | null)[] = [];
  globalThis.fetch = (async (_input, init) => {
    requests.push(new Headers(init?.headers).get('range'));
    return new Promise<Response>(() => {});
  }) as typeof fetch;
  const abort = new AbortController();
  try {
    const target = join(root, 'archive');
    const task = downloadVerified(
      'https://github.com/Co1Swet/MulNX_CS2/releases/download/CancelProbe/MulNX.7z',
      target,
      createHash('sha256').update('good').digest('hex'),
      4,
      abort.signal,
      undefined,
      undefined,
      undefined,
      undefined,
      true,
    );
    abort.abort();
    await assert.rejects(task);
    assert.ok(requests.length > 0 && requests.every((range) => range === 'bytes=0-3'));
    await assert.rejects(access(target), { code: 'ENOENT' });
  } finally {
    globalThis.fetch = previous;
    await rm(root, { recursive: true, force: true });
  }
});
