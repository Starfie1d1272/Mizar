import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { BoxClient } from './box-sync.mjs';
import { curlMultipartUpload } from './box-curl-upload.mjs';

const { AbortSignal, Blob, FormData, Response } = globalThis;

function client(transport) {
  const box = new BoxClient('test-token', transport);
  box.api = async (_endpoint, _path, _method, _body, signal) => {
    assert.ok(signal);
    return 'https://box.example/upload';
  };
  box.temporaryUrl = (value) => new URL(value);
  return box;
}

test('retries only the zero-byte failed chunk and retains the successful prefix', async () => {
  const ranges = [];
  const box = client(async (_url, options) => {
    const range = options.headers['Content-Range'];
    ranges.push(range);
    if (ranges.length === 2)
      throw Object.assign(new Error('connection failed'), {
        code: 'BOX_CURL_FAILED',
        retrySafeUpload: true,
      });
    return Response.json(range.startsWith('bytes 2-') ? [{ name: 'payload' }] : { success: true });
  });
  await box.uploadChunks('/Archive/test', 'payload', Buffer.from('abcd'), 2);
  assert.deepEqual(ranges, ['bytes 0-1/4', 'bytes 2-3/4', 'bytes 2-3/4']);
});

test('uncertain chunk failure is not replayed', async () => {
  let calls = 0;
  const box = client(async () => {
    calls++;
    throw Object.assign(new Error('connection lost'), { code: 'BOX_CURL_FAILED' });
  });
  await assert.rejects(box.uploadChunks('/Archive/test', 'payload', Buffer.from('abcd'), 2), {
    uploadOutcomeUnknown: true,
    retrySafeUpload: false,
  });
  assert.equal(calls, 1);
});

test('zero-byte retries stop after three attempts', async () => {
  let calls = 0;
  const box = client(async () => {
    calls++;
    throw Object.assign(new Error('connection failed'), {
      code: 'BOX_CURL_FAILED',
      retrySafeUpload: true,
    });
  });
  await assert.rejects(box.uploadChunks('/Archive/test', 'payload', Buffer.from('a')), {
    retrySafeUpload: true,
  });
  assert.equal(calls, 3);
});

test('upload link and all chunks share the 180-second deadline', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const ranges = [];
  const box = client(async (_url, options) => {
    ranges.push(options.headers['Content-Range']);
    now += 179000;
    return Response.json({ success: true });
  });
  box.api = async () => {
    now += 1000;
    return 'https://box.example/upload';
  };
  await assert.rejects(
    box.uploadChunks('/Archive/test', 'payload', Buffer.from('abcd'), 2),
    /预算已用完/,
  );
  assert.deepEqual(ranges, ['bytes 0-1/4']);
});

test('real curl TLS failure reports zero sent bytes as safe to retry', async () => {
  const server = createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const form = new FormData();
    form.set('file', new Blob(['local']), 'local');
    await assert.rejects(
      curlMultipartUpload(`https://127.0.0.1:${server.address().port}/`, {
        body: form,
        signal: AbortSignal.timeout(5000),
      }),
      { code: 'BOX_CURL_FAILED', retrySafeUpload: true },
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('partial or malformed curl metrics never authorize replay', async () => {
  for (const metrics of ['000 0 0 0 0 0 1 2 0', '000 0 0']) {
    const run = () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stdin = new Writable({
        write(_chunk, _encoding, callback) {
          callback();
        },
        final(callback) {
          child.stdout.end(metrics);
          child.emit('close', 35);
          callback();
        },
      });
      child.kill = () => {};
      return child;
    };
    const form = new FormData();
    form.set('file', new Blob(['local']), 'local');
    await assert.rejects(
      curlMultipartUpload(
        'https://example.test/',
        { body: form, signal: AbortSignal.timeout(5000) },
        run,
      ),
      { code: 'BOX_CURL_FAILED', retrySafeUpload: false },
    );
  }
});
