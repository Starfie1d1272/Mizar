import { test } from 'node:test';
import assert from 'node:assert/strict';

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
      undefined,
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
