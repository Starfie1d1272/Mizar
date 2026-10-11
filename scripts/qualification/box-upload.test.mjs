import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { Buffer, Blob } from 'node:buffer';
import { setTimeout } from 'node:timers';
import { afterEach, expect, it, vi } from 'vitest';
import { apiRequest, multipartUpload } from './box-upload.mjs';
import { BoxClient } from './box-sync.mjs';

const { AbortController, AbortSignal, FormData } = globalThis;

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
it('sends an API mutation once with the original JSON, authentication and UTF-8 length', async () => {
  let observed;
  const url = await endpoint(async (incoming, response) => {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    observed = { method: incoming.method, headers: incoming.headers, bytes: Buffer.concat(chunks) };
    response.end(JSON.stringify({ ok: true }));
  });
  let calls = 0;
  const client = new BoxClient('fixture-token', undefined, (address, settings) => {
    calls++;
    expect(address.origin).toBe('https://box.nju.edu.cn');
    expect(address.pathname).toBe('/api/v2.1/via-repo-token/sync-batch-move-item/');
    return apiRequest(url, settings, request);
  });
  const body = { src_dir: '/Stable', dst_dir: '/Archive', names: ['原文件.zip'] };
  expect(await client.api('sync-batch-move-item', undefined, 'POST', body)).toEqual({ ok: true });
  expect(calls).toBe(1);
  expect(observed.method).toBe('POST');
  expect(observed.headers.authorization).toBe('Token fixture-token');
  expect(observed.headers['content-type']).toBe('application/json');
  expect(Number(observed.headers['content-length'])).toBe(observed.bytes.length);
  expect(observed.bytes.toString('utf8')).toBe(JSON.stringify(body));
});
it('cancels API connection and response waits through the caller signal without replay', async () => {
  let calls = 0;
  const url = await endpoint((incoming, response) => {
    calls++;
    incoming.resume();
    response.write('partial response');
  });
  await expect(apiRequest(url, { signal: AbortSignal.abort() }, request)).rejects.toMatchObject({
    name: 'AbortError',
  });
  expect(calls).toBe(0);
  const controller = new AbortController();
  const received = once(servers.at(-1), 'request');
  const pending = apiRequest(url, { method: 'POST', signal: controller.signal }, request);
  const failed = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await received;
  controller.abort();
  await failed;
  expect(calls).toBe(1);
});
it('does not follow API redirects or expose their private body', async () => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  let calls = 0;
  const url = await endpoint((incoming, response) => {
    calls++;
    incoming.resume();
    response.writeHead(302, { Location: '/private-target' });
    response.end('private-server-body');
  });
  const client = new BoxClient('private-token', undefined, (_address, settings) =>
    apiRequest(url, settings, request),
  );
  await expect(client.api('dir', '/Stable')).rejects.toThrow('HTTP 302');
  expect(calls).toBe(1);
  expect(logs.mock.calls.flat().join('\n')).not.toMatch(/private|http:\/\//);
});
it('bounds the API response while accepting an empty HTTP result', async () => {
  const empty = await endpoint((incoming, response) => {
    incoming.resume();
    response.writeHead(204);
    response.end();
  });
  const result = await apiRequest(empty, { signal: AbortSignal.timeout(5000) }, request);
  expect(result.status).toBe(204);
  expect(await result.text()).toBe('');
  const large = await endpoint((incoming, response) => {
    incoming.resume();
    response.end(Buffer.alloc(2 * 1024 * 1024 + 1));
  });
  await expect(apiRequest(large, { signal: AbortSignal.timeout(5000) }, request)).rejects.toThrow();
});
it('reports the API JSON parsing stage without quoting private server content', async () => {
  const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
  const url = await endpoint((incoming, response) => {
    incoming.resume();
    response.end('private-token https://box.nju.edu.cn/private-signed-link');
  });
  const client = new BoxClient('private-token', undefined, (_address, settings) =>
    apiRequest(url, settings, request),
  );
  await expect(client.api('dir', '/Stable')).rejects.toThrow('JSON（解析阶段，SyntaxError）');
  expect(logs.mock.calls.flat().join('\n')).not.toMatch(/private|https:\/\//);
});
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
it.each([204, 205, 304])(
  'represents an empty HTTP %s response without an uncaught conversion error',
  async (status) => {
    const url = await endpoint((incoming, response) => {
      incoming.resume();
      response.writeHead(status);
      response.end();
    });
    const result = await multipartUpload(url, options(), request);
    expect(result.status).toBe(status);
    expect(await result.text()).toBe('');
  },
);
it('rejects an invalid response status through the upload promise', async () => {
  const url = await endpoint((incoming, response) => {
    incoming.resume();
    response.writeHead(700);
    response.end();
  });
  await expect(multipartUpload(url, options(), request)).rejects.toThrow('status invalid');
});
it.each([200, 204, 304, 503])(
  'does not accept an empty or rejected HTTP %s as a successful upload',
  async (status) => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => {});
    let calls = 0;
    const url = await endpoint((incoming, response) => {
      calls++;
      incoming.resume();
      response.writeHead(status);
      response.end(status === 503 ? 'private server response' : undefined);
    });
    const client = new BoxClient('private-token', (_url, settings) =>
      multipartUpload(url, settings, request),
    );
    client.api = async () => 'https://box.nju.edu.cn/seafhttp/upload-api/private-url';
    const failed = client.upload('/Runtime/v1.3.0', 'original.exe', Buffer.from('original'));
    await expect(failed).rejects.toThrow(status >= 300 ? `HTTP ${status}` : 'JSON');
    expect(calls).toBe(1);
    expect(logs.mock.calls.flat().join('\n')).not.toMatch(/private|http:\/\//);
  },
);
