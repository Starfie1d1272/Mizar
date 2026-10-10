import { makeMachineMetadata } from '../../packages/resource-pack-contract/transport.mjs';
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
    assert.equal(url.searchParams.get('path'), '/Runtime/v2.0.0/machine-metadata.json');
    return globalThis.Response.json(
      'https://box.nju.edu.cn/seafhttp/files/test/resource-descriptor.json',
    );
  }
  assert.equal(headers.has('Authorization'), false);
  return new globalThis.Response(
    makeMachineMetadata(new Map([['resource-descriptor.json', original]])),
  );
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
await assert.rejects(
  () =>
    downloadResourceOriginal({
      version: '2.0.0',
      name: 'resource-descriptor.json',
      maximum: 65536,
      signal: new globalThis.AbortController().signal,
      fetcher: async (url) => {
        throw new Error(
          String(url).includes('box.nju.edu.cn')
            ? 'original mirror failure'
            : 'original canonical failure',
        );
      },
    }),
  (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    const [mirror, canonical] = error.errors;
    for (const [wrapped, source, message] of [
      [mirror, 'box.nju.edu.cn', 'original mirror failure'],
      [canonical, 'github.com', 'original canonical failure'],
    ]) {
      assert.equal(wrapped.name, 'UpdateRequestError');
      assert.equal(wrapped.message, 'update_network_failed');
      assert.equal(wrapped.source, source);
      assert.ok(wrapped.cause instanceof Error);
      assert.equal(wrapped.cause.message, message);
    }
    assert.equal(error.cause, canonical);
    assert.equal(error.cause.cause, canonical.cause);
    return true;
  },
);
console.log(
  'PASS: actual deployed resource transport uses read-only Box, keeps token off bytes/GitHub, falls back to canonical GitHub and rejects traversal; no signature/installation claim',
);
