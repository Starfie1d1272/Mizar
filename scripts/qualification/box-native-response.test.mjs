import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
    if (path === '/disconnect' && (count === 1 || req.method === 'POST')) {
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
      res.writeHead(503);
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
