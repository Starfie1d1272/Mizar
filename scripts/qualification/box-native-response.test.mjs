import process from 'node:process';
import { curlMultipartUpload } from './box-curl-upload.mjs';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Agent, createServer, request } from 'node:https';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxClient } from './box-sync.mjs';
import { apiRequest, multipartUpload } from './box-upload.mjs';

const { AbortSignal, Buffer, URL } = globalThis;
let server;
let agent;
let localOrigin;
let uploadStatus;
let certificateDirectory;
const counts = new Map();
const events = [];
beforeAll(async () => {
  // This certificate is trusted only by this local test agent; TLS verification stays enabled.
  certificateDirectory = await mkdtemp(join(tmpdir(), 'mizar-box-https-'));
  const certPath = join(certificateDirectory, 'cert.pem');
  const keyPath = join(certificateDirectory, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { stdio: 'ignore' },
  );
  const cert = await readFile(certPath);
  const key = await readFile(keyPath);
  agent = new Agent({ ca: cert });
  server = createServer({ cert, key }, (req, res) => {
    const path = req.url;
    const count = (counts.get(path) ?? 0) + 1;
    counts.set(path, count);
    req.resume();
    if (path === '/curl-redirect') {
      res.writeHead(302, { Location: '/curl-success' });
      res.end();
    } else if (path === '/curl-stall') {
      // Read request, then deliberately never acknowledge it.
    } else if (path === '/curl-success') {
      res.end('[{"name":"test.bin"}]');
    } else if (path === '/disconnect' && (count === 1 || req.method === 'POST')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100' });
      res.write('{"repo_name":');
      globalThis.setTimeout(() => res.destroy(), 30);
    } else if (path === '/slow401') {
      res.writeHead(401);
      res.write('PRIVATE-RESPONSE');
    } else if (path === '/large') {
      res.writeHead(200);
      res.end(Buffer.alloc(2 * 1024 * 1024 + 1));
    } else if (path === '/temporary' && count === 1) {
      res.writeHead(503, { 'Retry-After': '2' });
      res.write('PRIVATE-RESPONSE');
    } else if (path === '/upload-link') {
      res.end(JSON.stringify('https://box.nju.edu.cn/seafhttp/local-test'));
    } else if (path === '/upload') {
      res.writeHead(uploadStatus);
      res.write('PRIVATE-UPLOAD-RESPONSE');
    } else {
      res.end(JSON.stringify({ repo_name: 'Mizar' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  localOrigin = `https://127.0.0.1:${server.address().port}`;
});
beforeEach(() => {
  counts.clear();
  events.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  agent?.destroy();
  server?.closeAllConnections();
  if (server) await new Promise((resolve) => server.close(resolve));
  if (certificateDirectory) await rm(certificateDirectory, { recursive: true, force: true });
});

function localRequest(path) {
  return (_url, options, callback) =>
    request(new URL(path, localOrigin), { ...options, agent }, (incoming) => {
      incoming.on('aborted', () => events.push({ kind: 'aborted' }));
      incoming.on('error', (error) => events.push({ kind: 'error', code: error.code }));
      callback(incoming);
    });
}
function client(path) {
  return new BoxClient(
    'PRIVATE-TEST-TOKEN',
    (url, options) => multipartUpload(url, options, localRequest('/upload')),
    (url, options) => apiRequest(url, options, localRequest(path)),
  );
}
function shortDeadline() {
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => timeout(1000));
}

describe('Box native HTTPS response boundaries', () => {
  it('uses the default curl transport with verified TLS and without redirects or retries', async () => {
    const previous = process.env.CURL_CA_BUNDLE;
    process.env.CURL_CA_BUNDLE = join(certificateDirectory, 'cert.pem');
    try {
      const upload = (path) => {
        const body = new globalThis.FormData();
        body.set('file', new globalThis.Blob([Buffer.alloc(1024 * 1024 + 1)]), 'test.bin');
        return curlMultipartUpload(new URL(path, localOrigin), {
          body,
          signal: AbortSignal.timeout(5000),
        });
      };
      const response = await upload('/curl-success');
      expect(await response.json()).toEqual([{ name: 'test.bin' }]);
      expect((await upload('/curl-redirect')).status).toBe(302);
      expect(counts.get('/curl-success')).toBe(1);
      await expect(upload('/large')).rejects.toThrow();
      expect(counts.get('/large')).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.CURL_CA_BUNDLE;
      else process.env.CURL_CA_BUNDLE = previous;
    }
  });

  it('retries a real successful-body disconnect with its native transient code', async () => {
    await expect(client('/disconnect').api('repo-info')).resolves.toEqual({ repo_name: 'Mizar' });
    expect(counts.get('/disconnect')).toBe(2);
    expect(events.some((event) => event.kind === 'aborted')).toBe(true);
    expect(events.some((event) => event.code === 'ECONNRESET')).toBe(true);
  });

  it('keeps 401 terminal even when its body never finishes', async () => {
    shortDeadline();
    await expect(client('/slow401').api('repo-info')).rejects.toMatchObject({ httpStatus: 401 });
    expect(counts.get('/slow401')).toBe(1);
  });

  it('does not retry active destruction of an oversized successful body', async () => {
    await expect(client('/large').api('repo-info')).rejects.toThrow('response_limit');
    expect(counts.get('/large')).toBe(1);
  });

  it('retries 503 without waiting for an unfinished error body', async () => {
    shortDeadline();
    await expect(client('/temporary').api('repo-info')).resolves.toEqual({ repo_name: 'Mizar' });
    expect(counts.get('/temporary')).toBe(2);
  });

  it('does not replay a real POST after its successful body disconnects', async () => {
    await expect(client('/disconnect').api('file', '/Stable/test', 'POST')).rejects.toThrow(
      '已尝试1次',
    );
    expect(counts.get('/disconnect')).toBe(1);
  });

  it.each([401, 503])(
    'keeps a real upload HTTP %s terminal with an unfinished body',
    async (status) => {
      shortDeadline();
      uploadStatus = status;
      await expect(
        client('/upload-link').upload('/Stable', 'test.txt', Buffer.from('test')),
      ).rejects.toMatchObject({ httpStatus: status });
      expect(counts.get('/upload')).toBe(1);
    },
  );
});

it.each([
  ['unsent timeout', 28, '000', 0, true],
  ['partial timeout', 28, '000', 1, false],
  ['complete timeout', 28, '000', 'full', false],
  ['certificate failure', 60, '000', 0, false],
  ['auth failure', 28, '403', 0, false],
])(
  'classifies curl %s without leaking its private address',
  async (_label, exit, http, sent, retrySafe) => {
    const run = vi.fn((_command, args) => {
      expect(args.join(' ')).not.toContain('PRIVATE');
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.kill = vi.fn();
      child.stdin.on('finish', async () => {
        const payload = await readFile(args[args.indexOf('--data-binary') + 1].slice(1));
        await writeFile(args[args.indexOf('--output') + 1], '');
        child.stdout.write(
          `${http} 0.01 0.02 0.03 0.04 0 60 ${sent === 'full' ? payload.length : sent} 0`,
        );
        child.emit('close', exit);
      });
      return child;
    });
    const body = new globalThis.FormData();
    body.set('file', new globalThis.Blob(['payload']), 'test.bin');
    await expect(
      curlMultipartUpload(
        'https://box.nju.edu.cn/seafhttp/PRIVATE',
        { body, signal: AbortSignal.timeout(5000) },
        run,
      ),
    ).rejects.toMatchObject({ retrySafeUpload: retrySafe });
    expect(run).toHaveBeenCalledTimes(1);
    expect(console.log.mock.calls.flat().join(' ')).not.toContain('PRIVATE');
  },
);
it('preserves Retry-After from a real response with an unfinished error body', async () => {
  const response = await apiRequest(
    'https://box.nju.edu.cn/',
    { signal: AbortSignal.timeout(1000) },
    localRequest('/temporary'),
  );
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('2');
});
it('terminates a stalled real curl process at the caller deadline', async () => {
  const previous = process.env.CURL_CA_BUNDLE;
  process.env.CURL_CA_BUNDLE = join(certificateDirectory, 'cert.pem');
  try {
    const body = new globalThis.FormData();
    body.set('file', new globalThis.Blob(['payload']), 'test.bin');
    const started = Date.now();
    await expect(
      curlMultipartUpload(new URL('/curl-stall', localOrigin), {
        body,
        signal: AbortSignal.timeout(300),
      }),
    ).rejects.toMatchObject({ retrySafeUpload: false });
    expect(Date.now() - started).toBeLessThan(3000);
    expect(counts.get('/curl-stall')).toBe(1);
  } finally {
    if (previous === undefined) delete process.env.CURL_CA_BUNDLE;
    else process.env.CURL_CA_BUNDLE = previous;
  }
});
