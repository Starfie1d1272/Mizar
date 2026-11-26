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

test('updateRequest follows wrapped GH-Proxy 302 redirects without credentials', async () => {
  const { boundedBytes, updateRequest } = await import('../src/updates/network.js');
  const origin =
    'https://github.com/Starfie1d1272/Mizar/releases/download/v1.9.2/Mizar-v1.9.2-Windows-x64-Core-Setup.exe';
  const proxy = `https://gh-proxy.com/${origin}`;
  const wrappedRedirect =
    'https://gh-proxy.com/https://release-assets.githubusercontent.com/github-production-release-asset/12345/setup.exe?rscd=attachment&sp=r';
  const signal = new AbortController().signal;
  const visited: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    visited.push(url);
    const headers = new Headers(init?.headers);
    assert.equal(headers.has('authorization'), false);
    assert.equal(headers.has('cookie'), false);
    if (url === proxy) {
      return new Response(null, { status: 302, headers: { location: wrappedRedirect } });
    }
    assert.equal(url, wrappedRedirect);
    return new Response('good', { status: 200 });
  };
  const response = await updateRequest(proxy, signal, fetcher);
  assert.equal((await boundedBytes(response, 1024)).toString('utf8'), 'good');
  assert.deepEqual(visited, [proxy, wrappedRedirect]);
});

test('updateRequest rejects non-HTTPS redirects and URLs with embedded credentials', async () => {
  const { updateRequest } = await import('../src/updates/network.js');
  const signal = new AbortController().signal;
  const httpRedirect: typeof fetch = async () =>
    new Response(null, { status: 302, headers: { location: 'http://example.com/insecure' } });
  await assert.rejects(
    updateRequest(
      'https://gh-proxy.com/https://github.com/org/repo/releases/download/v1/x',
      signal,
      httpRedirect,
    ),
    /update_url_forbidden/,
  );
  await assert.rejects(
    updateRequest('https://user:pass@example.com/file', signal, httpRedirect),
    /update_url_forbidden/,
  );
  const credentialRedirect: typeof fetch = async () =>
    new Response(null, { status: 302, headers: { location: 'https://user@example.com/file' } });
  await assert.rejects(
    updateRequest('https://example.com/start', signal, credentialRedirect),
    /update_url_forbidden/,
  );
});

test('updateRequest isolates Box Authorization header on per-hop redirect', async () => {
  const { updateRequest } = await import('../src/updates/network.js');
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
    return new Response('ok', { status: 200 });
  };
  const response = await updateRequest(boxApi, signal, fetcher);
  await response.body?.cancel();
  assert.deepEqual(authSeen, [
    { url: boxApi, hasAuth: true },
    { url: externalTarget, hasAuth: false },
  ]);
});
