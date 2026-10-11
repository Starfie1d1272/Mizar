import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { Buffer, Blob } from 'node:buffer';
import { setTimeout } from 'node:timers';
import { afterEach, expect, it, vi } from 'vitest';
import { multipartUpload } from './box-upload.mjs';

const { AbortSignal, FormData } = globalThis;

const servers = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
async function endpoint(handler) {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}/upload`;
}
function options(signal = AbortSignal.timeout(5000)) {
  const body = new FormData();
  body.set('parent_dir', '/Runtime/v1.3.0');
  body.set('replace', '0');
  body.set('file', new Blob([Buffer.from([0, 1, 255, 13, 10])]), 'original.exe');
  return { body, signal };
}
it('sends complete multipart bytes with a correct length, then awaits the upload receipt', async () => {
  let observed;
  const url = await endpoint(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    observed = { headers: incoming.headers, bytes: Buffer.concat(chunks) };
    setTimeout(() => response.end('[{"name":"original.exe"}]'), 25);
  });
  const result = await multipartUpload(url, options(), request);
  expect(await result.json()).toEqual([{ name: 'original.exe' }]);
  expect(Number(observed.headers['content-length'])).toBe(observed.bytes.length);
  const boundary = observed.headers['content-type'].split('boundary=')[1];
  expect(observed.bytes.toString()).toContain('name="parent_dir"\r\n\r\n/Runtime/v1.3.0');
  expect(observed.bytes.toString()).toContain('name="replace"\r\n\r\n0');
  expect(observed.bytes.includes(Buffer.from([0, 1, 255, 13, 10]))).toBe(true);
  expect(observed.bytes.toString().endsWith(`--${boundary}--\r\n`)).toBe(true);
});
it('honors the total deadline while waiting for response headers and never retries', async () => {
  let calls = 0;
  const url = await endpoint((incoming) => {
    calls++;
    incoming.resume();
  });
  await expect(
    multipartUpload(url, options(AbortSignal.timeout(100)), request),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toBe(1);
});
it('does not follow redirects or expose signed URLs in progress', async () => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  let calls = 0;
  const url = await endpoint((incoming, response) => {
    calls++;
    incoming.resume();
    response.writeHead(302, { Location: '/private-signed-target' });
    response.end('private body');
  });
  const result = await multipartUpload(url + '?secret=private-token', options(), request);
  expect(result.status).toBe(302);
  expect(calls).toBe(1);
  expect(logs.mock.calls.flat().join('\n')).not.toMatch(/private|http:\/\//);
});
it('bounds the receipt body independently of the uploaded file size', async () => {
  const url = await endpoint((incoming, response) => {
    incoming.resume();
    response.end(Buffer.alloc(65537));
  });
  await expect(multipartUpload(url, options(), request)).rejects.toThrow('exceeds limit');
});
