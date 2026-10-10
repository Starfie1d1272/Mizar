import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { Buffer } from 'node:buffer';
const { downloadResourceOriginal, mirrorResourcePath } = await import(
  pathToFileURL(resolve(process.argv[2])).href
);
// Transport bytes only; no publisher proof, installation, or Store-ready claim.
const original = Buffer.from('unchanged bounded transport bytes');
const requests = [];
let unavailable = false;
const fetcher = async (input, options) => {
  const url = new globalThis.URL(input instanceof globalThis.Request ? input.url : String(input));
  const headers = new globalThis.Headers(options?.headers);
  requests.push(url.hostname);
  if (url.hostname === 'box.nju.edu.cn' && url.pathname.startsWith('/api/')) {
    assert.match(headers.get('Authorization'), /^Token /);
    if (unavailable) return new globalThis.Response('unavailable', { status: 503 });
    if (url.pathname.endsWith('/dir/'))
      return globalThis.Response.json({ repo_name: 'Mizar', user_perm: 'r' });
    assert.equal(url.searchParams.get('path'), '/Resources/v2.0.0/resource-descriptor.json');
    return globalThis.Response.json(
      'https://box.nju.edu.cn/seafhttp/files/test/resource-descriptor.json',
    );
  }
  assert.equal(headers.has('Authorization'), false);
  return new globalThis.Response(original);
};
const read = () =>
  downloadResourceOriginal({
    version: '2.0.0',
    name: 'resource-descriptor.json',
    maximum: 65536,
    signal: new globalThis.AbortController().signal,
    fetcher,
  });
assert.deepEqual(await read(), original);
assert.equal(
  requests.some((host) => host.includes('github')),
  false,
);
unavailable = true;
requests.length = 0;
assert.deepEqual(await read(), original);
assert.equal(requests.at(-1), 'github.com');
assert.throws(() => mirrorResourcePath('2.0.0', '../outside.json'));
console.log(
  'PASS: actual deployed resource transport uses read-only Box, keeps token off bytes/GitHub, falls back to canonical GitHub and rejects traversal; no signature/installation claim',
);
